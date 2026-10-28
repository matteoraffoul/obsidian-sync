import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { UserInfo } from "@team-sync/shared";
import type { Db } from "./db.js";

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, cost, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(cost) });
  return timingSafeEqual(expected, actual);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "user";
}

export interface Session {
  user: UserInfo;
  clientId: string;
}

function toUserInfo(row: UserRow): UserInfo {
  return { id: row.id, username: row.username, role: row.role };
}

// Used when the username does not exist, so a failed login takes the same time either way.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

export class Users {
  constructor(private readonly db: Db) {}

  create(username: string, password: string, role: "admin" | "user" = "user"): UserInfo {
    if (!/^[\p{L}\p{N}._-]{2,64}$/u.test(username)) {
      throw new Error("Username must be 2-64 letters, digits, '.', '_' or '-'");
    }
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    const result = this.db
      .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
      .run(username, hashPassword(password), role, Date.now());
    return { id: Number(result.lastInsertRowid), username, role };
  }

  setPassword(username: string, password: string): void {
    if (password.length < 8) throw new Error("Password must be at least 8 characters");
    const result = this.db
      .prepare("UPDATE users SET password_hash = ? WHERE username = ?")
      .run(hashPassword(password), username);
    if (result.changes === 0) throw new Error(`User "${username}" not found`);
    // Changing the password logs the user out everywhere.
    this.db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(username);
  }

  remove(username: string): void {
    const result = this.db.prepare("DELETE FROM users WHERE username = ?").run(username);
    if (result.changes === 0) throw new Error(`User "${username}" not found`);
  }

  list(): UserInfo[] {
    const rows = this.db.prepare("SELECT id, username, password_hash, role FROM users ORDER BY username").all();
    return (rows as unknown as UserRow[]).map(toUserInfo);
  }

  /** Returns a new session (token + device id), or null when the credentials are wrong. */
  login(username: string, password: string): Session & { token: string } | null {
    const row = this.db
      .prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) return null;
    const token = randomBytes(32).toString("base64url");
    // Server-issued, so nobody can act under another device's id (and so bypass its locks).
    const clientId = randomBytes(12).toString("base64url");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, client_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), row.id, clientId, now, now);
    return { token, user: toUserInfo(row), clientId };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }

  authenticate(token: unknown): Session | null {
    if (typeof token !== "string" || token.length === 0) return null;
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.password_hash, u.role, s.client_id FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as (UserRow & { client_id: string }) | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
    return { user: toUserInfo(row), clientId: row.client_id };
  }
}
