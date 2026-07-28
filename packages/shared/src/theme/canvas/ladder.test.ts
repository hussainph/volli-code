/**
 * The two ladder tables, asserted against each other and against the settled
 * spread that indexes them — the properties that hold before any canvas is
 * involved.
 */
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME } from "../definition";
import { generateThemeTokens } from "../generate";
import { hexToOklch } from "../color";
import { buildDarkLadder, DARK_LADDER, LIGHT_LADDER, spreadCurve } from "./ladder";
import { ARC_SETTLED, settled } from "./settled";

describe("the light ladder", () => {
  it("descends without a single repeated token", () => {
    const { rungs } = LIGHT_LADDER;
    for (let i = 1; i < rungs.length; i += 1) {
      expect(rungs[i].L).toBeLessThan(rungs[i - 1].L);
    }
    // The whole surface set, covered exactly once.
    const covered = rungs.flatMap((rung) => rung.tokens);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("opens, which is the correction it exists for", () => {
    // Light's rungs were mirrored from the dark generator's step for step, and
    // perceptual step size is not symmetric about mid-grey — so they arrived too
    // tight near paper. Unlike dark's, this range therefore STARTS at 1 and only
    // opens, and the settled value is near its top.
    const { min, max } = LIGHT_LADDER.spread;
    expect(min).toBe(1);
    expect(min + (max - min) * ARC_SETTLED.surfaceSpread.light).toBeGreaterThan(2);
  });
});

describe("the dark ladder", () => {
  it("keeps gain 1.0 at the centre of its range, and settles above it", () => {
    // `DARK_LADDER.spread` is centred so 0.5 is a multiplier of exactly 1.0,
    // which is the range's anchor: at that position the ladder is the shipped
    // dark one byte for byte. The centre is a fixed point that a later widening
    // or narrowing must preserve, so it is asserted on the table rather than
    // through a derivation the settled value can no longer reach.
    const { min, max } = DARK_LADDER.spread;
    expect((min + max) / 2).toBeCloseTo(1, 10);
    // …and the settled position sits ABOVE it, i.e. the dark ladder is opened
    // rather than tightened. That direction is the whole claim: `cardTint` pulls
    // every rung toward one target and so compresses the gaps, and the spread is
    // what buys them back.
    expect(min + (max - min) * ARC_SETTLED.surfaceSpread.dark).toBeGreaterThan(1);
  });

  it("reproduces the generator's own ladder at the range's centre and no tint", () => {
    // The anchor, exercised rather than merely stated. Spread 0.5 is gain 1.0 and
    // tint 0 mixes nothing, so every surface has to come back byte-identical to
    // what `generateThemeTokens` emitted — which is what makes this path a MOVE
    // of the shipped ladder rather than a second one.
    const dark = generateThemeTokens(DEFAULT_THEME);
    const ladder = buildDarkLadder(dark, hexToOklch("#e8652a"), {
      ...settled("dark"),
      surfaceSpread: 0.5,
      cardTint: 0,
    });
    for (const token of DARK_LADDER.surfaces) {
      expect({ token, hex: ladder[token] }).toEqual({ token, hex: dark[token] });
    }
  });
});

describe("spreadCurve", () => {
  it("pins the origin and fades to nothing at the far end", () => {
    const spread = spreadCurve(0.9, 0.2, 2);
    // The page is the one surface with nowhere to go: a ladder whose anchor
    // drifted with a spacing control would be a brightness control.
    expect(spread(0.9)).toBeCloseTo(0.9, 10);
    // The deepest rung is already as far as it goes.
    expect(spread(0.7)).toBeCloseTo(0.7, 10);
    // Between them the gain applies, faded by how far along the rung sits.
    expect(spread(0.8)).toBeLessThan(0.8);
  });

  it("runs the gain in both directions, which is what lets one curve serve both ladders", () => {
    // Dark's `--card` sits ABOVE its `--background` while its `--rail` sits below,
    // so a formula that assumed one direction would push half the ladder the
    // wrong way.
    const spread = spreadCurve(0.18, 0.2, 2);
    expect(spread(0.2)).toBeGreaterThan(0.2);
    expect(spread(0.16)).toBeLessThan(0.16);
  });

  it("leaves a depthless ladder alone rather than filling it with NaN", () => {
    // No far end to fade toward means 0/0 at the origin. Unreachable from either
    // table — both have depth — which is exactly why it is asserted here: the
    // failure would be a window painted `#NaNNaNNaN`, not an error.
    const spread = spreadCurve(0.5, 0, 2);
    expect(spread(0.5)).toBe(0.5);
    expect(Number.isNaN(spread(0.6))).toBe(false);
  });
});
