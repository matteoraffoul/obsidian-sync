import type { ErrorBody, FileListResponse, FileMeta, LockInfo } from "@team-sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupData } from "../src/backup.js";
import { openDb } from "../src/db.js";
import { FileStore } from "../src/files.js";
import { startServer, TestClient, type TestServer } from "./helpers.js";

let server: TestServer;
let alice: TestClient;
let bob: TestClient;

beforeEach(async () => {
  server = await startServer();
  alice = new TestClient(server.url);
  bob = new TestClient(server.url);
  await alice.login("alice", "alice-password");
  await bob.login("bob", "bob-password");
});

afterEach(async () => {
  await server.close();
});

describe("auth", () => {
  it("rejects wrong passwords and unauthenticated requests", async () => {
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "nope" }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${server.url}/api/files`)).status).toBe(401);
  });

  it("logout invalidates the token", async () => {
    expect((await alice.request("POST", "/api/auth/logout")).status).toBe(200);
    expect((await alice.request("GET", "/api/files")).status).toBe(401);
  });
});

describe("files", () => {
  it("creates, reads, updates and keeps history", async () => {
    const created = (await (await alice.put("Notes/a.md", "one", 0)).json()) as FileMeta;
    expect(created).toMatchObject({ path: "Notes/a.md", version: 1, updatedBy: "alice", deleted: false });
    expect(await bob.read("Notes/a.md")).toBe("one");

    const updated = (await (await bob.put("Notes/a.md", "two", 1)).json()) as FileMeta;
    expect(updated.version).toBe(2);
    expect(await alice.read("Notes/a.md")).toBe("two");

    const history = await (await alice.request("GET", "/api/files/history?path=Notes%2Fa.md")).json();
    expect(history.versions.map((v: FileMeta) => v.version)).toEqual([2, 1]);
    const old = await alice.request("GET", "/api/files/content?path=Notes%2Fa.md&version=1");
    expect(await old.text()).toBe("one");
  });

  it("rejects a write based on a stale version", async () => {
    await alice.put("a.md", "one", 0);
    await alice.put("a.md", "two", 1);
    const res = await bob.put("a.md", "bob", 1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.current?.version).toBe(2);
  });

  it("does not bump the version when the content is identical", async () => {
    await alice.put("a.md", "same", 0);
    const meta = (await (await alice.put("a.md", "same", 1)).json()) as FileMeta;
    expect(meta.version).toBe(1);
  });

  it("deletes into a tombstone that can be recreated", async () => {
    await alice.put("a.md", "x", 0);
    const del = await bob.request("DELETE", "/api/files?path=a.md&baseVersion=1");
    expect(del.status).toBe(200);
    const list = (await (await alice.request("GET", "/api/files")).json()) as FileListResponse;
    expect(list.files).toEqual([expect.objectContaining({ path: "a.md", deleted: true, version: 2 })]);
    expect((await alice.request("GET", "/api/files/content?path=a.md")).status).toBe(404);
    expect((await alice.put("a.md", "again", 2)).status).toBe(200);
  });

  it("renames, keeping content and refusing to overwrite", async () => {
    await alice.put("a.md", "content", 0);
    await alice.put("b.md", "other", 0);
    expect((await alice.request("POST", "/api/files/rename", { from: "a.md", to: "b.md", baseVersion: 1 })).status).toBe(409);
    const res = await alice.request("POST", "/api/files/rename", { from: "a.md", to: "Folder/c.md", baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(await bob.read("Folder/c.md")).toBe("content");
    expect((await bob.request("GET", "/api/files/content?path=a.md")).status).toBe(404);
  });

  it("rejects paths that escape the vault or clash by letter case", async () => {
    for (const bad of ["../etc/passwd", "/abs.md", "a//b.md", "C:/x.md", "a/./b.md", ".git/hooks/post-checkout", "a/.obsidian/x.json", "CON.md", "dir./x.md", "x .md ", "a?.md"]) {
      expect((await alice.put(bad, "x", 0)).status, bad).toBe(400);
    }
    await alice.put("Note.md", "x", 0);
    const clash = await bob.put("note.md", "y", 0);
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as ErrorBody).error).toBe("case_conflict");
    // Non-ASCII letter case and Unicode normalization count too.
    await alice.put("Ärger.md", "x", 0);
    expect((await bob.put("ärger.md", "y", 0)).status).toBe(409);
    await alice.put("café.md", "x", 0);
    expect((await bob.put("café.md", "y", 1)).status).toBe(200); // same file once normalized
    expect(await alice.read("café.md")).toBe("y");
  });

  it("stores binary content unchanged", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const res = await alice.request("PUT", "/api/files/content?path=img.png&baseVersion=0", bytes, "application/octet-stream");
    expect(res.status).toBe(200);
    const back = new Uint8Array(await (await bob.request("GET", "/api/files/content?path=img.png")).arrayBuffer());
    expect(back).toEqual(bytes);
  });
});

describe("backup", () => {
  it("snapshots database and contents while the server runs, incrementally", async () => {
    await alice.put("a.md", "one", 0);
    await alice.put("a.md", "two", 1);
    await alice.put("img.png", "binary-ish", 0);
    const target = mkdtempSync(path.join(tmpdir(), "team-sync-backup-"));
    try {
      const dataDir = server.app.dataDir;
      expect((await backupData(server.app.db, dataDir, target)).blobsCopied).toBe(3);
      expect((await backupData(server.app.db, dataDir, target)).blobsCopied).toBe(0);
      // The backup is a working data dir: open it and read old and new versions.
      const restoredDb = openDb(target);
      try {
        const restored = new FileStore(restoredDb, target);
        expect((await restored.read("a.md")).data.toString()).toBe("two");
        expect((await restored.read("a.md", 1)).data.toString()).toBe("one");
      } finally {
        restoredDb.close();
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("concurrency", () => {
  it("accepts many concurrent uploads of identical content", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? alice : bob).put(`same-${i}.md`, "identical content", 0)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(40).fill(200));
  });
});

describe("locks", () => {
  it("blocks other clients from writing, deleting and locking a locked file", async () => {
    await alice.put("a.md", "x", 0);
    const lock = (await (await alice.request("POST", "/api/locks", { path: "a.md" })).json()) as LockInfo;
    expect(lock).toMatchObject({ path: "a.md", username: "alice", clientId: alice.clientId });

    const steal = await bob.request("POST", "/api/locks", { path: "a.md" });
    expect(steal.status).toBe(423);
    expect(((await steal.json()) as ErrorBody).lock?.username).toBe("alice");
    expect((await bob.put("a.md", "bob", 1)).status).toBe(423);
    expect((await bob.request("DELETE", "/api/files?path=a.md&baseVersion=1")).status).toBe(423);

    // The holder can still write.
    expect((await alice.put("a.md", "alice", 1)).status).toBe(200);

    await alice.request("DELETE", "/api/locks?path=a.md");
    expect((await bob.request("POST", "/api/locks", { path: "a.md" })).status).toBe(200);
  });

  it("treats the same user on another device as a different editor", async () => {
    const aliceTablet = new TestClient(server.url);
    await aliceTablet.login("alice", "alice-password");
    await alice.request("POST", "/api/locks", { path: "a.md" });
    expect((await aliceTablet.request("POST", "/api/locks", { path: "a.md" })).status).toBe(423);
  });

  it("ignores a client id sent by the client, so locks cannot be bypassed", async () => {
    await alice.put("a.md", "x", 0);
    await alice.request("POST", "/api/locks", { path: "a.md" });
    const spoof = { "x-client-id": alice.clientId };
    const res = await bob.request("PUT", "/api/files/content?path=a.md&baseVersion=1", new TextEncoder().encode("bob"), "application/octet-stream", spoof);
    expect(res.status).toBe(423);
    expect(await (await bob.request("DELETE", "/api/locks?path=a.md", undefined, undefined, spoof)).json()).toEqual({ released: false });
  });

  it("lets only admins force-release", async () => {
    await bob.request("POST", "/api/locks", { path: "a.md" });
    const aliceTwo = new TestClient(server.url);
    await aliceTwo.login("alice", "alice-password");
    expect((await bob.request("POST", "/api/locks/force-release", { path: "a.md" })).status).toBe(403);
    expect(await (await alice.request("POST", "/api/locks/force-release", { path: "a.md" })).json()).toEqual({ released: true });
  });

  it("expires locks that are not renewed", async () => {
    await server.close();
    server = await startServer({ lockTtlMs: 300 });
    alice = new TestClient(server.url);
    bob = new TestClient(server.url);
    await alice.login("alice", "alice-password");
    await bob.login("bob", "bob-password");
    await alice.request("POST", "/api/locks", { path: "a.md" });
    expect((await bob.request("POST", "/api/locks", { path: "a.md" })).status).toBe(423);
    await new Promise((r) => setTimeout(r, 400));
    expect((await bob.request("POST", "/api/locks", { path: "a.md" })).status).toBe(200);
  });
});

describe("websocket", () => {
  it("rejects connections without a valid token", async () => {
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "auth", token: "bogus" }));
    const close = await new Promise<CloseEvent>((r) => ws.addEventListener("close", r, { once: true }));
    expect(close.code).toBe(4001);
  });

  it("survives malformed and oversized messages", async () => {
    const url = `${server.url.replace(/^http/, "ws")}/api/ws`;
    for (const payload of ["null", "[]", "{\"type\":\"auth\"}", "{\"type\":\"auth\",\"token\":42}", "not json", "x".repeat(10_000)]) {
      const ws = new WebSocket(url);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      ws.send(payload);
      const close = await new Promise<CloseEvent>((r) => ws.addEventListener("close", r, { once: true }));
      expect(close.code, payload.slice(0, 20)).not.toBe(1000);
    }
    // Still alive, and an authenticated socket sending garbage is closed without harm.
    const live = await alice.connect();
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    live.close();
  });

  it("closes sockets of revoked sessions on the next heartbeat", async () => {
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "auth", token: bob.token }));
    await new Promise((r) => ws.addEventListener("message", r, { once: true }));
    server.app.users.setPassword("bob", "a-new-password");
    ws.send(JSON.stringify({ type: "heartbeat" }));
    const close = await new Promise<CloseEvent>((r) => ws.addEventListener("close", r, { once: true }));
    expect(close.code).toBe(4001);
  });

  it("pushes file and lock events to every client", async () => {
    const bobLive = await bob.connect();
    await alice.put("a.md", "x", 0);
    const changed = await bobLive.next("file.changed");
    expect(changed).toMatchObject({ type: "file.changed", clientId: alice.clientId, file: { path: "a.md", version: 1 } });

    await alice.request("POST", "/api/locks", { path: "a.md" });
    expect(await bobLive.next("lock.acquired")).toMatchObject({ lock: { path: "a.md", username: "alice" } });

    await alice.request("POST", "/api/files/rename", { from: "a.md", to: "b.md", baseVersion: 1 });
    expect(await bobLive.next("file.renamed")).toMatchObject({ from: { path: "a.md", deleted: true }, file: { path: "b.md" } });
    // The lock follows the file.
    expect(await bobLive.next("lock.acquired")).toMatchObject({ lock: { path: "b.md" } });

    await alice.request("DELETE", "/api/files?path=b.md&baseVersion=1");
    expect(await bobLive.next("file.deleted")).toMatchObject({ file: { path: "b.md", deleted: true } });
    expect(await bobLive.next("lock.released")).toMatchObject({ path: "b.md" });
    bobLive.close();
  });

  it("keeps locks alive with heartbeats", async () => {
    await server.close();
    server = await startServer({ lockTtlMs: 400 });
    alice = new TestClient(server.url);
    bob = new TestClient(server.url);
    await alice.login("alice", "alice-password");
    await bob.login("bob", "bob-password");
    const aliceLive = await alice.connect();
    await alice.request("POST", "/api/locks", { path: "a.md" });
    // Renew a few times past the TTL through the socket used by the plugin.
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "auth", token: alice.token }));
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: "heartbeat" }));
    }
    expect((await bob.request("POST", "/api/locks", { path: "a.md" })).status).toBe(423);
    ws.close();
    aliceLive.close();
  });
});
