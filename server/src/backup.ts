import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { backup } from "node:sqlite";
import type { Db } from "./db.js";

/**
 * Consistent snapshot of the server data into `target`, safe while the server is running:
 * the database through SQLite's online backup, the blobs by copying the missing ones
 * (blobs are immutable, so an existing copy is always identical).
 */
export async function backupData(db: Db, dataDir: string, target: string): Promise<{ blobsCopied: number }> {
  await mkdir(target, { recursive: true });
  // Database first: every blob it references was written before its row was committed.
  await backup(db, path.join(target, "team-sync.db"));

  let blobsCopied = 0;
  const source = path.join(dataDir, "blobs");
  const entries = await readdir(source, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
    const from = path.join(entry.parentPath, entry.name);
    const to = path.join(target, "blobs", path.relative(source, from));
    if (await stat(to).then(() => true, () => false)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    blobsCopied++;
  }
  return { blobsCopied };
}
