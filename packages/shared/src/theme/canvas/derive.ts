/** Neutral reading paper with canvas-tinted surrounding materials. */
import { compositeHex, hexToOklch, lerp, oklchToHex, wcagContrast } from "../color";
import { generateAccentTokens, solveLightnessOrCeiling, solveStatusTokens } from "../generate";
import type { ThemeTokens } from "../tokens";
import { baseFillHex } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import type { Canvas, ResolvedAppearance } from "./types";
import { ARC_TUNING } from "./tuning";
import { SECONDARY_FILL_ALPHA, readingInk, writingGlass } from "./glass";

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

/**
 * Writing glass is translucent, so its tint adds to whatever the backdrop
 * shows. Over a saturated green corner a green-tinted veil, under the 7.8%
 * resting fill an inspector control paints (`.inspector-popup`), pushes body ink below AA even
 * though neutral glass clears it. Body ink stays fixed; the tint yields only as
 * much chroma as that pair needs, keeping its lightness and hue.
 */
function writingGlassFill(
  tinted: string,
  foreground: string,
  fill: string,
  resolved: ResolvedAppearance,
): string {
  const passes = (hex: string) =>
    writingGlass(hex, resolved).pools.every(
      (pool) =>
        wcagContrast(foreground, pool) >= 4.5 &&
        wcagContrast(foreground, compositeHex(fill, SECONDARY_FILL_ALPHA, pool)) >= 4.5,
    );
  if (passes(tinted)) return tinted;
  const { L, C, h } = hexToOklch(tinted);
  let low = 0,
    high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (passes(oklchToHex(L, C * mid, h))) low = mid;
    else high = mid;
  }
  return oklchToHex(L, C * low, h);
}

/**
 * The paper-side backings reading ink and the focus ring clear: paper, the
 * under-page, the accent selection, the editor selection and every filtered
 * writing-glass corner. The renderer's painted ring adds its navigation
 * backings to this same set, in one solve.
 */
export function readingBackings(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  tokens: Pick<ThemeTokens, "--background" | "--muted" | "--popover" | "--foreground">,
): string[] {
  const paper = tokens["--background"];
  return [
    paper,
    tokens["--muted"],
    compositeHex(canvas.stops[0].hex, 0.18, paper),
    compositeHex(tintCanvasNeutral(tokens["--foreground"], canvas, resolved), 0.22, paper),
    ...writingGlass(tokens["--popover"], resolved).pools,
  ];
}

/**
 * Non-text 3:1 focus indication: the accent ink, moved toward the appearance's
 * pole only as far as every backing needs. Bounded at the pole; the contrast
 * tests are what establish that a backing set admits it.
 */
export function focusRing(
  ink: string,
  backings: readonly string[],
  resolved: ResolvedAppearance,
): string {
  return readingInk(ink, backings, resolved, 3);
}

/** Paper stays neutral; cards, controls, fills and secondary ink carry the canvas hue. */
export function deriveCanvasTokens(canvas: Canvas, resolved: ResolvedAppearance): ThemeTokens {
  const dark = resolved === "dark";
  const neutral = (hex: string) => tintCanvasNeutral(hex, canvas, resolved);
  // The reading plane is invariant. Tint belongs to the objects placed on it.
  const paper = dark ? "#1e1e1e" : "#ffffff";
  const under = neutral(dark ? "#282828" : "#eaeaea");
  const foreground = dark ? "#ededed" : "#272727";
  const popover = writingGlassFill(
    neutral(dark ? "#282828" : "#fafafa"),
    foreground,
    // The renderer's --fill-secondary ink: the same tinted foreground
    // (canvas-paint.test pins the emitted fill to it).
    neutral(foreground),
    resolved,
  );
  // First stop is the accent. primaryIndex still controls the mesh's dominant pool.
  const seed = canvas.stops[0].hex;
  const accent = generateAccentTokens(seed);
  const { C, h } = hexToOklch(seed);
  const selected = compositeHex(seed, 0.18, paper);
  const readingPools = readingBackings(canvas, resolved, {
    "--background": paper,
    "--muted": under,
    "--popover": popover,
    "--foreground": foreground,
  });
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
    "--foreground": foreground,
    // Paper's opaque secondary tier. Navigation glass solves its own ink pair.
    "--muted-foreground": secondaryHex,
    "--sidebar-foreground": dark ? "#ededed" : "#272727",
    "--border": neutral(dark ? "#424242" : "#d2d2d2"),
    "--border-strong": neutral(dark ? "#5c5c5c" : "#afafaf"),
    "--sidebar-border": neutral(dark ? "#424242" : "#d2d2d2"),
    ...accent,
    "--primary-text": ink,
    // The paper-side ring. The app paints deriveCanvasPaint's ring, solved once
    // from this same ink against these backings plus navigation glass.
    "--ring": focusRing(ink, readingPools, resolved),
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

/**
 * Settings' plain canvas (VC-1228). The Settings window is a native-style
 * pane, the one deliberate exception to "every surface wears the canvas": it
 * paints system greys in the resolved appearance, never the authored gradient.
 * One achromatic stop (macOS systemGray) at zero vibrancy and grain runs through
 * the same pipeline as any canvas, so its tokens stay generated, never authored.
 * Never stored and never offered as a user canvas.
 */
export const SETTINGS_CANVAS: Canvas = {
  stops: [{ hex: "#8e8e93", x: 0.5, y: 0.5 }],
  primaryIndex: 0,
  vibrancy: 0,
  grain: 0,
};

/**
 * The accent Settings wears over those greys: the system blue, solved by the
 * same pipeline. A canvas's first stop is both its accent and its neutral
 * tint, so the accent comes from this second canvas and the greys from the
 * first; a grey accent left an on switch reading as off.
 */
export const SETTINGS_ACCENT_CANVAS: Canvas = {
  stops: [{ hex: "#007aff", x: 0.5, y: 0.5 }],
  primaryIndex: 0,
  vibrancy: 0,
  grain: 0,
};

/** The accent-derived tokens Settings takes from {@link SETTINGS_ACCENT_CANVAS}. */
const SETTINGS_ACCENT_TOKEN_NAMES = [
  "--accent",
  "--primary",
  "--primary-foreground",
  "--primary-text",
] as const satisfies readonly (keyof ThemeTokens)[];

/** Settings' token set: system greys with the system accent; the ring re-solved over both. */
export function deriveSettingsTokens(resolved: ResolvedAppearance): ThemeTokens {
  const tokens = deriveCanvasTokens(SETTINGS_CANVAS, resolved);
  const accent = deriveCanvasTokens(SETTINGS_ACCENT_CANVAS, resolved);
  for (const name of SETTINGS_ACCENT_TOKEN_NAMES) tokens[name] = accent[name];
  tokens["--ring"] = focusRing(
    tokens["--primary-text"],
    [
      ...readingBackings(SETTINGS_CANVAS, resolved, tokens),
      compositeHex(SETTINGS_ACCENT_CANVAS.stops[0].hex, 0.18, tokens["--background"]),
    ],
    resolved,
  );
  return tokens;
}

/** The Settings window's floor: its plain canvas's sidebar rung, for `backgroundColor`. */
export function settingsWindowBackground(resolved: ResolvedAppearance): string {
  return deriveCanvasTokens(SETTINGS_CANVAS, resolved)["--sidebar"];
}
