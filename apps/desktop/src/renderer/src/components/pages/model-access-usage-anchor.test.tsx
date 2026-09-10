// @vitest-environment jsdom
/**
 * The countdown's anchor travels with the snapshot, not the mount.
 *
 * The account row stays mounted across a Refresh, so a `now` taken once at
 * mount would read every later snapshot against a clock that stopped when the
 * page opened — a page left open twenty minutes and then refreshed would show
 * a fresh `resetsAt` as twenty minutes further away than it is. The static
 * markup tests cannot see this: it needs a second render into the same root.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { UsageLimits } from "@volli/shared";

import { ModelAccessUsage } from "./model-access-usage";

const MOUNTED_AT = Date.parse("2026-03-01T12:00:00Z");
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function limitsResettingAt(resetsAt: number, checkedAt: number): UsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 50,
        resetsAt: iso(resetsAt),
        windowDurationMins: 300,
      },
    ],
  };
}

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(MOUNTED_AT);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(limits: UsageLimits): void {
  act(() => {
    root?.render(<ModelAccessUsage limits={limits} />);
  });
}

describe("ModelAccessUsage anchor", () => {
  it("re-anchors the countdown when a newer snapshot arrives on the same mount", () => {
    render(limitsResettingAt(MOUNTED_AT + 120 * MINUTE, MOUNTED_AT));
    expect(container?.textContent).toContain("resets in 2h");

    // Twenty minutes pass with the page open, then a Refresh brings a snapshot
    // whose window resets two hours from NOW — not from when the page opened.
    vi.setSystemTime(MOUNTED_AT + 20 * MINUTE);
    render(limitsResettingAt(MOUNTED_AT + 140 * MINUTE, MOUNTED_AT + 20 * MINUTE));
    expect(container?.textContent).toContain("resets in 2h");
    expect(container?.textContent).not.toContain("2h 20m");
  });

  it("holds the anchor still while the snapshot is the same object", () => {
    const limits = limitsResettingAt(MOUNTED_AT + 120 * MINUTE, MOUNTED_AT);
    render(limits);
    vi.setSystemTime(MOUNTED_AT + 20 * MINUTE);
    // A confirming inspection hands the very same object back: no tick.
    render(limits);
    expect(container?.textContent).toContain("resets in 2h");
    expect(container?.textContent).not.toContain("1h 40m");
  });
});
