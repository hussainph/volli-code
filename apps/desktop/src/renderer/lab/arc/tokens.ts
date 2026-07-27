/**
 * The canvas, pushed inward: the opaque content card stops being stock dark and
 * becomes a derivative of whatever gradient is on the window.
 *
 * The owner's two directives, and why they land here rather than in the seam:
 *
 *  1. The card is the surface stared at all day, so it must belong to the
 *     canvas's family — but contrast wins wherever the two disagree. A card
 *     that merely *tinted* toward a vivid canvas would drift with it; a card
 *     built by a ladder that pins lightness and lets only hue and chroma follow
 *     cannot.
 *  2. The light/dark ink flip has to be app-WIDE. `lab.css` can only flip the
 *     two tokens that paint directly on the canvas; helper text inside the card
 *     (`--muted-foreground` and friends) is unreadable on a light surface until
 *     the whole token set flips with it.
 *
 * Two paths, and only one of them is new work:
 *
 *  - **Dark** delegates entirely to the app's own `generateThemeTokens`, seeded
 *    from the canvas's primary. That generator is the proven ladder — every
 *    lightness is a constant in it and every foreground is APCA-solved — so
 *    hand-building a second dark ladder here would be inventing a way to be
 *    wrong.
 *  - **Light** has no shipped counterpart (the app is dark-only, `class="dark"`
 *    pinned), so {@link LIGHT_LADDER} is a mirror of `generate.ts`: same shape,
 *    same floor list, same solver, inverted rungs. It deliberately reuses that
 *    module's exported `solveLightnessForContrast` rather than reimplementing
 *    it — the solver already chooses its search arm FROM the background, which
 *    is exactly the light-mode case its own docstring says it was generalized
 *    for.
 *
 * Pure and deterministic, like the generator it mirrors. No DOM: `paint.ts`
 * writes the result.
 */
import {
  DEFAULT_THEME,
  generateThemeTokens,
  hexToOklch,
  neutralChroma,
  oklchToHex,
  solveLightnessForContrast,
  type ThemeTokenName,
  type ThemeTokens,
} from "@volli/shared";

import { effectiveChroma, type ArcCanvasState, type ArcResolvedMode } from "./model";

/**
 * The contrast floors this module is held to — the SAME list `generate.ts`
 * declares, restated as data so the sweep can iterate it.
 *
 * Identical to `scratches/theming.tsx`'s table on purpose: if a floor moves in
 * the generator, both of these are wrong until it moves here too, which is the
 * intended failure mode. A silent disagreement would be a test that passes for
 * the wrong reason.
 */
export const ARC_TOKEN_FLOORS: readonly {
  text: ThemeTokenName;
  surface: ThemeTokenName;
  floor: number;
  what: string;
}[] = [
  { text: "--foreground", surface: "--background", floor: 90, what: "Body copy" },
  { text: "--muted-foreground", surface: "--background", floor: 60, what: "Secondary copy" },
  { text: "--sidebar-foreground", surface: "--sidebar", floor: 75, what: "Sidebar nav" },
  { text: "--primary-text", surface: "--background", floor: 60, what: "Accent as text" },
  { text: "--primary-foreground", surface: "--primary", floor: 60, what: "Button label" },
];

/**
 * Everything the light path is tuned by, in one commented block — the same
 * contract as `ARC_TUNING`, because this ladder gets adjusted from screenshots
 * exactly like the gradient does.
 */
export const LIGHT_LADDER = {
  /**
   * The seed handed to `generateThemeTokens`. Its lightness is arbitrary and
   * DISCARDED by that function (it reads hue and chroma only), so this is a
   * carrier, not a color anybody sees. Mid-scale so it is representable at
   * every hue and chroma the canvas can produce.
   */
  seedCarrierL: 0.6,

  /**
   * The neutral ladder, LIGHTEST → darkest: a fixed lightness plus a chroma
   * multiplier per rung, mirroring `generate.ts`'s table with the ordering
   * turned over. `k` still rises as the rungs move AWAY from paper, for the
   * same reason it rises there — a constant chroma reads as draining of color
   * across a ladder.
   *
   * Two placements are not free choices and must not be "fixed" by eye:
   *
   *  - `--sidebar` sits BELOW `--rail`, the reverse of the dark ladder. The
   *    veil solve (`veil.ts`) is `C = (T − B(1−α))/α` at α 0.10, so the veiled
   *    surface may exceed its base by at most (255 − B)/10 bytes — about 2 at
   *    this end of the scale. A sidebar lighter than the rail is unsolvable
   *    here, and `generateVeilTokens` does not clamp: it would emit an
   *    out-of-range `rgb()` and the sidebar would quietly composite wrong.
   *  - `--rail` is darker than `--background` rather than lighter. In the dark
   *    ladder the rail is the recessive backdrop; on a light page receding
   *    means darker, and a backdrop lighter than the content card would make
   *    the card read as a hole punched in the window.
   */
  rungs: [
    { tokens: ["--background"], L: 0.955, k: 1.0 },
    { tokens: ["--popover"], L: 0.945, k: 1.0 },
    { tokens: ["--card"], L: 0.938, k: 1.1 },
    { tokens: ["--rail"], L: 0.93, k: 0.8 },
    { tokens: ["--secondary", "--muted"], L: 0.918, k: 1.2 },
    { tokens: ["--sidebar"], L: 0.9, k: 1.1 },
    { tokens: ["--sidebar-border"], L: 0.878, k: 1.4 },
    { tokens: ["--accent", "--sidebar-accent"], L: 0.872, k: 1.3 },
    { tokens: ["--border", "--input"], L: 0.858, k: 1.4 },
    { tokens: ["--border-hover"], L: 0.806, k: 1.5 },
    { tokens: ["--border-strong"], L: 0.778, k: 1.5 },
  ] satisfies readonly { tokens: readonly ThemeTokenName[]; L: number; k: number }[],

  /**
   * How much the paper is allowed to say about the canvas, as a multiplier on
   * `neutralChroma` — lerped by vibrancy so the slider reaches both ends of the
   * owner's ask: 0 is near-neutral paper, 1 is clearly tinted.
   *
   * 3 is a measured ceiling, not a taste: at L 0.955 the sRGB boundary is close
   * enough that a warm hue already gives chroma back to the gamut map there
   * (0.0288 requested, 0.0240 kept). Past it the cool hues keep gaining and the
   * warm ones do not, so the tint would stop being even across the wheel.
   */
  tintGain: { min: 1, max: 3 },
} as const;

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * The light ladder: a mirror of `generateThemeTokens`, step for step.
 *
 * `dark` is passed in rather than recomputed because three things are taken
 * from it verbatim. `--primary` and `--primary-foreground` are a solved PAIR
 * whose floor is measured on the button itself, so it holds whatever page the
 * button sits on — re-solving would be a no-op that could only introduce drift.
 * `--destructive` is hue-locked by the semantic escape list and ignores the
 * seed entirely.
 */
function lightTokens(
  state: ArcCanvasState,
  seedChroma: number,
  hue: number,
  dark: ThemeTokens,
): ThemeTokens {
  const tint =
    neutralChroma(seedChroma) *
    lerp(LIGHT_LADDER.tintGain.min, LIGHT_LADDER.tintGain.max, state.vibrancy);

  const ladder = {} as Record<ThemeTokenName, string>;
  for (const { tokens, L, k } of LIGHT_LADDER.rungs) {
    const hex = oklchToHex(L, tint * k, hue);
    for (const token of tokens) ladder[token] = hex;
  }
  const background = ladder["--background"];
  const sidebar = ladder["--sidebar"];

  // Every foreground here is solved against a CARD surface and nothing else.
  // Secondary copy also appears on the canvas — in a sidebar that gave up its
  // fill to sit on it — but that is not this token's problem to carry: one
  // value cannot serve near-white paper and a mid-tone gradient at once, and
  // trying collapses body and secondary onto the same hex while still missing
  // the floor the gradient needs. `lab.css` flips the on-canvas subtrees to the
  // canvas ink instead, which is the arrangement the port will formalize as
  // dedicated tokens.
  const foregroundL = solveLightnessForContrast(90, tint, hue, background);
  const mutedForegroundL = solveLightnessForContrast(60, tint, hue, background);
  const sidebarForegroundL = solveLightnessForContrast(75, tint, hue, sidebar);

  const foreground = oklchToHex(foregroundL, tint, hue);
  // The accent's hue and chroma as the dark generation settled them, re-solved
  // for lightness only — so accent-as-text stays recognizably the accent
  // instead of becoming a second neutral.
  const accent = hexToOklch(dark["--primary"]);

  return {
    ...ladder,
    "--foreground": foreground,
    "--card-foreground": foreground,
    "--popover-foreground": foreground,
    "--secondary-foreground": foreground,
    "--accent-foreground": foreground,
    "--sidebar-accent-foreground": foreground,
    "--muted-foreground": oklchToHex(mutedForegroundL, tint, hue),
    "--sidebar-foreground": oklchToHex(sidebarForegroundL, tint, hue),
    "--primary-text": oklchToHex(
      solveLightnessForContrast(60, accent.C, accent.h, background),
      accent.C,
      accent.h,
    ),
    "--primary": dark["--primary"],
    "--primary-foreground": dark["--primary-foreground"],
    "--ring": dark["--primary"],
    "--sidebar-primary": dark["--primary"],
    "--sidebar-primary-foreground": dark["--primary-foreground"],
    "--sidebar-ring": dark["--primary"],
    "--destructive": dark["--destructive"],
    "--destructive-foreground": dark["--destructive-foreground"],
  };
}

/**
 * The full app token set a canvas implies — what the inner card, its copy and
 * its controls become while this gradient is on the window.
 *
 * Seeded from the PRIMARY stop's authored hue at the chroma the canvas actually
 * paints, so vibrancy modulates the card exactly as it modulates the gradient:
 * a near-neutral wash yields near-neutral chrome, and a vivid canvas yields
 * chrome that visibly belongs to it.
 */
export function deriveArcTokens(state: ArcCanvasState, resolved: ArcResolvedMode): ThemeTokens {
  const { C, h } = hexToOklch(state.stops[state.primaryIndex].hex);
  const chroma = effectiveChroma(C, resolved, state.vibrancy);
  const dark = generateThemeTokens({
    ...DEFAULT_THEME,
    seed: oklchToHex(LIGHT_LADDER.seedCarrierL, chroma, h),
  });
  return resolved === "dark" ? dark : lightTokens(state, chroma, h, dark);
}
