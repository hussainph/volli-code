import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  REMOTE_LISTING_DEBOUNCE_MS,
  REMOTE_LISTING_POLL_MS,
  startRemoteListingRefresh,
  type RemoteListingRefresh,
  type RemoteListingRefreshPorts,
} from "./remote-listing-refresh";

let reads: string[];
let reconnect: ((workspaceId: string) => void) | null;
let focus: (() => void) | null;
let unsubscribed: string[];
let state: {
  workspaces: string[];
  visible: string[];
  ready: Set<string>;
  windowVisible: boolean;
  hold: Map<string, () => void>;
};
let scheduler: RemoteListingRefresh | null;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  reads = [];
  unsubscribed = [];
  reconnect = null;
  focus = null;
  scheduler = null;
  state = {
    workspaces: ["a", "b"],
    visible: ["a"],
    ready: new Set(["a", "b"]),
    windowVisible: true,
    hold: new Map(),
  };
});

afterEach(() => {
  scheduler?.stop();
  vi.useRealTimers();
});

function start(holdReads = false): RemoteListingRefresh {
  const ports: RemoteListingRefreshPorts = {
    workspaces: () => state.workspaces,
    visible: () => state.visible,
    ready: (id) => state.ready.has(id),
    windowVisible: () => state.windowVisible,
    refresh: (id) => {
      reads.push(id);
      if (!holdReads) return Promise.resolve();
      return new Promise<void>((resolve) => state.hold.set(id, resolve));
    },
    onReconnect: (listener) => {
      reconnect = listener;
      return () => unsubscribed.push("reconnect");
    },
    onFocus: (listener) => {
      focus = listener;
      return () => unsubscribed.push("focus");
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  };
  scheduler = startRemoteListingRefresh(ports);
  return scheduler;
}

describe("re-reading remote listings (VC-713)", () => {
  it("polls only the visible project, every interval, while the window is visible", async () => {
    start();
    expect(reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(reads).toEqual(["a"]);
    state.windowVisible = false;
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(reads).toEqual(["a"]);
    state.windowVisible = true;
    state.ready.delete("a");
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(reads).toEqual(["a"]);
  });

  it("never polls a visible id that is not an opened remote Workspace", async () => {
    state.visible = ["local-project"];
    start();
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(reads).toEqual([]);
  });

  it("reads every ready Workspace on focus, and a reconnected one at once", async () => {
    state.ready.delete("b");
    start();
    focus!();
    expect(reads).toEqual(["a"]);
    state.ready.add("b");
    reconnect!("b");
    expect(reads).toEqual(["a", "b"]);
    // A link this window never opened is not ours to read.
    reconnect!("elsewhere");
    expect(reads).toEqual(["a", "b"]);
  });

  it("collapses a burst into one read now and one trailing read", async () => {
    const refresh = start();
    focus!();
    reconnect!("a");
    refresh.refreshAll();
    expect(reads).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS);
    expect(reads).toEqual(["a", "b", "a", "b"]);
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS);
    expect(reads).toEqual(["a", "b", "a", "b"]);
  });

  it("keeps one read in flight per Workspace, and reads again once it settles", async () => {
    state.workspaces = ["a"];
    start(true);
    focus!();
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS + 1);
    focus!();
    expect(reads).toEqual(["a"]);
    // The trailing read finds the first still in flight and waits a window more.
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS);
    expect(reads).toEqual(["a"]);
    state.hold.get("a")!();
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS);
    expect(reads).toEqual(["a", "a"]);
  });

  it("drops a trailing read whose link went away meanwhile", async () => {
    start();
    focus!();
    focus!();
    state.ready.delete("a");
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_DEBOUNCE_MS);
    expect(reads).toEqual(["a", "b", "b"]);
  });

  it("reads everything after a sleep the poll slept through", async () => {
    state.windowVisible = false;
    start();
    // The process was frozen: the tick fires minutes late.
    vi.setSystemTime(Date.now() + 10 * REMOTE_LISTING_POLL_MS);
    await vi.advanceTimersByTimeAsync(REMOTE_LISTING_POLL_MS);
    expect(reads).toEqual(["a", "b"]);
  });

  it("swallows a failed read: the reader reports it, and the schedule carries on", async () => {
    const ports = {
      workspaces: () => ["a"],
      visible: () => ["a"],
      ready: () => true,
      windowVisible: () => true,
      refresh: vi.fn(async () => {
        throw new Error("link dropped");
      }),
      onReconnect: () => () => {},
      onFocus: () => () => {},
      clock: {
        now: () => Date.now(),
        setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    };
    scheduler = startRemoteListingRefresh(ports);
    await vi.advanceTimersByTimeAsync(2 * REMOTE_LISTING_POLL_MS);
    expect(ports.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops every timer and subscription at once, and reads nothing after", async () => {
    const refresh = start();
    focus!();
    focus!();
    refresh.stop();
    refresh.stop();
    expect(unsubscribed).toEqual(["reconnect", "focus"]);
    await vi.advanceTimersByTimeAsync(5 * REMOTE_LISTING_POLL_MS);
    refresh.refreshAll();
    expect(reads).toEqual(["a", "b"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
