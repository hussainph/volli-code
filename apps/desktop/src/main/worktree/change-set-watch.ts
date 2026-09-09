/**
 * Debounced worktree filesystem watch for Change Set refresh (CONCEPT #47):
 * while a ticket workspace is live, main emits `volli:worktree-changed`
 * so the renderer can refetch the snapshot. Follows volli-fs's
 * {@link WATCH_DEBOUNCE_MS} cadence and window-scoped subscription lifecycle
 * (teardown on unwatch / `destroyed` — never leaks across tickets).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { WORKTREE_MISSING_ON_DISK } from "@volli/shared";
import type {
  Result,
  VolliIpcEvent,
  WorktreeChangedEvent,
  WorktreeWatchErrorEvent,
} from "../../ipc/contract";
import {
  GIT_COMMAND_TIMEOUT_MS,
  GIT_MAX_BUFFER,
  runGitCapturingAsync,
  stderrOf,
} from "./git";
import type { RunGitAsync } from "./types";

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
  /** Git-reported ignored files and directory prefixes, always slash-normalized. */
  ignoredPaths: Set<string>;
  /** Directories already found not to be ignored, so they are checked only once. */
  checkedDirectories: Set<string>;
  /** Newly-created directories waiting for one batched `git check-ignore --stdin`. */
  pendingDirectoryEvents: Set<string>;
  directoryCheckQueued: boolean;
  ignoreRefreshTimer: NodeJS.Timeout | null;
  ignoreRefreshNeedsBroadcast: boolean;
  /** True when `.git` is a real directory here — see {@link isSelfFedGitEvent}. */
  skipGitEvents: boolean;
  onDestroyed: () => void;
}

/** Injectable stdin-based git seam for lazily classifying newly-created directories. */
export type CheckIgnoredPaths = (
  worktreePath: string,
  paths: readonly string[],
) => Promise<readonly string[]>;

export interface WorktreeChangeWatchOptions {
  watch?: WorktreeWatchFn;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Async git seam used to derive the repository's complete current ignored set. */
  git?: RunGitAsync;
  /** Injectable `git check-ignore --stdin` seam for new-directory batches. */
  checkIgnoredPaths?: CheckIgnoredPaths;
  /** Injectable `.git`-is-a-directory probe (see {@link isSelfFedGitEvent}). */
  gitPathIsDirectory?: (worktreePath: string) => boolean;
  /** Injectable directory probe for lazy ignore checks. */
  pathIsDirectory?: (worktreePath: string, relativePath: string) => boolean;
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

/** Default directory probe; a missing/unreadable path is not a new directory. */
function statPathIsDirectory(worktreePath: string, relativePath: string): boolean {
  try {
    return statSync(join(worktreePath, relativePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs the lazy path probe with NUL-delimited stdin. Exit 1 means none of the
 * supplied paths are ignored, which is a successful classification rather
 * than a failed git command.
 */
function checkIgnoredPathsWithGit(
  worktreePath: string,
  paths: readonly string[],
): Promise<readonly string[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin", "-z"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error === null || error.code === 1) {
          resolve(splitNul(stdout));
          return;
        }
        reject(new Error(stderr.trim() || error.message));
      },
    );
    child.stdin?.end(`${paths.join("\0")}\0`);
  });
}

/** Slash-normalizes a watch/git path and rejects paths outside the watch root. */
function normalizeRepoPath(path: string): string | null {
  const parts = path.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") return null;
    normalized.push(part);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

/** Parses `git ls-files ... --directory -z` into exact files + directory prefixes. */
function ignoredPathSet(output: string): Set<string> {
  const ignored = new Set<string>();
  for (const rawPath of splitNul(output)) {
    const directory = rawPath.endsWith("/") || rawPath.endsWith("\\");
    const path = normalizeRepoPath(rawPath);
    if (path !== null) ignored.add(directory ? `${path}/` : path);
  }
  return ignored;
}

/** Set lookup is O(path depth), not O(number of ignored dependency files). */
function isIgnoredPath(ignoredPaths: ReadonlySet<string>, path: string): boolean {
  if (ignoredPaths.has(path) || ignoredPaths.has(`${path}/`)) return true;
  let separator = path.indexOf("/");
  while (separator >= 0) {
    if (ignoredPaths.has(path.slice(0, separator + 1))) return true;
    separator = path.indexOf("/", separator + 1);
  }
  return false;
}

function isIgnoreRulesEvent(path: string): boolean {
  return path === ".gitignore" || path.endsWith("/.gitignore") || path === ".git/info/exclude";
}

function splitNul(output: string): string[] {
  if (output.length === 0) return [];
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
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
  private readonly git: RunGitAsync;
  private readonly checkIgnoredPaths: CheckIgnoredPaths;
  private readonly gitPathIsDirectory: (worktreePath: string) => boolean;
  private readonly pathIsDirectory: (worktreePath: string, relativePath: string) => boolean;
  private readonly now: () => number;

  constructor(options: WorktreeChangeWatchOptions = {}) {
    this.watchFn = options.watch ?? ((path, opts, listener) => fsWatch(path, opts, listener));
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
    this.git = options.git ?? runGitCapturingAsync;
    this.checkIgnoredPaths = options.checkIgnoredPaths ?? checkIgnoredPathsWithGit;
    this.gitPathIsDirectory = options.gitPathIsDirectory ?? statGitPathIsDirectory;
    this.pathIsDirectory = options.pathIsDirectory ?? statPathIsDirectory;
    this.now = options.now ?? Date.now;
  }

  private keyFor(webContents: WebContents, ticketId: string): string {
    return `${webContents.id}:${ticketId}`;
  }

  /**
   * The one watch fault the rail can act on (VC-113): an ENOENT from a
   * vanished DIRECTORY is "missing" — the shared sentence the renderer matches
   * to offer Recreate instead of Retry, the same one the direct worktree reads
   * answer with, so both surfaces agree about what "gone" reads like. Anything
   * else keeps its own message: mapping unknown faults would teach the UI to
   * misdiagnose every watcher hiccup as a deleted checkout.
   */
  private watchErrorMessage(sub: WorktreeWatchSubscription, error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    if ("code" in error && error.code === "ENOENT" && !existsSync(sub.worktreePath)) {
      return WORKTREE_MISSING_ON_DISK;
    }
    return error.message;
  }

  /**
   * Idempotent: watching an already-watched ticket for this window is a no-op —
   * UNLESS the ticket's worktree has moved. A ticket can be removed and re-ensured
   * at a fresh path within one window's lifetime, and the old subscription would
   * then be watching a directory that no longer belongs to it, so a differing
   * path restarts the watch rather than silently keeping the stale one.
   */
  async watch(
    webContents: WebContents,
    ticketId: string,
    worktreePath: string,
  ): Promise<Result> {
    const key = this.keyFor(webContents, ticketId);
    const existing = this.subs.get(key);
    if (existing) {
      if (existing.worktreePath === worktreePath) return { ok: true };
      this.teardown(key);
    }
    // A destroyed window can neither hold a watch nor receive its events, so
    // reporting success would tell the caller it is subscribed when it is not.
    if (webContents.isDestroyed()) {
      return { ok: false, error: "This window is closing, so its worktree watch was not started." };
    }

    const sub: WorktreeWatchSubscription = {
      webContents,
      ticketId,
      worktreePath,
      watcher: null,
      debounceTimer: null,
      maxWaitAt: null,
      ignoredPaths: new Set(),
      checkedDirectories: new Set(),
      pendingDirectoryEvents: new Set(),
      directoryCheckQueued: false,
      ignoreRefreshTimer: null,
      ignoreRefreshNeedsBroadcast: false,
      skipGitEvents: this.gitPathIsDirectory(worktreePath),
      onDestroyed: () => this.teardown(key),
    };
    this.subs.set(key, sub);
    webContents.once("destroyed", sub.onDestroyed);
    try {
      const ignoredOutput = await this.git(
        ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
        worktreePath,
      );
      if (!this.isLive(sub)) return { ok: true };
      sub.ignoredPaths = ignoredPathSet(ignoredOutput);
    } catch (error) {
      this.teardown(key);
      return { ok: false, error: stderrOf(error) };
    }

    try {
      const watcher = this.watchFn(worktreePath, { recursive: true }, (eventType, filename) => {
        this.handleFsEvent(sub, eventType, filename);
      });
      sub.watcher = watcher;
      watcher.on("error", (error: Error) => {
        // An async watch fault must never crash main — but it must not vanish
        // either: once we drop the subscription no further `worktree-changed`
        // arrives, and a frozen Change Set is indistinguishable from a quiet
        // worktree. Tell the renderer first, then tear down.
        this.emitWatchError(sub, this.watchErrorMessage(sub, error));
        this.teardown(key);
      });
      return { ok: true };
    } catch (error) {
      const message = this.watchErrorMessage(sub, error);
      this.teardown(key);
      return { ok: false, error: message };
    }
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
    const keys: string[] = [];
    for (const [key, sub] of this.subs) {
      if (sub.ticketId === ticketId) keys.push(key);
    }
    for (const key of keys) this.teardown(key);
  }

  private isLive(sub: WorktreeWatchSubscription): boolean {
    return this.subs.get(this.keyFor(sub.webContents, sub.ticketId)) === sub;
  }

  private handleFsEvent(
    sub: WorktreeWatchSubscription,
    eventType: string,
    filename: string | null,
  ): void {
    if (!this.isLive(sub)) return;
    const path = filename === null ? null : normalizeRepoPath(filename);

    // `.git/info/exclude` is the one meaningful `.git` event: refresh the
    // filter, but retain the existing self-fed exclusion for every other git
    // bookkeeping write.
    if (sub.skipGitEvents && isSelfFedGitEvent(filename)) {
      if (path === ".git/info/exclude") this.queueIgnoredPathRefresh(sub, false);
      return;
    }
    if (path !== null && isIgnoredPath(sub.ignoredPaths, path)) return;
    if (path !== null && isIgnoreRulesEvent(path)) {
      this.queueIgnoredPathRefresh(sub, true);
      return;
    }
    if (path === null) {
      this.scheduleBroadcast(sub);
      return;
    }

    // `ls-files --directory` cannot list an ignored directory that did not
    // exist at watch start. A newly-created directory therefore gets one lazy
    // check before its event is allowed to schedule a Change Set snapshot.
    if (eventType === "rename" && !sub.checkedDirectories.has(path)) {
      let directory = false;
      try {
        directory = this.pathIsDirectory(sub.worktreePath, path);
      } catch {
        // A probe racing deletion is simply not a newly-created directory.
      }
      if (directory) {
        this.queueDirectoryCheck(sub, path);
        return;
      }
    }
    for (const pending of sub.pendingDirectoryEvents) {
      if (path === pending || path.startsWith(`${pending}/`)) return;
    }
    this.scheduleBroadcast(sub);
  }

  private queueIgnoredPathRefresh(
    sub: WorktreeWatchSubscription,
    broadcastAfterRefresh: boolean,
  ): void {
    sub.ignoreRefreshNeedsBroadcast ||= broadcastAfterRefresh;
    if (sub.ignoreRefreshTimer !== null) clearTimeout(sub.ignoreRefreshTimer);
    sub.ignoreRefreshTimer = setTimeout(() => {
      sub.ignoreRefreshTimer = null;
      void this.refreshIgnoredPaths(sub);
    }, this.debounceMs);
  }

  private async refreshIgnoredPaths(sub: WorktreeWatchSubscription): Promise<void> {
    try {
      const output = await this.git(
        ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
        sub.worktreePath,
      );
      if (!this.isLive(sub)) return;
      sub.ignoredPaths = ignoredPathSet(output);
      sub.checkedDirectories.clear();
    } catch {
      // Fail open: an ignore refresh must not freeze an otherwise healthy
      // Change Set watch. The previous cache remains valid for older rules.
    }
    if (!this.isLive(sub)) return;
    const broadcast = sub.ignoreRefreshNeedsBroadcast;
    sub.ignoreRefreshNeedsBroadcast = false;
    if (broadcast) this.scheduleBroadcast(sub);
  }

  private queueDirectoryCheck(sub: WorktreeWatchSubscription, path: string): void {
    sub.pendingDirectoryEvents.add(path);
    if (sub.directoryCheckQueued) return;
    sub.directoryCheckQueued = true;
    queueMicrotask(() => {
      sub.directoryCheckQueued = false;
      void this.flushDirectoryChecks(sub);
    });
  }

  private async flushDirectoryChecks(sub: WorktreeWatchSubscription): Promise<void> {
    if (!this.isLive(sub)) return;
    const candidates = [...sub.pendingDirectoryEvents];
    sub.pendingDirectoryEvents.clear();
    let ignored = new Set<string>();
    try {
      const outputPaths = await this.checkIgnoredPaths(sub.worktreePath, candidates);
      ignored = new Set(
        outputPaths
          .map((path) => normalizeRepoPath(path))
          .filter((path): path is string => path !== null),
      );
    } catch {
      // Fail open like a full refresh: one failed optimization probe must not
      // suppress a real source change forever.
    }
    if (!this.isLive(sub)) return;
    let shouldBroadcast = false;
    for (const path of candidates) {
      sub.checkedDirectories.add(path);
      if (ignored.has(path)) {
        sub.ignoredPaths.add(`${path}/`);
      } else {
        shouldBroadcast = true;
      }
    }
    if (shouldBroadcast) this.scheduleBroadcast(sub);
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

  private emitWatchError(sub: WorktreeWatchSubscription, message: string): void {
    if (sub.webContents.isDestroyed()) return;
    const payload: WorktreeWatchErrorEvent = { ticketId: sub.ticketId, error: message };
    sub.webContents.send("volli:worktree-watch-error" satisfies VolliIpcEvent, payload);
  }

  private teardown(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    if (sub.debounceTimer !== null) {
      clearTimeout(sub.debounceTimer);
      sub.debounceTimer = null;
    }
    if (sub.ignoreRefreshTimer !== null) {
      clearTimeout(sub.ignoreRefreshTimer);
      sub.ignoreRefreshTimer = null;
    }
    sub.maxWaitAt = null;
    sub.pendingDirectoryEvents.clear();
    sub.watcher?.close();
    sub.watcher = null;
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
  }
}
