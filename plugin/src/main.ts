import { MarkdownView, Notice, Plugin, requestUrl, TFile, TFolder, type TAbstractFile } from "obsidian";
import { ApiClient, ApiError, type Http } from "./api";
import { createEditorLock } from "./lock/editorLock";
import { ObsidianVault } from "./obsidianVault";
import { Realtime, type ConnectionStatus } from "./realtime";
import { DEFAULT_SETTINGS, TeamSyncSettingTab, type TeamSyncSettings } from "./settings";
import { SyncEngine, type SyncState } from "./sync/engine";

interface Session {
  token: string;
  /** Server-issued id of this login: locks belong to it. */
  clientId: string;
}

interface PluginData {
  settings: TeamSyncSettings;
  /**
   * Device that owns `session` and `sync`. data.json gets copied along with .obsidian (new
   * vault from a template, .obsidian synced by other tools): a copy must not reuse another
   * device's session, nor its sync state, which would make missing files look deleted.
   */
  deviceId: string;
  session: Session | null;
  sync: { server: string; state: SyncState };
}

const DEVICE_KEY = "team-sync-device-id";
const LOCAL_CHANGE_DEBOUNCE_MS = 800;
/** After a note is closed, wait for Obsidian's own save before releasing its lock. */
const RELEASE_AFTER_CLOSE_MS = 3000;

const EMPTY_STATE: SyncState = { instanceId: "", records: {} };

const obsidianHttp: Http = async ({ url, method, headers, body }) => {
  const { "content-type": contentType, ...rest } = headers;
  const res = await requestUrl({ url, method, headers: rest, body, contentType, throw: false });
  return { status: res.status, headers: res.headers, arrayBuffer: res.arrayBuffer };
};

export default class TeamSyncPlugin extends Plugin {
  declare settings: TeamSyncSettings;
  private data!: PluginData;
  private api!: ApiClient;
  private engine!: SyncEngine;
  private realtime!: Realtime;
  private status: ConnectionStatus = "offline";
  private statusBar!: HTMLElement;
  private editorLock!: ReturnType<typeof createEditorLock>;
  private readonly pendingChanges = new Map<string, number>();
  private readonly idleTimers = new Map<string, number>();
  private readonly acquiring = new Set<string>();
  /** Shown live in the settings tab while it is open. */
  statusListener: (() => void) | undefined;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.api = new ApiClient({
      http: obsidianHttp,
      serverUrl: () => this.settings.serverUrl,
      token: () => this.data.session?.token ?? "",
    });
    this.createEngine();

    this.realtime = new Realtime({
      serverUrl: () => this.settings.serverUrl,
      token: () => this.data.session?.token ?? "",
      onEvent: (event) => {
        this.engine.handleServerEvent(event);
        // (Re)connected: catch up on whatever happened while we were away.
        if (event.type === "ready") this.syncNow(false);
      },
      onStatus: (status) => {
        this.status = status;
        if (status !== "online") this.engine.clearLocks();
        if (status === "unauthorized" && this.data.session) {
          new Notice("Team Sync: sessione scaduta, accedi di nuovo dalle impostazioni.");
        }
        this.updateStatusBar();
      },
    });

    this.editorLock = createEditorLock({
      lockedBy: (path) => this.engine.lockedByOther(path)?.username,
      onUserEdit: (path) => this.onUserEdit(path),
    });
    this.registerEditorExtension(this.editorLock.extension);

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("team-sync-status");
    this.statusBar.onClickEvent(() => this.syncNow(true));

    this.addSettingTab(new TeamSyncSettingTab(this.app, this));
    this.registerCommands();

    this.registerEvent(this.app.workspace.on("file-open", (file) => this.onFileOpen(file)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.releaseClosedFiles()));

    // Vault events only after the vault has loaded, otherwise every existing file fires "create".
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
      this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
      this.watchExplorer();
      this.realtime.start();
    });
    this.updateStatusBar();
  }

  onunload(): void {
    this.realtime.stop();
    for (const timer of [...this.pendingChanges.values(), ...this.idleTimers.values()]) window.clearTimeout(timer);
    // Best effort; locks we cannot release expire on the server.
    for (const path of this.engine.heldLocks()) void this.api.releaseLock(path).catch(() => {});
    this.engine.stop();
  }

  private async loadPluginData(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    let deviceId = this.app.loadLocalStorage(DEVICE_KEY) as string | null;
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      this.app.saveLocalStorage(DEVICE_KEY, deviceId);
    }
    const ownedHere = stored.deviceId === deviceId;
    if (!ownedHere && stored.session) {
      new Notice("Team Sync: impostazioni copiate da un altro dispositivo. Accedi di nuovo per sincronizzare questo vault.", 10_000);
    }
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...stored.settings },
      deviceId,
      session: ownedHere ? (stored.session ?? null) : null,
      sync: ownedHere && stored.sync ? stored.sync : { server: "", state: EMPTY_STATE },
    };
    this.settings = this.data.settings;
    await this.saveData(this.data);
  }

  // ---------- account ----------

  isLoggedIn(): boolean {
    return this.data.session !== null;
  }

  async login(username: string, password: string): Promise<void> {
    if (!this.settings.serverUrl) throw new Error("inserisci prima l'indirizzo del server");
    const result = await this.api.login(username, password);
    this.settings.username = result.user.username;
    this.data.session = { token: result.token, clientId: result.clientId };
    if (this.data.sync.server !== this.settings.serverUrl) {
      // A different server: what we knew about the old one means nothing here.
      this.engine.stop();
      this.data.sync = { server: this.settings.serverUrl, state: EMPTY_STATE };
      this.createEngine();
    }
    await this.saveSettings();
    this.realtime.restart();
  }

  async logout(): Promise<void> {
    for (const path of this.engine.heldLocks()) await this.releaseMine(path);
    try {
      await this.api.logout();
    } catch {
      // Offline or already expired: forgetting the token locally is enough.
    }
    this.data.session = null;
    await this.saveSettings();
    this.realtime.stop();
    this.updateStatusBar();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  /** Called by the settings tab when the excluded folders change. */
  exclusionsChanged(): void {
    this.engine.forgetExcluded();
  }

  statusLabel(): string {
    switch (this.status) {
      case "online":
        return "online";
      case "connecting":
        return "connessione…";
      case "unauthorized":
        return "accesso richiesto";
      default:
        return "offline";
    }
  }

  syncNow(manual: boolean): void {
    if (!this.isLoggedIn()) {
      if (manual) new Notice("Team Sync: accedi dalle impostazioni del plugin.");
      return;
    }
    this.engine
      .fullSync()
      .then(() => {
        if (manual) new Notice("Team Sync: sincronizzazione completata.");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          this.status = "unauthorized";
          this.updateStatusBar();
        }
        if (manual || !(err instanceof ApiError)) {
          new Notice(`Team Sync: sincronizzazione non riuscita (${err instanceof Error ? err.message : String(err)})`);
        }
      });
  }

  // ---------- engine ----------

  private get clientId(): string {
    return this.data.session?.clientId ?? "";
  }

  private createEngine(): void {
    const engine: SyncEngine = new SyncEngine({
      api: this.api,
      vault: new ObsidianVault(this.app),
      clientId: () => this.clientId,
      initialState: this.data.sync.state,
      saveState: (state) => {
        // A replaced engine must not overwrite its successor's state.
        if (this.engine !== engine) return;
        this.data.sync.state = state;
        void this.saveData(this.data);
      },
      isExcluded: (path) => this.isExcluded(path),
      notify: (message) => new Notice(`Team Sync: ${message}`, 8000),
    });
    this.engine = engine;
    engine.onLocksChanged(() => {
      this.editorLock?.refresh(this.app);
      this.updateStatusBar();
      this.updateExplorerBadges();
    });
  }

  private isExcluded(path: string): boolean {
    const lower = path.toLowerCase();
    const configDir = this.app.vault.configDir.toLowerCase();
    if (lower === configDir || lower.startsWith(`${configDir}/`) || lower.startsWith(".trash/")) return true;
    return this.settings.excludedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`));
  }

  // ---------- vault events ----------

  private onVaultChange(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !this.isLoggedIn()) return;
    // Obsidian saves while you type: wait for a pause before uploading.
    window.clearTimeout(this.pendingChanges.get(file.path));
    this.pendingChanges.set(
      file.path,
      window.setTimeout(() => this.flushChange(file.path), LOCAL_CHANGE_DEBOUNCE_MS),
    );
  }

  private flushChange(path: string): void {
    const timer = this.pendingChanges.get(path);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.pendingChanges.delete(path);
    this.engine.onLocalChange(path);
  }

  private cancelChange(path: string): void {
    window.clearTimeout(this.pendingChanges.get(path));
    this.pendingChanges.delete(path);
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (!this.isLoggedIn()) return;
    if (file instanceof TFolder) {
      for (const path of this.engine.trackedUnder(file.path)) this.engine.onLocalDelete(path);
      return;
    }
    this.cancelChange(file.path);
    this.engine.onLocalDelete(file.path);
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (!this.isLoggedIn()) return;
    // The engine uploads the renamed file's current content after the rename, so pending
    // edits under the old path are covered: drop their timers, move the idle timers.
    const moves =
      file instanceof TFolder
        ? this.engine.trackedUnder(oldPath).map((path) => [path, file.path + path.slice(oldPath.length)] as const)
        : [[oldPath, file.path] as const];
    if (file instanceof TFolder) {
      for (const path of [...this.pendingChanges.keys()]) if (path.startsWith(`${oldPath}/`)) this.cancelChange(path);
    }
    for (const [from, to] of moves) {
      this.cancelChange(from);
      const idle = this.idleTimers.get(from);
      if (idle !== undefined) {
        window.clearTimeout(idle);
        this.idleTimers.delete(from);
        this.resetIdleTimer(to);
      }
      this.engine.onLocalRename(from, to);
    }
  }

  // ---------- locks ----------

  private onUserEdit(path: string): void {
    this.resetIdleTimer(path);
    if (this.engine.lockOf(path)?.clientId === this.clientId || this.acquiring.has(path)) return;
    if (this.status !== "online") return; // Offline: edit freely, conflicts are resolved on reconnect.
    this.acquiring.add(path);
    this.engine
      .acquireLock(path)
      .then((result) => {
        if (typeof result === "object") {
          new Notice(`Team Sync: ${result.lockedBy.username} sta già modificando questa nota.`);
        }
      })
      .catch((err) => console.error("[team-sync] acquire lock", err))
      .finally(() => this.acquiring.delete(path));
  }

  private resetIdleTimer(path: string): void {
    window.clearTimeout(this.idleTimers.get(path));
    this.idleTimers.set(
      path,
      window.setTimeout(() => void this.releaseMine(path), this.settings.idleReleaseMinutes * 60_000),
    );
  }

  /** Saves and uploads pending edits, then lets others edit the note. */
  private async releaseMine(path: string): Promise<void> {
    window.clearTimeout(this.idleTimers.get(path));
    this.idleTimers.delete(path);
    for (const view of this.openMarkdownViews(path)) await view.save();
    this.flushChange(path);
    await this.engine.releaseLock(path);
  }

  private openMarkdownViews(path?: string): MarkdownView[] {
    const views: MarkdownView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file && (path === undefined || leaf.view.file.path === path)) {
        views.push(leaf.view);
      }
    });
    return views;
  }

  private releaseClosedFiles(): void {
    const closed = () => {
      const open = new Set(this.openMarkdownViews().map((view) => view.file!.path));
      return this.engine.heldLocks().filter((path) => !open.has(path));
    };
    if (closed().length === 0) return;
    window.setTimeout(() => {
      for (const path of closed()) void this.releaseMine(path);
    }, RELEASE_AFTER_CLOSE_MS);
  }

  private onFileOpen(file: TFile | null): void {
    this.updateStatusBar();
    const lock = file && this.engine.lockedByOther(file.path);
    if (lock) new Notice(`🔒 ${lock.username} sta modificando "${file.basename}": aperta in sola lettura.`);
  }

  // ---------- UI ----------

  private registerCommands(): void {
    this.addCommand({
      id: "sync-now",
      name: "Sincronizza ora",
      callback: () => this.syncNow(true),
    });
    this.addCommand({
      id: "release-lock",
      name: "Rilascia il blocco della nota corrente",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.engine.lockOf(file.path)?.clientId !== this.clientId) return false;
        if (!checking) void this.releaseMine(file.path).then(() => new Notice("Team Sync: blocco rilasciato."));
        return true;
      },
    });
    this.addCommand({
      id: "force-release-lock",
      name: "Forza lo sblocco della nota corrente (admin)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.engine.lockedByOther(file.path)) return false;
        if (!checking) {
          this.api
            .forceReleaseLock(file.path)
            .then(() => new Notice("Team Sync: blocco rimosso."))
            .catch((err) => new Notice(`Team Sync: ${err instanceof Error ? err.message : String(err)}`));
        }
        return true;
      },
    });
    this.addCommand({
      id: "show-locks",
      name: "Mostra chi sta modificando",
      callback: () => {
        const locks = this.engine.allLocks();
        new Notice(
          locks.length === 0
            ? "Team Sync: nessuna nota in modifica."
            : `In modifica:\n${locks.map((l) => `• ${l.path} — ${l.username}`).join("\n")}`,
          10_000,
        );
      },
    });
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const dot = this.status === "online" ? "●" : "○";
    let text = `Team Sync ${dot} ${this.statusLabel()}`;
    const file = this.app.workspace.getActiveFile();
    const lock = file && this.engine.lockOf(file.path);
    if (lock) text += lock.clientId === this.clientId ? " · ✏️ in modifica da te" : ` · 🔒 ${lock.username}`;
    this.statusBar.setText(text);
    this.statusBar.setAttr("aria-label", "Clic per sincronizzare ora");
    this.statusListener?.();
  }

  /** The explorer creates rows lazily (e.g. when a folder is expanded): badge them as they appear. */
  private watchExplorer(): void {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        this.updateExplorerBadges();
      });
    });
    const attach = () => {
      observer.disconnect();
      for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
        observer.observe(leaf.view.containerEl, { childList: true, subtree: true });
      }
    };
    attach();
    this.registerEvent(this.app.workspace.on("layout-change", attach));
    this.register(() => observer.disconnect());
  }

  /** Lock icon next to notes someone else is editing in the file explorer. */
  private updateExplorerBadges(): void {
    const locked = new Map(this.engine.allLocks().map((l) => [l.path, l]));
    document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((el) => {
      const lock = locked.get(el.dataset.path ?? "");
      const user = lock && lock.clientId !== this.clientId ? lock.username : undefined;
      // Only touch the DOM when something changes, so the MutationObserver does not loop.
      if (el.getAttribute("data-team-sync-user") === (user ?? null)) return;
      el.toggleClass("team-sync-locked", user !== undefined);
      if (user) el.setAttr("data-team-sync-user", user);
      else el.removeAttribute("data-team-sync-user");
    });
  }
}
