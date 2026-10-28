import type { FileMeta } from "@team-sync/shared";
import { describe, expect, it } from "vitest";
import { conflictPath } from "../src/sync/engine";
import { decide, type SyncRecord } from "../src/sync/reconcile";

const record = (version: number, hash: string): SyncRecord => ({ version, hash, mtime: 1, size: 1 });
const remote = (version: number, hash: string, deleted = false): FileMeta => ({
  path: "a.md",
  version,
  hash: deleted ? "" : hash,
  size: 1,
  mtime: 1,
  updatedBy: "bob",
  deleted,
});

describe("decide", () => {
  it("does nothing when everything matches", () => {
    expect(decide("h1", record(1, "h1"), remote(1, "h1"))).toBe("none");
    expect(decide(null, undefined, undefined)).toBe("none");
  });

  it("uploads local-only changes and new files", () => {
    expect(decide("h2", record(1, "h1"), remote(1, "h1"))).toBe("upload");
    expect(decide("h1", undefined, undefined)).toBe("upload");
    // Server lost the file (e.g. a fresh server): upload again.
    expect(decide("h1", record(1, "h1"), undefined)).toBe("upload");
  });

  it("downloads server-only changes and new files", () => {
    expect(decide("h1", record(1, "h1"), remote(2, "h2"))).toBe("download");
    expect(decide(null, undefined, remote(1, "h1"))).toBe("download");
  });

  it("flags a conflict when both sides changed", () => {
    expect(decide("local", record(1, "h1"), remote(2, "server"))).toBe("conflict");
    // Same name created on both sides with different content.
    expect(decide("local", undefined, remote(1, "server"))).toBe("conflict");
  });

  it("adopts when both sides already have the same content", () => {
    expect(decide("same", undefined, remote(3, "same"))).toBe("adopt");
    expect(decide("same", record(1, "old"), remote(2, "same"))).toBe("adopt");
  });

  it("propagates deletions unless the other side changed", () => {
    expect(decide(null, record(1, "h1"), remote(1, "h1"))).toBe("deleteRemote");
    expect(decide(null, record(1, "h1"), remote(2, "h2"))).toBe("download");
    expect(decide("h1", record(1, "h1"), remote(2, "", true))).toBe("deleteLocal");
    // Edits win over a remote deletion.
    expect(decide("h2", record(1, "h1"), remote(2, "", true))).toBe("upload");
    expect(decide(null, record(1, "h1"), remote(2, "", true))).toBe("forget");
    expect(decide(null, record(1, "h1"), undefined)).toBe("forget");
  });
});

describe("conflictPath", () => {
  const date = new Date(2026, 9, 26, 9, 5);
  it("keeps folder and extension and avoids existing names", () => {
    expect(conflictPath("Folder/Note.md", date, () => false)).toBe("Folder/Note (conflitto 2026-10-26 0905).md");
    const taken = new Set(["Note (conflitto 2026-10-26 0905).md"]);
    expect(conflictPath("Note.md", date, (p) => taken.has(p))).toBe("Note (conflitto 2026-10-26 0905 2).md");
    expect(conflictPath("README", date, () => false)).toBe("README (conflitto 2026-10-26 0905)");
  });
});
