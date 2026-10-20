import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WebContents } from "electron";
import { WorktreeChangeWatchManager } from "@volli/host-core/worktree";
import { clientEventSink, pageClientEventSink } from "./client-event-sink";

function contents(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
}

describe("one client's addressed host stream", () => {
  it("sends to exactly its WebContents on the unchanged channel", () => {
    const first = contents(1);
    const second = contents(2);
    const sink = clientEventSink(first as unknown as WebContents);
    sink.publish("worktree-changed", { ticketId: "t" });
    sink.publish("worktree-watch-error", { ticketId: "t", error: "gone" });
    expect(sink.id).toBe("1");
    expect(first.send.mock.calls).toEqual([
      ["volli:worktree-changed", { ticketId: "t" }],
      ["volli:worktree-watch-error", { ticketId: "t", error: "gone" }],
    ]);
    expect(second.send).not.toHaveBeenCalled();
    expect(clientEventSink(first as unknown as WebContents).id).toBe(sink.id);
  });

  it("reads and observes that same client's lifetime, removing only its hook", () => {
    const first = contents(1);
    const sink = clientEventSink(first as unknown as WebContents);
    const listener = vi.fn();
    expect(sink.isClosed()).toBe(false);
    first.isDestroyed.mockReturnValue(true);
    expect(sink.isClosed()).toBe(true);
    sink.onceClosed(listener);
    expect(first.once).toHaveBeenCalledExactlyOnceWith("destroyed", listener);
    sink.removeCloseListener(listener);
    expect(first.removeListener).toHaveBeenCalledExactlyOnceWith("destroyed", listener);
  });
});

/** A window's WebContents that can fire any page-lifetime event. */
function page(id = 1) {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  });
}

const asContents = (appPage: ReturnType<typeof page>): WebContents =>
  appPage as unknown as WebContents;

const PAGE_EVENTS = ["did-navigate", "render-process-gone", "destroyed"] as const;

describe("one page's addressed host stream (VC-831)", () => {
  it("is the same client on the same channel, closed only while the window is", () => {
    const appPage = page(7);
    const sink = pageClientEventSink(asContents(appPage));
    sink.publish("worktree-changed", { ticketId: "t" });
    expect(sink.id).toBe("7");
    expect(appPage.send).toHaveBeenCalledExactlyOnceWith("volli:worktree-changed", {
      ticketId: "t",
    });
    expect(sink.isClosed()).toBe(false);
    appPage.emit("did-navigate");
    // A reloaded page is a live client: only its old subscriptions closed.
    expect(sink.isClosed()).toBe(false);
    appPage.isDestroyed.mockReturnValue(true);
    expect(sink.isClosed()).toBe(true);
  });

  it.each(PAGE_EVENTS)("closes its subscriptions once on %s, and lets go of the page", (event) => {
    const appPage = page();
    const sink = pageClientEventSink(asContents(appPage));
    const listener = vi.fn();
    sink.onceClosed(listener);
    appPage.emit(event);
    for (const again of PAGE_EVENTS) appPage.emit(again);
    expect(listener).toHaveBeenCalledOnce();
    expect(appPage.eventNames()).toEqual([]);
    // Removing a hook that already fired is a no-op.
    sink.removeCloseListener(listener);
  });

  it("closes nothing on an in-page or refused navigation", () => {
    const appPage = page();
    const listener = vi.fn();
    pageClientEventSink(asContents(appPage)).onceClosed(listener);
    appPage.emit("did-navigate-in-page");
    appPage.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it("removes a hook through any sink for the same window, one registration at a time", () => {
    const appPage = page();
    const listener = vi.fn();
    const other = vi.fn();
    pageClientEventSink(asContents(appPage)).onceClosed(listener);
    pageClientEventSink(asContents(appPage)).onceClosed(listener);
    pageClientEventSink(asContents(appPage)).onceClosed(other);
    const remover = pageClientEventSink(asContents(appPage));
    remover.removeCloseListener(listener);
    appPage.emit("did-navigate");
    expect(listener).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();

    remover.removeCloseListener(other);
    const last = vi.fn();
    remover.onceClosed(last);
    remover.removeCloseListener(last);
    remover.removeCloseListener(last);
    appPage.emit("destroyed");
    expect(last).not.toHaveBeenCalled();
    expect(appPage.eventNames()).toEqual([]);
  });
});

// The worktree change watch, through the real manager: its recursive watcher
// must go with the page that opened it, not with the window (VC-831).
type WorktreeWatchFn = NonNullable<
  NonNullable<ConstructorParameters<typeof WorktreeChangeWatchManager>[0]>["watch"]
>;

describe("a worktree change watch across a reload (VC-831)", () => {
  const closes: Array<{ path: string; close: ReturnType<typeof vi.fn> }> = [];
  const watch: WorktreeWatchFn = (path) => {
    const close = vi.fn();
    closes.push({ path, close });
    return { close, on: vi.fn() } as unknown as ReturnType<WorktreeWatchFn>;
  };
  const manager = () =>
    new WorktreeChangeWatchManager({
      watch,
      git: async () => "",
      gitPathIsDirectory: () => false,
      rewatchGraceMs: 0,
    });

  afterEach(() => {
    closes.length = 0;
    vi.useRealTimers();
  });

  it.each(["did-navigate", "render-process-gone"] as const)(
    "closes the watcher of a rail the page opened before %s and never reopened",
    async (event) => {
      const appPage = page();
      const watches = manager();
      expect(await watches.watch(pageClientEventSink(asContents(appPage)), "t1", "/wt/t1")).toEqual(
        { ok: true },
      );
      expect(closes).toHaveLength(1);
      appPage.emit(event);
      expect(closes[0]?.close).toHaveBeenCalledOnce();
    },
  );

  it("closes the watcher when the reloaded page re-opens and then releases the rail", async () => {
    vi.useFakeTimers();
    const appPage = page();
    const watches = manager();
    await watches.watch(pageClientEventSink(asContents(appPage)), "t1", "/wt/t1");
    appPage.emit("did-navigate");
    await watches.watch(pageClientEventSink(asContents(appPage)), "t1", "/wt/t1");
    watches.unwatch(pageClientEventSink(asContents(appPage)), "t1");
    vi.runAllTimers();
    expect(closes).toHaveLength(2);
    for (const { close } of closes) expect(close).toHaveBeenCalledOnce();
    expect(appPage.eventNames()).toEqual([]);
  });

  it("keeps the watcher through an in-page navigation", async () => {
    const appPage = page();
    const watches = manager();
    await watches.watch(pageClientEventSink(asContents(appPage)), "t1", "/wt/t1");
    appPage.emit("did-navigate-in-page");
    expect(closes[0]?.close).not.toHaveBeenCalled();
  });
});
