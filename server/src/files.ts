import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathKey, type FileMeta, type FileVersion } from "@team-sync/shared";
import type { Db } from "./db.js";

/** The client's `baseVersion` is not the server's current version: someone changed the file meanwhile. */
export class VersionConflictError extends Error {
  constructor(readonly current: FileMeta | undefined) {
    super("The file was changed on the server");
  }
}

export class NotFoundError extends Error {}

/** Another live file differs from this path only by letter case (would clash on Windows/macOS). */
export class CaseConflictError extends Error {
  constructor(readonly existing: string) {
    super(`"${existing}" already exists with different letter case`);
  }
}

interface FileRow {
  path: string;
  version: number;
  hash: string;
  size: number;
  mtime: number;
  updated_by: string;
  deleted: number;
}

function toMeta(row: FileRow): FileMeta {
  return {
    path: row.path,
    version: row.version,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    updatedBy: row.updated_by,
    deleted: row.deleted === 1,
  };
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Vault storage. Metadata lives in SQLite; contents are stored once per distinct hash
 * under `blobs/`, so renames are cheap and every past version stays readable.
 */
export class FileStore {
  private readonly blobDir: string;
  private readonly pendingBlobs = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.blobDir = path.join(dataDir, "blobs");
  }

  list(): FileMeta[] {
    const rows = this.db.prepare("SELECT * FROM files ORDER BY path").all() as unknown as FileRow[];
    return rows.map(toMeta);
  }

  get(filePath: string): FileMeta | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as FileRow | undefined;
    return row && toMeta(row);
  }

  history(filePath: string): FileVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM file_versions WHERE path = ? ORDER BY version DESC")
      .all(filePath) as unknown as FileRow[];
    return rows.map((row) => {
      const { path: _path, ...meta } = toMeta(row);
      return meta;
    });
  }

  /** Content of the current version, or of a past one. */
  async read(filePath: string, version?: number): Promise<{ meta: FileVersion; data: Buffer }> {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT * FROM files WHERE path = ?").get(filePath)
        : this.db.prepare("SELECT * FROM file_versions WHERE path = ? AND version = ?").get(filePath, version)
    ) as FileRow | undefined;
    if (!row || row.deleted) throw new NotFoundError(`"${filePath}" not found`);
    const { path: _path, ...meta } = toMeta(row);
    return { meta, data: await readFile(this.blobPath(row.hash)) };
  }

  /**
   * Creates or overwrites a file. `baseVersion` is the version the client last saw
   * (0, or the tombstone's version, for a new file). Returns the unchanged meta when
   * the content is identical.
   */
  async write(
    filePath: string,
    data: Buffer,
    baseVersion: number,
    user: string,
    /** Runs right before committing (after the blob is stored), e.g. to re-check locks. */
    beforeCommit: () => void = () => {},
  ): Promise<FileMeta> {
    this.checkBase(filePath, baseVersion);
    const hash = sha256(data);
    const current = this.get(filePath);
    if (current && !current.deleted && current.hash === hash) return current;
    await this.storeBlob(hash, data);
    // Re-check after the await: another request may have committed (or locked) meanwhile.
    this.checkBase(filePath, baseVersion);
    beforeCommit();
    const meta: FileMeta = {
      path: filePath,
      version: (current?.version ?? 0) + 1,
      hash,
      size: data.length,
      mtime: Date.now(),
      updatedBy: user,
      deleted: false,
    };
    this.transaction(() => this.commit(meta));
    return meta;
  }

  delete(filePath: string, baseVersion: number, user: string): FileMeta {
    const current = this.get(filePath);
    if (!current || current.deleted) throw new NotFoundError(`"${filePath}" not found`);
    this.checkBase(filePath, baseVersion);
    const meta = this.tombstone(current, user);
    this.transaction(() => this.commit(meta));
    return meta;
  }

  rename(from: string, to: string, baseVersion: number, user: string): { from: FileMeta; file: FileMeta } {
    const current = this.get(from);
    if (!current || current.deleted) throw new NotFoundError(`"${from}" not found`);
    this.checkBase(from, baseVersion);
    const target = this.get(to);
    if (target && !target.deleted) throw new VersionConflictError(target);
    this.checkCase(to, from);
    const file: FileMeta = {
      ...current,
      path: to,
      version: (target?.version ?? 0) + 1,
      mtime: Date.now(),
      updatedBy: user,
    };
    const tombstone = this.tombstone(current, user);
    this.transaction(() => {
      this.commit(tombstone);
      this.commit(file);
    });
    return { from: tombstone, file };
  }

  private checkBase(filePath: string, baseVersion: number): void {
    const current = this.get(filePath);
    if ((current?.version ?? 0) !== baseVersion) throw new VersionConflictError(current);
    if (!current || current.deleted) this.checkCase(filePath);
  }

  private checkCase(filePath: string, ignore?: string): void {
    const rows = this.db
      .prepare("SELECT path FROM files WHERE path_key = ? AND path != ? AND deleted = 0")
      .all(pathKey(filePath), filePath) as unknown as { path: string }[];
    const clash = rows.find((row) => row.path !== ignore);
    if (clash) throw new CaseConflictError(clash.path);
  }

  private tombstone(current: FileMeta, user: string): FileMeta {
    return { ...current, version: current.version + 1, hash: "", size: 0, mtime: Date.now(), updatedBy: user, deleted: true };
  }

  private commit(meta: FileMeta): void {
    const values = [meta.path, meta.version, meta.hash, meta.size, meta.mtime, meta.updatedBy, meta.deleted ? 1 : 0];
    this.db
      .prepare(
        `INSERT INTO files (path, version, hash, size, mtime, updated_by, deleted, path_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET version = excluded.version, hash = excluded.hash, size = excluded.size,
           mtime = excluded.mtime, updated_by = excluded.updated_by, deleted = excluded.deleted`,
      )
      .run(...values, pathKey(meta.path));
    this.db
      .prepare(
        "INSERT INTO file_versions (path, version, hash, size, mtime, updated_by, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(...values);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private blobPath(hash: string): string {
    return path.join(this.blobDir, hash.slice(0, 2), hash);
  }

  private storeBlob(hash: string, data: Buffer): Promise<void> {
    // Identical content uploaded concurrently (templates, copies) shares one write.
    let pending = this.pendingBlobs.get(hash);
    if (!pending) {
      pending = this.writeBlob(hash, data).finally(() => this.pendingBlobs.delete(hash));
      this.pendingBlobs.set(hash, pending);
    }
    return pending;
  }

  private async writeBlob(hash: string, data: Buffer): Promise<void> {
    const target = this.blobPath(hash);
    if (existsSync(target)) return;
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, data);
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      // On Windows renaming onto an existing (or open) file fails: same hash, same content, fine.
      if (!existsSync(target)) throw err;
    }
  }
}
