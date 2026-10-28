import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "team-sync.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );

    -- Current state of every path, tombstones included.
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      -- NFC + lowercase (computed in JS: SQLite's lower() only folds ASCII).
      path_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS files_path_key ON files (path_key);

    -- Every version ever written, so nothing is lost when someone overwrites or deletes a file.
    CREATE TABLE IF NOT EXISTS file_versions (
      path TEXT NOT NULL,
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, version)
    );
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('instance_id', ?)").run(randomUUID());
  return db;
}

/** Random id created with the database: lets clients notice the server was reset. */
export function instanceId(db: Db): string {
  return (db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string }).value;
}
