/**
 * Elevation, held to the two properties it exists for.
 *
 * The first is SEPARATION: the whole reason this module exists is that light
 * mode's tiers were measured a hundredth of a lightness unit apart, so the
 * tests assert a real gap and assert it in the same units the failure was
 * found in. The second is that the dial's ZERO is genuinely zero — the seam's
 * rules are unconditional, so "lift off" has to mean the overlays are inert
 * rather than merely small, or every surface in the app would carry a faint
 * unexplained wash forever.
 */
import { apcaLc, hexToOklch } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { arcBaseFillHex, DEFAULT_ARC_CANVAS, type ArcCanvasState } from "./model";
import { arcElevation, arcShadows } from "./surfaces";
import { deriveArcTokens } from "./tokens";

const HUES = ["#e8652a", "#2e6f8e", "#4a7d5b", "#a06bb8", "#ffffff"];

function canvasOf(hex: string, patch: Partial<ArcCanvasState> = {}): ArcCanvasState {
  return { ...DEFAULT_ARC_CANVAS, stops: [{ hex, x: 0.68, y: 0.3 }], ...patch };
}

function elevationOf(state: ArcCanvasState, resolved: "light" | "dark" = "light") {
  return arcElevation(state, resolved, deriveArcTokens(state, resolved));
}

/** Every layer's alpha in a `box-shadow`, in order. */
function alphasOf(value: string): number[] {
  return [...value.matchAll(/\/ ([\d.]+)\)/g)].map(([, alpha]) => Number(alpha));
}

/** The widest blur in a `box-shadow` — how far the tier reads as casting. */
function reachOf(value: string): number {
  return Math.max(...[...value.matchAll(/0 \d+px (\d+)px/g)].map(([, blur]) => Number(blur)));
}

/** A tier's composited lightness over the canvas's base fill. */
function tierL(state: ArcCanvasState, tier: number): number {
  const elevation = elevationOf(state);
  const base = arcBaseFillHex(state, "light");
  const surfaces = elevation.tiers[tier].surfaces;
  // The base fill is the LAST surface in the list — see arcElevation.
  const composited = surfaces[surfaces.length - 1] ?? base;
  return hexToOklch(composited).L;
}

describe("lift", () => {
  it("gives every tier a real share of the distance between canvas and paper", () => {
    // Stated as a SHARE rather than an absolute ΔL, because the distance being
    // divided is not a constant: the light band runs to L 0.90 and the paper
    // sits at 0.955, so a near-white seed leaves barely 0.10 of lightness for
    // both tiers while ember leaves 0.17. An absolute floor would either be
    // unmeetable at the light end or meaningless at the dark one — the honest
    // property is that each step takes a visible fraction of whatever room
    // there is.
    //
    // The number it replaces, for scale: the shipped veil gave the sidebar
    // ΔL 0.015 out of ember's 0.17 — under 9%, which is why the two panes read
    // as one.
    for (const hex of HUES) {
      const state = canvasOf(hex, { lift: 1 });
      const base = hexToOklch(arcBaseFillHex(state, "light")).L;
      const paper = hexToOklch(deriveArcTokens(state, "light")["--background"]).L;
      const headroom = paper - base;
      const outer = (tierL(state, 0) - base) / headroom;
      const inner = (tierL(state, 1) - base) / headroom;
      expect({ hex, canvasToOuter: outer > 0.25 }).toEqual({ hex, canvasToOuter: true });
      expect({ hex, outerToInner: inner - outer > 0.25 }).toEqual({ hex, outerToInner: true });
      // And never all the way: a sidebar that reached the paper would stop
      // being a tier and start being the card with a seam down the middle.
      expect({ hex, staysCanvas: inner < 0.85 }).toEqual({ hex, staysCanvas: true });
    }
  });

  it("turns the whole arrangement over when the dial goes negative", () => {
    // One dial, two models. The recessed reading is not a second code path —
    // it is this one with the sign flipped, which is what makes the toggle
    // between them a comparison rather than an A/B of two implementations.
    for (const hex of HUES) {
      const state = canvasOf(hex, { lift: -1 });
      const base = hexToOklch(arcBaseFillHex(state, "light")).L;
      const outer = tierL(state, 0);
      const inner = tierL(state, 1);
      expect({ hex, sinks: outer < base && inner < outer }).toEqual({ hex, sinks: true });
    }
  });

  it("is genuinely inert at zero, not merely quiet", () => {
    const elevation = elevationOf(canvasOf("#e8652a", { lift: 0, shadow: 0 }));
    expect(elevation.tiers.map((tier) => tier.veil)).toEqual(["transparent", "transparent"]);
    expect(elevation.surfaces).toEqual([]);
    expect(elevation.shadows).toEqual({ raised: "none", card: "none", overlay: "none" });
  });

  it("leaves dark mode alone at every setting", () => {
    // Dark already separates its tiers with a veil that reads. Stacking lift on
    // top would double-count exactly the separation the veil provides.
    for (const lift of [-1, -0.5, 0.5, 1]) {
      const elevation = elevationOf(canvasOf("#e8652a", { lift, shadow: 1 }), "dark");
      expect({ lift, veils: elevation.tiers.map((tier) => tier.veil) }).toEqual({
        lift,
        veils: ["transparent", "transparent"],
      });
      expect({ lift, card: elevation.shadows.card }).toEqual({ lift, card: "none" });
    }
  });

  it("keeps the on-canvas ink readable on the surfaces it creates", () => {
    // The reason `paint.ts` derives elevation BEFORE ink. A lifted tier is a
    // new surface under the sidebar's text; at negative lift it is darker than
    // any pool, so it — not the gradient — is the worst case the ink has to
    // clear. Scoring the tiers here is what makes that ordering a contract.
    for (const hex of HUES) {
      for (const lift of [-1, -0.4, 0.4, 1]) {
        const state = canvasOf(hex, { lift });
        const elevation = elevationOf(state);
        // Both candidate inks are scored by `arcInk`; here we only need to know
        // that SOME ink clears the floor on every surface lift introduces.
        const worst = elevation.surfaces.map((surface) => {
          const tokens = deriveArcTokens(state, "light");
          return Math.max(
            Math.abs(apcaLc(tokens["--foreground"], surface)),
            Math.abs(apcaLc(tokens["--background"], surface)),
          );
        });
        expect({ hex, lift, floor: Math.min(...worst) > 45 }).toEqual({ hex, lift, floor: true });
      }
    }
  });
});

describe("shadows", () => {
  it("scales every layer's alpha with the dial and vanishes at zero", () => {
    const state = canvasOf("#e8652a");
    expect(arcShadows({ ...state, shadow: 0 }, "light").card).toBe("none");
    const half = arcShadows({ ...state, shadow: 0.5 }, "light").card;
    const full = arcShadows({ ...state, shadow: 1 }, "light").card;
    const halved = alphasOf(half);
    const whole = alphasOf(full);
    expect(halved.length).toBe(whole.length);
    for (const [index, alpha] of halved.entries()) {
      expect(alpha).toBeCloseTo(whole[index] / 2, 4);
    }
  });

  it("carries the canvas's hue rather than a neutral black", () => {
    // A grey shadow over a warm pastel desaturates what is under it, so it
    // reads as dirt on the gradient instead of as an absence of light.
    const warm = arcShadows(canvasOf("#e8652a"), "light").card;
    const cool = arcShadows(canvasOf("#2e6f8e"), "light").card;
    expect(warm).not.toBe(cool);
    const [r, g, b] = /rgb\((\d+) (\d+) (\d+)/.exec(warm)?.slice(1).map(Number) ?? [];
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(4);
  });

  it("orders the tiers — a floating overlay casts further than a raised one", () => {
    const { raised, card, overlay } = arcShadows(canvasOf("#e8652a", { shadow: 1 }), "light");
    expect(reachOf(raised)).toBeLessThan(reachOf(card));
    expect(reachOf(card)).toBeLessThan(reachOf(overlay));
  });
});
