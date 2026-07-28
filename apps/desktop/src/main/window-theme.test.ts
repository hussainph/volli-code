import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CANVAS, windowBackground } from "@volli/shared";
import type { Canvas } from "@volli/shared";

import {
  FIRST_PAINT_APPEARANCE_ARG,
  firstPaintArguments,
  resolveFirstPaint,
  windowBackgroundColor,
} from "./window-theme";

const midnight: Canvas = {
  stops: [{ hex: "#4c6ef5", x: 0.5, y: 0.5 }],
  primaryIndex: 0,
  vibrancy: 0.6,
  grain: 0.15,
};

describe("resolveFirstPaint", () => {
  it("is exactly the canvas pipeline's window background, so the edge cannot drift from the app", () => {
    expect(
      windowBackgroundColor({
        hint: null,
        canvas: midnight,
        appearance: "dark",
        systemPrefersDark: true,
      }),
    ).toBe(windowBackground(midnight, "dark"));
  });

  it("follows the authored canvas", () => {
    const input = { hint: null, appearance: "dark", systemPrefersDark: true } as const;

    expect(windowBackgroundColor({ ...input, canvas: midnight })).not.toBe(
      windowBackgroundColor({ ...input, canvas: DEFAULT_CANVAS }),
    );
  });

  it("falls back to the shipped canvas when nothing is stored", () => {
    // A window is created before any UI exists to surface a read failure in —
    // an absent or unreadable canvas must still paint.
    const stored = { hint: null, appearance: "dark", systemPrefersDark: true } as const;

    expect(windowBackgroundColor({ ...stored, canvas: null })).toBe(
      windowBackgroundColor({ ...stored, canvas: DEFAULT_CANVAS }),
    );
  });

  it("resolves `auto`, and an unset appearance, against the system", () => {
    const base = { hint: null, canvas: DEFAULT_CANVAS } as const;

    expect(
      resolveFirstPaint({ ...base, appearance: "auto", systemPrefersDark: true }).appearance,
    ).toBe("dark");
    expect(
      resolveFirstPaint({ ...base, appearance: "auto", systemPrefersDark: false }).appearance,
    ).toBe("light");
    // Never chosen reads as `auto`, not as dark.
    expect(
      resolveFirstPaint({ ...base, appearance: null, systemPrefersDark: false }).appearance,
    ).toBe("light");
  });

  it("lets an explicit appearance win over the system", () => {
    const base = { hint: null, canvas: DEFAULT_CANVAS, systemPrefersDark: true } as const;

    expect(resolveFirstPaint({ ...base, appearance: "light" }).appearance).toBe("light");
  });

  it("paints the same canvas differently in the two modes", () => {
    const base = { hint: null, canvas: DEFAULT_CANVAS, appearance: null } as const;

    expect(windowBackgroundColor({ ...base, systemPrefersDark: true })).not.toBe(
      windowBackgroundColor({ ...base, systemPrefersDark: false }),
    );
  });

  /**
   * The hint is what the renderer ACTUALLY painted, which may be a workspace's
   * canvas — and which workspace was open is renderer state main cannot
   * resolve. Re-deriving from the global pair would paint the window edge the
   * wrong color and let the renderer correct it, which is the flash this path
   * exists to prevent.
   */
  it("prefers the recorded hint over the stored global pair", () => {
    const painted = { appearance: "light", background: "#123456" } as const;

    expect(
      resolveFirstPaint({
        hint: painted,
        canvas: midnight,
        appearance: "dark",
        systemPrefersDark: true,
      }),
    ).toEqual(painted);
  });
});

describe("firstPaintArguments", () => {
  it("carries the resolved mode under the prefix the preload reads", () => {
    // Pinned in both directions: `src/preload/index.ts` states the same literal
    // because it may not import this module (main and preload are kept
    // dependency-disjoint) — so the two can only be held together by a test.
    expect(FIRST_PAINT_APPEARANCE_ARG).toBe("--volli-first-paint-appearance=");
    expect(firstPaintArguments({ appearance: "light", background: "#123456" })).toEqual([
      "--volli-first-paint-appearance=light",
    ]);
    expect(firstPaintArguments({ appearance: "dark", background: "#123456" })).toEqual([
      "--volli-first-paint-appearance=dark",
    ]);
  });
});
