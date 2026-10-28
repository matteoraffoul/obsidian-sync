import { normalizeVaultPath, type FileMeta, type LockInfo, type ServerEvent } from "@team-sync/shared";
import { ApiError, OfflineError, type ApiClient } from "../api";
import { decide, type SyncRecord } from "./reconcile";

export interface LocalStat {
  path: string;
  mtime: number;
  size: number;
}

/** The parts of the vault the engine needs; implemented on top of Obsidian's Vault (and in memory for tests). */
export interface VaultIO {
  list(): Promise<LocalStat[]>;
  stat(path: string): Promise<LocalStat | null>;
  read(path: string): Promise<ArrayBuffer>;
  /** Creates (with parent folders) or overwrites. */
  write(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** What the engine persists between sessions. */
export interface SyncState {
  /** Server data the records refer to (see FileListResponse.instanceId). */
  instanceId: string;
  records: Record<string, SyncRecord>;
}

export interface EngineOptions {
  api: ApiClient;
  vault: VaultIO;
  /** This device's id for the current login session (server-issued). */
  clientId(): string;
  initialState: SyncState;
  saveState(state: SyncState): void;
  isExcluded(path: string): boolean;
  notify(message: string): void;
  log?(message: string, error?: unknown): void;
}

/**
 * A full sync that would delete more than this many files on the server (and more than
 * MASS_DELETE_RATIO of the tracked files) restores them instead: far more likely a broken
 * local state (copied settings, a vault restored from backup) than a real clean-up.
 */
const MASS_DELETE_MIN = 10;
const MASS_DELETE_RATIO = 0.2;

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function conflictPath(path: string, date: Date, exists: (candidate: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  for (let i = 1; ; i++) {
    const candidate = `${dir}${base} (conflitto ${stamp}${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

function isValidPath(path: string): boolean {
  try {
    return normalizeVaultPath(path) === path;
  } catch {
    return false;
  }
}

type LockResult = "held" | "offline" | { lockedBy: LockInfo };

/**
 * Keeps the local vault and the server in sync.
 *
 * Every operation on a path runs in that path's queue, so local events, server events and
 * full syncs never interleave on the same file. A record is only written after the local
 * vault really matches it; the vault events caused by the engine's own writes run later in
 * the same queue and are recognised by their hash, so they are not uploaded again.
 */
export class SyncEngine {
  private readonly state: Map<string, SyncRecord>;
  private instanceId: string;
  private readonly locks = new Map<string, LockInfo>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lockListeners = new Set<() => void>();
  private fullSyncRunning: Promise<void> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: EngineOptions) {
    this.state = new Map(Object.entries(options.initialState.records));
    this.instanceId = options.initialState.instanceId;
  }

  private get clientId(): string {
    return this.options.clientId();
  }

  // ---------- state ----------

  snapshot(): SyncState {
    return { instanceId: this.instanceId, records: Object.fromEntries(this.state) };
  }

  record(path: string): SyncRecord | undefined {
    return this.state.get(path);
  }

  /** Waits until every queued operation has finished. */
  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.fullSyncRunning) {
      await Promise.all([...this.queues.values(), this.fullSyncRunning?.catch(() => {})]);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.flushState();
    this.stopped = true;
  }

  flushState(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.stopped) this.options.saveState(this.snapshot());
  }

  private setRecord(path: string, record: SyncRecord | undefined): void {
    if (record) this.state.set(path, record);
    else this.state.delete(path);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushState(), 1000);
  }

  private recordFromMeta(meta: FileMeta, stat: LocalStat | null): SyncRecord {
    return { version: meta.version, hash: meta.hash, mtime: stat?.mtime ?? 0, size: stat?.size ?? meta.size };
  }

  /** Records under `folder/` (for folder deletes and renames). */
  trackedUnder(folder: string): string[] {
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    return [...this.state.keys()].filter((p) => p.startsWith(prefix));
  }

  /**
   * Forgets records of excluded paths. Must run when exclusions change: otherwise deleting an
   * excluded folder locally and later re-including it would delete it on the server.
   */
  forgetExcluded(): void {
    for (const path of [...this.state.keys()]) {
      if (this.options.isExcluded(path)) this.setRecord(path, undefined);
    }
  }

  // ---------- locks ----------

  onLocksChanged(listener: () => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  lockOf(path: string): LockInfo | undefined {
    return this.locks.get(path);
  }

  lockedByOther(path: string): LockInfo | undefined {
    const lock = this.locks.get(path);
    return lock && lock.clientId !== this.clientId ? lock : undefined;
  }

  heldLocks(): string[] {
    return [...this.locks.values()].filter((l) => l.clientId === this.clientId).map((l) => l.path);
  }

  allLocks(): LockInfo[] {
    return [...this.locks.values()];
  }

  /** Forget lock state, e.g. while offline (it may be stale). */
  clearLocks(): void {
    this.locks.clear();
    this.emitLocks();
  }

  async acquireLock(path: string): Promise<LockResult> {
    const other = this.lockedByOther(path);
    if (other) return { lockedBy: other };
    if (this.locks.has(path)) return "held";
    try {
      const lock = await this.options.api.acquireLock(path);
      this.locks.set(path, lock);
      this.emitLocks();
      return "held";
    } catch (err) {
      if (err instanceof ApiError && err.status === 423 && err.body.lock) {
        this.locks.set(path, err.body.lock);
        this.emitLocks();
        return { lockedBy: err.body.lock };
      }
      if (err instanceof OfflineError) return "offline";
      throw err;
    }
  }

  /** Waits for pending work on the file (so the last edit is uploaded), then releases our lock. */
  async releaseLock(path: string): Promise<void> {
    await this.queues.get(path);
    const lock = this.locks.get(path);
    if (!lock || lock.clientId !== this.clientId) return;
    this.locks.delete(path);
    this.emitLocks();
    try {
      await this.options.api.releaseLock(path);
    } catch (err) {
      // Offline: the server lets the lock expire on its own.
      if (!(err instanceof OfflineError)) this.log(`release lock ${path}`, err);
    }
  }

  private emitLocks(): void {
    for (const listener of this.lockListeners) listener();
  }

  // ---------- server events ----------

  handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "ready":
        this.locks.clear();
        for (const lock of event.locks) this.locks.set(lock.path, lock);
        this.emitLocks();
        return;
      case "lock.acquired":
        this.locks.set(event.lock.path, event.lock);
        this.emitLocks();
        return;
      case "lock.released":
        // Through the queue: the file change that preceded the release must be applied before
        // the note becomes editable again.
        void this.enqueue([event.path], async () => {
          if (this.locks.get(event.path)?.clientId === event.clientId) {
            this.locks.delete(event.path);
            this.emitLocks();
          }
        });
        return;
      case "file.changed":
        if (event.clientId === this.clientId || !this.acceptRemote(event.file.path)) return;
        void this.enqueue([event.file.path], () => this.applyRemoteChange(event.file));
        return;
      case "file.deleted":
        if (event.clientId === this.clientId || !this.acceptRemote(event.file.path)) return;
        void this.enqueue([event.file.path], () => this.applyRemoteDelete(event.file));
        return;
      case "file.renamed": {
        if (event.clientId === this.clientId) return;
        const fromOk = this.acceptRemote(event.from.path);
        const toOk = this.acceptRemote(event.file.path);
        if (fromOk && toOk) {
          void this.enqueue([event.from.path, event.file.path], () => this.applyRemoteRename(event.from, event.file));
        } else if (fromOk) {
          void this.enqueue([event.from.path], () => this.applyRemoteDelete(event.from));
        } else if (toOk) {
          void this.enqueue([event.file.path], () => this.applyRemoteChange(event.file));
        }
        return;
      }
      case "error":
        this.log(`server: ${event.message}`);
        return;
    }
  }

  /** Paths from the server are validated again: never write outside the vault or into hidden folders. */
  private acceptRemote(path: string): boolean {
    if (!isValidPath(path)) {
      this.log(`ignoring invalid path from server: ${JSON.stringify(path)}`);
      return false;
    }
    return !this.options.isExcluded(path);
  }

  private async applyRemoteChange(meta: FileMeta): Promise<void> {
    const record = this.state.get(meta.path);
    if (record && record.version >= meta.version) return;
    const stat = await this.options.vault.stat(meta.path);
    if (stat) {
      const localHash = await this.localHash(meta.path, stat, record);
      if (localHash === meta.hash) {
        this.setRecord(meta.path, this.recordFromMeta(meta, stat));
        return;
      }
      if (!record || localHash !== record.hash) {
        // Unsynced local edits: keep them next to the server version.
        await this.keepLocalAsConflict(meta.path, `"${meta.path}" è stata modificata da ${meta.updatedBy}`);
        return;
      }
    }
    await this.download(meta.path);
  }

  private async applyRemoteDelete(meta: FileMeta): Promise<void> {
    const record = this.state.get(meta.path);
    const stat = await this.options.vault.stat(meta.path);
    if (!stat) {
      this.setRecord(meta.path, undefined);
      return;
    }
    const localHash = await this.localHash(meta.path, stat, record);
    if (record && localHash === record.hash) {
      await this.options.vault.remove(meta.path);
      this.setRecord(meta.path, undefined);
    } else {
      // Edited here but deleted on the server: the edits win, the file comes back.
      this.setRecord(meta.path, undefined);
      await this.push(meta.path);
    }
  }

  private async applyRemoteRename(from: FileMeta, to: FileMeta): Promise<void> {
    const { vault } = this.options;
    const record = this.state.get(from.path);
    const fromStat = await vault.stat(from.path);
    const canMove =
      record &&
      fromStat &&
      record.hash === to.hash &&
      !(await vault.stat(to.path)) &&
      (await this.localHash(from.path, fromStat, record)) === record.hash;
    if (!canMove) {
      await this.applyRemoteDelete(from);
      await this.applyRemoteChange(to);
      return;
    }
    await vault.rename(from.path, to.path);
    this.setRecord(from.path, undefined);
    this.setRecord(to.path, { ...record, version: to.version });
  }

  // ---------- local events ----------

  onLocalChange(path: string): void {
    if (this.options.isExcluded(path)) return;
    void this.enqueue([path], () => this.push(path));
  }

  onLocalDelete(path: string): void {
    if (this.options.isExcluded(path)) return;
    void this.enqueue([path], () => this.deleteRemote(path));
  }

  onLocalRename(from: string, to: string): void {
    const fromExcluded = this.options.isExcluded(from);
    const toExcluded = this.options.isExcluded(to);
    if (fromExcluded && toExcluded) return;
    if (fromExcluded) return this.onLocalChange(to);
    if (toExcluded) return this.onLocalDelete(from);
    void this.enqueue([from, to], () => this.renameRemote(from, to));
  }

  private async push(path: string): Promise<void> {
    const { vault, api } = this.options;
    const stat = await vault.stat(path);
    if (!stat) return;
    const data = await vault.read(path);
    const hash = await sha256Hex(data);
    const record = this.state.get(path);
    if (record?.hash === hash) {
      // Our own write coming back, or a save without changes.
      if (record.mtime !== stat.mtime || record.size !== stat.size) this.setRecord(path, { ...record, mtime: stat.mtime, size: stat.size });
      return;
    }
    const lock = this.lockedByOther(path);
    if (lock) {
      await this.keepLocalAsConflict(path, `${lock.username} sta modificando "${path}"`, data);
      return;
    }
    let baseVersion = record?.version ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const meta = await api.upload(path, data, baseVersion);
        this.setRecord(path, this.recordFromMeta(meta, stat));
        return;
      } catch (err) {
        if (err instanceof OfflineError) return; // The next full sync uploads it.
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 423) {
          await this.keepLocalAsConflict(path, `${err.body.lock?.username ?? "Un altro utente"} sta modificando "${path}"`, data);
          return;
        }
        if (err.status === 409 && err.body.error === "version_conflict") {
          const current = err.body.current;
          if (current && !current.deleted && current.hash === hash) {
            this.setRecord(path, this.recordFromMeta(current, stat));
            return;
          }
          if ((!current || current.deleted) && attempt === 0) {
            // Re-creating a file deleted on the server: our content wins.
            baseVersion = current?.version ?? 0;
            continue;
          }
          await this.keepLocalAsConflict(path, `"${path}" è stata modificata da ${current?.updatedBy ?? "un altro utente"}`, data);
          return;
        }
        this.options.notify(`Impossibile sincronizzare "${path}": ${err.message}`);
        return;
      }
    }
  }

  private async deleteRemote(path: string): Promise<void> {
    const record = this.state.get(path);
    if (!record) return;
    // A stale event: the file is back (e.g. restored) and will sync as a change.
    if (await this.options.vault.stat(path)) return;
    const lock = this.lockedByOther(path);
    if (lock) {
      this.options.notify(`${lock.username} sta modificando "${path}": la nota è stata ripristinata.`);
      await this.download(path);
      return;
    }
    try {
      await this.options.api.delete(path, record.version);
      this.setRecord(path, undefined);
    } catch (err) {
      if (err instanceof OfflineError) return;
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 404 || (err.status === 409 && err.body.current?.deleted)) {
        this.setRecord(path, undefined);
        return;
      }
      if (err.status === 409 || err.status === 423) {
        const who = err.body.lock?.username ?? err.body.current?.updatedBy ?? "un altro utente";
        this.options.notify(`"${path}" è stata modificata da ${who} nel frattempo: è stata ripristinata.`);
        await this.download(path);
        return;
      }
      this.options.notify(`Impossibile eliminare "${path}" sul server: ${err.message}`);
    }
  }

  private async renameRemote(from: string, to: string): Promise<void> {
    const record = this.state.get(from);
    // Untracked source, or our own rename coming back: just sync the new path.
    if (!record || this.lockedByOther(from)) {
      await this.push(to);
      await this.deleteRemote(from);
      return;
    }
    try {
      const result = await this.options.api.rename(from, to, record.version);
      this.setRecord(from, undefined);
      // The server has the content as of the last upload. mtime 0 forces push() to hash the
      // local file, so an edit saved just before the rename is uploaded rather than trusted away.
      this.setRecord(to, { ...this.recordFromMeta(result.file, null), mtime: 0 });
      const lock = this.locks.get(from);
      if (lock?.clientId === this.clientId) {
        this.locks.delete(from);
        this.locks.set(to, { ...lock, path: to });
        this.emitLocks();
      }
    } catch (err) {
      if (err instanceof OfflineError) return; // Full sync sees a delete + a new file.
      if (!(err instanceof ApiError)) throw err;
      // Server state moved on: upload the new path as a file of its own, then handle the old one.
      await this.push(to);
      await this.deleteRemote(from);
      return;
    }
    await this.push(to);
  }

  // ---------- full sync ----------

  /** Compares the whole vault with the server and fixes every difference. */
  fullSync(): Promise<void> {
    this.fullSyncRunning ??= this.runFullSync().finally(() => {
      this.fullSyncRunning = undefined;
    });
    return this.fullSyncRunning;
  }

  private async runFullSync(): Promise<void> {
    const { api, vault, isExcluded } = this.options;
    const listing = await api.listFiles();
    if (listing.instanceId !== this.instanceId) {
      // A different (or reset) server: our records describe something else. Start over;
      // with no records nothing gets deleted, differences become downloads or conflict copies.
      if (this.instanceId) this.log(`server instance changed (${this.instanceId} -> ${listing.instanceId}): resetting sync state`);
      this.state.clear();
      this.instanceId = listing.instanceId;
      this.flushState();
    }
    this.forgetExcluded();
    this.locks.clear();
    for (const lock of listing.locks) this.locks.set(lock.path, lock);
    this.emitLocks();

    const remote = new Map(listing.files.filter((f) => isValidPath(f.path)).map((f) => [f.path, f]));
    const localPaths = new Set((await vault.list()).map((s) => s.path));
    const paths = new Set([...remote.keys(), ...localPaths, ...this.state.keys()]);
    const work = [...paths].filter((p) => !isExcluded(p));

    // Files that would be deleted on the server because they are missing here.
    const missing = work.filter((p) => !localPaths.has(p) && this.state.has(p) && remote.get(p)?.deleted === false);
    const allowRemoteDeletes = missing.length < Math.max(MASS_DELETE_MIN, this.state.size * MASS_DELETE_RATIO);
    if (!allowRemoteDeletes) {
      this.options.notify(
        `${missing.length} file presenti sul server mancano in questo vault: sono stati riscaricati invece di eliminarli per tutti. ` +
          "Se volevi davvero eliminarli, eliminali di nuovo ora.",
      );
    }

    // A few files at a time: enough to be quick, without flooding the server.
    let next = 0;
    const worker = async () => {
      while (next < work.length && !this.stopped) {
        const path = work[next++]!;
        await this.enqueue([path], () => this.reconcile(path, remote.get(path), allowRemoteDeletes));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  private async reconcile(path: string, remote: FileMeta | undefined, allowRemoteDeletes: boolean): Promise<void> {
    const record = this.state.get(path);
    // The listing is older than what a live event already told us: nothing to decide from it.
    if (record && remote && record.version > remote.version) return;
    // Stat now rather than trusting the listing: the file may have changed meanwhile.
    const stat = await this.options.vault.stat(path);
    const localHash = stat ? await this.localHash(path, stat, record) : null;
    switch (decide(localHash, record, remote)) {
      case "none":
        return;
      case "adopt":
        this.setRecord(path, this.recordFromMeta(remote!, stat));
        return;
      case "upload":
        await this.push(path);
        return;
      case "download":
        await this.download(path);
        return;
      case "conflict":
        await this.keepLocalAsConflict(path, `"${path}" è stata modificata sia qui sia da ${remote?.updatedBy ?? "un altro utente"}`);
        return;
      case "deleteLocal":
        await this.options.vault.remove(path);
        this.setRecord(path, undefined);
        return;
      case "deleteRemote":
        if (allowRemoteDeletes) await this.deleteRemote(path);
        else await this.download(path);
        return;
      case "forget":
        this.setRecord(path, undefined);
        return;
    }
  }

  // ---------- helpers ----------

  /** Fetches the server version and writes it locally; the record is updated only once the write succeeded. */
  private async download(path: string): Promise<void> {
    const { api, vault } = this.options;
    let file;
    try {
      file = await api.download(path);
    } catch (err) {
      if (err instanceof OfflineError) return;
      if (err instanceof ApiError && err.status === 404) return;
      throw err;
    }
    try {
      await vault.write(path, file.data);
    } catch (err) {
      this.options.notify(`Impossibile salvare "${path}" su questo dispositivo: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const stat = await vault.stat(path);
    this.setRecord(path, { version: file.version, hash: file.hash, mtime: stat?.mtime ?? 0, size: stat?.size ?? file.data.byteLength });
  }

  /** Saves the local content as a conflict copy (uploaded as a new file), then takes the server version. */
  private async keepLocalAsConflict(path: string, reason: string, data?: ArrayBuffer): Promise<void> {
    const { vault } = this.options;
    const content = data ?? (await vault.read(path));
    const existing = new Set((await vault.list()).map((s) => s.path));
    const copy = conflictPath(path, new Date(), (candidate) => existing.has(candidate) || this.state.has(candidate));
    await vault.write(copy, content);
    this.onLocalChange(copy);
    await this.download(path);
    this.options.notify(`${reason}. Le tue modifiche sono in "${copy}".`);
  }

  private async localHash(path: string, stat: LocalStat, record: SyncRecord | undefined): Promise<string> {
    if (record && record.mtime === stat.mtime && record.size === stat.size && record.mtime !== 0) return record.hash;
    return sha256Hex(await this.options.vault.read(path));
  }

  private enqueue(paths: string[], task: () => Promise<void>): Promise<void> {
    const previous = paths.map((p) => this.queues.get(p) ?? Promise.resolve());
    const run = Promise.all(previous)
      .then(() => (this.stopped ? undefined : task()))
      .catch((err) => this.log(`sync ${paths.join(" -> ")}`, err));
    for (const path of paths) this.queues.set(path, run);
    void run.then(() => {
      for (const path of paths) if (this.queues.get(path) === run) this.queues.delete(path);
    });
    return run;
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? console.error)(`[team-sync] ${message}`, error);
  }
}
