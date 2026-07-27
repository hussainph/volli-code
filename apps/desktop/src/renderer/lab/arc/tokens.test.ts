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

import { DEFAULT_ARC_CANVAS, type ArcCanvasState, type ArcResolvedMode } from "./model";
import {
  ARC_TOKEN_FLOORS,
  deriveArcLabelInk,
  deriveArcTokens,
  lightFloors,
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

describe("deriveArcTokens", () => {
  it("clears every declared contrast floor, for every canvas the editor can reach", () => {
    const failures: string[] = [];
    for (const { hex, vibrancy, resolved } of everyCase()) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), resolved);
      for (const { text, surface, floor, what } of ARC_TOKEN_FLOORS) {
        const lc = Math.abs(apcaLc(tokens[text], tokens[surface]));
        if (lc < floor) {
          failures.push(
            `${what} (${text} on ${surface}) scored ${lc.toFixed(1)} < ${floor} — ${hex} @ v${vibrancy} ${resolved}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
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

  it("clears the LIGHT floors on the surface each one is actually painted on", () => {
    // The bug this locks out, measured before the fix: secondary copy cleared
    // its floor on `--background` (60.3) and missed it on `--card` (57.0) —
    // and `--card` is the rung every panel, rail and popover in the app paints
    // it on. A floor asserted against the lightest surface in the ladder is a
    // floor that fails everywhere else in the ladder.
    const failures: string[] = [];
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      for (const textWeight of [0, 0.5, 1]) {
        const state = { ...canvasOf(hex, vibrancy), textWeight };
        const tokens = deriveArcTokens(state, "light");
        const floors = lightFloors(textWeight);
        const label = deriveArcLabelInk(state, "light");
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
          // assert that OKLCH can produce contrast it cannot, and the dial is
          // allowed to ask for more than the color space has.
          const { C, h } = hexToOklch(text);
          const owed = Math.min(floor, Math.abs(apcaLc(oklchToHex(0, C, h), surface)));
          if (lc < owed - 0.5) {
            failures.push(
              `${what} scored ${lc.toFixed(1)} < ${owed.toFixed(1)} — ${hex} @ v${vibrancy} w${textWeight}`,
            );
          }
        }
        // The label tier has no floor of its own — it is a position between the
        // two above — so what it owes is that it stay between them.
        const labelL = hexToOklch(label ?? "").L;
        const bodyL = hexToOklch(tokens["--foreground"]).L;
        const secondaryL = hexToOklch(tokens["--muted-foreground"]).L;
        if (!(labelL > bodyL && labelL < secondaryL)) {
          failures.push(
            `label L ${labelL.toFixed(3)} outside body ${bodyL.toFixed(3)}…secondary ${secondaryL.toFixed(3)} — ${hex} @ v${vibrancy} w${textWeight}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a real span between body and secondary, at every weight", () => {
    // The span is what has to survive the dial; where the label sits inside it
    // is what the dial is FOR. At weight 1 the label lands 0.3 Lc off body,
    // because "use the branch text's colour across the board" is exactly what
    // the top of that travel means — asserting a minimum gap there would be
    // asserting against the request.
    //
    // So this holds the two ends apart, and the floors test above holds the
    // label between them. Together those are the whole contract; neither is
    // enough alone.
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      for (const textWeight of [0, 0.5, 1]) {
        const state = { ...canvasOf(hex, vibrancy), textWeight };
        const tokens = deriveArcTokens(state, "light");
        const card = tokens["--card"];
        const body = Math.abs(apcaLc(tokens["--foreground"], card));
        const secondary = Math.abs(apcaLc(tokens["--muted-foreground"], card));
        const at = `${hex} @ v${vibrancy} w${textWeight} — ${body.toFixed(1)}/${secondary.toFixed(1)}`;
        expect({ at, spanned: body - secondary > 2 }).toEqual({ at, spanned: true });
      }
    }
  });

  it("mixes the paper toward the canvas without letting vibrancy off the hook", () => {
    // `cardTint` and `vibrancy` are not two names for one dial. Tint decides
    // how much of the canvas reaches the paper; vibrancy decides how much
    // canvas there is to reach it — so a quiet canvas stays quiet however far
    // the tint is pushed, which is the property that keeps the two composable.
    const chromaAt = (vibrancy: number, cardTint: number) =>
      hexToOklch(deriveArcTokens({ ...canvasOf("#e8652a", vibrancy), cardTint }, "light")["--card"])
        .C;

    expect(chromaAt(0.6, 0.25)).toBeGreaterThan(chromaAt(0.6, 0) * 1.5);
    expect(chromaAt(0, 0.25)).toBeLessThan(0.01);
  });

  it("holds the ladder's order at every tint, so no veil solve leaves its window", () => {
    // Every rung moves by the same fraction toward the same target, so gaps
    // scale by (1 − tint) and the order is preserved by construction. Asserted
    // anyway: the veil solve `C = (T − B(1−α))/α` does not clamp, and a pair
    // that swapped rungs would emit an out-of-range rgb() rather than an error.
    for (const cardTint of [0, 0.05, 0.25]) {
      for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
        const tokens = deriveArcTokens({ ...canvasOf(hex, vibrancy), cardTint }, "light");
        const rungs = LIGHT_LADDER.rungs.map((rung) => hexToOklch(tokens[rung.tokens[0]]).L);
        for (let i = 1; i < rungs.length; i += 1) {
          const at = `${hex} @ v${vibrancy} t${cardTint} rung ${i}`;
          expect({ at, descending: rungs[i] <= rungs[i - 1] }).toEqual({ at, descending: true });
        }
      }
    }
  });
});
