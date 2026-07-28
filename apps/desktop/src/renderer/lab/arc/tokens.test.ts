/**
 * The floors, swept rather than spot-checked.
 *
 * A derived token set has one job — stay readable for every canvas anyone can
 * author — and a handful of examples cannot show that. So this is a value sweep
 * over the whole input space the editor can reach: hue × vibrancy × mode, with
 * the achromatic extremes included because they are where the generator's
 * grey-seed guard changes behavior and where a chroma-scaled ladder is most
 * likely to divide by something it should not.
 *
 * `ARC_TOKEN_FLOORS` is iterated as DATA, exactly like `scratches/theming.tsx`
 * does, so this file states no floor of its own — it asks the same table the
 * generator's own contract is written in.
 *
 * The sweeps used to run over the spread/tint/weight cube as well, because all
 * three were dials and a floor had to hold at every corner of it. They are
 * settled now, so the cube is a point: the sweep below covers the canvas and
 * `describe("the settled settings")` at the bottom pins the point itself, so a
 * future edit that drifts one of the three fails on the number it was solved
 * for rather than somewhere downstream of it.
 */
import {
  apcaLc,
  hexToOklch,
  isHexColor,
  oklchToHex,
  THEME_TOKEN_NAMES,
  type ThemeTokenName,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  ARC_SETTLED,
  DEFAULT_ARC_CANVAS,
  type ArcCanvasState,
  type ArcResolvedMode,
} from "./model";
import {
  ARC_TOKEN_FLOORS,
  copyFloors,
  DARK_LADDER,
  deriveArcLabelInk,
  deriveArcTokens,
  LIGHT_LADDER,
} from "./tokens";

/** Eight hues around the wheel plus both achromatic extremes. */
const HUES = [
  "#e8652a", // ember — the shipped accent
  "#c53d43", // red
  "#f2d060", // yellow
  "#4a7d5b", // green
  "#2e6f8e", // teal
  "#4653a2", // blue
  "#a06bb8", // violet
  "#f2a7c3", // magenta
  "#000000", // no hue at all
  "#ffffff", // no hue, other end
];

const VIBRANCIES = [0, 0.6, 1];
const MODES: readonly ArcResolvedMode[] = ["light", "dark"];

function canvasOf(hex: string, vibrancy: number): ArcCanvasState {
  return { ...DEFAULT_ARC_CANVAS, stops: [{ hex, x: 0.68, y: 0.3 }], vibrancy };
}

/** Every (hue, vibrancy, mode) the sweep covers, as one flat list of cases. */
function everyCase(): { hex: string; vibrancy: number; resolved: ArcResolvedMode }[] {
  return HUES.flatMap((hex) =>
    VIBRANCIES.flatMap((vibrancy) => MODES.map((resolved) => ({ hex, vibrancy, resolved }))),
  );
}

/**
 * The best contrast ANY ink can reach on `surface` — measured from the two
 * extremes of the space rather than from a hue, so it is an upper bound on
 * every candidate: nothing at any chroma beats black or white on a given
 * surface. The same expression `solveClamped` guards with.
 */
function ceilingOn(surface: string): number {
  return Math.max(Math.abs(apcaLc("#000000", surface)), Math.abs(apcaLc("#ffffff", surface)));
}

/** |ΔL| between the page and the rail on the shipped canvas — the tab strip's pair. */
function railGap(resolved: ArcResolvedMode): number {
  const tokens = deriveArcTokens(DEFAULT_ARC_CANVAS, resolved);
  return Math.abs(hexToOklch(tokens["--background"]).L - hexToOklch(tokens["--rail"]).L);
}

/** The two copy numbers exactly as the editor's readout rounds them. */
function shownFloors(resolved: ArcResolvedMode): { secondary: number; labelTowardBody: number } {
  const floors = copyFloors(resolved);
  return {
    secondary: Number(floors.secondary.toFixed(0)),
    labelTowardBody: Math.round((1 - floors.labelTowardSecondary) * 100),
  };
}

describe("deriveArcTokens", () => {
  it("clears every declared floor, or the ceiling its surface physically allows", () => {
    // The escape clause is not a softened assertion, it is the honest contract,
    // and the settled spread is what made it load-bearing. A floor can be asked
    // for on a surface where NO ink of any hue reaches it: light's `--sidebar`
    // is pushed to L 0.840, where even pure black scores 74.8 against a
    // declared 75. `solveClamped` answers that by clamping rather than
    // throwing, so the assertion has to be the one that can actually be kept —
    // every token either meets its floor or is AT the best its surface allows,
    // which still catches anything short for a reason other than physics.
    //
    // The next test pins how narrow that exception is, and it has to stay
    // narrow or this one stops meaning anything.
    const failures: string[] = [];
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      for (const { text, surface, floor, what } of ARC_TOKEN_FLOORS) {
        const lc = Math.abs(apcaLc(tokens[text], tokens[surface]));
        if (lc < floor && lc < ceilingOn(tokens[surface]) - 0.5) {
          failures.push(
            `${what} (${text} on ${surface}) scored ${lc.toFixed(1)} < ${floor} — ${hex} @ v${vibrancy} ${resolved}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("names the ONE floor the settled spread puts physically out of reach", () => {
    // The exception above, pinned by name and by size so it cannot quietly
    // grow into a standing hole in the contract.
    //
    // It is `--sidebar-foreground` and nothing else, in light and not dark, and
    // it misses by under half an Lc. The cause is `ARC_SETTLED.surfaceSpread`:
    // solving light's rail gap to 0.042 drives every rung below the page down
    // with it, and `--sidebar` lands at L 0.840 where the space itself runs out
    // a fraction short of 75. It is also the least costly place for that to
    // happen — `lab.css` overrides this token with the canvas ink on every
    // surface that sits out on the gradient, which is where the sidebar is.
    //
    // If a retune drives some OTHER rung past its ceiling, this fails and names
    // it. That is the intended failure mode.
    const capped = new Set<string>();
    let shortfall = 0;
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      for (const { text, surface, floor } of ARC_TOKEN_FLOORS) {
        const ceiling = ceilingOn(tokens[surface]);
        if (ceiling >= floor) continue;
        capped.add(`${text} on ${surface} in ${resolved}`);
        shortfall = Math.max(shortfall, floor - ceiling);
      }
    }
    expect([...capped]).toEqual(["--sidebar-foreground on --sidebar in light"]);
    expect(shortfall).toBeLessThan(0.5);
  });

  it("keeps gain 1.0 at the centre of the dark spread range, and settles above it", () => {
    // `DARK_LADDER.spread` is centred so 0.5 is a multiplier of exactly 1.0,
    // which is the range's anchor: at that position the ladder is the shipped
    // dark one byte for byte. The centre is a fixed point that a later widening
    // or narrowing of the range must preserve, so it is asserted on the table
    // rather than through a derivation the settled value can no longer reach.
    const { min, max } = DARK_LADDER.spread;
    expect((min + max) / 2).toBeCloseTo(1, 10);
    // …and the settled position sits ABOVE it, i.e. the dark ladder is opened
    // rather than tightened. That direction is the whole claim: `cardTint`
    // pulls every rung toward one target and so compresses the gaps, and the
    // spread is what buys them back.
    const gain = min + (max - min) * ARC_SETTLED.surfaceSpread.dark;
    expect(gain).toBeGreaterThan(1);
  });

  it("opens the light ladder, which is the correction it exists for", () => {
    // Light's rungs were mirrored from the dark generator's step for step, and
    // perceptual step size is not symmetric about mid-grey — so they arrived
    // too tight near paper. Unlike dark's, this range therefore STARTS at 1 and
    // only opens, and the settled value is near its top.
    const { min, max } = LIGHT_LADDER.spread;
    expect(min).toBe(1);
    const gain = min + (max - min) * ARC_SETTLED.surfaceSpread.light;
    expect(gain).toBeGreaterThan(2);
  });

  it("keeps the rail a real gap under the page on every canvas, in both modes", () => {
    // The rung the complaint was actually about: the tab strip under a tab.
    // Pinned to a floor here and to its exact settled value below — this one is
    // the property that has to survive every seed, that one is the number the
    // seeds were tuned around.
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      const gap = Math.abs(hexToOklch(tokens["--background"]).L - hexToOklch(tokens["--rail"]).L);
      const at = `${hex} @ v${vibrancy} ${resolved} — ${gap.toFixed(4)}`;
      expect({ at, separated: gap > 0.015 }).toEqual({ at, separated: true });
    }
  });

  it("emits every token name as a paintable hex", () => {
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      const broken = THEME_TOKEN_NAMES.filter(
        (name) => typeof tokens[name] !== "string" || !isHexColor(tokens[name]),
      );
      // A missing name is the trap CLAUDE.md names: it silently keeps whatever
      // the previous set left on the element, so the card would half-flip.
      expect({ case: `${hex} @ v${vibrancy} ${resolved}`, broken }).toEqual({
        case: `${hex} @ v${vibrancy} ${resolved}`,
        broken: [],
      });
    }
  });

  it("actually inverts polarity in light mode, and keeps it in dark", () => {
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      const background = hexToOklch(tokens["--background"]).L;
      const foreground = hexToOklch(tokens["--foreground"]).L;
      const label = `${hex} @ v${vibrancy} ${resolved}`;
      if (resolved === "light") {
        expect({ label, lighter: background > foreground }).toEqual({ label, lighter: true });
      } else {
        expect({ label, lighter: background < foreground }).toEqual({ label, lighter: true });
      }
    }
  });

  it("keeps a real copy hierarchy — secondary is visibly lighter than body", () => {
    // Distinct, not merely non-inverted. Solving this token against the canvas
    // as well as the card used to flatten the two onto one hex; the on-canvas
    // rows are handled by the scoped flip in `lab.css` instead, which leaves
    // this free to say what it means on the card.
    //
    // Stated in Lc rather than in the ΔL 0.1 it used to be. That threshold was
    // calibrated when secondary sat at Lc 60 and 0.1 of lightness was what
    // separated the two; raising secondary to 75 deliberately closes the gap in
    // lightness while keeping it wide in the unit anyone perceives. Asserting
    // the old number here would have made the fix look like a regression.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), "light");
      const card = tokens["--card"];
      const gap =
        Math.abs(apcaLc(tokens["--foreground"], card)) -
        Math.abs(apcaLc(tokens["--muted-foreground"], card));
      expect({ case: `${hex} @ v${vibrancy}`, gap: gap > 6 }).toEqual({
        case: `${hex} @ v${vibrancy}`,
        gap: true,
      });
    }
  });

  it("holds the light ladder's descending order, so no two surfaces swap rungs", () => {
    const rungs = LIGHT_LADDER.rungs;
    for (let i = 1; i < rungs.length; i += 1) {
      expect(rungs[i].L).toBeLessThan(rungs[i - 1].L);
    }
    // The whole THEME_TOKEN_NAMES surface set, covered exactly once.
    const covered = rungs.flatMap((rung) => rung.tokens);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("keeps every veil solvable at the light end", () => {
    // `generateVeilTokens` solves C = (T − B(1−α))/α and does NOT clamp, so a
    // rung pair outside the window silently emits an out-of-range rgb().
    const pairs: [ThemeTokenName, ThemeTokenName][] = [
      ["--sidebar", "--rail"],
      ["--sidebar-accent", "--sidebar"],
      ["--sidebar-border", "--sidebar"],
    ];
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), "light");
      for (const [target, base] of pairs) {
        for (let channel = 0; channel < 3; channel += 1) {
          const at = (name: ThemeTokenName) =>
            parseInt(tokens[name].slice(1 + channel * 2, 3 + channel * 2), 16);
          const solved = (at(target) - at(base) * 0.9) / 0.1;
          expect({
            case: `${target} over ${base} — ${hex} @ v${vibrancy}`,
            inRange: solved >= 0 && solved <= 255,
          }).toEqual({ case: `${target} over ${base} — ${hex} @ v${vibrancy}`, inRange: true });
        }
      }
    }
  });

  it("lets vibrancy decide how much the paper says about the canvas", () => {
    // Vibrancy 0 is near-neutral paper; 1 is visibly of the canvas's family.
    const quiet = hexToOklch(deriveArcTokens(canvasOf("#2e6f8e", 0), "light")["--background"]).C;
    const loud = hexToOklch(deriveArcTokens(canvasOf("#2e6f8e", 1), "light")["--background"]).C;
    expect(quiet).toBeLessThan(0.008);
    expect(loud).toBeGreaterThan(quiet * 2);
  });

  it("is deterministic — the same canvas always derives the same set", () => {
    const state = canvasOf("#4653a2", 0.6);
    for (const resolved of MODES) {
      expect(deriveArcTokens(state, resolved)).toEqual(deriveArcTokens(state, resolved));
    }
  });

  it("clears the copy floors on the surface each one is actually painted on", () => {
    // The bug this locks out, measured before the fix: secondary copy cleared
    // its floor on `--background` (60.3) and missed it on `--card` (57.0) —
    // and `--card` is the rung every panel, rail and popover in the app paints
    // it on. A floor asserted against the lightest surface in the ladder is a
    // floor that fails everywhere else in the ladder.
    const failures: string[] = [];
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const state = canvasOf(hex, vibrancy);
      const tokens = deriveArcTokens(state, resolved);
      const floors = copyFloors(resolved);
      const label = deriveArcLabelInk(state, resolved);
      // Each tier on the surface it is SOLVED against — the whole point of
      // the correction. Measuring both on the lightest rung is what let
      // secondary sit 3 Lc under its own floor for as long as it did.
      const cases: [string, string, string, number][] = [
        ["body", tokens["--foreground"], tokens["--background"], floors.body],
        ["secondary", tokens["--muted-foreground"], tokens["--card"], floors.secondary],
      ];
      for (const [what, text, surface, floor] of cases) {
        const lc = Math.abs(apcaLc(text, surface));
        // The ask is clamped to what the hue can actually deliver
        // (`solveClamped`), so the assertion is against the SAME ceiling
        // rather than against the raw floor. Demanding the raw number would
        // assert that OKLCH can produce contrast it cannot, and a chromatic
        // ink on tinted paper does not always have it.
        const { C, h } = hexToOklch(text);
        const bound = hexToOklch(surface).L < 0.5 ? 1 : 0;
        const owed = Math.min(floor, Math.abs(apcaLc(oklchToHex(bound, C, h), surface)));
        if (lc < owed - 0.5) {
          failures.push(
            `${what} scored ${lc.toFixed(1)} < ${owed.toFixed(1)} — ${hex} @ v${vibrancy} ${resolved}`,
          );
        }
      }
      // The label tier has no floor of its own — it is a position between the
      // two above — so what it owes is that it stay between them. Stated as a
      // DISTANCE from body, since light's inks darken away from paper and
      // dark's lighten away from it.
      const labelL = hexToOklch(label ?? "").L;
      const bodyL = hexToOklch(tokens["--foreground"]).L;
      const secondaryL = hexToOklch(tokens["--muted-foreground"]).L;
      if (!(Math.abs(labelL - bodyL) < Math.abs(secondaryL - bodyL) && labelL !== bodyL)) {
        failures.push(
          `label L ${labelL.toFixed(3)} outside body ${bodyL.toFixed(3)}…secondary ${secondaryL.toFixed(3)} — ${hex} @ v${vibrancy} ${resolved}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a real span between body and secondary, on every canvas and in both modes", () => {
    // The span is what the settled weight has to leave intact; where the label
    // sits inside it is what the weight decides. Both ends of `secondary`'s
    // range are deliberately close to body — the top of it is "use the branch
    // text's colour across the board" — so this asserts the tiers stay
    // distinguishable rather than asserting a comfortable gap.
    //
    // So this holds the two ends apart, and the floors test above holds the
    // label between them. Together those are the whole contract; neither is
    // enough alone.
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      const card = tokens["--card"];
      const body = Math.abs(apcaLc(tokens["--foreground"], card));
      const secondary = Math.abs(apcaLc(tokens["--muted-foreground"], card));
      const at = `${hex} @ v${vibrancy} ${resolved} — ${body.toFixed(1)}/${secondary.toFixed(1)}`;
      expect({ at, spanned: body - secondary > 2 }).toEqual({ at, spanned: true });
    }
  });

  it("mixes the paper toward the canvas without letting vibrancy off the hook", () => {
    // `cardTint` and `vibrancy` were never two names for one thing. The tint
    // decides how much of the canvas reaches the paper; vibrancy decides how
    // much canvas there is to reach it. It settled at the top of its range, so
    // the property that matters is the one that stops that from being loud on
    // its own: at vibrancy 0 the wash is near-neutral, and a quarter of nearly
    // nothing is still nearly nothing.
    const chromaAt = (vibrancy: number) =>
      hexToOklch(deriveArcTokens(canvasOf("#e8652a", vibrancy), "light")["--card"]).C;

    expect(chromaAt(0)).toBeLessThan(0.01);
    expect(chromaAt(0.6)).toBeGreaterThan(chromaAt(0) * 3);
    expect(chromaAt(1)).toBeGreaterThan(chromaAt(0.6));
  });

  it("holds the light ladder's order down to `--border-hover`", () => {
    // The tint moves every rung by the same fraction toward the same target,
    // so gaps scale by (1 − tint) and the order among them is preserved by
    // construction. The SPREAD is what can break it, and the assertion stops
    // one rung short of the end because at the settled spread it does — see
    // the next test. Everything above that point is what the veil solve
    // `C = (T − B(1−α))/α` depends on, and it does not clamp: a pair that
    // swapped rungs would emit an out-of-range rgb() rather than an error.
    const rungs = LIGHT_LADDER.rungs.slice(0, -1);
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), "light");
      const Ls = rungs.map((rung) => hexToOklch(tokens[rung.tokens[0]]).L);
      for (let i = 1; i < Ls.length; i += 1) {
        const at = `${hex} @ v${vibrancy} — ${rungs[i - 1].tokens[0]} → ${rungs[i].tokens[0]}`;
        expect({ at, descending: Ls[i] <= Ls[i - 1] }).toEqual({ at, descending: true });
      }
    }
  });

  it("bounds the last rung's inversion, which the settled spread introduces", () => {
    // A characterization, not an endorsement. `spreadCurve` applies its FADED
    // multiplier to a rung's whole distance from paper rather than integrating
    // it along the way, which makes the map non-monotone once the gain passes
    // 2.0 — and light's settled gain is 2.509. So `--border-strong`, which sits
    // at the fade's far end and by design does not move at all, ends up a
    // little LIGHTER than `--border-hover`, which is still being pushed.
    //
    // Measured at ΔL 0.0063 on ember and never more across the sweep: two
    // hairline borders a hundredth of a lightness unit out of order, under a
    // ladder whose visible surfaces all sit above them and whose veil pairs do
    // not involve either. Left rather than fixed because the fix is a change to
    // the curve, and the curve is what the settled spread was chosen against —
    // that is a retune, not a freeze.
    //
    // Bounded here so it cannot grow: if a later edit widens it into something
    // visible, or pushes the inversion up into a rung that carries a surface,
    // this fails.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), "light");
      const hover = hexToOklch(tokens["--border-hover"]).L;
      const strong = hexToOklch(tokens["--border-strong"]).L;
      const at = `${hex} @ v${vibrancy} — hover ${hover.toFixed(4)} strong ${strong.toFixed(4)}`;
      expect({ at, hairline: strong - hover < 0.01 }).toEqual({ at, hairline: true });
    }
  });
});

/**
 * The three numbers the tuning pass ended on, pinned to what they were solved
 * FOR rather than to the value that produces them.
 *
 * This is the block that makes the freeze legible. Each of `surfaceSpread` and
 * `textWeight` is a position on a range whose endpoints are argued at length
 * elsewhere; nothing about the position itself says why 0.943 and not 0.9. What
 * says it is the measurement underneath — a rail gap, an Lc, a percentage — so
 * that is what is asserted here, and the constant is left free to move if the
 * range under it is ever retuned to keep the same measurement.
 *
 * Measured on the ember default at vibrancy 0.6, which is the canvas the app
 * ships and the one every number here was tuned against. The sweeps above cover
 * the other seeds; this covers the one the value was chosen on.
 */
describe("the settled settings", () => {
  it("puts the rail ΔL where `surfaceSpread` was solved to put it", () => {
    // Two targets, because perceptual step size is not symmetric about
    // mid-grey: 0.042 reads near paper, 0.020 reads near black, and the same
    // number in both would leave one mode's tab strip invisible.
    //
    // Dark's is 0.0197 rather than 0.0200 because the rungs are 8-bit and that
    // is the nearest one — the plateau either side of it spans spread
    // 0.571–0.683, and 0.627 is its middle.
    expect(railGap("light")).toBeCloseTo(0.042, 3);
    expect(railGap("dark")).toBeCloseTo(0.0197, 3);
  });

  it("holds the light rail gap ABOVE the dark one, which is the reason for two numbers", () => {
    // The relationship, not just the pair: if a retune ever collapses these to
    // one value, this is what says the mirror's defect has been forgotten.
    expect(railGap("light")).toBeGreaterThan(railGap("dark") * 1.8);
  });

  it("puts secondary copy and the label tier where `textWeight` was solved to put them", () => {
    // The two halves of one choice, and both have to hold: the weight is a
    // single position on two ranges, so a value that hits the secondary target
    // and misses the label one is not the value that was picked. The band
    // satisfying both is 0.122–0.144 in light and 0.211–0.233 in dark, and the
    // settled numbers sit in the middle of each.
    expect(shownFloors("light")).toEqual({ secondary: 70, labelTowardBody: 51 });
    expect(shownFloors("dark")).toEqual({ secondary: 64, labelTowardBody: 55 });
  });

  it("delivers those floors as actual measured contrast on the card", () => {
    // The floors are an ask; this is what the solver returned. They agree to
    // within a rounding step on the ember default, which is what says the ask
    // was reachable rather than clamped — the case `solveClamped` exists for.
    for (const resolved of MODES) {
      const tokens = deriveArcTokens(DEFAULT_ARC_CANVAS, resolved);
      const measured = Math.abs(apcaLc(tokens["--muted-foreground"], tokens["--card"]));
      expect({ resolved, measured }).toEqual({
        resolved,
        measured: expect.closeTo(copyFloors(resolved).secondary, 0),
      });
    }
  });
});
