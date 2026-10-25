/**
 * The app's windows as menu-bar mode and the return doors see them (VC-577),
 * over the real flush-and-ack barrier: each fake window's renderer is asked
 * over `volli:client-state-flush`, and the test answers as that renderer. The
 * barrier's overdue timer is a manual clock; the Immediate that defers native
 * destruction is the real one.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { captureHostLog } from "@volli/host-core/testing";

import { answerSecondInstance, createAppWindows } from "./app-windows";
import { createClientStateFlush, MENU_BAR_FLUSH_OVERDUE_MS } from "./client-state-flush";

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A window as the module touches it; its renderer's flush requests are remembered. */
function fakeWindow(id: number, name: string, calls: string[], requests: Map<string, unknown>) {
  let destroyed = false;
  let rendererGone = false;
  return {
    id,
    name,
    hide: () => {
      calls.push(`${name}.hide`);
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      calls.push(`${name}.destroy`);
    },
    loseRenderer: () => {
      rendererGone = true;
    },
    webContents: {
      isDestroyed: () => rendererGone,
      send: (channel: string, requestId: unknown) => {
        calls.push(
          channel === "volli:client-state-flush" ? `${name}.flush-asked` : `${name}.${channel}`,
        );
        requests.set(name, requestId);
      },
    },
  };
}

function appWindows(names: readonly string[] = ["a", "b"]) {
  const calls: string[] = [];
  const requests = new Map<string, unknown>();
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 0;
  let nextRequestId = 0;
  const flush = createClientStateFlush({
    newRequestId: () => `req-${++nextRequestId}`,
    timers: {
      setTimeout: (run, ms) => {
        nextTimer += 1;
        timers.set(nextTimer, { run, ms });
        return nextTimer;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    log: () => {},
  });
  const all = names.map((name, index) => fakeWindow(index + 1, name, calls, requests));
  const create = vi.fn();
  const reveal = vi.fn();
  const windows = createAppWindows({
    // As `BrowserWindow.getAllWindows`: a destroyed window is no longer listed.
    all: () => all.filter((window) => !window.isDestroyed()),
    create,
    reveal,
    flush,
  });
  return {
    windows,
    port: windows.menuBarPort,
    a: all[0]!,
    b: all[1]!,
    calls,
    create,
    reveal,
    /** The named window's renderer acks its latest flush request. */
    ack: (name: string) => flush.acknowledge(requests.get(name)),
    /** The barrier's pending bounds, in ms. */
    bounds: () => [...timers.values()].map((timer) => timer.ms),
    overdue: () => {
      for (const [id, timer] of timers) {
        timers.delete(id);
        timer.run();
      }
    },
  };
}

describe("menu-bar entry's windows (VC-577 B2)", () => {
  it("hides every window, then destroys each one only from its own renderer's flush ack", async () => {
    const captured = captureHostLog();
    try {
      const w = appWindows();
      w.port.closeAll();
      expect(w.calls).toEqual(["a.hide", "b.hide", "a.flush-asked", "b.flush-asked"]);
      expect(w.bounds()).toEqual([MENU_BAR_FLUSH_OVERDUE_MS]);
      // Retired at once: hidden windows no longer count as open.
      expect(w.port.count()).toBe(0);
      w.ack("a");
      // Never inside the acknowledgement itself.
      expect(w.a.isDestroyed()).toBe(false);
      await nextImmediate();
      expect(w.calls.at(-1)).toBe("a.destroy");
      expect(w.b.isDestroyed()).toBe(false);
      w.ack("b");
      expect(w.b.isDestroyed()).toBe(false);
      await nextImmediate();
      expect(w.calls.at(-1)).toBe("b.destroy");
      // Both answered inside the bound: it is cleared, and nothing warns.
      expect(w.bounds()).toEqual([]);
      await nextImmediate();
      expect(captured.of("menu-bar").filter((record) => record.level === "warn")).toEqual([]);
      expect(captured.of("menu-bar").map((record) => [record.msg, record["windowId"]])).toEqual([
        ["window draft flush acknowledged", 1],
        ["destroying acknowledged window", 1],
        ["acknowledged window destroyed", 1],
        ["window draft flush acknowledged", 2],
        ["destroying acknowledged window", 2],
        ["acknowledged window destroyed", 2],
      ]);
    } finally {
      captured.restore();
    }
  });

  it("never destroys an unflushed window: overdue logs and keeps it hidden until its ack", async () => {
    const captured = captureHostLog();
    try {
      const w = appWindows();
      w.port.closeAll();
      w.ack("a");
      await nextImmediate();
      w.overdue();
      await nextImmediate();
      expect(captured.of("menu-bar").filter((record) => record.level === "warn")).toEqual([
        expect.objectContaining({
          msg: "windows still saving drafts; kept hidden, not destroyed",
          unanswered: 1,
        }),
      ]);
      expect(w.b.isDestroyed()).toBe(false);
      // Still retiring: hidden, and not counted as open.
      expect(w.port.count()).toBe(0);
      // The slow renderer finally saved its latest draft: now it may go.
      w.ack("b");
      expect(w.b.isDestroyed()).toBe(false);
      await nextImmediate();
      expect(w.b.isDestroyed()).toBe(true);
    } finally {
      captured.restore();
    }
  });

  it("a reveal reuses a window still saving its drafts, and its late ack then keeps it", async () => {
    const w = appWindows();
    w.port.closeAll();
    w.ack("a");
    await nextImmediate();
    w.port.open();
    expect(w.create).not.toHaveBeenCalled();
    expect(w.reveal).toHaveBeenCalledExactlyOnceWith(w.b);
    expect(w.port.count()).toBe(1);
    w.ack("b");
    await nextImmediate();
    expect(w.b.isDestroyed()).toBe(false);
    // With nothing retained, a reveal builds a fresh window.
    w.b.destroy();
    w.port.open();
    expect(w.create).toHaveBeenCalledOnce();
  });

  it("a reveal after the flush ack but before native destruction cancels the deferred teardown", async () => {
    const w = appWindows();
    w.port.closeAll();
    w.ack("a");
    w.port.open();
    expect(w.reveal).toHaveBeenCalledExactlyOnceWith(w.a);
    await nextImmediate();
    expect(w.a.isDestroyed()).toBe(false);
    expect(w.port.count()).toBe(1);
    expect(w.b.isDestroyed()).toBe(false);
  });

  it("an already destroyed acknowledged window is not destroyed again by its Immediate", async () => {
    const w = appWindows();
    w.port.closeAll();
    w.ack("a");
    w.a.destroy();
    await nextImmediate();
    expect(w.calls.filter((call) => call === "a.destroy")).toHaveLength(1);
  });
});

describe("a system shutdown's window flush (VC-577)", () => {
  it("asks every window, a hidden one included, and skips a renderer already gone", async () => {
    const w = appWindows();
    w.port.closeAll();
    w.calls.length = 0;
    w.b.loseRenderer();
    const outcome = w.windows.flushAll(2_000);
    expect(w.calls).toEqual(["a.flush-asked"]);
    expect(w.bounds()).toContain(2_000);
    w.ack("a");
    await expect(outcome).resolves.toEqual({ acked: 1, unanswered: 0 });
  });
});

describe("window returns through the menu-bar host (VC-577)", () => {
  it("activate with no open window reveals through the menu-bar host; with one, does nothing", () => {
    const menuBar = { noteActivated: vi.fn(), reveal: vi.fn() };
    appWindows([]).windows.activated(menuBar);
    expect(menuBar.reveal).toHaveBeenCalledExactlyOnceWith();
    // Every activation ends a noted logout (VC-577 B3), window or not.
    expect(menuBar.noteActivated).toHaveBeenCalledOnce();
    const open = appWindows(["a"]);
    open.windows.activated(menuBar);
    expect(menuBar.reveal).toHaveBeenCalledOnce();
    expect(menuBar.noteActivated).toHaveBeenCalledTimes(2);
    // A window menu-bar entry hid while its drafts flush is not an open one.
    open.port.closeAll();
    open.windows.activated(menuBar);
    expect(menuBar.reveal).toHaveBeenCalledTimes(2);
  });

  it("a notification click with no window reveals through the menu-bar host once it exists", () => {
    const none = appWindows([]);
    const reveal = vi.fn();
    none.windows.openForNotification({ reveal });
    expect(reveal).toHaveBeenCalledOnce();
    expect(none.create).not.toHaveBeenCalled();
    // Before the host exists (boot), exactly the former body.
    none.windows.openForNotification(null);
    expect(none.create).toHaveBeenCalledOnce();
    const one = appWindows(["a"]);
    one.windows.openForNotification(null);
    expect(one.create).not.toHaveBeenCalled();
  });

  it("second launch with no window: today's early return with the flag off, a reveal with it on", () => {
    for (const cloud of [false, true]) {
      const revealForLaunch = vi.fn();
      const show = vi.fn();
      answerSecondInstance(undefined, {
        cloudEnabled: () => cloud,
        revealForLaunch,
        show,
        quiet: false,
      });
      expect(revealForLaunch).toHaveBeenCalledTimes(cloud ? 1 : 0);
      expect(show).not.toHaveBeenCalled();
    }
    // Flag on before the window factory exists: nothing to open yet.
    expect(() =>
      answerSecondInstance(undefined, {
        cloudEnabled: () => true,
        revealForLaunch: null,
        show: vi.fn(),
        quiet: false,
      }),
    ).not.toThrow();
  });

  it("second launch with a window: restores, shows and focuses it, never focusing a quiet one", () => {
    for (const [minimized, quiet, want] of [
      [true, false, ["restore", "show", "focus"]],
      [false, false, ["show", "focus"]],
      [true, true, ["restore", "show"]],
    ] as const) {
      const calls: string[] = [];
      const window = {
        isMinimized: () => minimized,
        restore: () => calls.push("restore"),
        focus: () => calls.push("focus"),
      };
      const cloudEnabled = vi.fn(() => true);
      const revealForLaunch = vi.fn();
      answerSecondInstance(window, {
        cloudEnabled,
        revealForLaunch,
        show: (shown) => {
          expect(shown).toBe(window);
          calls.push("show");
        },
        quiet,
      });
      expect(calls).toEqual(want);
      expect(cloudEnabled).not.toHaveBeenCalled();
      expect(revealForLaunch).not.toHaveBeenCalled();
    }
  });
});
