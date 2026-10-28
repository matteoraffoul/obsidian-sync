import websocket from "@fastify/websocket";
import {
  InvalidPathError,
  normalizeVaultPath,
  WS_CLOSE_PROTOCOL,
  WS_CLOSE_UNAUTHORIZED,
  type ErrorBody,
  type FileListResponse,
  type LockInfo,
  type LoginResponse,
  type ServerEvent,
  type UserInfo,
} from "@team-sync/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { Users } from "./auth.js";
import type { Config } from "./config.js";
import { instanceId as readInstanceId, openDb, type Db } from "./db.js";
import { CaseConflictError, FileStore, NotFoundError, VersionConflictError } from "./files.js";
import { LockedError, LockManager } from "./locks.js";
import { VERSION } from "./version.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserInfo;
    /** Device id of the session (issued by the server at login, never taken from the client). */
    clientId: string;
  }
}

export interface App {
  server: FastifyInstance;
  dataDir: string;
  db: Db;
  users: Users;
  files: FileStore;
  locks: LockManager;
  close(): Promise<void>;
}

const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/login", "/api/ws"]);
const AUTH_TIMEOUT_MS = 10_000;
const MAX_WS_MESSAGE_BYTES = 4096;

interface Peer {
  socket: WebSocket;
  token: string;
  user: UserInfo;
  clientId: string;
}

class BadRequestError extends Error {}

function parseVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) throw new BadRequestError("baseVersion must be a non-negative integer");
  return version;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

/** Parses a client WebSocket message; anything malformed yields undefined. */
function parseMessage(raw: unknown): { type: string; token?: unknown } | undefined {
  try {
    const message: unknown = JSON.parse(String(raw));
    if (message && typeof message === "object" && typeof (message as { type?: unknown }).type === "string") {
      return message as { type: string; token?: unknown };
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function createApp(config: Config): App {
  const db = openDb(config.dataDir);
  const instanceId = readInstanceId(db);
  const users = new Users(db);
  const files = new FileStore(db, config.dataDir);
  const peers = new Set<Peer>();

  const broadcast = (event: ServerEvent): void => {
    const payload = JSON.stringify(event);
    for (const peer of peers) {
      if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(payload);
    }
  };

  const locks = new LockManager(config.lockTtlMs, {
    acquired: (lock) => broadcast({ type: "lock.acquired", lock }),
    released: (path, clientId) => broadcast({ type: "lock.released", path, clientId }),
  });

  const server = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 1024 * 1024,
  });

  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.maxFileBytes },
    (_request, body, done) => done(null, body),
  );

  server.setErrorHandler((error: Error & { statusCode?: number }, _request, reply: FastifyReply) => {
    const send = (status: number, body: ErrorBody) => reply.status(status).send(body);
    if (error instanceof LockedError) return send(423, { error: "locked", message: error.message, lock: error.lock });
    if (error instanceof VersionConflictError) {
      return send(409, { error: "version_conflict", message: error.message, current: error.current });
    }
    if (error instanceof CaseConflictError) return send(409, { error: "case_conflict", message: error.message });
    if (error instanceof NotFoundError) return send(404, { error: "not_found", message: error.message });
    if (error instanceof InvalidPathError || error instanceof BadRequestError) {
      return send(400, { error: "bad_request", message: error.message });
    }
    if (error.statusCode && error.statusCode < 500) {
      return send(error.statusCode, { error: "bad_request", message: error.message });
    }
    server.log.error(error);
    return send(500, { error: "internal", message: "Internal server error" });
  });

  server.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (PUBLIC_ROUTES.has(url)) return;
    const session = users.authenticate(bearerToken(request));
    if (!session) {
      return reply.status(401).send({ error: "unauthorized", message: "Login required" } satisfies ErrorBody);
    }
    request.user = session.user;
    request.clientId = session.clientId;
  });

  const requireAdmin = (request: FastifyRequest) => {
    if (request.user.role !== "admin") {
      throw Object.assign(new Error("Admin only"), { statusCode: 403 });
    }
  };

  const assertNotLockedByOther = (path: string, clientId: string) => {
    const lock = locks.heldByOther(path, clientId);
    if (lock) throw new LockedError(lock);
  };

  server.register(websocket, { options: { maxPayload: MAX_WS_MESSAGE_BYTES } });

  server.register(async (api) => {
    api.get("/api/health", async () => ({ ok: true, version: VERSION }));

    api.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
      const { username, password } = request.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        throw new BadRequestError("username and password are required");
      }
      const result = users.login(username, password);
      if (!result) {
        return reply.status(401).send({ error: "invalid_credentials", message: "Wrong username or password" });
      }
      return result satisfies LoginResponse;
    });

    api.post("/api/auth/logout", async (request) => {
      const token = bearerToken(request);
      if (token) users.logout(token);
      for (const lock of locks.list()) {
        if (lock.clientId === request.clientId) locks.release(lock.path, request.clientId);
      }
      for (const peer of peers) {
        if (peer.clientId === request.clientId) peer.socket.close(WS_CLOSE_UNAUTHORIZED, "Logged out");
      }
      return { ok: true };
    });

    api.get("/api/me", async (request) => request.user);

    api.get("/api/files", async () => ({ instanceId, files: files.list(), locks: locks.list() }) satisfies FileListResponse);

    api.get<{ Querystring: { path?: string; version?: string } }>("/api/files/content", async (request, reply) => {
      const path = normalizeVaultPath(request.query.path);
      const version = request.query.version === undefined ? undefined : parseVersion(request.query.version);
      const { meta, data } = await files.read(path, version);
      return reply
        .header("content-type", "application/octet-stream")
        .header("x-file-version", String(meta.version))
        .header("x-file-hash", meta.hash)
        .send(data);
    });

    api.get<{ Querystring: { path?: string } }>("/api/files/history", async (request) => {
      const path = normalizeVaultPath(request.query.path);
      return { path, versions: files.history(path) };
    });

    api.put<{ Querystring: { path?: string; baseVersion?: string }; Body: Buffer }>(
      "/api/files/content",
      async (request) => {
        const path = normalizeVaultPath(request.query.path);
        const baseVersion = parseVersion(request.query.baseVersion);
        if (!Buffer.isBuffer(request.body)) throw new BadRequestError("Body must be application/octet-stream");
        assertNotLockedByOther(path, request.clientId);
        const meta = await files.write(path, request.body, baseVersion, request.user.username, () =>
          // Someone may have taken the lock while the content was being stored.
          assertNotLockedByOther(path, request.clientId),
        );
        if (meta.version !== baseVersion) {
          broadcast({ type: "file.changed", file: meta, clientId: request.clientId });
        }
        return meta;
      },
    );

    api.delete<{ Querystring: { path?: string; baseVersion?: string } }>("/api/files", async (request) => {
      const path = normalizeVaultPath(request.query.path);
      const baseVersion = parseVersion(request.query.baseVersion);
      assertNotLockedByOther(path, request.clientId);
      const meta = files.delete(path, baseVersion, request.user.username);
      // File event first, then the lock change, so clients see them in a meaningful order.
      broadcast({ type: "file.deleted", file: meta, clientId: request.clientId });
      locks.release(path, request.clientId);
      return meta;
    });

    api.post<{ Body: { from?: string; to?: string; baseVersion?: number } }>(
      "/api/files/rename",
      async (request) => {
        const from = normalizeVaultPath(request.body?.from);
        const to = normalizeVaultPath(request.body?.to);
        const baseVersion = parseVersion(request.body?.baseVersion);
        assertNotLockedByOther(from, request.clientId);
        assertNotLockedByOther(to, request.clientId);
        const result = files.rename(from, to, baseVersion, request.user.username);
        broadcast({ type: "file.renamed", from: result.from, file: result.file, clientId: request.clientId });
        locks.move(from, to);
        return result;
      },
    );

    api.get("/api/locks", async () => locks.list());

    api.post<{ Body: { path?: string } }>("/api/locks", async (request) => {
      const path = normalizeVaultPath(request.body?.path);
      return locks.acquire(path, request.user, request.clientId) satisfies LockInfo;
    });

    api.delete<{ Querystring: { path?: string } }>("/api/locks", async (request) => {
      const path = normalizeVaultPath(request.query.path);
      return { released: locks.release(path, request.clientId) };
    });

    api.post<{ Body: { path?: string } }>("/api/locks/force-release", async (request) => {
      requireAdmin(request);
      const path = normalizeVaultPath(request.body?.path);
      return { released: locks.release(path, request.clientId, true) };
    });

    // Real-time channel. The first message must authenticate; tokens never go in the URL.
    api.get("/api/ws", { websocket: true }, (socket) => {
      let peer: Peer | undefined;
      const authTimer = setTimeout(() => socket.close(WS_CLOSE_PROTOCOL, "Authentication timeout"), AUTH_TIMEOUT_MS);

      const onMessage = (raw: unknown) => {
        const message = parseMessage(raw);
        if (!message) return socket.close(WS_CLOSE_PROTOCOL, "Malformed message");
        if (!peer) {
          if (message.type !== "auth") return socket.close(WS_CLOSE_PROTOCOL, "Authentication required");
          const session = users.authenticate(message.token);
          if (!session) return socket.close(WS_CLOSE_UNAUTHORIZED, "Invalid token");
          clearTimeout(authTimer);
          peer = { socket, token: message.token as string, ...session };
          peers.add(peer);
          locks.renewClient(peer.clientId);
          const ready: ServerEvent = { type: "ready", user: session.user, instanceId, locks: locks.list() };
          socket.send(JSON.stringify(ready));
          return;
        }
        if (message.type === "heartbeat") {
          // The session may have been revoked (logout, password change, user removed).
          if (!users.authenticate(peer.token)) return socket.close(WS_CLOSE_UNAUTHORIZED, "Session expired");
          locks.renewClient(peer.clientId);
        }
      };

      socket.on("message", (raw) => {
        try {
          onMessage(raw);
        } catch (err) {
          // Never let one bad socket take the server down.
          server.log.error(err);
          socket.close(WS_CLOSE_PROTOCOL, "Internal error");
        }
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        if (peer) peers.delete(peer);
      });
    });
  });

  return {
    server,
    dataDir: config.dataDir,
    db,
    users,
    files,
    locks,
    async close() {
      locks.close();
      await server.close();
      db.close();
    },
  };
}
