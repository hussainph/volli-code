import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WORKTREE_MISSING_ON_DISK } from "@volli/shared";

import {
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_WAIT_MS,
  WorktreeChangeWatchManager,
  type WorktreeChangeWatchOptions,
  type WorktreeWatchFn,
} from "./change-set-watch";
import { runGitCapturingAsync } from "./git";

interface FakeWatcher {
  close: ReturnType<typeof vi.fn<() => void>>;
  on: ReturnType<typeof vi.fn<(event: "error", listener: (error: Error) => void) => void>>;
  /** Fires the "error" listener the manager registered. */
  fail(error: Error): void;
}

interface WatchCall {
  path: string;
  options: { recursive?: boolean } | undefined;
  cb: (eventType: string, filename: string | null) => void;
  watcher: FakeWatcher;
}

function makeFakeWatcher(): FakeWatcher {
  let onError: ((error: Error) => void) | null = null;
  return {
    close: vi.fn<() => void>(),
    on: vi.fn<(event: "error", listener: (error: Error) => void) => void>((_event, listener) => {
      onError = listener;
    }),
    fail(error: Error) {
      onError?.(error);
    },
  };
}

function makeWebContents(id = 1) {
  const eventListeners = new Map<string, () => void>();
  return {
    id,
    send: vi.fn(),
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed;
    },
    once: vi.fn(function (this: unknown, event: string, cb: () => void) {
      eventListeners.set(event, cb);
    }),
    removeListener: vi.fn(function (this: unknown, event: string) {
      eventListeners.delete(event);
    }),
    fireDestroyed() {
      eventListeners.get("destroyed")?.();
    },
  };
}

describe("WorktreeChangeWatchManager", () => {
  const watchCalls: WatchCall[] = [];
  let manager: WorktreeChangeWatchManager;

  afterEach(() => {
    watchCalls.length = 0;
    vi.useRealTimers();
  });

  function makeManager(
    overrides: Omit<WorktreeChangeWatchOptions, "watch"> = {},
  ): WorktreeChangeWatchManager {
    const watchFn: WorktreeWatchFn = (path, options, cb) => {
      const watcher = makeFakeWatcher();
      watchCalls.push({ path, options, cb, watcher });
      return watcher;
    };
    return new WorktreeChangeWatchManager({
      watch: watchFn,
      debounceMs: WATCH_DEBOUNCE_MS,
      maxWaitMs: WATCH_MAX_WAIT_MS,
      git: async () => "",
      // Linked ticket worktrees have `.git` as a file — the default for tests.
      gitPathIsDirectory: () => false,
      now: () => Date.now(),
      ...overrides,
    });
  }

  it("debounces filesystem events and emits volli:worktree-changed for the ticket", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    const result = await manager.watch(webContents as never, "t1", "/wt/t1");
    expect(result.ok).toBe(true);
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0]?.path).toBe("/wt/t1");
    expect(watchCalls[0]?.options?.recursive).toBe(true);

    watchCalls[0]!.cb("change", "src/a.ts");
    watchCalls[0]!.cb("change", "src/b.ts");
    expect(webContents.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(webContents.send).toHaveBeenCalledWith("volli:worktree-changed", { ticketId: "t1" });
  });

  it("filters ignored directories reported by git in a non-Node fixture", async () => {
    const repo = mkdtempSync(join(tmpdir(), "volli-watch-ignore-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(join(repo, ".gitignore"), "target/\n.venv/\n", "utf8");
      mkdirSync(join(repo, "target"));
      mkdirSync(join(repo, ".venv"));
      writeFileSync(join(repo, "target", "artifact"), "ignored", "utf8");
      writeFileSync(join(repo, ".venv", "installed"), "ignored", "utf8");

      manager = makeManager({ git: runGitCapturingAsync });
      const webContents = makeWebContents();
      const result = await manager.watch(webContents as never, "t1", repo);
      expect(result.ok).toBe(true);

      vi.useFakeTimers();
      const cb = watchCalls[0]!.cb;
      cb("change", "target/artifact");
      cb("change", ".venv/installed");
      vi.advanceTimersByTime(WATCH_MAX_WAIT_MS);
      expect(webContents.send).not.toHaveBeenCalled();

      cb("change", "src/main.rs");
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
      expect(webContents.send).toHaveBeenCalledWith("volli:worktree-changed", { ticketId: "t1" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("batches lazy git checks when unknown ignored directories appear", async () => {
    const checks: string[][] = [];
    manager = makeManager({
      pathIsDirectory: () => true,
      checkIgnoredPaths: async (_worktreePath, paths) => {
        checks.push([...paths]);
        return paths;
      },
    });
    const webContents = makeWebContents();
    await manager.watch(webContents as never, "t1", "/wt/t1");
    vi.useFakeTimers();

    const cb = watchCalls[0]!.cb;
    cb("rename", "target");
    cb("rename", ".venv");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(checks).toEqual([["target", ".venv"]]);
    vi.advanceTimersByTime(WATCH_MAX_WAIT_MS);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("fires at the maxWait ceiling even while events keep arriving", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/t1");
    const cb = watchCalls[0]!.cb;

    // An agent writing faster than the debounce window never leaves a 250ms
    // gap, so a pure trailing debounce would defer forever.
    for (let elapsed = 0; elapsed < WATCH_MAX_WAIT_MS; elapsed += WATCH_DEBOUNCE_MS - 50) {
      cb("change", "src/generated.ts");
      vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 50);
    }
    expect(webContents.send).toHaveBeenCalledTimes(1);

    // The ceiling resets with the burst, so the next quiet gap fires normally.
    cb("change", "src/generated.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).toHaveBeenCalledTimes(2);
  });

  it("ignores .git events when the watched tree is a main repo", async () => {
    vi.useFakeTimers();
    manager = makeManager({ gitPathIsDirectory: () => true });
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/repo");
    const cb = watchCalls[0]!.cb;

    // Our own snapshot's index/lock writes come straight back through the
    // recursive watch — feeding them on would never settle.
    cb("change", ".git/index");
    cb("rename", ".git");
    vi.advanceTimersByTime(WATCH_MAX_WAIT_MS);
    expect(webContents.send).not.toHaveBeenCalled();

    cb("change", "src/a.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("refreshes ignored paths when .gitignore changes, then broadcasts that source change", async () => {
    vi.useFakeTimers();
    let ignoredOutput = "target/\0";
    const git = vi.fn(async () => ignoredOutput);
    manager = makeManager({ git, gitPathIsDirectory: () => false });
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/t1");
    ignoredOutput = ".venv/\0";
    watchCalls[0]!.cb("change", ".gitignore");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await Promise.resolve();
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

    expect(git).toHaveBeenCalledTimes(2);
    expect(webContents.send).toHaveBeenCalledTimes(1);

    watchCalls[0]!.cb("change", ".venv/installed");
    vi.advanceTimersByTime(WATCH_MAX_WAIT_MS);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("refreshes .git/info/exclude without feeding git metadata into a snapshot", async () => {
    vi.useFakeTimers();
    const git = vi.fn(async () => "");
    manager = makeManager({ git, gitPathIsDirectory: () => true });
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/repo");
    watchCalls[0]!.cb("change", ".git/info/exclude");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    await Promise.resolve();
    vi.advanceTimersByTime(WATCH_MAX_WAIT_MS);

    expect(git).toHaveBeenCalledTimes(2);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("restarts the watch when the ticket's worktree moved", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/old");
    await manager.watch(webContents as never, "t1", "/wt/old");
    expect(watchCalls).toHaveLength(1);

    // Removed and re-ensured at a fresh path inside one window's lifetime.
    await manager.watch(webContents as never, "t1", "/wt/new");
    expect(watchCalls).toHaveLength(2);
    expect(watchCalls[0]!.watcher.close).toHaveBeenCalled();
    expect(watchCalls[1]?.path).toBe("/wt/new");

    watchCalls[0]!.cb("change", "stale.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).not.toHaveBeenCalled();

    watchCalls[1]!.cb("change", "fresh.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("unwatchTicket drops every window's watch on that ticket", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const windowA = makeWebContents(1);
    const windowB = makeWebContents(2);

    await manager.watch(windowA as never, "t1", "/wt/t1");
    await manager.watch(windowB as never, "t1", "/wt/t1");
    await manager.watch(windowA as never, "t2", "/wt/t2");

    manager.unwatchTicket("t1");
    expect(watchCalls[0]!.watcher.close).toHaveBeenCalled();
    expect(watchCalls[1]!.watcher.close).toHaveBeenCalled();
    expect(watchCalls[2]!.watcher.close).not.toHaveBeenCalled();

    watchCalls[0]!.cb("change", "gone.ts");
    watchCalls[1]!.cb("change", "gone.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(windowA.send).not.toHaveBeenCalled();
    expect(windowB.send).not.toHaveBeenCalled();

    // The untouched ticket keeps working.
    watchCalls[2]!.cb("change", "still-here.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(windowA.send).toHaveBeenCalledWith("volli:worktree-changed", { ticketId: "t2" });
  });

  it("tells the renderer a watcher faulted, then tears the subscription down", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/t1");
    watchCalls[0]!.watcher.fail(new Error("EMFILE: too many open files"));

    expect(webContents.send).toHaveBeenCalledWith("volli:worktree-watch-error", {
      ticketId: "t1",
      error: "EMFILE: too many open files",
    });
    expect(watchCalls[0]!.watcher.close).toHaveBeenCalled();

    // Dead for good — no further change events from this subscription.
    watchCalls[0]!.cb("change", "after.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("maps a vanished-directory ENOENT to the shared missing sentence, so the rail can offer Recreate", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/does-not-exist");
    const enoent = new Error("ENOENT: no such file or directory, watch '/wt/does-not-exist'");
    Object.assign(enoent, { code: "ENOENT" });
    watchCalls[0]!.watcher.fail(enoent);

    expect(webContents.send).toHaveBeenCalledWith("volli:worktree-watch-error", {
      ticketId: "t1",
      error: WORKTREE_MISSING_ON_DISK,
    });
  });

  it("keeps the raw message when ENOENT does not mean the worktree is gone", async () => {
    const live = mkdtempSync(join(tmpdir(), "volli-watch-live-"));
    try {
      vi.useFakeTimers();
      manager = makeManager();
      const webContents = makeWebContents();

      await manager.watch(webContents as never, "t1", live);
      const enoent = new Error(`ENOENT: no such file or directory, watch '${live}'`);
      Object.assign(enoent, { code: "ENOENT" });
      watchCalls[0]!.watcher.fail(enoent);

      expect(webContents.send).toHaveBeenCalledWith("volli:worktree-watch-error", {
        ticketId: "t1",
        error: enoent.message,
      });
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });

  it("reports a synchronous arm-time ENOENT on a missing worktree as missing on disk", async () => {
    const enoent = new Error("ENOENT: no such file or directory, watch '/wt/gone'");
    Object.assign(enoent, { code: "ENOENT" });
    manager = new WorktreeChangeWatchManager({
      watch: () => {
        throw enoent;
      },
      debounceMs: WATCH_DEBOUNCE_MS,
      maxWaitMs: WATCH_MAX_WAIT_MS,
      git: async () => "",
      gitPathIsDirectory: () => false,
      now: () => Date.now(),
    });
    const webContents = makeWebContents();

    const result = await manager.watch(webContents as never, "t1", "/wt/gone");

    expect(result).toEqual({ ok: false, error: WORKTREE_MISSING_ON_DISK });
  });

  it("reports a non-Error arm failure by string rather than guessing a cause", async () => {
    manager = new WorktreeChangeWatchManager({
      watch: () => {
        throw "boom";
      },
      debounceMs: WATCH_DEBOUNCE_MS,
      maxWaitMs: WATCH_MAX_WAIT_MS,
      git: async () => "",
      gitPathIsDirectory: () => false,
      now: () => Date.now(),
    });
    const webContents = makeWebContents();

    const result = await manager.watch(webContents as never, "t1", "/wt/t1");

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("refuses to report a watch on a destroyed window as started", async () => {
    manager = makeManager();
    const webContents = makeWebContents();
    webContents.destroyed = true;

    const result = await manager.watch(webContents as never, "t1", "/wt/t1");

    expect(result.ok).toBe(false);
    expect(watchCalls).toHaveLength(0);
  });

  it("does not leak a watcher across tickets after unwatch", async () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    await manager.watch(webContents as never, "t1", "/wt/t1");
    const first = watchCalls[0]!;
    manager.unwatch(webContents as never, "t1");
    expect(first.watcher.close).toHaveBeenCalled();

    first.cb("change", "late.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).not.toHaveBeenCalled();

    await manager.watch(webContents as never, "t2", "/wt/t2");
    expect(watchCalls).toHaveLength(2);
    expect(watchCalls[1]?.path).toBe("/wt/t2");
  });
});
