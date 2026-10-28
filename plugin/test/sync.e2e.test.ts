import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "../../server/test/helpers";
import { ApiClient, type Http } from "../src/api";
import { Realtime, type ConnectionStatus } from "../src/realtime";
import { SyncEngine, type SyncState } from "../src/sync/engine";
import { MemoryVault } from "./memoryVault";


/** One device running the plugin's sync code against the real server. */
class Device {
  readonly vault = new MemoryVault();
  readonly api: ApiClient;
  readonly engine: SyncEngine;
  readonly realtime: Realtime;
  readonly notices: string[] = [];
  status: ConnectionStatus = "offline";
  token = "";
  clientId = "";
  excluded: string[] = [".obsidian/"];
  /** Simulates a lost network: every HTTP request fails like requestUrl would. */
  networkDown = false;

  constructor(url: string, initialState: SyncState = { instanceId: "", records: {} }) {
    const http: Http = async ({ url, method, headers, body }) => {
      if (this.networkDown) throw new Error("net::ERR_INTERNET_DISCONNECTED");
      const res = await fetch(url, { method, headers, body });
      return { status: res.status, headers: Object.fromEntries(res.headers), arrayBuffer: await res.arrayBuffer() };
    };
    this.api = new ApiClient({ http, serverUrl: () => url, token: () => this.token });
    this.engine = new SyncEngine({
      api: this.api,
      vault: this.vault,
      clientId: () => this.clientId,
      initialState,
      saveState: () => {},
      isExcluded: (path) => this.excluded.some((prefix) => path.startsWith(prefix)),
      notify: (message) => this.notices.push(message),
      log: (message, error) => {
        throw new Error(`${message}: ${String(error)}`);
      },
    });
    this.vault.engine = this.engine;
    this.realtime = new Realtime({
      serverUrl: () => url,
      token: () => this.token,
      onEvent: (event) => this.engine.handleServerEvent(event),
      onStatus: (status) => {
        this.status = status;
        if (status !== "online") this.engine.clearLocks();
      },
    });
  }

  async start(username: string, password: string): Promise<void> {
    const session = await this.api.login(username, password);
    this.token = session.token;
    this.clientId = session.clientId;
    this.realtime.start();
    await waitFor(() => this.status === "online");
    await this.engine.fullSync();
  }

  stop(): void {
    this.realtime.stop();
    this.engine.stop();
  }
}

async function waitFor(condition: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

let server: TestServer;
let alice: Device;
let bob: Device;

async function settle(...devices: Device[]): Promise<void> {
  // Let WebSocket events arrive, then let every queue drain.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 60));
    await Promise.all(devices.map((d) => d.engine.idle()));
  }
}

beforeEach(async () => {
  server = await startServer();
  alice = new Device(server.url);
  bob = new Device(server.url);
  await alice.start("alice", "alice-password");
  await bob.start("bob", "bob-password");
});

afterEach(async () => {
  alice.stop();
  bob.stop();
  await server.close();
});

describe("two devices", () => {
  it("propagates creates, edits, renames and deletes", async () => {
    await alice.vault.edit("Projects/plan.md", "# Plan");
    await waitFor(() => bob.vault.text("Projects/plan.md") === "# Plan", "create on bob");

    await bob.vault.edit("Projects/plan.md", "# Plan\n- step 1");
    await waitFor(() => alice.vault.text("Projects/plan.md") === "# Plan\n- step 1", "edit on alice");

    await alice.vault.rename("Projects/plan.md", "Archive/plan.md");
    await waitFor(() => bob.vault.text("Archive/plan.md") === "# Plan\n- step 1", "rename on bob");
    expect(bob.vault.files.has("Projects/plan.md")).toBe(false);

    await bob.vault.remove("Archive/plan.md");
    await waitFor(() => !alice.vault.files.has("Archive/plan.md"), "delete on alice");
    await settle(alice, bob);
    expect(server.app.files.get("Archive/plan.md")?.deleted).toBe(true);
    expect(alice.notices).toEqual([]);
    expect(bob.notices).toEqual([]);
  });

  it("syncs binary attachments", async () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 7) % 256);
    await alice.vault.write("img/photo.png", bytes.buffer);
    await waitFor(() => bob.vault.files.has("img/photo.png"));
    expect(bob.vault.files.get("img/photo.png")!.data).toEqual(bytes);
  });

  it("shows the lock to others and keeps their edits as a conflict copy", async () => {
    await alice.vault.edit("note.md", "v1");
    await waitFor(() => bob.vault.text("note.md") === "v1");

    expect(await alice.engine.acquireLock("note.md")).toBe("held");
    await waitFor(() => bob.engine.lockedByOther("note.md")?.username === "alice", "lock visible to bob");
    expect(await bob.engine.acquireLock("note.md")).toEqual({ lockedBy: expect.objectContaining({ username: "alice" }) });

    // Bob changes the file anyway (e.g. from another plugin): his text is kept aside.
    await bob.vault.edit("note.md", "bob was here");
    await settle(alice, bob);
    expect(bob.vault.text("note.md")).toBe("v1");
    const copy = [...bob.vault.files.keys()].find((p) => p.startsWith("note (conflitto"));
    expect(copy).toBeDefined();
    expect(bob.vault.text(copy!)).toBe("bob was here");
    expect(bob.notices[0]).toContain("alice sta modificando");
    // The conflict copy is shared with the team.
    await waitFor(() => alice.vault.text(copy!) === "bob was here", "conflict copy on alice");

    // Alice keeps editing, then releases: bob gets her version and can lock.
    await alice.vault.edit("note.md", "v2 by alice");
    await alice.engine.releaseLock("note.md");
    await waitFor(() => bob.vault.text("note.md") === "v2 by alice", "alice edit on bob");
    await waitFor(() => bob.engine.lockOf("note.md") === undefined, "lock released on bob");
    expect(await bob.engine.acquireLock("note.md")).toBe("held");
  });

  it("moves the lock with a renamed file", async () => {
    await alice.vault.edit("a.md", "x");
    await waitFor(() => bob.vault.files.has("a.md"));
    await alice.engine.acquireLock("a.md");
    await alice.vault.rename("a.md", "b.md");
    await waitFor(() => bob.vault.files.has("b.md") && bob.engine.lockedByOther("b.md") !== undefined, "lock moved");
    expect(alice.engine.heldLocks()).toEqual(["b.md"]);
  });

  it("resolves offline edits on reconnect", async () => {
    await alice.vault.edit("shared.md", "base");
    await alice.vault.edit("bob-only.md", "base");
    await alice.vault.edit("to-delete.md", "bye");
    await waitFor(() => bob.vault.files.size === 3);

    bob.realtime.stop();
    bob.networkDown = true;
    await bob.vault.edit("shared.md", "bob offline");
    await bob.vault.edit("bob-only.md", "bob offline");
    await bob.vault.remove("to-delete.md");
    await bob.vault.edit("new-offline.md", "created offline");
    await alice.vault.edit("shared.md", "alice online");
    await settle(alice);

    await settle(bob);
    expect(bob.notices).toEqual([]);
    expect(alice.vault.text("bob-only.md")).toBe("base");

    // Back online.
    bob.networkDown = false;
    bob.realtime.start();
    await waitFor(() => bob.status === "online");
    await bob.engine.fullSync();
    await settle(alice, bob);

    expect(bob.vault.text("shared.md")).toBe("alice online");
    const copy = [...bob.vault.files.keys()].find((p) => p.startsWith("shared (conflitto"));
    expect(copy && bob.vault.text(copy)).toBe("bob offline");
    expect(alice.vault.text("bob-only.md")).toBe("bob offline");
    expect(alice.vault.text("new-offline.md")).toBe("created offline");
    expect(alice.vault.files.has("to-delete.md")).toBe(false);
  });

  it("brings a new device up to date", async () => {
    await alice.vault.edit("one.md", "1");
    await alice.vault.edit("deep/two.md", "2");
    await settle(alice, bob);
    const carol = new Device(server.url);
    try {
      await carol.start("bob", "bob-password");
      await settle(carol);
      expect(carol.vault.text("one.md")).toBe("1");
      expect(carol.vault.text("deep/two.md")).toBe("2");
    } finally {
      carol.stop();
    }
  });

  it("uploads an edit saved right before a rename", async () => {
    await alice.vault.edit("A.md", "v1");
    await waitFor(() => bob.vault.text("A.md") === "v1");
    // Obsidian writes the file, and the rename happens before the debounced change is pushed.
    alice.vault.editSilently("A.md", "v2 typed just before renaming");
    await alice.vault.rename("A.md", "B.md");
    await waitFor(() => bob.vault.text("B.md") === "v2 typed just before renaming", "edit after rename on bob");
    await settle(alice, bob);
    expect(bob.vault.files.has("A.md")).toBe(false);
    expect(server.app.files.get("B.md")?.version).toBe(2);
  });

  it("never deletes on the server a file it failed to write locally", async () => {
    bob.vault.failWrites.add("locked-by-antivirus.md");
    await alice.vault.edit("locked-by-antivirus.md", "precious");
    await settle(alice, bob);
    expect(bob.notices.some((n) => n.includes("Impossibile salvare"))).toBe(true);
    await bob.engine.fullSync();
    await bob.engine.fullSync();
    await settle(alice, bob);
    expect(server.app.files.get("locked-by-antivirus.md")?.deleted).toBe(false);
    expect(alice.vault.text("locked-by-antivirus.md")).toBe("precious");
    // Once writable again, it arrives.
    bob.vault.failWrites.clear();
    await bob.engine.fullSync();
    expect(bob.vault.text("locked-by-antivirus.md")).toBe("precious");
  });

  it("restores instead of mass-deleting when the sync state does not match the vault", async () => {
    for (let i = 0; i < 12; i++) await alice.vault.edit(`notes/n${i}.md`, `note ${i}`);
    await settle(alice, bob);
    // A vault set up by copying .obsidian (and the plugin's state) from Alice's.
    const copy = new Device(server.url, alice.engine.snapshot());
    try {
      await copy.start("bob", "bob-password");
      await settle(copy, alice);
      expect(server.app.files.list().filter((f) => f.deleted)).toEqual([]);
      expect(copy.vault.text("notes/n3.md")).toBe("note 3");
      expect(copy.notices.some((n) => n.includes("12 file"))).toBe(true);
    } finally {
      copy.stop();
    }
  });

  it("does not delete a folder on the server after it was excluded and re-included", async () => {
    await alice.vault.edit("Private/a.md", "a");
    await alice.vault.edit("Private/b.md", "b");
    await settle(alice);
    alice.excluded.push("Private/");
    alice.engine.forgetExcluded();
    alice.vault.removeSilently("Private/a.md");
    alice.vault.removeSilently("Private/b.md");
    alice.excluded.pop();
    alice.engine.forgetExcluded();
    await alice.engine.fullSync();
    await settle(alice);
    expect(server.app.files.get("Private/a.md")?.deleted).toBe(false);
    expect(alice.vault.text("Private/a.md")).toBe("a");
  });

  it("recreates a file deleted on the server when edited locally", async () => {
    await alice.vault.edit("x.md", "v1");
    await waitFor(() => bob.vault.files.has("x.md"));
    await alice.vault.remove("x.md");
    await waitFor(() => !bob.vault.files.has("x.md"));
    await alice.vault.edit("x.md", "back");
    await waitFor(() => bob.vault.text("x.md") === "back", "recreated on bob");
  });
});
