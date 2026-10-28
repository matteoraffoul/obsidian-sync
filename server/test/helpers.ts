import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoginResponse, ServerEvent } from "@team-sync/shared";
import { createApp, type App } from "../src/app.js";

export interface TestServer {
  app: App;
  url: string;
  close(): Promise<void>;
}

export async function startServer(options: { lockTtlMs?: number } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "team-sync-test-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    lockTtlMs: options.lockTtlMs ?? 60_000,
    maxFileBytes: 10 * 1024 * 1024,
    logLevel: "silent",
  });
  app.users.create("alice", "alice-password", "admin");
  app.users.create("bob", "bob-password");
  const address = await app.server.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    url: address,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal HTTP client for tests, logged in as one user on one device. */
export class TestClient {
  token = "";
  /** Issued by the server at login. */
  clientId = "";

  constructor(private readonly url: string) {}

  async login(username: string, password: string): Promise<void> {
    const res = await fetch(`${this.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status}`);
    const body = (await res.json()) as LoginResponse;
    this.token = body.token;
    this.clientId = body.clientId;
  }

  request(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...extraHeaders };
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      headers["content-type"] = contentType;
      payload = contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit);
    }
    return fetch(`${this.url}${path}`, { method, headers, body: payload });
  }

  put(filePath: string, content: string, baseVersion: number): Promise<Response> {
    const query = new URLSearchParams({ path: filePath, baseVersion: String(baseVersion) });
    return this.request("PUT", `/api/files/content?${query}`, new TextEncoder().encode(content), "application/octet-stream");
  }

  async read(filePath: string): Promise<string> {
    const res = await this.request("GET", `/api/files/content?${new URLSearchParams({ path: filePath })}`);
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    return res.text();
  }

  /** Opens an authenticated WebSocket and collects the events it receives. */
  async connect(): Promise<{ events: ServerEvent[]; next(type: ServerEvent["type"]): Promise<ServerEvent>; close(): void }> {
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/api/ws`);
    const events: ServerEvent[] = [];
    const waiters: Array<() => void> = [];
    ws.addEventListener("message", (msg) => {
      events.push(JSON.parse(String(msg.data)) as ServerEvent);
      waiters.splice(0).forEach((wake) => wake());
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.send(JSON.stringify({ type: "auth", token: this.token }));
    let seen = 0;
    const next = async (type: ServerEvent["type"]): Promise<ServerEvent> => {
      for (;;) {
        while (seen < events.length) {
          const event = events[seen++]!;
          if (event.type === type) return event;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    };
    await next("ready");
    return { events, next, close: () => ws.close() };
  }
}
