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
  THEME_TOKEN_NAMES,
  type ThemeTokenName,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ARC_CANVAS, type ArcCanvasState, type ArcResolvedMode } from "./model";
import { ARC_TOKEN_FLOORS, deriveArcTokens, LIGHT_LADDER } from "./tokens";

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
    for (const { hex, vibrancy } of everyCase().filter((one) => one.resolved === "light")) {
      const tokens = deriveArcTokens(canvasOf(hex, vibrancy), "light");
      const body = hexToOklch(tokens["--foreground"]).L;
      const secondary = hexToOklch(tokens["--muted-foreground"]).L;
      expect({ case: `${hex} @ v${vibrancy}`, gap: secondary - body > 0.1 }).toEqual({
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
});
