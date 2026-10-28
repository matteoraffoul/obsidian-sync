import type { LocalStat, SyncEngine, VaultIO } from "../src/sync/engine";

/**
 * In-memory vault that, like Obsidian, reports every change (including the engine's own
 * writes) back as vault events.
 */
export class MemoryVault implements VaultIO {
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  engine: SyncEngine | undefined;
  /** Paths this "operating system" refuses to write (e.g. names Windows rejects). */
  readonly failWrites = new Set<string>();
  private clock = 1;

  async list(): Promise<LocalStat[]> {
    return [...this.files.keys()].map((path) => this.statSync(path)!);
  }

  async stat(path: string): Promise<LocalStat | null> {
    return this.statSync(path);
  }

  async read(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`not found: ${path}`);
    return file.data.slice().buffer;
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    if (this.failWrites.has(path)) throw new Error(`EPERM: cannot write ${path}`);
    this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: this.clock++ });
    this.engine?.onLocalChange(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.engine?.onLocalDelete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, file);
    this.engine?.onLocalRename(from, to);
  }

  /** What the user typing in Obsidian would do. */
  edit(path: string, text: string): Promise<void> {
    return this.write(path, new TextEncoder().encode(text).buffer);
  }

  /** Changes content without a vault event yet, like Obsidian before its debounced save event fires. */
  editSilently(path: string, text: string): void {
    this.files.set(path, { data: new TextEncoder().encode(text), mtime: this.clock++ });
  }

  /** Deletes without telling the engine (e.g. done while the path was excluded). */
  removeSilently(path: string): void {
    this.files.delete(path);
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file && new TextDecoder().decode(file.data);
  }

  private statSync(path: string): LocalStat | null {
    const file = this.files.get(path);
    return file ? { path, mtime: file.mtime, size: file.data.byteLength } : null;
  }
}
