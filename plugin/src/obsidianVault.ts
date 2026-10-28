import { TFile, type App, type TFolder } from "obsidian";
import type { LocalStat, VaultIO } from "./sync/engine";

function toStat(file: TFile): LocalStat {
  return { path: file.path, mtime: file.stat.mtime, size: file.stat.size };
}

/** VaultIO on top of Obsidian's Vault API, so the editor, links and caches stay up to date. */
export class ObsidianVault implements VaultIO {
  constructor(private readonly app: App) {}

  async list(): Promise<LocalStat[]> {
    return this.app.vault.getFiles().map(toStat);
  }

  async stat(path: string): Promise<LocalStat | null> {
    const file = this.app.vault.getFileByPath(path);
    return file ? toStat(file) : null;
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.app.vault.readBinary(this.file(path));
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file) {
      await this.app.vault.modifyBinary(file, data);
      return;
    }
    await this.ensureParent(path);
    await this.app.vault.createBinary(path, data);
  }

  async remove(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    // Honours the user's "deleted files" preference, so a remote delete is recoverable locally.
    if (!file) return;
    const parent = file.parent;
    await this.app.fileManager.trashFile(file);
    await this.removeIfEmpty(parent);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureParent(to);
    // vault.rename, not fileManager.renameFile: links were already updated by whoever renamed it.
    const file = this.file(from);
    const parent = file.parent;
    await this.app.vault.rename(file, to);
    await this.removeIfEmpty(parent);
  }

  /** Folders emptied by someone else's rename or delete go away too (they are not synced themselves). */
  private async removeIfEmpty(folder: TFolder | null): Promise<void> {
    while (folder && !folder.isRoot() && folder.children.length === 0) {
      const parent = folder.parent;
      await this.app.vault.delete(folder);
      folder = parent;
    }
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return file;
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    }
  }
}
