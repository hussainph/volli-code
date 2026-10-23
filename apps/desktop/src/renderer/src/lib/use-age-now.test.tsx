// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MAX_TIMER_DELAY_MS } from "./boundary-timer";
import { compactAge } from "./relative-time";
import { useAgeBoundaryTimer, useBoundaryClock } from "./use-age-now";

const NOW = new Date(2026, 6, 14, 12).getTime();
let root: Root;
let container: HTMLDivElement;
let renders: number;

function List({ stamps, statusAt = null }: { stamps: number[]; statusAt?: number | null }) {
  const clock = useBoundaryClock();
  const [now] = clock;
  useAgeBoundaryTimer(stamps, clock, statusAt !== null && statusAt > now ? statusAt : null);
  renders++;
  return <span data-clock={now}>{stamps.map((stamp) => compactAge(stamp, now)).join("")}</span>;
}

async function draw(stamps: number[], statusAt?: number) {
  await act(async () => root.render(<List stamps={stamps} statusAt={statusAt} />));
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  root = createRoot(container);
  renders = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one age clock per list", () => {
  it("coalesces simultaneous row boundaries, and skips the unchanged 60-second label", async () => {
    await draw([NOW - 30_000, NOW - 30_000]);
    expect(vi.getTimerCount()).toBe(1);
    expect(container.textContent).toBe("nownow");
    await advance(15_001);
    expect(container.textContent).toBe("1m1m");
    expect(renders).toBe(2);
    await advance(44_999);
    expect(renders).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("replaces the timer when the visible rows change, and stops for an empty list", async () => {
    await draw([NOW - 30_000]);
    await draw([NOW - 10_000]);
    await advance(15_001);
    expect(renders).toBe(2);
    await advance(20_000);
    expect(container.textContent).toBe("1m");
    await draw([]);
    expect(vi.getTimerCount()).toBe(0);
    await advance(3_600_000);
    await draw([NOW]);
    expect(container.textContent).toBe("now");
    expect(vi.getTimerCount()).toBe(1);
    await advance(1);
    expect(container.textContent).toBe("1h");
  });

  it("leaves the state clock unchanged on unrelated renders", async () => {
    await draw([NOW - 30_000]);
    await advance(10_000);
    await draw([NOW - 30_000]);
    expect(renders).toBe(2);
    expect(container.querySelector("span")?.getAttribute("data-clock")).toBe(String(NOW));
    expect(container.textContent).toBe("now");
    await advance(5_001);
    expect(container.textContent).toBe("1m");
    expect(renders).toBe(3);
  });

  it("shares the age timer with an earlier status boundary", async () => {
    await draw([NOW - 30_000], NOW + 5_000);
    expect(vi.getTimerCount()).toBe(1);
    await advance(5_001);
    expect(renders).toBe(2);
    await advance(10_000);
    expect(container.textContent).toBe("1m");
    expect(renders).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-arms a clamped long timeout even when the boundary stays the same", async () => {
    await draw([new Date(2026, 0, 1).getTime()]);
    await advance(MAX_TIMER_DELAY_MS);
    expect(renders).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
