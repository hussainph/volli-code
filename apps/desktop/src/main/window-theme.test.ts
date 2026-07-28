import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CANVAS, windowBackground } from "@volli/shared";
import type { Canvas } from "@volli/shared";

import {
  FIRST_PAINT_APPEARANCE_ARG,
  SYSTEM_DARK_ARG,
  firstPaintArguments,
  resolveFirstPaint,
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
      resolveFirstPaint({
        hint: null,
        canvas: midnight,
        appearance: "dark",
        systemPrefersDark: true,
      }).background,
    ).toBe(windowBackground(midnight, "dark"));
  });

  it("follows the authored canvas", () => {
    const input = { hint: null, appearance: "dark", systemPrefersDark: true } as const;

    expect(resolveFirstPaint({ ...input, canvas: midnight }).background).not.toBe(
      resolveFirstPaint({ ...input, canvas: DEFAULT_CANVAS }).background,
    );
  });

  it("falls back to the shipped canvas when nothing is stored", () => {
    // A window is created before any UI exists to surface a read failure in —
    // an absent or unreadable canvas must still paint.
    const stored = { hint: null, appearance: "dark", systemPrefersDark: true } as const;

    expect(resolveFirstPaint({ ...stored, canvas: null }).background).toBe(
      resolveFirstPaint({ ...stored, canvas: DEFAULT_CANVAS }).background,
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

    expect(resolveFirstPaint({ ...base, systemPrefersDark: true }).background).not.toBe(
      resolveFirstPaint({ ...base, systemPrefersDark: false }).background,
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

  /**
   * Scenario: appearance is `auto` (the default). The user quit with the Mac in
   * dark mode, so the hint recorded `dark`. They switch macOS to light while the
   * app is closed, then relaunch. The hint is a snapshot of the OLD system
   * preference, not an instruction — honoring its mode would paint the dark
   * window edge that the renderer only corrects after `boot()`'s IPC round
   * trip, which is exactly the flash this function exists to prevent, arriving
   * from the other direction.
   */
  it("re-resolves `auto` against the system rather than trust a hint recorded under the old preference", () => {
    const stale = { appearance: "dark", background: "#000000" } as const;

    const result = resolveFirstPaint({
      hint: stale,
      canvas: DEFAULT_CANVAS,
      appearance: "auto",
      systemPrefersDark: false,
    });

    expect(result.appearance).toBe("light");
    // The hint's background belongs to the mode it recorded, not the mode we
    // just resolved to — reusing it would paint a dark window edge around a
    // light UI.
    expect(result.background).toBe(windowBackground(DEFAULT_CANVAS, "light"));
    expect(result.background).not.toBe(stale.background);
  });

  it("re-resolves the mirror case — the OS switched to dark while the app was closed", () => {
    const stale = { appearance: "light", background: "#ffffff" } as const;

    const result = resolveFirstPaint({
      hint: stale,
      canvas: DEFAULT_CANVAS,
      appearance: "auto",
      systemPrefersDark: true,
    });

    expect(result.appearance).toBe("dark");
    expect(result.background).toBe(windowBackground(DEFAULT_CANVAS, "dark"));
    expect(result.background).not.toBe(stale.background);
  });

  it("still honors the hint under an explicit choice, regardless of what the system is doing", () => {
    // An explicit choice has no expiry — unlike `auto` it means the same thing
    // no matter what the OS does in the meantime, so the recorded hint stays
    // authoritative even when it disagrees with `systemPrefersDark`.
    const paintedLight = { appearance: "light", background: "#123456" } as const;
    const paintedDark = { appearance: "dark", background: "#654321" } as const;

    expect(
      resolveFirstPaint({
        hint: paintedLight,
        canvas: DEFAULT_CANVAS,
        appearance: "light",
        systemPrefersDark: true,
      }),
    ).toEqual(paintedLight);
    expect(
      resolveFirstPaint({
        hint: paintedDark,
        canvas: DEFAULT_CANVAS,
        appearance: "dark",
        systemPrefersDark: false,
      }),
    ).toEqual(paintedDark);
  });

  it("treats a null stored appearance as `auto` for hint trust too — an unread row isn't an explicit choice", () => {
    const stale = { appearance: "dark", background: "#000000" } as const;

    const result = resolveFirstPaint({
      hint: stale,
      canvas: DEFAULT_CANVAS,
      appearance: null,
      systemPrefersDark: false,
    });

    expect(result.appearance).toBe("light");
    expect(result.background).not.toBe(stale.background);
  });
});

describe("firstPaintArguments", () => {
  it("carries the resolved mode under the prefix the preload reads", () => {
    // Pinned in both directions: `src/preload/index.ts` states the same literal
    // because it may not import this module (main and preload are kept
    // dependency-disjoint) — so the two can only be held together by a test.
    expect(FIRST_PAINT_APPEARANCE_ARG).toBe("--volli-first-paint-appearance=");
    expect(firstPaintArguments({ appearance: "light", background: "#123456" }, false)).toEqual([
      "--volli-first-paint-appearance=light",
      "--volli-system-dark=0",
    ]);
    expect(firstPaintArguments({ appearance: "dark", background: "#123456" }, true)).toEqual([
      "--volli-first-paint-appearance=dark",
      "--volli-system-dark=1",
    ]);
  });

  it("carries what `auto` resolves against, which the renderer cannot work out alone", () => {
    // Same duplicated-literal-plus-pinning-test arrangement as the flag above,
    // and here the duplication buys something specific: the renderer's own
    // `matchMedia("(prefers-color-scheme: dark)")` is resolved against the root
    // element's used `color-scheme`, which the app stamps — so it reads back the
    // mode already painted. `nativeTheme` is the only honest source and this
    // flag is how its answer crosses.
    expect(SYSTEM_DARK_ARG).toBe("--volli-system-dark=");
    const paint = { appearance: "dark", background: "#123456" } as const;

    expect(firstPaintArguments(paint, true)).toContain("--volli-system-dark=1");
    expect(firstPaintArguments(paint, false)).toContain("--volli-system-dark=0");
  });

  it("keeps the two flags independent — the resolved mode is not the system's", () => {
    // The whole point of shipping both: a user on an explicit dark inside a
    // light system paints dark, and `auto` still has to be able to resolve to
    // light the moment they switch back to it.
    expect(firstPaintArguments({ appearance: "dark", background: "#123456" }, false)).toEqual([
      "--volli-first-paint-appearance=dark",
      "--volli-system-dark=0",
    ]);
  });
});
