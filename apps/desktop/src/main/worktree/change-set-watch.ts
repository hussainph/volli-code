/**
 * Debounced worktree filesystem watch for Change Set refresh (CONCEPT #47):
 * while a ticket workspace is live, main emits `volli:worktree-changed`
 * so the renderer can refetch the snapshot. Follows volli-fs's
 * {@link WATCH_DEBOUNCE_MS} cadence. One refcounted recursive watcher is shared
 * by every window subscribed to the same worktree and closes with its last
 * subscriber (unwatch / `destroyed` — never leaks across tickets).
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
import { GIT_COMMAND_TIMEOUT_MS, GIT_MAX_BUFFER, runGitCapturingAsync, stderrOf } from "./git";
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

interface WorktreeWatchSubscriber {
  webContents: WebContents;
  ticketId: string;
  root: SharedWorktreeWatch;
  /** Only foreground subscribers receive change broadcasts. */
  active: boolean;
  onDestroyed: () => void;
}

interface SharedWorktreeWatch {
  worktreePath: string;
  subscribers: Map<string, WorktreeWatchSubscriber>;
  watcher: WorktreeWatchHandle | null;
  armPromise: Promise<Result> | null;
  debounceTimer: NodeJS.Timeout | null;
  /** Deadline for the current burst; null when no burst is pending. */
  maxWaitAt: number | null;
  /** Git-reported ignored files and directory prefixes, always slash-normalized. */
  ignoredPaths: Set<string>;
  /** Monotonic token preventing an older async ignore read from replacing a newer one. */
  ignoreLoadId: number;
  /** Directories already found not to be ignored, so they are checked only once. */
  checkedDirectories: Set<string>;
  /** Newly-created directories waiting for one batched `git check-ignore --stdin`. */
  pendingDirectoryEvents: Set<string>;
  directoryCheckQueued: boolean;
  ignoreRefreshTimer: NodeJS.Timeout | null;
  ignoreRefreshNeedsBroadcast: boolean;
  /** True when `.git` is a real directory here — see {@link isSelfFedGitEvent}. */
  skipGitEvents: boolean;
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
 * One recursive watch per worktree path, shared across window/ticket
 * subscribers. Events remain scoped: each subscriber receives its own ticket
 * payload in its own window, while the expensive FSEvents handle is refcounted.
 */
export class WorktreeChangeWatchManager {
  private readonly subs = new Map<string, WorktreeWatchSubscriber>();
  private readonly roots = new Map<string, SharedWorktreeWatch>();
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
  private watchErrorMessage(root: SharedWorktreeWatch, error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    if ("code" in error && error.code === "ENOENT" && !existsSync(root.worktreePath)) {
      return WORKTREE_MISSING_ON_DISK;
    }
    return error.message;
  }

  /**
   * Idempotent for one window/ticket subscriber. A moved worktree transfers
   * that subscriber to the new root; the old recursive watcher survives only
   * when another subscriber still references it.
   */
  async watch(webContents: WebContents, ticketId: string, worktreePath: string): Promise<Result> {
    const key = this.keyFor(webContents, ticketId);
    const existing = this.subs.get(key);
    if (existing) {
      if (existing.root.worktreePath === worktreePath) return { ok: true };
      this.teardownSubscriber(key);
    }
    if (webContents.isDestroyed()) {
      return { ok: false, error: "This window is closing, so its worktree watch was not started." };
    }

    let root = this.roots.get(worktreePath);
    if (root === undefined) {
      root = {
        worktreePath,
        subscribers: new Map(),
        watcher: null,
        armPromise: null,
        debounceTimer: null,
        maxWaitAt: null,
        ignoredPaths: new Set(),
        ignoreLoadId: 0,
        checkedDirectories: new Set(),
        pendingDirectoryEvents: new Set(),
        directoryCheckQueued: false,
        ignoreRefreshTimer: null,
        ignoreRefreshNeedsBroadcast: false,
        skipGitEvents: this.gitPathIsDirectory(worktreePath),
      };
      this.roots.set(worktreePath, root);
    }

    const sub: WorktreeWatchSubscriber = {
      webContents,
      ticketId,
      root,
      active: true,
      onDestroyed: () => this.teardownSubscriber(key),
    };
    this.subs.set(key, sub);
    root.subscribers.set(key, sub);
    webContents.once("destroyed", sub.onDestroyed);
    return this.ensureRootArmed(root);
  }

  private ensureRootArmed(root: SharedWorktreeWatch): Promise<Result> {
    if (root.watcher !== null) return Promise.resolve({ ok: true });
    if (root.armPromise !== null) return root.armPromise;
    const armPromise = this.armRoot(root);
    root.armPromise = armPromise;
    void armPromise.then(() => {
      if (root.armPromise === armPromise) root.armPromise = null;
    });
    return armPromise;
  }

  private async armRoot(root: SharedWorktreeWatch): Promise<Result> {
    const ignoreLoadId = ++root.ignoreLoadId;
    try {
      const ignoredOutput = await this.git(
        ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
        root.worktreePath,
      );
      if (!this.isRootLive(root)) return { ok: true };
      if (root.ignoreLoadId === ignoreLoadId) {
        root.ignoredPaths = ignoredPathSet(ignoredOutput);
        root.checkedDirectories.clear();
      }
      if (!this.hasActiveSubscribers(root)) return { ok: true };
    } catch (error) {
      this.teardownRoot(root);
      return { ok: false, error: stderrOf(error) };
    }

    try {
      let watcher: WorktreeWatchHandle;
      watcher = this.watchFn(root.worktreePath, { recursive: true }, (eventType, filename) => {
        if (root.watcher !== watcher) return;
        this.handleFsEvent(root, eventType, filename);
      });
      root.watcher = watcher;
      watcher.on("error", (error: Error) => {
        if (!this.isRootLive(root) || root.watcher !== watcher) return;
        // Every subscriber is frozen by a shared-handle fault. Tell each
        // renderer first, then release the root and all of its references.
        this.emitWatchError(root, this.watchErrorMessage(root, error));
        this.teardownRoot(root);
      });
      return { ok: true };
    } catch (error) {
      const message = this.watchErrorMessage(root, error);
      this.teardownRoot(root);
      return { ok: false, error: message };
    }
  }

  /** Releases one subscriber and closes its root only when the refcount hits zero. */
  unwatch(webContents: WebContents, ticketId: string): void {
    this.teardownSubscriber(this.keyFor(webContents, ticketId));
  }

  /** Pauses one background subscriber and the OS watcher if no foreground ref remains. */
  pause(webContents: WebContents, ticketId: string): Result {
    const sub = this.subs.get(this.keyFor(webContents, ticketId));
    if (!sub) return { ok: false, error: "This worktree watch is not subscribed." };
    sub.active = false;
    if (!this.hasActiveSubscribers(sub.root)) this.disarmRoot(sub.root);
    return { ok: true };
  }

  /** Re-arms a paused root and sends this subscriber one catch-up refresh. */
  async resume(webContents: WebContents, ticketId: string): Promise<Result> {
    const key = this.keyFor(webContents, ticketId);
    const sub = this.subs.get(key);
    if (!sub) return { ok: false, error: "This worktree watch is not subscribed." };
    if (sub.active) return { ok: true };
    sub.active = true;
    const result = await this.ensureRootArmed(sub.root);
    if (!result.ok) return result;
    if (this.subs.get(key) !== sub || sub.webContents.isDestroyed()) return { ok: true };
    const payload: WorktreeChangedEvent = { ticketId: sub.ticketId };
    sub.webContents.send("volli:worktree-changed" satisfies VolliIpcEvent, payload);
    return { ok: true };
  }

  /**
   * Tears down EVERY window's subscription on a ticket. The remove/archive
   * paths call this before deleting the checkout. Any unrelated subscribers to
   * the same root retain the shared handle until their own teardown.
   */
  unwatchTicket(ticketId: string): void {
    const keys: string[] = [];
    for (const [key, sub] of this.subs) {
      if (sub.ticketId === ticketId) keys.push(key);
    }
    for (const key of keys) this.teardownSubscriber(key);
  }

  private isRootLive(root: SharedWorktreeWatch): boolean {
    return this.roots.get(root.worktreePath) === root;
  }

  private hasActiveSubscribers(root: SharedWorktreeWatch): boolean {
    for (const sub of root.subscribers.values()) {
      if (sub.active) return true;
    }
    return false;
  }

  private handleFsEvent(
    root: SharedWorktreeWatch,
    eventType: string,
    filename: string | null,
  ): void {
    if (!this.isRootLive(root)) return;
    const path = filename === null ? null : normalizeRepoPath(filename);

    // `.git/info/exclude` is the one meaningful `.git` event: refresh the
    // filter, but retain the existing self-fed exclusion for every other git
    // bookkeeping write.
    if (root.skipGitEvents && isSelfFedGitEvent(filename)) {
      if (path === ".git/info/exclude") this.queueIgnoredPathRefresh(root, false);
      return;
    }
    // The root rules file can itself be ignored; it still controls every other
    // path and must always invalidate the cache. Nested rules under an ignored
    // parent cannot affect traversal, so those are filtered normally first.
    if (path === ".gitignore") {
      this.queueIgnoredPathRefresh(root, true);
      return;
    }
    if (path !== null && isIgnoredPath(root.ignoredPaths, path)) return;
    if (path !== null && isIgnoreRulesEvent(path)) {
      this.queueIgnoredPathRefresh(root, true);
      return;
    }
    if (path === null) {
      this.scheduleBroadcast(root);
      return;
    }

    // `ls-files --directory` cannot list an ignored directory that did not
    // exist at watch start. A newly-created directory therefore gets one lazy
    // check before its event is allowed to schedule a Change Set snapshot.
    if (eventType === "rename" && !root.checkedDirectories.has(path)) {
      let directory = false;
      try {
        directory = this.pathIsDirectory(root.worktreePath, path);
      } catch {
        // A probe racing deletion is simply not a newly-created directory.
      }
      if (directory) {
        this.queueDirectoryCheck(root, path);
        return;
      }
    }
    for (const pending of root.pendingDirectoryEvents) {
      if (path === pending || path.startsWith(`${pending}/`)) return;
    }
    this.scheduleBroadcast(root);
  }

  private queueIgnoredPathRefresh(root: SharedWorktreeWatch, broadcastAfterRefresh: boolean): void {
    root.ignoreRefreshNeedsBroadcast ||= broadcastAfterRefresh;
    if (root.ignoreRefreshTimer !== null) clearTimeout(root.ignoreRefreshTimer);
    root.ignoreRefreshTimer = setTimeout(() => {
      root.ignoreRefreshTimer = null;
      void this.refreshIgnoredPaths(root);
    }, this.debounceMs);
  }

  private async refreshIgnoredPaths(root: SharedWorktreeWatch): Promise<void> {
    const ignoreLoadId = ++root.ignoreLoadId;
    try {
      const output = await this.git(
        ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
        root.worktreePath,
      );
      if (!this.isRootLive(root)) return;
      if (root.ignoreLoadId === ignoreLoadId) {
        root.ignoredPaths = ignoredPathSet(output);
        root.checkedDirectories.clear();
      }
    } catch {
      // Fail open: an ignore refresh must not freeze an otherwise healthy
      // Change Set watch. The previous cache remains valid for older rules.
    }
    if (!this.isRootLive(root)) return;
    const broadcast = root.ignoreRefreshNeedsBroadcast;
    root.ignoreRefreshNeedsBroadcast = false;
    if (broadcast) this.scheduleBroadcast(root);
  }

  private queueDirectoryCheck(root: SharedWorktreeWatch, path: string): void {
    root.pendingDirectoryEvents.add(path);
    if (root.directoryCheckQueued) return;
    root.directoryCheckQueued = true;
    queueMicrotask(() => {
      root.directoryCheckQueued = false;
      void this.flushDirectoryChecks(root);
    });
  }

  private async flushDirectoryChecks(root: SharedWorktreeWatch): Promise<void> {
    if (!this.isRootLive(root)) return;
    const candidates = [...root.pendingDirectoryEvents];
    root.pendingDirectoryEvents.clear();
    let ignored = new Set<string>();
    try {
      const outputPaths = await this.checkIgnoredPaths(root.worktreePath, candidates);
      ignored = new Set(
        outputPaths
          .map((path) => normalizeRepoPath(path))
          .filter((path): path is string => path !== null),
      );
    } catch {
      // Fail open like a full refresh: one failed optimization probe must not
      // suppress a real source change forever.
    }
    if (!this.isRootLive(root)) return;
    let shouldBroadcast = false;
    for (const path of candidates) {
      root.checkedDirectories.add(path);
      if (ignored.has(path)) {
        root.ignoredPaths.add(`${path}/`);
      } else {
        shouldBroadcast = true;
      }
    }
    if (shouldBroadcast) this.scheduleBroadcast(root);
  }

  /** Trailing debounce with a max-wait ceiling, shared by the whole root. */
  private scheduleBroadcast(root: SharedWorktreeWatch): void {
    if (!this.hasActiveSubscribers(root)) return;
    const now = this.now();
    if (root.maxWaitAt === null) root.maxWaitAt = now + this.maxWaitMs;
    if (root.debounceTimer !== null) clearTimeout(root.debounceTimer);
    const delay = Math.max(0, Math.min(this.debounceMs, root.maxWaitAt - now));
    root.debounceTimer = setTimeout(() => {
      root.debounceTimer = null;
      root.maxWaitAt = null;
      if (!this.isRootLive(root)) return;
      for (const [key, sub] of root.subscribers) {
        if (!sub.active || this.subs.get(key) !== sub || sub.webContents.isDestroyed()) continue;
        const payload: WorktreeChangedEvent = { ticketId: sub.ticketId };
        sub.webContents.send("volli:worktree-changed" satisfies VolliIpcEvent, payload);
      }
    }, delay);
  }

  private emitWatchError(root: SharedWorktreeWatch, message: string): void {
    for (const [key, sub] of root.subscribers) {
      if (this.subs.get(key) !== sub || sub.webContents.isDestroyed()) continue;
      const payload: WorktreeWatchErrorEvent = { ticketId: sub.ticketId, error: message };
      sub.webContents.send("volli:worktree-watch-error" satisfies VolliIpcEvent, payload);
    }
  }

  private teardownSubscriber(key: string): void {
    const sub = this.subs.get(key);
    if (!sub) return;
    this.subs.delete(key);
    sub.root.subscribers.delete(key);
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
    if (sub.root.subscribers.size === 0) {
      this.teardownRoot(sub.root);
    } else if (!this.hasActiveSubscribers(sub.root)) {
      this.disarmRoot(sub.root);
    }
  }

  private disarmRoot(root: SharedWorktreeWatch): void {
    if (root.debounceTimer !== null) {
      clearTimeout(root.debounceTimer);
      root.debounceTimer = null;
    }
    if (root.ignoreRefreshTimer !== null) {
      clearTimeout(root.ignoreRefreshTimer);
      root.ignoreRefreshTimer = null;
    }
    root.maxWaitAt = null;
    root.ignoreRefreshNeedsBroadcast = false;
    root.pendingDirectoryEvents.clear();
    root.watcher?.close();
    root.watcher = null;
  }

  private teardownRoot(root: SharedWorktreeWatch): void {
    if (!this.isRootLive(root)) return;
    this.roots.delete(root.worktreePath);
    this.disarmRoot(root);

    for (const [key, sub] of root.subscribers) {
      this.subs.delete(key);
      if (!sub.webContents.isDestroyed()) {
        sub.webContents.removeListener("destroyed", sub.onDestroyed);
      }
    }
    root.subscribers.clear();
  }
}
