/**
 * Debounced worktree filesystem watch for Change Set refresh (monaco-migration
 * §9): while a ticket workspace is live, main emits `volli:worktree-changed`
 * so the renderer can refetch the snapshot. Follows volli-fs's
 * {@link WATCH_DEBOUNCE_MS} cadence and window-scoped subscription lifecycle
 * (teardown on unwatch / `destroyed` — never leaks across tickets).
 */
import { watch as fsWatch } from "node:fs";
import type { WebContents } from "electron";
import type { Result, WorktreeChangedEvent, VolliIpcEvent } from "@volli/shared";

/** Same debounce as FileWatchManager / DirWatchManager (volli-fs.ts). */
export const WATCH_DEBOUNCE_MS = 250;

/** Injectable `fs.watch` seam so tests drive events without racing the OS. */
export type WorktreeWatchFn = typeof fsWatch;

interface WorktreeWatchSubscription {
  webContents: WebContents;
  ticketId: string;
  worktreePath: string;
  watcher: ReturnType<typeof fsWatch> | null;
  debounceTimer: NodeJS.Timeout | null;
  onDestroyed: () => void;
}

export interface WorktreeChangeWatchOptions {
  watch?: WorktreeWatchFn;
  debounceMs?: number;
}

/**
 * One recursive watch per `(webContents, ticketId)`. Broadcasts are scoped to
 * the subscribing window only (same stance as PtyManager / FileWatchManager).
 */
export class WorktreeChangeWatchManager {
  private readonly subs = new Map<string, WorktreeWatchSubscription>();
  private readonly watchFn: WorktreeWatchFn;
  private readonly debounceMs: number;

  constructor(options: WorktreeChangeWatchOptions = {}) {
    this.watchFn = options.watch ?? fsWatch;
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  }

  private keyFor(webContents: WebContents, ticketId: string): string {
    return `${webContents.id}:${ticketId}`;
  }

  /** Idempotent: watching an already-watched ticket for this window is a no-op. */
  watch(webContents: WebContents, ticketId: string, worktreePath: string): Result {
    const key = this.keyFor(webContents, ticketId);
    if (this.subs.has(key)) return { ok: true };
    if (webContents.isDestroyed()) return { ok: true };

    const sub: WorktreeWatchSubscription = {
      webContents,
      ticketId,
      worktreePath,
      watcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
    };
    this.subs.set(key, sub);
    try {
      sub.watcher = this.watchFn(worktreePath, { recursive: true }, () => {
        this.scheduleBroadcast(sub);
      });
      sub.watcher.on("error", () => {
        // An async watch fault must never crash main — drop this subscription.
        this.teardown(key);
      });
    } catch (error) {
      this.teardown(key);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
    webContents.once("destroyed", sub.onDestroyed);
    return { ok: true };
  }

  /** Tears down the watch; safe if never watched. */
  unwatch(webContents: WebContents, ticketId: string): void {
    this.teardown(this.keyFor(webContents, ticketId));
  }

  private scheduleBroadcast(sub: WorktreeWatchSubscription): void {
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      if (sub.webContents.isDestroyed()) return;
      // Only fire if this subscription is still the live one for its key.
      if (this.subs.get(this.keyFor(sub.webContents, sub.ticketId)) !== sub) return;
      const payload: WorktreeChangedEvent = { ticketId: sub.ticketId };
      sub.webContents.send("volli:worktree-changed" satisfies VolliIpcEvent, payload);
    }, this.debounceMs);
  }

  private teardown(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.debounceTimer !== null) {
      clearTimeout(sub.debounceTimer);
      sub.debounceTimer = null;
    }
    sub.watcher?.close();
    sub.watcher = null;
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
  }
}
