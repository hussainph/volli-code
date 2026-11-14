import { describe, expect, it } from "vite-plus/test";

import { GLASS_MOTION } from "@renderer/lib/glass-motion";

import {
  LATEST_GLIDE_SCREENS,
  glideToLatest,
  latestGlideProgress,
  latestGlideStart,
  latestGlideStep,
  type LatestClock,
  type LatestScroller,
} from "./scroll-to-latest";

describe("latestGlideStart", () => {
  it("glides the whole way when the end is near", () => {
    expect(latestGlideStart(500, 800, false)).toBe(500);
  });

  it("starts a long trip two screens from the end", () => {
    expect(LATEST_GLIDE_SCREENS).toBe(2);
    expect(latestGlideStart(200_000, 800, false)).toBe(1600);
  });

  it("arrives at once when instant, with nothing to travel, or with no viewport", () => {
    expect(latestGlideStart(200_000, 800, true)).toBe(0);
    expect(latestGlideStart(0, 800, false)).toBe(0);
    expect(latestGlideStart(-3, 800, false)).toBe(0);
    expect(latestGlideStart(Number.NaN, 800, false)).toBe(0);
    expect(latestGlideStart(500, 0, false)).toBe(0);
  });
});

describe("latestGlideProgress", () => {
  it("runs the shared smooth spring from 0 to exactly 1 in its duration", () => {
    expect(latestGlideProgress(0)).toBe(0);
    expect(latestGlideProgress(-5)).toBe(0);
    expect(latestGlideProgress(GLASS_MOTION.pin)).toBe(1);
    expect(latestGlideProgress(GLASS_MOTION.pin * 3)).toBe(1);
  });

  it("only ever moves forward, without overshoot", () => {
    let last = 0;
    for (let ms = 1; ms < GLASS_MOTION.pin; ms += 1) {
      const value = latestGlideProgress(ms);
      expect(value).toBeGreaterThanOrEqual(last);
      expect(value).toBeLessThanOrEqual(1);
      last = value;
    }
    // Critically damped: most of the way within the first half.
    expect(latestGlideProgress(GLASS_MOTION.pin / 2)).toBeGreaterThan(0.8);
  });
});

describe("latestGlideStep", () => {
  it("scales the distance still to go, so growth below is spread over the frames left", () => {
    expect(latestGlideStep(1000, 0, 0.5)).toBe(500);
    // 100px arrived below the reader after half the trip: half of it is taken
    // up now, not all of it.
    expect(latestGlideStep(600, 0.5, 0.75)).toBe(300);
  });

  it("is the end at progress 1, and never above it", () => {
    expect(latestGlideStep(1000, 0.9, 1)).toBe(0);
    expect(latestGlideStep(1000, 1, 1)).toBe(0);
    expect(latestGlideStep(-20, 0.2, 0.4)).toBe(0);
  });
});

/**
 * A scroller with the two behaviours that matter: `scrollTop` clamps to the
 * content, and content above the reader can change height with the browser's
 * scroll anchoring keeping the reader's view still (moving `scrollTop` by the
 * change), which is what made the library's spring stop short.
 */
function fakeScroller(height: number, viewport: number, top: number) {
  let contentHeight = height;
  let position = top;
  const scroller: LatestScroller & {
    resizeAbove(delta: number): void;
    resizeBelow(delta: number): void;
  } = {
    get scrollHeight() {
      return contentHeight;
    },
    clientHeight: viewport,
    get scrollTop() {
      return position;
    },
    set scrollTop(value: number) {
      position = Math.max(0, Math.min(value, contentHeight - viewport));
    },
    resizeAbove(delta: number) {
      contentHeight += delta;
      position = Math.max(0, position + delta);
    },
    resizeBelow(delta: number) {
      contentHeight += delta;
      position = Math.min(position, contentHeight - viewport);
    },
  };
  return scroller;
}

function fakeClock(frameMs = 16) {
  let time = 0;
  let queued: (() => void) | null = null;
  const clock: LatestClock & { tick(): boolean; cancelled: number } = {
    cancelled: 0,
    frame(callback) {
      queued = callback;
      return () => {
        if (queued === callback) {
          queued = null;
          clock.cancelled += 1;
        }
      };
    },
    now: () => time,
    tick() {
      const next = queued;
      if (next === null) return false;
      queued = null;
      time += frameMs;
      next();
      return true;
    },
  };
  return clock;
}

const end = (scroller: LatestScroller) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

describe("glideToLatest", () => {
  it("ends at the true end although content above shrinks on every frame of the trip", () => {
    // The reported case: 200,000px up, and every frame a code block the trip
    // passes takes its real height, 46px under its placeholder.
    const scroller = fakeScroller(204_000, 880, 0);
    const clock = fakeClock();
    let arrived = 0;
    let atArrival = Number.NaN;
    glideToLatest(
      scroller,
      false,
      () => {
        arrived += 1;
        atArrival = end(scroller);
      },
      clock,
    );
    const distances: number[] = [];
    while (clock.tick()) {
      if (arrived === 0) scroller.resizeAbove(-46);
      distances.push(end(scroller));
    }
    expect(arrived).toBe(1);
    expect(atArrival).toBe(0);
    expect(end(scroller)).toBe(0);
    // One continuous motion: the first frame places the start two screens
    // from the end, and from there the reader only ever gets nearer.
    expect(distances[0]).toBe(1760);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!).toBeLessThanOrEqual(distances[i - 1]!);
    }
    // In the shared duration, whatever the distance: 270ms of motion after
    // the start frame and the clock's first frame.
    expect(distances.length).toBe(2 + Math.ceil(GLASS_MOTION.pin / 16));
  });

  it("ends at the end as it stands when a reply grows below the reader on the way", () => {
    const scroller = fakeScroller(5000, 800, 3000);
    const clock = fakeClock();
    let arrived = false;
    glideToLatest(scroller, false, () => (arrived = true), clock);
    let last = end(scroller);
    let largestMove = 0;
    while (clock.tick()) {
      if (!arrived) scroller.resizeBelow(30);
      const now = end(scroller);
      largestMove = Math.max(largestMove, now - last);
      last = now;
    }
    expect(arrived).toBe(true);
    expect(end(scroller)).toBe(0);
    // Growth is absorbed as the trip goes; the reader is never pushed back
    // by more than one frame's growth.
    expect(largestMove).toBeLessThanOrEqual(30);
  });

  it("glides a short trip from where the reader is, without a jump", () => {
    const scroller = fakeScroller(5000, 800, 3000);
    const clock = fakeClock();
    let arrived = false;
    glideToLatest(scroller, false, () => (arrived = true), clock);
    const distances: number[] = [];
    while (clock.tick()) distances.push(end(scroller));
    expect(arrived).toBe(true);
    // The first frame starts the clock where the reader is; the next moves.
    expect(distances[0]).toBe(1200);
    expect(distances[1]).toBeLessThan(1200);
    expect(distances.at(-1)).toBe(0);
    expect(distances.length).toBe(1 + Math.ceil(GLASS_MOTION.pin / 16));
  });

  it("measures on its first frame, after the press's own commit has landed", () => {
    const scroller = fakeScroller(204_000, 880, 0);
    const clock = fakeClock();
    glideToLatest(scroller, false, () => {}, clock);
    expect(scroller.scrollTop).toBe(0);
    // The press dropped the held rows: the chat is now its tail.
    scroller.resizeBelow(-194_000);
    clock.tick();
    expect(end(scroller)).toBe(1760);
  });

  it("arrives on the first frame when instant", () => {
    const scroller = fakeScroller(204_000, 880, 0);
    const clock = fakeClock();
    let arrived = 0;
    glideToLatest(scroller, true, () => (arrived += 1), clock);
    expect(arrived).toBe(0);
    expect(clock.tick()).toBe(true);
    expect(arrived).toBe(1);
    expect(end(scroller)).toBe(0);
    expect(clock.tick()).toBe(false);
  });

  it("stops where the reader is when cancelled, and never arrives", () => {
    const scroller = fakeScroller(10_000, 800, 0);
    const clock = fakeClock();
    let arrived = false;
    const cancel = glideToLatest(scroller, false, () => (arrived = true), clock);
    clock.tick();
    clock.tick();
    clock.tick();
    const where = scroller.scrollTop;
    cancel();
    expect(clock.cancelled).toBe(1);
    expect(clock.tick()).toBe(false);
    expect(scroller.scrollTop).toBe(where);
    expect(arrived).toBe(false);
  });

  it("runs on the browser's frames by default", async () => {
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    const globals = globalThis as {
      requestAnimationFrame?: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame?: (id: number) => void;
    };
    const saved = [globals.requestAnimationFrame, globals.cancelAnimationFrame] as const;
    globals.requestAnimationFrame = (callback) => frames.push(callback);
    globals.cancelAnimationFrame = (id) => cancelled.push(id);
    try {
      const scroller = fakeScroller(10_000, 800, 0);
      const cancel = glideToLatest(scroller, false, () => {});
      expect(frames).toHaveLength(1);
      frames[0]!(0);
      expect(end(scroller)).toBe(1600);
      frames[1]!(0);
      expect(end(scroller)).toBeCloseTo(1600, 0);
      cancel();
      expect(cancelled).toEqual([3]);
    } finally {
      [globals.requestAnimationFrame, globals.cancelAnimationFrame] = saved;
    }
  });
});
