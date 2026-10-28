import type { LockInfo, UserInfo } from "@team-sync/shared";

export class LockedError extends Error {
  constructor(readonly lock: LockInfo) {
    super(`"${lock.path}" is being edited by ${lock.username}`);
  }
}

export interface LockEvents {
  acquired(lock: LockInfo): void;
  released(path: string, clientId: string): void;
}

/**
 * Exclusive edit locks, one per path. Locks live in memory only: after a server restart
 * clients simply acquire them again. A lock expires when its client stops renewing it.
 */
export class LockManager {
  private readonly locks = new Map<string, LockInfo>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number,
    private readonly events: LockEvents,
    private readonly now: () => number = Date.now,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(5000, ttlMs / 3));
    this.sweepTimer.unref();
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  list(): LockInfo[] {
    this.sweep();
    return [...this.locks.values()];
  }

  get(path: string): LockInfo | undefined {
    const lock = this.locks.get(path);
    if (lock && lock.expiresAt <= this.now()) {
      this.expire(lock);
      return undefined;
    }
    return lock;
  }

  /** The lock on `path` if it belongs to a client other than `clientId`. */
  heldByOther(path: string, clientId: string): LockInfo | undefined {
    const lock = this.get(path);
    return lock && lock.clientId !== clientId ? lock : undefined;
  }

  acquire(path: string, user: UserInfo, clientId: string): LockInfo {
    const existing = this.heldByOther(path, clientId);
    if (existing) throw new LockedError(existing);
    const now = this.now();
    const current = this.locks.get(path);
    const lock: LockInfo = {
      path,
      userId: user.id,
      username: user.username,
      clientId,
      acquiredAt: current?.acquiredAt ?? now,
      expiresAt: now + this.ttlMs,
    };
    this.locks.set(path, lock);
    if (!current) this.events.acquired(lock);
    return lock;
  }

  /** Releases the lock if `clientId` holds it (or unconditionally when `force`). */
  release(path: string, clientId: string, force = false): boolean {
    const lock = this.locks.get(path);
    if (!lock || (!force && lock.clientId !== clientId)) return false;
    this.locks.delete(path);
    this.events.released(path, lock.clientId);
    return true;
  }

  renewClient(clientId: string): void {
    const expiresAt = this.now() + this.ttlMs;
    for (const lock of this.locks.values()) {
      if (lock.clientId === clientId) lock.expiresAt = expiresAt;
    }
  }

  /** Moves a lock along with a renamed file. */
  move(from: string, to: string): void {
    const lock = this.locks.get(from);
    if (!lock) return;
    this.locks.delete(from);
    this.events.released(from, lock.clientId);
    const moved = { ...lock, path: to };
    this.locks.set(to, moved);
    this.events.acquired(moved);
  }

  private sweep(): void {
    const now = this.now();
    for (const lock of [...this.locks.values()]) {
      if (lock.expiresAt <= now) this.expire(lock);
    }
  }

  private expire(lock: LockInfo): void {
    this.locks.delete(lock.path);
    this.events.released(lock.path, lock.clientId);
  }
}
