import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  WATCH_DEBOUNCE_MS,
  WorktreeChangeWatchManager,
  type WorktreeWatchFn,
} from "./change-set-watch";

interface FakeWatcher {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

interface WatchCall {
  path: string;
  options: { recursive?: boolean } | undefined;
  cb: (eventType: string, filename: string | null) => void;
  watcher: FakeWatcher;
}

function makeFakeWatcher(): FakeWatcher {
  return { close: vi.fn(), on: vi.fn() };
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

  function makeManager(): WorktreeChangeWatchManager {
    const watchFn: WorktreeWatchFn = ((path, optionsOrCb, maybeCb) => {
      const options = typeof optionsOrCb === "function" ? undefined : optionsOrCb;
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb!;
      const watcher = makeFakeWatcher();
      watchCalls.push({ path, options, cb, watcher });
      return watcher as never;
    }) as WorktreeWatchFn;
    return new WorktreeChangeWatchManager({ watch: watchFn, debounceMs: WATCH_DEBOUNCE_MS });
  }

  it("debounces filesystem events and emits volli:worktree-changed for the ticket", () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    const result = manager.watch(webContents as never, "t1", "/wt/t1");
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

  it("does not leak a watcher across tickets after unwatch", () => {
    vi.useFakeTimers();
    manager = makeManager();
    const webContents = makeWebContents();

    manager.watch(webContents as never, "t1", "/wt/t1");
    const first = watchCalls[0]!;
    manager.unwatch(webContents as never, "t1");
    expect(first.watcher.close).toHaveBeenCalled();

    first.cb("change", "late.ts");
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(webContents.send).not.toHaveBeenCalled();

    manager.watch(webContents as never, "t2", "/wt/t2");
    expect(watchCalls).toHaveLength(2);
    expect(watchCalls[1]?.path).toBe("/wt/t2");
  });
});
