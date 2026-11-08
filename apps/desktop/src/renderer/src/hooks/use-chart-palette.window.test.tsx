// @vitest-environment jsdom
/**
 * The chart palette reads the document once per theme change, not once per
 * render (VC-1079).
 *
 * The empty chat these charts fill is a Draft somebody is typing into, so a
 * render is a keystroke, and a `getComputedStyle` read per render was a style
 * read per keystroke. What is pinned here is both halves of the memo: an
 * ordinary re-render reads nothing, and a change to the root's class or inline
 * style — an appearance or a canvas — still reaches the colours.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSeriesColors, useStreakRamp } from "./use-chart-palette";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const seen: { ramp: string[]; series: string[] }[] = [];

function Probe({ count }: { count: number }) {
  const ramp = useStreakRamp();
  const series = useSeriesColors(count);
  seen.push({ ramp, series });
  return null;
}

function rootReads(spy: { mock: { calls: readonly (readonly unknown[])[] } }): number {
  return spy.mock.calls.filter(([element]) => element === document.documentElement).length;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.style.setProperty("--background", "#101010");
  document.documentElement.style.setProperty("--primary", "#d37550");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seen.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.removeAttribute("style");
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("the chart palette", () => {
  it("reads the document once, and not again on an ordinary re-render", async () => {
    const spy = vi.spyOn(window, "getComputedStyle");
    await act(async () => root?.render(<Probe count={5} />));
    const afterMount = rootReads(spy);
    expect(afterMount).toBeGreaterThan(0);

    // A keystroke in the Draft, as far as this hook can tell: the parent
    // renders again and nothing about the theme moved.
    for (let index = 0; index < 5; index += 1) {
      await act(async () => root?.render(<Probe count={5} />));
    }
    expect(rootReads(spy)).toBe(afterMount);
    expect(seen.at(-1)?.ramp).toBe(seen[0]?.ramp);
    expect(seen.at(-1)?.series).toBe(seen[0]?.series);
  });

  it("re-reads when the canvas or the appearance changes on the root", async () => {
    await act(async () => root?.render(<Probe count={5} />));
    const before = seen.at(-1);

    // A canvas lands as inline custom properties on the root.
    await act(async () => {
      document.documentElement.style.setProperty("--primary", "#3060d0");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const recoloured = seen.at(-1);
    expect(recoloured?.series).not.toEqual(before?.series);
    expect(recoloured?.ramp).not.toEqual(before?.ramp);

    // An appearance lands as a class on the root; the observer wakes on it
    // even when the computed value happens not to move.
    const spy = vi.spyOn(window, "getComputedStyle");
    await act(async () => {
      document.documentElement.className = "light";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rootReads(spy)).toBeGreaterThan(0);
  });

  it("re-derives the series when the count changes, without waiting on the theme", async () => {
    await act(async () => root?.render(<Probe count={3} />));
    expect(seen.at(-1)?.series).toHaveLength(3);
    await act(async () => root?.render(<Probe count={5} />));
    expect(seen.at(-1)?.series).toHaveLength(5);
  });
});
