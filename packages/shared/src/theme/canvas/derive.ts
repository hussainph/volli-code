/** Neutral content paper; the person's canvas supplies chrome and accent only. */
import { hexToOklch, lerp, oklchToHex } from "../color";
import { generateAccentTokens, solveLightnessOrCeiling, solveStatusTokens } from "../generate";
import type { ThemeTokens } from "../tokens";
import { baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import type { Canvas, ResolvedAppearance } from "./types";

/** All content surfaces are opaque Apple neutrals, independent of the canvas. */
export function deriveCanvasTokens(canvas: Canvas, resolved: ResolvedAppearance): ThemeTokens {
  const dark = resolved === "dark";
  const paper = dark ? "#1e1e1e" : "#ffffff";
  const under = dark ? "#282828" : "#f6f6f6";
  // First stop is the accent. primaryIndex still controls the mesh's dominant pool.
  const seed = canvas.stops[0].hex;
  const accent = generateAccentTokens(seed);
  const { C, h } = hexToOklch(seed);
  const ink = oklchToHex(solveLightnessOrCeiling(75, C, h, tint(seed, paper, 0.18)), C, h);
  return {
    "--rail": under,
    "--background": paper,
    "--card": paper,
    "--popover": dark ? "#282828" : "#fafafa",
    "--muted": under,
    // Tint is opaque here for legacy callers and derived from the accent, not grey.
    "--accent": tint(seed, paper, dark ? 0.16 : 0.09),
    "--sidebar": dark ? "#282828" : "#f6f6f6",
    "--foreground": dark ? "#ededed" : "#272727",
    // These opaque tiers also clear 4.5:1 on the worst 90%-veiled glass pool.
    "--muted-foreground": dark ? "#bdbdbd" : "#555555",
    "--sidebar-foreground": dark ? "#ededed" : "#272727",
    "--border": dark ? "#424242" : "#dfdfdf",
    "--border-strong": dark ? "#5c5c5c" : "#bcbcbc",
    "--sidebar-border": dark ? "#424242" : "#dfdfdf",
    ...accent,
    "--primary-text": ink,
    "--ring": ink,
    ...solveStatusTokens(paper),
  };
}

/** sRGB compositing is also how CSS color-mix(in srgb, …) paints these fills. */
function tint(foreground: string, background: string, alpha: number): string {
  const channels = [1, 3, 5].map((at) =>
    Math.round(
      parseInt(foreground.slice(at, at + 2), 16) * alpha +
        parseInt(background.slice(at, at + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("")}`;
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
