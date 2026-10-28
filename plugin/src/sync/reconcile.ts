import type { FileMeta } from "@team-sync/shared";

/** What we knew about a file the last time it was in sync with the server. */
export interface SyncRecord {
  version: number;
  hash: string;
  /** Local stat at sync time: lets us skip re-hashing unchanged files. */
  mtime: number;
  size: number;
}

export type Action =
  | "none"
  /** Same content on both sides: just record the server version. */
  | "adopt"
  | "upload"
  | "download"
  /** Changed on both sides: keep the local copy as a conflict file, take the server version. */
  | "conflict"
  | "deleteLocal"
  | "deleteRemote"
  /** Gone on both sides: drop the record. */
  | "forget";

/**
 * Three-way decision for one path, from the local content hash (null = no local file),
 * the last synced record and the server state (tombstones included).
 */
export function decide(localHash: string | null, record: SyncRecord | undefined, remote: FileMeta | undefined): Action {
  const remoteLive = remote && !remote.deleted ? remote : undefined;

  if (localHash === null) {
    if (!record) return remoteLive ? "download" : "none";
    if (!remoteLive) return "forget";
    // We deleted it locally. If nobody touched it on the server since, delete it there too;
    // otherwise someone else's newer edit wins and comes back.
    return remoteLive.version === record.version ? "deleteRemote" : "download";
  }

  const localChanged = !record || localHash !== record.hash;

  if (!remoteLive) {
    if (!remote) return "upload";
    // Deleted on the server. Keep local edits (they win over a deletion), otherwise follow the deletion.
    return localChanged ? "upload" : "deleteLocal";
  }

  if (localHash === remoteLive.hash) return record?.version === remoteLive.version && record.hash === localHash ? "none" : "adopt";

  const remoteChanged = !record || record.version !== remoteLive.version;
  if (!remoteChanged) return localChanged ? "upload" : "none";
  return localChanged ? "conflict" : "download";
}
