/**
 * The frozen APCA reference vectors this repository owns (VC-412).
 *
 * WHY THIS FILE EXISTS. {@link apcaLc} used to be cross-checked against the
 * `apca-w3` package — a second implementation imported as an oracle by
 * `color.test.ts`, `generate.test.ts` and the canvas smoke. That package pulls
 * `colorparsley`, whose manifest declares `"license": "AGPL v3"`, and the
 * owner's decision for VC-412 is that a project shipping as commercial OSS
 * downstream carries neither. So the dependency is gone, and the verification
 * it carried has to live here instead. Nothing in the product ever imported
 * it; only the checks did.
 *
 * WHAT A VECTOR IS. `[text, background, Lc]` — the magnitude
 * `apcaLc(text, background)` must return, to four decimals. The pairs are not
 * a random spread. Each group is chosen to sit inside one APCA constant's
 * region of influence, so that the table cannot stay green while a constant
 * moves:
 *
 *   • both polarity extremes, which APCA weights differently on purpose;
 *   • the surfaces and ink this app actually ships, in both appearances;
 *   • pure primaries on black and on white, which pin the three luminance
 *     coefficients against each other;
 *   • near-black pairs, which only the soft black clamp explains;
 *   • the two 8-bit steps either side of the low-contrast clip, in both
 *     polarities, which pin the clip to within one step.
 *
 * `color.test.ts` proves that claim rather than asserting it: it re-derives
 * every vector from a separately written transcription of the APCA-W3 0.1.9
 * formula, then perturbs each constant of that transcription in turn and
 * requires at least one vector to disagree. A table that pinned nothing would
 * fail that test, not quietly pass this one.
 *
 * PROVENANCE. The numbers were captured from `apcaLc` itself, and the commit
 * that removed `apca-w3` recorded that they matched the departing oracle
 * exactly (zero difference across the 18×18 spread and four 256-step grey
 * ramps `color.test.ts` had always compared). They are a characterization
 * lock, and honest about it: they say "this is the function we shipped and
 * measured", and the invariants and the constant-pinning test beside them are
 * what say "and it is the right function".
 *
 * Data only, and importable from plain Node with type stripping — the canvas
 * smoke (`apps/desktop/e2e/canvas-theming-smoke.mjs`) reads it to prove the
 * metric it measures the running app's tokens with is this pinned one.
 */

/** One reference vector: text hex, background hex, and the Lc magnitude expected. */
export type ApcaVector = readonly [text: string, background: string, lc: number];

export const APCA_VECTORS: readonly ApcaVector[] = [
  // --- the two extremes, both polarities ---------------------------------
  // APCA-W3 0.1.9's published black/white anchors. They are not equal, and
  // that asymmetry is the whole reason this app measures with APCA rather
  // than with WCAG 2's symmetric ratio.
  ["#ffffff", "#000000", 107.8847],
  ["#000000", "#ffffff", 106.0407],
  ["#808080", "#000000", 34.7638],
  ["#808080", "#ffffff", 66.8961],
  ["#ffffff", "#808080", 72.4],

  // --- the shipped dark canvas: the smoke's own DARK table ---------------
  ["#e8e4e2", "#1c1310", 90.0044],
  ["#bdbab8", "#1c1310", 64.6139],
  ["#d0cdcb", "#211815", 75.2201],
  ["#fc9a74", "#1c1310", 60.6737],
  ["#ffffff", "#d37550", 65.038],
  ["#fbf1ed", "#211815", 98.5732],

  // --- the shipped light canvas ------------------------------------------
  ["#1c1310", "#fdded2", 89.1651],
  ["#000000", "#e2c3b7", 75.0398],

  // --- the ember golden, and the two tokens below the body-copy floor ----
  ["#ebe3df", "#15100e", 90.1672],
  ["#ff966c", "#15100e", 60.1422],
  ["#b2b2b2", "#151515", 59.8329],
  ["#9a9a9a", "#111111", 47.2064],
  ["#e8652a", "#111111", 41.3938],

  // --- pure primaries: the three luminance coefficients, against each
  //     other and in both polarities. Green carries the most luminance and
  //     blue the least, so these three cannot all stay green if one
  //     coefficient drifts.
  ["#ff0000", "#000000", 37.545],
  ["#00ff00", "#000000", 86.4892],
  ["#0000ff", "#000000", 16.2258],
  ["#ff0000", "#ffffff", 64.1262],
  ["#00ff00", "#ffffff", 17.1301],
  ["#0000ff", "#ffffff", 85.8208],

  // --- the soft black clamp ----------------------------------------------
  // Below Y 0.022 APCA lifts luminance rather than letting near-blacks pull
  // apart, which is why the first three of these are a flat 0 and why white
  // on #050505 is barely under white on #000000.
  ["#0a0a0a", "#000000", 0],
  ["#000000", "#0a0a0a", 0],
  ["#1a1a1a", "#000000", 0],
  ["#ffffff", "#050505", 107.8571],
  ["#9a9a9a", "#000000", 47.7122],
  ["#020202", "#9a9a9a", 49.9184],

  // --- the low-contrast clip, one 8-bit step either side, both polarities -
  // APCA reports small contrasts as *none* rather than as a small number, so
  // its output jumps from 0 straight to ~7.5. These four pairs are the two
  // steps that straddle that jump on a dark background and on a light one;
  // they are what hold the clip threshold in place.
  ["#3e3e3e", "#111111", 0],
  ["#3f3f3f", "#111111", 7.615],
  ["#efefef", "#ffffff", 0],
  ["#eeeeee", "#ffffff", 7.5674],

  // --- saturated and off-axis pairs --------------------------------------
  ["#7f00ff", "#ffff00", 73.8704],
  ["#123456", "#9a9a9a", 42.4222],
  ["#e5484d", "#0d0d0d", 36.0009],
];
