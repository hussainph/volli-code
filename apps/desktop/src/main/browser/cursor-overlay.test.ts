import type { Rectangle } from "electron";
import {
  SESSION_CURSOR_GLIDE_MAX_MS,
  SESSION_CURSOR_LABEL_PIN_MS,
  sessionCursorGlideMs,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabHolder } from "@volli/shared";
import {
  CURSOR_ASK_TO_LEAVE_CHANNEL,
  CURSOR_SETTLED_CHANNEL,
  CURSOR_SIZE_CHANNEL,
  CURSOR_TAKE_OVER_CHANNEL,
  CURSOR_TIP_INSET,
  type CursorOverlayState,
} from "../../ipc/cursor-contract";
import {
  createCursorOverlay,
  type CursorOverlayHost,
  type CursorOverlayIpc,
  type CursorOverlayView,
  type CursorOverlayWindow,
} from "./cursor-overlay";
import type { BrowserHoldEvent } from "./tab-host";

const A = { sessionId: "ses-a", attachmentId: "att-a" };
const HOLDER_A: BrowserTabHolder = {
  kind: "session",
  sessionId: "ses-a",
  name: "Alpha",
  color: "#aa0000",
};
const HOLDER_B: BrowserTabHolder = {
  kind: "session",
  sessionId: "ses-b",
  name: "Beta",
  color: "#0000bb",
};
const PAGE: Rectangle = { x: 100, y: 50, width: 800, height: 600 };

interface Harness {
  overlay: ReturnType<typeof createCursorOverlay>;
  /** Every state the page was sent. */
  pushed: CursorOverlayState[];
  /** Every setBounds call: bounds and whether it animated, and how long. */
  placed: { bounds: Rectangle; animateMs: number | null }[];
  /** Whether the view is in the window right now. */
  attached: () => boolean;
  /** The page acknowledging a seq, or pressing a label control. */
  page: {
    settle(seq: number): void;
    resize(size: unknown): void;
    takeOver(): void;
    askToLeave(): void;
  };
  /** A foreign sender speaking the same channels. */
  stranger: { settle(seq: number): void; takeOver(): void };
  host: {
    attach(tabId: string | null): void;
    hold(tabId: string, holder: BrowserTabHolder | null): void;
    emit(event: BrowserHoldEvent): void;
    takeOver: ReturnType<typeof vi.fn>;
    askToLeave: ReturnType<typeof vi.fn>;
    zoom: number;
  };
  reducedMotion: { value: boolean };
  views: number;
}

function harness(): Harness {
  const pushed: CursorOverlayState[] = [];
  const placed: { bounds: Rectangle; animateMs: number | null }[] = [];
  const holdListeners = new Set<(event: BrowserHoldEvent) => void>();
  const planeListeners = new Set<(attachedTabIds: readonly string[]) => void>();
  const holders = new Map<string, BrowserTabHolder | null>();
  const ipcListeners = new Map<
    string,
    Set<(event: { sender: { id: number } }, ...args: unknown[]) => void>
  >();
  let attachedTab: string | null = null;
  let inWindow: CursorOverlayView | null = null;
  let views = 0;
  const reducedMotion = { value: false };
  const hostState = { zoom: 1 };
  const takeOver = vi.fn();
  const askToLeave = vi.fn();

  const host: CursorOverlayHost = {
    // The host attaches a view per tab (VC-238); this fixture keeps one on
    // screen at a time, which is the case the cursor's rules are about.
    attachedTabIds: () => (attachedTab === null ? [] : [attachedTab]),
    isOnScreen: (tabId) => tabId === attachedTab,
    pageBoundsOf: (tabId) => (tabId === attachedTab ? { ...PAGE } : null),
    zoomFactorOf: () => hostState.zoom,
    heldBy: (tabId) => holders.get(tabId) ?? null,
    onHoldChange: (listener) => {
      holdListeners.add(listener);
      return () => holdListeners.delete(listener);
    },
    onPlaneChange: (listener) => {
      planeListeners.add(listener);
      return () => planeListeners.delete(listener);
    },
    takeOver,
    askToLeave,
  };
  const ipc: CursorOverlayIpc = {
    on: (channel, listener) => {
      const set = ipcListeners.get(channel) ?? new Set();
      set.add(listener);
      ipcListeners.set(channel, set);
    },
    removeListener: (channel, listener) => {
      ipcListeners.get(channel)?.delete(listener);
    },
  };
  const send = (channel: string, senderId: number, ...args: unknown[]): void => {
    for (const listener of ipcListeners.get(channel) ?? [])
      listener({ sender: { id: senderId } }, ...args);
  };
  const window: CursorOverlayWindow = {
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: CursorOverlayView) => {
        inWindow = view;
      },
      removeChildView: (view: CursorOverlayView) => {
        if (inWindow === view) inWindow = null;
      },
    },
  };
  const overlay = createCursorOverlay({
    host,
    ipc,
    createView: () => {
      views += 1;
      return {
        webContents: {
          id: 77,
          send: (_channel, payload) => pushed.push(payload as CursorOverlayState),
          isDestroyed: () => false,
        },
        setBounds: (bounds, options) =>
          placed.push({ bounds, animateMs: options?.animate?.duration ?? null }),
      };
    },
    getWindow: () => window,
    prefersReducedMotion: () => reducedMotion.value,
  });
  return {
    overlay,
    pushed,
    placed,
    attached: () => inWindow !== null,
    page: {
      settle: (seq) => send(CURSOR_SETTLED_CHANNEL, 77, seq),
      resize: (size) => send(CURSOR_SIZE_CHANNEL, 77, size),
      takeOver: () => send(CURSOR_TAKE_OVER_CHANNEL, 77),
      askToLeave: () => send(CURSOR_ASK_TO_LEAVE_CHANNEL, 77),
    },
    stranger: {
      settle: (seq) => send(CURSOR_SETTLED_CHANNEL, 12, seq),
      takeOver: () => send(CURSOR_TAKE_OVER_CHANNEL, 12),
    },
    host: {
      attach: (tabId) => {
        attachedTab = tabId;
        const onScreen = tabId === null ? [] : [tabId];
        for (const listener of planeListeners) listener(onScreen);
      },
      hold: (tabId, holder) => holders.set(tabId, holder),
      emit: (event) => {
        for (const listener of holdListeners) listener(event);
      },
      takeOver,
      askToLeave,
      get zoom() {
        return hostState.zoom;
      },
      set zoom(value: number) {
        hostState.zoom = value;
      },
    },
    reducedMotion,
    get views() {
      return views;
    },
  };
}

/** Settles whatever the page was last sent, the way a live page does at once. */
function pageAnswers(h: Harness): void {
  const last = h.pushed.at(-1);
  if (last !== undefined) h.page.settle(last.seq);
}

/** Runs a moveTo with the page answering each push at once, and the clock advancing. */
async function move(
  h: Harness,
  tabId: string,
  point: { x: number; y: number },
  gesture: "click" | "hover" | "type" | "scroll" = "click",
): Promise<void> {
  const driver = h.overlay.driverFor(tabId);
  const done = driver.moveTo(point, gesture);
  await Promise.resolve();
  pageAnswers(h);
  await vi.advanceTimersByTimeAsync(SESSION_CURSOR_GLIDE_MAX_MS + 200);
  await done;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCursorOverlay", () => {
  it("draws the on-screen tab's cursor at the target, tip inset, in the holder's colour and name", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");

    await move(h, "tab-a", { x: 40, y: 30 });

    expect(h.attached()).toBe(true);
    expect(h.views).toBe(1);
    expect(h.placed[0]).toEqual({
      bounds: {
        x: 100 + 40 - CURSOR_TIP_INSET,
        y: 50 + 30 - CURSOR_TIP_INSET,
        width: 44,
        height: 44,
      },
      animateMs: null,
    });
    // Moving, then the press: two pushes, the second wearing the ring.
    expect(h.pushed.map((state) => [state.gesture, state.pressKey, state.present])).toEqual([
      [null, 0, true],
      ["click", 1, true],
    ]);
    expect(h.pushed[0]).toMatchObject({ color: "#aa0000", name: "Alpha", handoff: false });
  });

  it("several Sessions: each tab keeps its own cursor, only the on-screen one is drawn, and colours differ", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.hold("tab-b", HOLDER_B);
    h.host.attach("tab-a");

    await move(h, "tab-a", { x: 10, y: 10 });
    const pushesAfterA = h.pushed.length;

    // B drives its tab off screen: no push, no view change, and no delay —
    // the promise settles without the clock moving.
    const offScreen = h.overlay.driverFor("tab-b").moveTo({ x: 300, y: 200 }, "click");
    await Promise.resolve();
    await Promise.resolve();
    await expect(offScreen).resolves.toBeUndefined();
    expect(h.pushed).toHaveLength(pushesAfterA);

    // Switching to B's tab shows B's cursor at its last position, in B's
    // colour, with no glide from wherever A's cursor was.
    h.host.attach("tab-b");
    expect(h.pushed.at(-1)).toMatchObject({ color: "#0000bb", name: "Beta", gesture: "click" });
    expect(h.placed.at(-1)).toEqual({
      bounds: {
        x: 100 + 300 - CURSOR_TIP_INSET,
        y: 50 + 200 - CURSOR_TIP_INSET,
        width: 44,
        height: 44,
      },
      animateMs: null,
    });
  });

  it("glides between targets on the app's distance-scaled curve, and dispatches only once it has landed", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });

    const driver = h.overlay.driverFor("tab-a");
    let landed = false;
    const done = driver.moveTo({ x: 310, y: 410 }, "click").then(() => {
      landed = true;
    });
    await Promise.resolve();
    const expected = sessionCursorGlideMs(500, false);
    expect(h.placed.at(-1)?.animateMs).toBe(expected);

    // The page has drawn it; the view is still gliding. Not landed yet.
    pageAnswers(h);
    await vi.advanceTimersByTimeAsync(expected - 10);
    expect(landed).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(landed).toBe(true);
  });

  it("goes ahead without the page: an overlay that never answers holds the action only to the bound", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");

    let landed = false;
    const done = h.overlay
      .driverFor("tab-a")
      .moveTo({ x: 10, y: 10 }, "hover")
      .then(() => {
        landed = true;
      });
    await vi.advanceTimersByTimeAsync(SESSION_CURSOR_GLIDE_MAX_MS + 50);
    expect(landed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(landed).toBe(true);
    expect(h.pushed.at(-1)?.gesture).toBe("hover");
  });

  it("jumps under reduced motion: no animated bounds, and the page is told", async () => {
    const h = harness();
    h.reducedMotion.value = true;
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });
    await move(h, "tab-a", { x: 600, y: 400 });

    expect(h.placed.every((placement) => placement.animateMs === null)).toBe(true);
    expect(h.pushed.every((state) => state.reducedMotion)).toBe(true);
  });

  it("parks at a field while typing and clears the typing state when the text is in; nudges on scroll", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");

    await move(h, "tab-a", { x: 20, y: 20 }, "type");
    expect(h.pushed.at(-1)?.gesture).toBe("type");
    h.overlay.driverFor("tab-a").gesture(null);
    expect(h.pushed.at(-1)?.gesture).toBeNull();

    await move(h, "tab-a", { x: 400, y: 300 }, "scroll");
    expect(h.pushed.at(-1)?.gesture).toBe("scroll");
    // A press does not ring twice for a type or a scroll.
    expect(h.pushed.at(-1)?.pressKey).toBe(0);

    // A gesture for a tab that has no cursor yet is nothing.
    expect(() => h.overlay.driverFor("tab-z").gesture("click")).not.toThrow();
  });

  it("pins the label when a hold begins and lets it go after a moment", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    // Nothing to draw until the first action places it.
    expect(h.pushed).toHaveLength(0);

    await move(h, "tab-a", { x: 10, y: 10 });
    expect(h.pushed.at(-1)?.labelPinned).toBe(true);
    await vi.advanceTimersByTimeAsync(SESSION_CURSOR_LABEL_PIN_MS + 10);
    expect(h.pushed.at(-1)?.labelPinned).toBe(false);
  });

  it("pins the label from when the page could first draw it, not from a boot it slept through", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    await move(h, "tab-a", { x: 10, y: 10 });

    // The overlay's page is built lazily by that first draw and boots slowly —
    // slower here than the whole pin. Every push so far went at a page that
    // was not listening yet, so nobody has seen the label.
    await vi.advanceTimersByTimeAsync(SESSION_CURSOR_LABEL_PIN_MS + 500);
    expect(h.pushed.at(-1)?.labelPinned).toBe(false);

    // Its first word is its size. From here it can hear, so the pin it slept
    // through runs now: without this the person is never told which Session
    // took their tab, and the view never grows past the bare arrow.
    h.page.resize({ width: 181, height: 40 });
    expect(h.pushed.at(-1)?.labelPinned).toBe(true);

    // And it still lets go a moment later, exactly as on a fast boot.
    await vi.advanceTimersByTimeAsync(SESSION_CURSOR_LABEL_PIN_MS + 10);
    expect(h.pushed.at(-1)?.labelPinned).toBe(false);
  });

  it("leaves a pin that is still live alone when the page reports, rather than extending it", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    await move(h, "tab-a", { x: 10, y: 10 });

    // A page that booted inside the pin — the fast path, which already worked.
    await vi.advanceTimersByTimeAsync(200);
    h.page.resize({ width: 181, height: 40 });
    expect(h.pushed.at(-1)?.labelPinned).toBe(true);

    // The pin ends on its ORIGINAL schedule; being heard does not restart it.
    await vi.advanceTimersByTimeAsync(SESSION_CURSOR_LABEL_PIN_MS - 200 + 10);
    expect(h.pushed.at(-1)?.labelPinned).toBe(false);
  });

  it("fades out when the hold ends with the turn, then forgets the tab and leaves the plane", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });

    h.host.hold("tab-a", null);
    h.host.emit({ kind: "released", tabId: "tab-a", holder: A, why: "turn-end" });
    // The exit is drawn in the colour of the hold that ended.
    expect(h.pushed.at(-1)).toMatchObject({ present: false, handoff: false, color: "#aa0000" });
    expect(h.attached()).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(h.attached()).toBe(false);

    // The next turn's first write draws it fresh.
    h.host.hold("tab-a", HOLDER_A);
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    await move(h, "tab-a", { x: 50, y: 50 });
    expect(h.pushed.at(-1)).toMatchObject({ present: true, labelPinned: true });
  });

  it("hands off rather than vanishing when the person takes over", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });

    h.host.hold("tab-a", { kind: "person" });
    h.host.emit({ kind: "released", tabId: "tab-a", holder: A, why: "takeover" });
    expect(h.pushed.at(-1)).toMatchObject({ present: false, handoff: true });
    h.host.emit({
      kind: "person-took",
      tabId: "tab-a",
      tabTitle: "",
      tabHostname: "",
      displaced: A,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.attached()).toBe(false);
  });

  it("ends a hold that never drew anything without leaving state behind", () => {
    const h = harness();
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    h.host.emit({ kind: "released", tabId: "tab-a", holder: A, why: "closed" });
    h.host.emit({ kind: "person-handed-back", tabId: "tab-a" });
    h.host.emit({ kind: "ask-to-leave", tabId: "tab-a", tabTitle: "", tabHostname: "", holder: A });
    expect(h.pushed).toHaveLength(0);
    expect(h.attached()).toBe(false);
  });

  it("yields with the plane: an app overlay detaches the view, and reattachment brings it back where it was", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });
    expect(h.attached()).toBe(true);

    h.host.attach(null);
    expect(h.attached()).toBe(false);

    h.host.attach("tab-a");
    expect(h.attached()).toBe(true);
    expect(h.placed.at(-1)).toEqual({
      bounds: {
        x: 100 + 10 - CURSOR_TIP_INSET,
        y: 50 + 10 - CURSOR_TIP_INSET,
        width: 44,
        height: 44,
      },
      animateMs: null,
    });
    // One view for the life of the overlay, re-added rather than rebuilt.
    expect(h.views).toBe(1);
  });

  it("maps page pixels through the zoom factor and keeps the tip inside the page", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    h.host.zoom = 2;
    await move(h, "tab-a", { x: 100, y: 100 });
    expect(h.placed.at(-1)?.bounds).toMatchObject({
      x: 100 + 200 - CURSOR_TIP_INSET,
      y: 50 + 200 - CURSOR_TIP_INSET,
    });
    // Past the page's edge, the tip is clamped to it.
    await move(h, "tab-a", { x: 5_000, y: -20 });
    expect(h.placed.at(-1)?.bounds).toMatchObject({
      x: 100 + 800 - CURSOR_TIP_INSET,
      y: 50 - CURSOR_TIP_INSET,
    });
  });

  it("sizes the view to the drawing the page reports, in place, and ignores nonsense", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });
    const before = h.placed.length;

    h.page.resize({ width: 180.4, height: 40 });
    expect(h.placed.at(-1)?.bounds).toMatchObject({ width: 181, height: 40 });
    expect(h.placed.at(-1)?.bounds.x).toBe(h.placed[before - 1]?.bounds.x);

    h.page.resize({ width: 0, height: 40 });
    h.page.resize("wide");
    h.page.resize(undefined);
    expect(h.placed).toHaveLength(before + 1);
  });

  it("relays Take over and Ask to leave from the label to the host for the on-screen tab, and from nobody else", () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    // The view exists once anything has been drawn; before that, presses from
    // anywhere are nothing.
    h.page.takeOver();
    expect(h.host.takeOver).not.toHaveBeenCalled();

    void h.overlay.driverFor("tab-a").moveTo({ x: 1, y: 1 }, "hover");
    h.page.takeOver();
    h.page.askToLeave();
    expect(h.host.takeOver).toHaveBeenCalledWith("tab-a");
    expect(h.host.askToLeave).toHaveBeenCalledWith("tab-a");

    h.stranger.takeOver();
    h.stranger.settle(999);
    expect(h.host.takeOver).toHaveBeenCalledTimes(1);

    h.host.attach(null);
    h.page.takeOver();
    expect(h.host.takeOver).toHaveBeenCalledTimes(1);
  });

  it("ignores a settle that names no seq, and a withdrawn move", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    void h.overlay.driverFor("tab-a").moveTo({ x: 1, y: 1 }, "hover");
    expect(() => h.page.settle("soon" as unknown as number)).not.toThrow();

    const withdrawn = new AbortController();
    withdrawn.abort(new Error("turn over"));
    await expect(
      h.overlay.driverFor("tab-a").moveTo({ x: 2, y: 2 }, "click", withdrawn.signal),
    ).rejects.toThrow("turn over");
  });

  it("draws nothing without a window, and disposes cleanly", async () => {
    const h = harness();
    h.host.hold("tab-a", HOLDER_A);
    h.host.attach("tab-a");
    await move(h, "tab-a", { x: 10, y: 10 });
    expect(h.attached()).toBe(true);

    h.overlay.dispose();
    expect(h.attached()).toBe(false);
    // Nothing listens any more: a hold event and a plane change draw nothing.
    h.host.emit({ kind: "taken", tabId: "tab-a", holder: A });
    h.host.attach("tab-a");
    expect(h.attached()).toBe(false);
    h.page.takeOver();
    expect(h.host.takeOver).not.toHaveBeenCalled();
  });
});
