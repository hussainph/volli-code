/**
 * Elevation, held to the two properties it exists for.
 *
 * The first is SEPARATION: the whole reason this module exists is that light
 * mode's tiers were measured a hundredth of a lightness unit apart, so the
 * tests assert a real gap and assert it in the same units the failure was
 * found in. The second is that the tiers pinned to the canvas are genuinely
 * pinned — the seam's rules are unconditional, so "this tier is the gradient"
 * has to mean the overlay is inert rather than merely small, or the chrome band
 * would carry a faint unexplained wash forever.
 *
 * Both were swept across a dial's whole travel while the lift was one. It is
 * now a settled pair (`ARC_SETTLED.lift`), so what used to be a sweep is a
 * measurement at the one arrangement that ships — and the sweep's real finding,
 * that the two modes arrive at the same picture from opposite signs, becomes an
 * assertion rather than a property of a control nobody can reach.
 */
import { apcaLc, hexToOklch, oklchToHex } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  arcBaseFillHex,
  ARC_SETTLED,
  ARC_TUNING,
  DEFAULT_ARC_CANVAS,
  type ArcCanvasState,
  type ArcResolvedMode,
} from "./model";
import { arcElevation, arcShadows } from "./surfaces";
import { deriveArcTokens } from "./tokens";

const HUES = ["#e8652a", "#2e6f8e", "#4a7d5b", "#a06bb8", "#ffffff"];

const MODES = ["light", "dark"] as const;

function canvasOf(hex: string, patch: Partial<ArcCanvasState> = {}): ArcCanvasState {
  return { ...DEFAULT_ARC_CANVAS, stops: [{ hex, x: 0.68, y: 0.3 }], ...patch };
}

function elevationOf(state: ArcCanvasState, resolved: ArcResolvedMode = "light") {
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
function tierL(state: ArcCanvasState, tier: number, resolved: ArcResolvedMode = "light"): number {
  const surfaces = elevationOf(state, resolved).tiers[tier].surfaces;
  // The base fill is the LAST surface in the list — see arcElevation.
  return hexToOklch(surfaces[surfaces.length - 1] ?? arcBaseFillHex(state, resolved)).L;
}

describe("lift", () => {
  it("gives the sidebar a real share of the distance between canvas and paper", () => {
    // Stated as a SHARE rather than an absolute ΔL, because the distance being
    // divided is not a constant: the light band runs to L 0.90 and the paper
    // sits at 0.955, so a near-white seed leaves barely 0.10 of lightness while
    // ember leaves 0.17. An absolute floor would either be unmeetable at the
    // light end or meaningless at the dark one — the honest property is that
    // the step takes a visible fraction of whatever room there is.
    //
    // The number it replaces, for scale: the shipped veil gave the sidebar
    // ΔL 0.015 out of ember's 0.17 — under 9%, which is why the two panes read
    // as one.
    for (const hex of HUES) {
      const state = canvasOf(hex);
      const base = hexToOklch(arcBaseFillHex(state, "light")).L;
      const paper = hexToOklch(deriveArcTokens(state, "light")["--background"]).L;
      const share = (tierL(state, 1) - base) / (paper - base);
      expect({ hex, separates: share > 0.1 }).toEqual({ hex, separates: true });
      // And never all the way: a sidebar that reached the paper would stop
      // being a tier and start being the card with a seam down the middle.
      expect({ hex, staysCanvas: share < 0.85 }).toEqual({ hex, staysCanvas: true });
    }
  });

  it("lands the sidebar above its canvas in BOTH modes, from opposite signs", () => {
    // The invariant that survives the freeze, and the one the derived sink
    // target exists for. `ARC_SETTLED.lift` is +0.25 in light and −0.25 in
    // dark, and the picture is the same in both: a pane a little lighter than
    // the gradient it sits on. It has to be the opposite sign in dark because
    // `--background` is the LIGHTEST surface in light and one of the darkest in
    // dark, so "toward paper" changes which way it points — a hardcoded "sink
    // means darker" would put the dark sidebar UNDER its canvas and make the
    // two appearances two different windows.
    expect(Math.sign(ARC_SETTLED.lift.light)).toBe(-Math.sign(ARC_SETTLED.lift.dark));
    for (const mode of MODES) {
      for (const hex of HUES) {
        const state = canvasOf(hex);
        const step = tierL(state, 1, mode) - hexToOklch(arcBaseFillHex(state, mode)).L;
        expect({ mode, hex, above: step > 0.01 }).toEqual({ mode, hex, above: true });
      }
    }
  });

  it("pins the chrome band and rail to the canvas, and moves the sidebar alone", () => {
    // The frame runs bare gradient around all four sides of the sidebar+card
    // unit, so any outer-tier share at all puts a hard edge along every wall of
    // it — chrome band against the gutter above, project rail against the
    // gutter beside. Inert is the only value that keeps a frame reading as one
    // thing, and inert has to mean INERT: `lab.css` paints tier 1 on the drag
    // region unconditionally, so a 0-alpha overlay would still be an overlay.
    //
    // Asserted in both modes, because the two take different arms of the lift
    // (light the paper overlay, dark the ink one) and a share reintroduced on
    // either would be just as visible.
    expect(ARC_TUNING.lift.shares[0]).toBe(0);
    for (const mode of MODES) {
      const elevation = elevationOf(canvasOf("#e8652a"), mode);
      expect({ mode, outer: elevation.tiers[0] }).toEqual({
        mode,
        outer: { veil: "transparent", surfaces: [] },
      });
      // …and the inner half still moves, or pinning the chrome would have been
      // achieved by turning the whole mechanism off.
      expect({ mode, moved: elevation.tiers[1].surfaces.length > 0 }).toEqual({
        mode,
        moved: true,
      });
    }
  });

  it("reports the sidebar's position between canvas and paper, and only when there is one", () => {
    // At either end the sidebar is one of the two materials the window already
    // has; anywhere between it is a third, which is what the "three background
    // colours" complaint was. Light lands a fifth of the way over — close
    // enough to the canvas to still read as the window rather than as a second
    // card.
    const light = elevationOf(canvasOf("#e8652a")).sidebarTowardPaper;
    expect(light).toBeGreaterThan(0.1);
    expect(light).toBeLessThan(0.3);
    // Dark's lift walks AWAY from paper, so there is no position between the
    // two to report and 0 is the honest answer rather than a small number.
    expect(elevationOf(canvasOf("#e8652a"), "dark").sidebarTowardPaper).toBe(0);
  });

  it("keeps every shadow below the canvas it falls on, in both modes", () => {
    // A shadow works by removing luminance, so its colour has to be darker than
    // the backdrop or the halo glows instead of falling. Light's rung was chosen
    // against the light band and reusing it in dark would have failed exactly
    // here: 0.32 sits ABOVE a dark blue canvas at 0.205.
    for (const mode of MODES) {
      for (const hex of HUES) {
        const state = canvasOf(hex);
        const { L, C } = ARC_TUNING.shadow.color[mode];
        const shadowL = hexToOklch(oklchToHex(L, C, hexToOklch(hex).h)).L;
        const canvasL = hexToOklch(arcBaseFillHex(state, mode)).L;
        expect({ mode, hex, darker: shadowL < canvasL }).toEqual({ mode, hex, darker: true });
        expect({ mode, hex, casts: arcShadows(state, mode).card !== "none" }).toEqual({
          mode,
          hex,
          casts: true,
        });
      }
    }
  });

  it("keeps the on-canvas ink readable on the surfaces it creates", () => {
    // The reason `paint.ts` derives elevation BEFORE ink. A lifted tier is a
    // new surface under the sidebar's text, and it is not one of the pools — so
    // it, not the gradient, can be the worst case the ink has to clear.
    // Scoring the tiers here is what makes that ordering a contract.
    for (const mode of MODES) {
      for (const hex of HUES) {
        const state = canvasOf(hex);
        const tokens = deriveArcTokens(state, mode);
        // Both candidate inks are scored by `arcInk`; here we only need to know
        // that SOME ink clears the floor on every surface lift introduces.
        const worst = elevationOf(state, mode).surfaces.map((surface) =>
          Math.max(
            Math.abs(apcaLc(tokens["--foreground"], surface)),
            Math.abs(apcaLc(tokens["--background"], surface)),
          ),
        );
        expect({ mode, hex, floor: Math.min(...worst) > 45 }).toEqual({ mode, hex, floor: true });
      }
    }
  });
});

describe("shadows", () => {
  it("scales every layer's alpha by the settled strength, and casts in both modes", () => {
    // The strength used to be a dial and every layer's alpha was asserted to
    // track it. It is one number now, so the property that still matters is
    // that the number REACHES every layer: a peak alpha applied to some layers
    // and not others would show up as a shadow that changed shape rather than
    // weight. Read off `ARC_TUNING.shadow` rather than restated, so a retuned
    // peak is not a failure here — a dropped scale is.
    for (const mode of MODES) {
      const emitted = alphasOf(arcShadows(canvasOf("#e8652a"), mode).card);
      const peaks = ARC_TUNING.shadow.card.map(({ alpha }) => alpha);
      expect({ mode, emitted }).toEqual({
        mode,
        emitted: peaks.map((alpha) => expect.closeTo(alpha * ARC_SETTLED.shadow, 4)),
      });
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
    const { raised, card, overlay } = arcShadows(canvasOf("#e8652a"), "light");
    expect(reachOf(raised)).toBeLessThan(reachOf(card));
    expect(reachOf(card)).toBeLessThan(reachOf(overlay));
  });
});
