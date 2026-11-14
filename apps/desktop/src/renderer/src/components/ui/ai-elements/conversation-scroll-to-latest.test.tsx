// @vitest-environment jsdom
/**
 * "Scroll to latest" against the real `use-stick-to-bottom` (VC-1232).
 *
 * jsdom has no layout, so the scroller's geometry is ours, and so is the one
 * browser behaviour that caused the short stop: scroll anchoring. When content
 * above the reader changes height, the browser moves `scrollTop` by the change
 * so the view stays still, and the scroll event that follows reports a position
 * below the one last written. The library's spring read that as the reader
 * scrolling up, detached, and stopped where it was. Its guard against exactly
 * this (`resizeDifference`, set by its ResizeObserver) is a race between two
 * one-millisecond timers; the ResizeObserver here never reports during the
 * trip, which is the race lost, every frame.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { Conversation, ConversationContent, ConversationScrollButton } from "./conversation";

const VIEWPORT = 800;
let contentHeight = 0;
let position = 0;
let lastReported = 0;
let resizeCallbacks: ResizeObserverCallback[] = [];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let scroller: HTMLElement;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const fromEnd = () => contentHeight - VIEWPORT - position;

/**
 * One browser frame: the frame callbacks, then layout (where `anchor` changes
 * content above the reader and anchoring moves `scrollTop` by the change), then
 * the scroll event a moved position raises.
 */
async function nextFrame(anchor = 0) {
  await act(async () => {
    await frame();
    if (anchor !== 0) {
      contentHeight += anchor;
      position = Math.max(0, position + anchor);
    }
    if (position !== lastReported) {
      lastReported = position;
      scroller.dispatchEvent(new Event("scroll"));
    }
    // The library judges a scroll on a one-millisecond timer.
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resizeCallbacks = [];
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
          <p>transcript</p>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>,
    ),
  );
  scroller = host.querySelector<HTMLElement>("[data-conversation-scroller]")!;
  contentHeight = 200_000;
  position = 0;
  lastReported = 0;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, get: () => contentHeight },
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = Math.max(0, Math.min(value, contentHeight - VIEWPORT));
      },
    },
  });
  // The reader is far up and has said so with the wheel: detached.
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
  });
  scroller.dispatchEvent(new Event("scroll"));
  await nextFrame();
  await nextFrame();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = () => host.querySelector<HTMLButtonElement>('[aria-label="Scroll to latest"]');

it("ends at the true end while content above shrinks under the trip, then follows", async () => {
  expect(button()).not.toBeNull();
  await act(async () => {
    button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  // Gone on the press.
  expect(button()).toBeNull();
  // Each of the trip's early frames passes a code block that takes its real
  // height, 46px under its placeholder. Given time to finish, the library's
  // spring arrives too when nothing above changes; with this it stopped short.
  for (let i = 0; i < 90; i++) await nextFrame(i < 10 ? -46 : 0);
  // At the end: within the transcript's own pinned slack, which is where the
  // library's slower spring also gets to in 90 frames when nothing changes.
  expect(fromEnd()).toBeLessThan(8);
  expect(button()).toBeNull();
  // Following is on: a reply that grows the transcript is followed.
  contentHeight += 500;
  await act(async () => {
    for (const callback of resizeCallbacks) {
      callback(
        [{ contentRect: { height: contentHeight } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
  await nextFrame();
  await nextFrame();
  expect(fromEnd()).toBeLessThanOrEqual(1);
});

it("glides as one motion that only ever nears the end", async () => {
  await act(async () => {
    button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  const distances: number[] = [];
  for (let i = 0; i < 30; i++) {
    await nextFrame();
    distances.push(fromEnd());
  }
  // A long trip starts two screens from the end.
  expect(distances[0]).toBe(2 * VIEWPORT);
  expect(distances.at(-1)).toBe(0);
  for (let i = 1; i < distances.length; i++) {
    expect(distances[i]!).toBeLessThanOrEqual(distances[i - 1]!);
  }
  // More than a jump and a correction: several frames in between.
  expect(distances.filter((d) => d > 0 && d < 2 * VIEWPORT).length).toBeGreaterThan(3);
});

it("arrives at once from the keyboard", async () => {
  await act(async () => button()!.click());
  await nextFrame();
  expect(fromEnd()).toBe(0);
});

it("arrives at once with reduced motion", async () => {
  document.documentElement.dataset.motion = "off";
  try {
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await nextFrame();
    expect(fromEnd()).toBe(0);
  } finally {
    delete document.documentElement.dataset.motion;
  }
});

it("hands the transcript back to a reader who wheels during the trip", async () => {
  await act(async () => {
    button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await nextFrame();
  await nextFrame();
  await nextFrame();
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  });
  position -= 120;
  await nextFrame();
  const left = fromEnd();
  expect(left).toBeGreaterThan(120);
  for (let i = 0; i < 20; i++) await nextFrame();
  expect(fromEnd()).toBe(left);
  // Detached: the way back is the button again.
  expect(button()).not.toBeNull();
});
