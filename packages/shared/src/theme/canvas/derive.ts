/** Neutral reading paper with canvas-tinted surrounding materials. */
import { compositeHex, hexToOklch, lerp, oklchToHex } from "../color";
import { generateAccentTokens, solveLightnessOrCeiling, solveStatusTokens } from "../generate";
import type { ThemeTokens } from "../tokens";
import { baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import type { Canvas, ResolvedAppearance } from "./types";
import { ARC_TUNING } from "./tuning";
import { readingInk, writingGlass } from "./glass";

/**
 * One chroma budget for the surrounding neutral family: fills, edges and secondary ink.
 * Reading paper is exempt. Lightness belongs to the rung, hue to the first authored stop (the accent),
 * never the mesh's movable primaryIndex. Near-grey canvases stay near-grey.
 * Vibrancy modulates colour, not reading lightness; gamut mapping may reduce
 * chroma further at the palest rungs. No resolved colour is stored.
 * Also consumed by the renderer's glass/card/control material generator.
 */
export function tintCanvasNeutral(
  neutral: string,
  canvas: Canvas,
  resolved: ResolvedAppearance,
): string {
  const { C, h } = hexToOklch(canvas.stops[0].hex);
  const chroma =
    Math.min(C * 0.25, ARC_TUNING.neutralTint[resolved]) * lerp(0.6, 1, canvas.vibrancy);
  return oklchToHex(hexToOklch(neutral).L, chroma, h);
}

/** Paper stays neutral; cards, controls, fills and secondary ink carry the canvas hue. */
export function deriveCanvasTokens(canvas: Canvas, resolved: ResolvedAppearance): ThemeTokens {
  const dark = resolved === "dark";
  const neutral = (hex: string) => tintCanvasNeutral(hex, canvas, resolved);
  // The reading plane is invariant. Tint belongs to the objects placed on it.
  const paper = dark ? "#1e1e1e" : "#ffffff";
  const under = neutral(dark ? "#282828" : "#eaeaea");
  const popover = neutral(dark ? "#282828" : "#fafafa");
  // First stop is the accent. primaryIndex still controls the mesh's dominant pool.
  const seed = canvas.stops[0].hex;
  const accent = generateAccentTokens(seed);
  const { C, h } = hexToOklch(seed);
  const selected = compositeHex(seed, 0.18, paper);
  const readingPools = [paper, under, selected, ...writingGlass(popover, resolved).pools];
  const ink = oklchToHex(solveLightnessOrCeiling(75, C, h, selected), C, h);
  // Actual glass pools and dark selections can compress the secondary hierarchy.
  const secondaryHex = readingInk(
    neutral(dark ? "#bdbdbd" : "#555555"),
    readingPools,
    resolved,
    4.5,
  );
  return {
    "--rail": under,
    "--background": paper,
    "--card": paper,
    "--popover": popover,
    "--muted": under,
    // Tint is opaque here for legacy callers and derived from the accent, not grey.
    "--accent": compositeHex(seed, dark ? 0.16 : 0.09, paper),
    "--sidebar": under,
    "--foreground": dark ? "#ededed" : "#272727",
    // Paper's opaque secondary tier. Navigation glass solves its own ink pair.
    "--muted-foreground": secondaryHex,
    "--sidebar-foreground": dark ? "#ededed" : "#272727",
    "--border": neutral(dark ? "#424242" : "#d2d2d2"),
    "--border-strong": neutral(dark ? "#5c5c5c" : "#afafaf"),
    "--sidebar-border": neutral(dark ? "#424242" : "#d2d2d2"),
    ...accent,
    "--primary-text": ink,
    "--ring": readingInk(ink, readingPools, resolved, 3),
    ...solveStatusTokens(paper),
  };
}

/** The micro-label tier sits between body and secondary, never below secondary. */
export function deriveLabelInk(tokens: ThemeTokens, _resolved: ResolvedAppearance): string {
  const body = hexToOklch(tokens["--foreground"]);
  const secondary = hexToOklch(tokens["--muted-foreground"]);
  return oklchToHex(lerp(body.L, secondary.L, 0.65), body.C, body.h);
}

/** Synchronous BrowserWindow hint, not persisted resolved tokens. */
export function windowBackground(canvas: Canvas | null, resolved: ResolvedAppearance): string {
  return baseFillHex(canvas ?? DEFAULT_CANVAS, resolved);
}
