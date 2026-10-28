// Protocol shared by the server and the Obsidian plugin.

/** Server-side state of one vault file. Deleted files stay as tombstones so deletions propagate. */
export interface FileMeta {
  path: string;
  /** Increases by one on every change (write, delete, rename). Used for optimistic concurrency. */
  version: number;
  /** Lowercase hex SHA-256 of the content ("" for tombstones). */
  hash: string;
  size: number;
  /** Server time (ms) of the last change. */
  mtime: number;
  updatedBy: string;
  deleted: boolean;
}

export interface FileVersion {
  version: number;
  hash: string;
  size: number;
  mtime: number;
  updatedBy: string;
  deleted: boolean;
}

export interface LockInfo {
  path: string;
  userId: number;
  username: string;
  /** Device (login session) that holds the lock: the same user on two devices still conflicts. */
  clientId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface UserInfo {
  id: number;
  username: string;
  role: "admin" | "user";
}

export interface LoginResponse {
  token: string;
  user: UserInfo;
  /** Issued by the server for this session: identifies the device for locks and echo suppression. */
  clientId: string;
}

export interface FileListResponse {
  /** Changes when the server's data is reset: clients must then forget what they knew. */
  instanceId: string;
  files: FileMeta[];
  locks: LockInfo[];
}

export interface ErrorBody {
  error: string;
  message: string;
  /** Present on version conflicts (409). */
  current?: FileMeta;
  /** Present when the file is locked by someone else (423). */
  lock?: LockInfo;
}

/** Events pushed by the server over the WebSocket. `clientId` is the device that caused the change. */
export type ServerEvent =
  | { type: "ready"; user: UserInfo; instanceId: string; locks: LockInfo[] }
  | { type: "file.changed"; file: FileMeta; clientId: string }
  | { type: "file.deleted"; file: FileMeta; clientId: string }
  | { type: "file.renamed"; from: FileMeta; file: FileMeta; clientId: string }
  | { type: "lock.acquired"; lock: LockInfo }
  | { type: "lock.released"; path: string; clientId: string }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "auth"; token: string }
  /** Renews every lock held by this client. */
  | { type: "heartbeat" };

export const HEARTBEAT_INTERVAL_MS = 20_000;

/** WebSocket close codes. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
export const WS_CLOSE_PROTOCOL = 4000;

export class InvalidPathError extends Error {}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Normalizes a vault-relative path (Unicode NFC, forward slashes) and rejects anything that
 * could escape the vault, reach hidden folders like .obsidian or .git, or that some team
 * member's operating system could not create (Windows forbids <>:"|?*, reserved names and
 * trailing dots/spaces).
 */
export function normalizeVaultPath(input: unknown): string {
  if (typeof input !== "string") throw new InvalidPathError("Path must be a string");
  const path = input.replace(/\\/g, "/").normalize("NFC");
  if (path.length === 0 || path.length > 1024) throw new InvalidPathError("Invalid path length");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"|?*]/.test(path)) {
    throw new InvalidPathError(`Path contains characters not allowed on every system: "${input}"`);
  }
  if (path.startsWith("/")) throw new InvalidPathError("Path must be relative");
  for (const segment of path.split("/")) {
    if (segment === "" || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ")) {
      throw new InvalidPathError(`Invalid path segment in "${input}"`);
    }
    if (WINDOWS_RESERVED.test(segment)) throw new InvalidPathError(`Reserved name in "${input}"`);
  }
  return path;
}

/** Key under which two paths count as the same file on case-insensitive systems. */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
