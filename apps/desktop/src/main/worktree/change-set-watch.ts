/**
 * Debounced worktree filesystem watch for Change Set refresh (monaco-migration
 * §9): while a ticket workspace is live, main emits `volli:worktree-changed`
 * so the renderer can refetch the snapshot. Follows volli-fs's
 * {@link WATCH_DEBOUNCE_MS} cadence and window-scoped subscription lifecycle
 * (teardown on unwatch / `destroyed` — never leaks across tickets).
 */
import { statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { Result, WorktreeChangedEvent, VolliIpcEvent } from "@volli/shared";

/** Same debounce as FileWatchManager / DirWatchManager (volli-fs.ts). */
export const WATCH_DEBOUNCE_MS = 250;

/**
 * Ceiling on how long the trailing debounce may keep deferring. An agent
 * writing a file every ~200ms — a long codegen run, a watch-mode build — never
 * leaves a 250ms gap, so a pure trailing debounce would postpone the refresh
 * for the entire run and the Changes rail would sit frozen exactly when the
 * user most wants to watch it move. Past this bound the pending burst fires
 * regardless and the debounce starts over.
 */
export const WATCH_MAX_WAIT_MS = 1000;

interface WorktreeWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** Injectable `fs.watch` seam so tests drive events without racing the OS. */
export type WorktreeWatchFn = (
  path: string,
  options: { recursive?: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => WorktreeWatchHandle;

interface WorktreeWatchSubscription {
  webContents: WebContents;
  ticketId: string;
  worktreePath: string;
  watcher: WorktreeWatchHandle | null;
  debounceTimer: NodeJS.Timeout | null;
  /** Deadline for the current burst; null when no burst is pending. */
  maxWaitAt: number | null;
  /** True when `.git` is a real directory here — see {@link isSelfFedGitEvent}. */
  skipGitEvents: boolean;
  onDestroyed: () => void;
}

export interface WorktreeChangeWatchOptions {
  watch?: WorktreeWatchFn;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Injectable `.git`-is-a-directory probe (see {@link isSelfFedGitEvent}). */
  gitPathIsDirectory?: (worktreePath: string) => boolean;
  /** Injectable clock, so the maxWait bound is testable with fake timers. */
  now?: () => number;
}

/** Default `.git`-is-a-directory probe; a missing/unreadable path is "not a directory". */
function statGitPathIsDirectory(worktreePath: string): boolean {
  try {
    return statSync(join(worktreePath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether an event names something inside `.git`.
 *
 * A linked ticket worktree has `.git` as a FILE pointing into the main repo, so
 * its own git bookkeeping happens outside the watched tree and never reaches
 * us. A watch rooted at a MAIN repo is different: every snapshot we run writes
 * index/lock/log files under `.git`, which the recursive watch reports back as
 * changes, which schedule another snapshot — a loop that never settles. Those
 * events carry no information the Change Set can use anyway, so drop them.
 */
function isSelfFedGitEvent(filename: string | null): boolean {
  if (filename === null) return false;
  return filename === ".git" || filename.startsWith(".git/") || filename.startsWith(".git\\");
}

/**
 * One recursive watch per `(webContents, ticketId)`. Broadcasts are scoped to
 * the subscribing window only (same stance as PtyManager / FileWatchManager).
 */
export class WorktreeChangeWatchManager {
  private readonly subs = new Map<string, WorktreeWatchSubscription>();
  private readonly watchFn: WorktreeWatchFn;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly gitPathIsDirectory: (worktreePath: string) => boolean;
  private readonly now: () => number;

  constructor(options: WorktreeChangeWatchOptions = {}) {
    this.watchFn = options.watch ?? ((path, opts, listener) => fsWatch(path, opts, listener));
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
    this.gitPathIsDirectory = options.gitPathIsDirectory ?? statGitPathIsDirectory;
    this.now = options.now ?? Date.now;
  }

  private keyFor(webContents: WebContents, ticketId: string): string {
    return `${webContents.id}:${ticketId}`;
  }

  /**
   * Idempotent: watching an already-watched ticket for this window is a no-op —
   * UNLESS the ticket's worktree has moved. A ticket can be removed and re-ensured
   * at a fresh path within one window's lifetime, and the old subscription would
   * then be watching a directory that no longer belongs to it, so a differing
   * path restarts the watch rather than silently keeping the stale one.
   */
  watch(webContents: WebContents, ticketId: string, worktreePath: string): Result {
    const key = this.keyFor(webContents, ticketId);
    const existing = this.subs.get(key);
    if (existing) {
      if (existing.worktreePath === worktreePath) return { ok: true };
      this.teardown(key);
    }
    if (webContents.isDestroyed()) return { ok: true };

    const sub: WorktreeWatchSubscription = {
      webContents,
      ticketId,
      worktreePath,
      watcher: null,
      debounceTimer: null,
      maxWaitAt: null,
      skipGitEvents: this.gitPathIsDirectory(worktreePath),
      onDestroyed: () => this.teardown(key),
    };
    this.subs.set(key, sub);
    try {
      const watcher = this.watchFn(worktreePath, { recursive: true }, (_eventType, filename) => {
        if (sub.skipGitEvents && isSelfFedGitEvent(filename)) return;
        this.scheduleBroadcast(sub);
      });
      sub.watcher = watcher;
      watcher.on("error", () => {
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

  /**
   * Tears down EVERY window's watch on a ticket. The remove/archive paths call
   * this: a recursive `fs.watch` keeps a handle on a directory that is about to
   * be deleted, and the renderer has no reason to unwatch — from its side
   * nothing happened, the ticket simply stopped having a worktree.
   */
  unwatchTicket(ticketId: string): void {
    for (const [key, sub] of [...this.subs]) {
      if (sub.ticketId === ticketId) this.teardown(key);
    }
  }

  /**
   * Trailing debounce with a {@link WATCH_MAX_WAIT_MS} ceiling: each event
   * pushes the timer out by `debounceMs`, but never past the deadline the
   * burst's first event set.
   */
  private scheduleBroadcast(sub: WorktreeWatchSubscription): void {
    const now = this.now();
    if (sub.maxWaitAt === null) sub.maxWaitAt = now + this.maxWaitMs;
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    const delay = Math.max(0, Math.min(this.debounceMs, sub.maxWaitAt - now));
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      sub.maxWaitAt = null;
      if (sub.webContents.isDestroyed()) return;
      // Only fire if this subscription is still the live one for its key.
      if (this.subs.get(this.keyFor(sub.webContents, sub.ticketId)) !== sub) return;
      const payload: WorktreeChangedEvent = { ticketId: sub.ticketId };
      sub.webContents.send("volli:worktree-changed" satisfies VolliIpcEvent, payload);
    }, delay);
  }

  private teardown(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.debounceTimer !== null) {
      clearTimeout(sub.debounceTimer);
      sub.debounceTimer = null;
    }
    sub.maxWaitAt = null;
    sub.watcher?.close();
    sub.watcher = null;
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
  }
}
