// @vitest-environment jsdom
/**
 * Following a streaming reply against the real `use-stick-to-bottom` (VC-1234).
 *
 * jsdom has no layout, so the scroller's geometry is ours, and so is the
 * browser's frame: `frame()` runs one in the browser's order. First the
 * scroll event for a position that moved, then the animation callbacks (the
 * library's following loop), then layout, where a streaming line lands and the
 * library's ResizeObserver reports it, and only then timers. That order is
 * what makes the library throw away a reader's scroll in a frame where the
 * reply grows: its one-millisecond judgement of the scroll runs after the
 * observer has set `resizeDifference`.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { SCROLL_THUMB_GRAB_EVENT } from "@renderer/lib/scroll-thumb/overlay-scrollbars";

import { Conversation, ConversationContent, useStopFollowing } from "./conversation";

const VIEWPORT = 800;
const LINE = 18;
let contentHeight = 0;
let position = 0;
let lastReported = 0;
let resizeCallbacks: ResizeObserverCallback[] = [];
let stopFollowing: () => void = () => {};

/** Stands in for a disclosure or a jump: the transcript's own `stopFollowing`. */
function Reader() {
  stopFollowing = useStopFollowing();
  return <p>transcript</p>;
}
let animationCallbacks: FrameRequestCallback[] = [];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let scroller: HTMLElement;

const end = () => contentHeight - VIEWPORT;
const fromEnd = () => end() - position;
const settle = () => new Promise((resolve) => setTimeout(resolve, 4));
const microtasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/**
 * One browser frame, optionally with content growing (or shrinking) in its
 * layout. `readFirst`: the growth is already laid out when the scroll event
 * reads the geometry, as when a scroll handler forces layout over a pending
 * commit; the observer still reports it after the frame's callbacks.
 */
async function frame(grow = 0, { readFirst = false } = {}) {
  await act(async () => {
    if (readFirst) contentHeight += grow;
    if (position !== lastReported) {
      lastReported = position;
      scroller.dispatchEvent(new Event("scroll"));
    }
    const callbacks = animationCallbacks;
    animationCallbacks = [];
    for (const callback of callbacks) callback(performance.now());
    await microtasks();
    if (grow !== 0) {
      if (!readFirst) contentHeight += grow;
      position = Math.min(position, end());
      for (const callback of resizeCallbacks) {
        callback(
          [{ contentRect: { height: contentHeight } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
      await microtasks();
    }
    await settle();
  });
}

/** A streaming reply: a line every other frame, the last frame without one. */
async function stream(frames: number) {
  const seen: number[] = [];
  for (let i = 0; i < frames; i++) {
    await frame(i % 2 === 0 ? LINE : 0);
    seen.push(fromEnd());
  }
  return seen;
}

/** Where the reader rests once the reply stops: at the end if following. */
async function rest() {
  for (let i = 0; i < 3; i++) await frame();
  return fromEnd();
}

/** A key pressed on what has focus in the transcript (its text, here). */
const keyInTranscript = (key: string) =>
  act(async () => {
    scroller
      .querySelector("p")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

/** The library's following loop runs on the next frame's callbacks. */
async function animationCallbacksOnly() {
  await act(async () => {
    const callbacks = animationCallbacks;
    animationCallbacks = [];
    for (const callback of callbacks) callback(performance.now());
    await microtasks();
  });
}

/** Lets the library's and this hook's one-millisecond timers run. */
const settleTimers = () => act(async () => settle());

/** The content observers report the current height, with no growth. */
async function observe() {
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback(
        [{ contentRect: { height: contentHeight } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
    await microtasks();
  });
}

/** Lets the half-second a wheel or key counts as the reader's hand run out. */
const handLifts = () => new Promise((resolve) => setTimeout(resolve, 600));

const wheel = (deltaY: number) =>
  act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resizeCallbacks = [];
  animationCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationCallbacks.push(callback);
    return animationCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Conversation>
        <ConversationContent>
          <Reader />
        </ConversationContent>
      </Conversation>,
    ),
  );
  scroller = host.querySelector<HTMLElement>("[data-conversation-scroller]")!;
  contentHeight = 20_000;
  position = end();
  lastReported = position;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = Math.max(0, Math.min(value, end()));
      },
    },
  });
  // The transcript as it opens: its first observation, at the end, following.
  await frame(1);
  // Following trails a line by one frame: it lands in layout, and the
  // library's loop writes on the next frame's animation callbacks.
  const following = await stream(6);
  expect(Math.max(...following)).toBeLessThanOrEqual(LINE + 1);
  expect(following.at(-1)).toBeLessThanOrEqual(1);
  // The scroll event for the library's last write, before the reader acts.
  await frame();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** The reader wheels well up from the end and reads there while the reply grows. */
async function readUp() {
  await wheel(-400);
  position -= 400;
  const away = await stream(6);
  expect(away.at(-1)).toBeGreaterThan(400);
}

const grab = () =>
  act(async () => {
    scroller.dispatchEvent(new Event(SCROLL_THUMB_GRAB_EVENT));
  });
// The thumb swallows its pointerup; the end of its pointer capture is what is left.
const letGo = () =>
  act(async () => {
    document.body.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true }));
  });
const none = async () => {};

for (const [how, before, after] of [
  ["wheel", (by: number) => wheel(by), none],
  ["a thumb drag", grab, letGo],
  // A scroll no input announces: only the position moves.
  ["a scripted scroll", none, none],
] as const) {
  it(`follows a reader who arrives by ${how} within the zone in a frame where a line lands`, async () => {
    for (const stop of [0, 18, 69]) {
      await readUp();
      await before(fromEnd() - stop);
      position = end() - stop;
      // The line lands in the very frame the reader arrives: the library
      // discards the arrival, and on main the reply runs on below the fold.
      await frame(2 * LINE);
      await after();
      await stream(10);
      expect(await rest(), `stopped ${stop}px from the end`).toBeLessThanOrEqual(1);
    }
  });
}

it("does not follow a reader who stops just outside the zone", async () => {
  await readUp();
  position = end() - 90;
  await frame();
  const after = await stream(10);
  expect(after.at(-1)).toBeGreaterThan(90);
});

it("releases a reader who scrolls up by key in a frame where a line lands, and keeps them released", async () => {
  await keyInTranscript("ArrowUp");
  // A smooth 40px step over three frames, the first sharing its frame with a line.
  position -= 14;
  await frame(LINE);
  position -= 13;
  await frame();
  position -= 13;
  await frame(LINE);
  const after = await stream(20);
  // On main the step is discarded, the lock holds, and the next line pulls the
  // reader back to the end.
  expect(Math.min(...after)).toBeGreaterThan(40);
  expect(after.at(-1)).toBeGreaterThan(after[0]!);
});

it("releases a reader who drags the thumb up in a frame where a line lands", async () => {
  await grab();
  position -= 100;
  await frame(LINE);
  await letGo();
  const after = await stream(20);
  expect(Math.min(...after)).toBeGreaterThan(100);
});

it("keeps a reader released who drags the thumb a little up, holds it while the reply grows, and lets go", async () => {
  await grab();
  position -= 40;
  await frame();
  // Held still: a frame after each line lands, the thumb keeps its share of
  // the longer range (VC-1217), which raises scrollTop with nobody moving. Its
  // scroll event comes once the library has stopped discarding for the line.
  for (let i = 0; i < 6; i++) {
    const share = position / end();
    await frame(LINE);
    await frame();
    position = Math.round(share * end());
    await frame();
  }
  await frame();
  expect(fromEnd()).toBeGreaterThan(40);
  // A last small step up, in the frame a line lands and is laid out before
  // the scroll event reads it. Then let go: the thumb's update still keeps
  // its place once, a frame after the release.
  position -= 5;
  const share = position / end();
  await frame(LINE, { readFirst: true });
  await letGo();
  await frame();
  position = Math.round(share * end());
  await frame();
  const after = await stream(10);
  expect(Math.min(...after)).toBeGreaterThan(40);
});

it("follows a reader who holds the thumb at the end while the reply grows, and after they let go", async () => {
  await readUp();
  await grab();
  // The thumb taken to the end writes the end itself as the content grows.
  for (let i = 0; i < 6; i++) {
    position = end();
    await frame(i % 2 === 0 ? LINE : 0);
  }
  await letGo();
  await stream(10);
  expect(await rest()).toBeLessThanOrEqual(1);
});

it("stays released when the scroll event of the library's last write arrives after a wheel up", async () => {
  // A line lands; the library writes the end on the next frame's callbacks,
  // and the scroll event for that write only comes the frame after.
  await frame(LINE);
  await act(async () => {
    const callbacks = animationCallbacks;
    animationCallbacks = [];
    for (const callback of callbacks) callback(performance.now());
    await microtasks();
  });
  // The reader wheels up in between: released on the wheel event itself.
  await wheel(-100);
  // The late event reports the write: scrollTop grew, with no reader behind it.
  await frame();
  position -= 100;
  const after = await stream(20);
  expect(Math.min(...after)).toBeGreaterThanOrEqual(100);
});

it("lets go of the reader's hand when the thumb's drag ends", async () => {
  await grab();
  await letGo();
  await new Promise((resolve) => setTimeout(resolve, 600));
  // Anchoring and a line in one frame, which looks like a scroll up: with no
  // hand on the transcript any more, following holds.
  contentHeight -= 46;
  position -= 46;
  // More lines than the block shrank, so the frame grows the column: a shrink
  // would let the library re-lock a reader near the end by itself.
  await frame(4 * LINE, { readFirst: true });
  await stream(10);
  expect(await rest()).toBeLessThanOrEqual(1);
});

it("releases one wheel notch up at once, and following never comes back by itself", async () => {
  await wheel(-100);
  position -= 100;
  const after = await stream(40);
  expect(Math.min(...after)).toBeGreaterThanOrEqual(100);
  for (let i = 1; i < after.length; i++) expect(after[i]!).toBeGreaterThanOrEqual(after[i - 1]!);
});

it("keeps following when anchoring lowers the position with no reader behind it", async () => {
  // A code block above takes its real height, 46px under its placeholder, in
  // the frame a line lands below: the position drops as a scroll up would.
  contentHeight -= 46;
  position -= 46;
  // More lines than the block shrank, so the frame grows the column: a shrink
  // would let the library re-lock a reader near the end by itself.
  await frame(4 * LINE, { readFirst: true });
  await stream(10);
  expect(await rest()).toBeLessThanOrEqual(1);
});

it("does not take a scroll on a key typed into a field as the reader leaving", async () => {
  const field = document.createElement("textarea");
  scroller.querySelector("p")!.after(field);
  try {
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    contentHeight -= 46;
    position -= 46;
    await frame(4 * LINE, { readFirst: true });
    await stream(10);
    expect(await rest()).toBeLessThanOrEqual(1);
  } finally {
    field.remove();
  }
});

it("does not take a key pressed outside the transcript as the reader leaving", async () => {
  // The other pane, the sidebar: a control with focus that is not in here.
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    await act(async () => {
      elsewhere.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    contentHeight -= 46;
    position -= 46;
    await frame(4 * LINE, { readFirst: true });
    await stream(10);
    expect(await rest()).toBeLessThanOrEqual(1);
  } finally {
    elsewhere.remove();
  }
});

for (const step of [4, 15]) {
  it(`releases a ${step}px wheel step up taken in the event of the library's write, and keeps it released`, async () => {
    // A line lands; on the next frame's callbacks the library writes the end,
    // and the reader's wheel moves in the same frame, so one scroll event
    // carries both.
    await frame(LINE);
    await animationCallbacksOnly();
    await wheel(-step);
    position -= step;
    await frame();
    const after = await stream(20);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(step);
    expect(after.at(-1)).toBeGreaterThan(after[0]!);
  });
}

it("keeps a released reader in place when content above them grows", async () => {
  await wheel(-40);
  position -= 40;
  await frame();
  await handLifts();
  // A row above the viewport grows 60px (an image, a tool's output) and
  // anchoring raises scrollTop by as much: the reader has not moved.
  position += 60;
  await frame(60, { readFirst: true });
  const after = await stream(10);
  expect(Math.min(...after)).toBeGreaterThan(40);
});

it("opts out of scroll anchoring while following, and back in once released", async () => {
  expect(scroller.style.overflowAnchor).toBe("none");
  await wheel(-100);
  position -= 100;
  await frame();
  await settleTimers();
  expect(scroller.style.overflowAnchor).toBe("");
  await wheel(100);
  position = end();
  await frame();
  await settleTimers();
  expect(scroller.style.overflowAnchor).toBe("none");
});

it("keeps following through a turn start whose row swap lowers scrollTop with no reader behind it", async () => {
  // The window adds a row at the end and drops one as tall from the top: the
  // height holds, the library's observer stays quiet, and anchoring (were it
  // on) lowers scrollTop by the row. The library reads a scroll up and lets go.
  position -= 108;
  await frame();
  await stream(10);
  expect(await rest()).toBeLessThanOrEqual(1);
});

it("keeps following when content shrinks under the end just after a click in the transcript", async () => {
  // A click (no drag) in the transcript: a pointer was held there a moment ago.
  await act(async () => {
    const text = scroller.querySelector("p")!;
    text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  });
  // A line lands and the library writes the end; in the frame of that write
  // the content gets 315px shorter and the browser clamps scrollTop to the new
  // end: one scroll event whose scrollTop fell below the library's write.
  await frame(LINE);
  await animationCallbacksOnly();
  contentHeight -= 315;
  position = Math.min(position, end());
  await act(async () => {
    lastReported = position;
    scroller.dispatchEvent(new Event("scroll"));
    // The observer reports the shrink in the same frame, before any timer.
    for (const callback of resizeCallbacks) {
      callback(
        [{ contentRect: { height: contentHeight } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
    await microtasks();
    await settle();
  });
  await stream(10);
  expect(await rest()).toBeLessThanOrEqual(1);
});

it("does not capture a reader selecting text when the selection auto-scrolls into the zone", async () => {
  await readUp();
  await act(async () => {
    scroller
      .querySelector("p")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  // The selection runs past the bottom edge and the browser scrolls after it.
  for (let i = 0; i < 6; i++) {
    position = Math.min(end() - 10, position + 120);
    await frame(i % 2 === 0 ? LINE : 0);
  }
  await act(async () => {
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  });
  const after = await stream(10);
  expect(Math.min(...after)).toBeGreaterThan(10);
  expect(after.at(-1)).toBeGreaterThan(after[0]!);
});

it("does not take the transcript's own jump near the end, just after it let go, for an arrival", async () => {
  await readUp();
  await handLifts();
  // A jump to the last message, 40px above the end: the transcript lets go
  // first (`stopFollowing`), then writes the place.
  await act(async () => stopFollowing());
  position = end() - 40;
  await frame(LINE);
  const after = await stream(10);
  expect(Math.min(...after)).toBeGreaterThan(40);
  expect(after.at(-1)).toBeGreaterThan(after[0]!);
});

it("measures a transcript swapped in place afresh", async () => {
  // Released 300px up in one Session…
  await wheel(-300);
  position -= 300;
  await frame();
  await handLifts();
  // …and the plane shows another in its place, one that ends 40px below the
  // same scrollTop. The library re-locks a reader that near, as it does when
  // content shrinks; nobody scrolled.
  contentHeight -= 260;
  await observe();
  await frame();
  // The reader nudges the wheel up 10px. Measured from the old Session it
  // would read as a move from 300px to 50px from the end, an arrival.
  await wheel(-10);
  position -= 10;
  await frame();
  const after = await stream(10);
  expect(Math.min(...after)).toBeGreaterThanOrEqual(50);
  expect(after.at(-1)).toBeGreaterThan(after[0]!);
});
