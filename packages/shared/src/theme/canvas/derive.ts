/**
 * The canvas, pushed inward: the opaque content card stops being stock dark and
 * becomes a derivative of whatever gradient is on the window.
 *
 * Two directives, and why they land here rather than in the stylesheet:
 *
 *  1. The card is the surface stared at all day, so it must belong to the
 *     canvas's family — but contrast wins wherever the two disagree. A card that
 *     merely *tinted* toward a vivid canvas would drift with it; a card built by
 *     a ladder that pins lightness and lets only hue and chroma follow cannot.
 *  2. The light/dark ink flip has to be app-WIDE. A stylesheet can only flip the
 *     tokens that paint directly on the canvas; helper text inside the card
 *     (`--muted-foreground` and friends) is unreadable on a light surface until
 *     the whole token set flips with it.
 *
 * Both paths apply the same three settings in the same order — spread the rungs
 * (`ladder.ts`), mix them toward the canvas (also there), then solve the copy
 * against where they ended up (here). All three come from `ARC_SETTLED`, and all
 * three are per-mode or measured in both.
 *
 * Pure and deterministic, like the generator it is built on.
 */

import { hexToOklch, lerp, oklchToHex } from "../color";
import { DEFAULT_THEME } from "../definition";
import { generateThemeTokens, solveLightnessOrCeiling } from "../generate";
import type { ThemeTokens } from "../tokens";
import { copyFloors } from "./floors";
import { baseFillHex, effectiveChroma, effectiveStopHexes } from "./gradient";
import {
  buildDarkLadder,
  buildLightLadder,
  lightTint,
  SEED_CARRIER_L,
  type LadderFills,
} from "./ladder";
import { DEFAULT_CANVAS } from "./parse";
import { settled, type SettledDials } from "./settled";
import type { Canvas, ResolvedAppearance } from "./types";

/**
 * The accent-as-text floor, re-solved on the surface the copy tiers are solved
 * on rather than on the page's lightest rung. It is a link and a button label
 * inside panels, not a headline on `--background`.
 */
const ACCENT_TEXT_LC = 60;

/** Every foreground the two paths solve, and nothing else. */
type CopyTokens = Pick<
  ThemeTokens,
  | "--foreground"
  | "--card-foreground"
  | "--popover-foreground"
  | "--secondary-foreground"
  | "--accent-foreground"
  | "--sidebar-accent-foreground"
  | "--muted-foreground"
  | "--sidebar-foreground"
  | "--primary-text"
>;

/**
 * The copy tiers, solved against the ladder they will actually be painted on.
 *
 * Body on `--background`, secondary on `--card`, nav on `--sidebar` — the same
 * three surfaces in both modes, so the two appearances rank their copy
 * identically. A window that ordered its tiers one way in light and another in
 * dark would be two design languages wearing one theme.
 *
 * The asymmetry between body and secondary is the point rather than an oversight:
 * `--background` is the LIGHTEST rung in light, so a floor met only there is met
 * nowhere else, and secondary copy lives a rung down on every panel, rail and
 * popover in the app. Body's own floor already lands on the ink that was wanted,
 * and re-solving it one rung down would trade that ink for a near-black in the
 * name of consistency. See `floors.ts`.
 *
 * Every solve goes through `solveLightnessOrCeiling`, so a floor this canvas's
 * ink physically cannot reach clamps to the best its surface allows instead of
 * throwing — the gradient is the user's to author, and a saturated seed on
 * tinted paper can put the ask past what that hue reaches.
 */
function solveCopy(
  ladder: LadderFills,
  resolved: ResolvedAppearance,
  /** The ink's own chroma and hue — the one thing the two paths disagree about. */
  ink: { C: number; h: number },
  accent: { C: number; h: number },
): CopyTokens {
  const floors = copyFloors(resolved);
  const at = (targetLc: number, surface: string) =>
    oklchToHex(solveLightnessOrCeiling(targetLc, ink.C, ink.h, surface), ink.C, ink.h);

  const foreground = at(floors.body, ladder["--background"]);
  return {
    "--foreground": foreground,
    "--card-foreground": foreground,
    "--popover-foreground": foreground,
    "--secondary-foreground": foreground,
    "--accent-foreground": foreground,
    "--sidebar-accent-foreground": foreground,
    "--muted-foreground": at(floors.secondary, ladder["--card"]),
    "--sidebar-foreground": at(floors.sidebar, ladder["--sidebar"]),
    "--primary-text": oklchToHex(
      solveLightnessOrCeiling(ACCENT_TEXT_LC, accent.C, accent.h, ladder["--card"]),
      accent.C,
      accent.h,
    ),
  };
}

/**
 * The light path: a mirror of `generateThemeTokens`, step for step.
 *
 * `dark` is passed in rather than recomputed because three things are taken from
 * it verbatim. `--primary` and `--primary-foreground` are a solved PAIR whose
 * floor is measured on the button itself, so it holds whatever page the button
 * sits on — re-solving would be a no-op that could only introduce drift. And
 * `--destructive` is hue-locked by the semantic escape list, so it ignores the
 * seed entirely.
 */
function lightTokens(
  canvas: Canvas,
  seedChroma: number,
  hue: number,
  dark: ThemeTokens,
  dials: SettledDials,
): ThemeTokens {
  const tint = lightTint(seedChroma, canvas.vibrancy);
  const painted = hexToOklch(effectiveStopHexes(canvas, "light")[canvas.primaryIndex]);
  const ladder = buildLightLadder(painted, tint, hue, dials);
  // The accent's hue and chroma as the dark generation settled them, re-solved
  // for lightness only — so accent-as-text stays recognizably the accent instead
  // of becoming a second neutral.
  const accent = hexToOklch(dark["--primary"]);

  return {
    ...ladder,
    ...solveCopy(ladder, "light", { C: tint, h: hue }, accent),
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
 * The dark path — the opposite construction, and deliberately so. The light one
 * BUILDS a ladder from authored rungs because light has no shipped counterpart;
 * this one starts from the generator's output and moves it, because dark does.
 *
 * What is NOT touched: `--primary`/`--primary-foreground` and the hue-locked
 * `--destructive` family, both carried over by the spread below.
 */
function darkTokens(canvas: Canvas, dark: ThemeTokens, dials: SettledDials): ThemeTokens {
  const painted = hexToOklch(effectiveStopHexes(canvas, "dark")[canvas.primaryIndex]);
  const ladder = buildDarkLadder(dark, painted, dials);
  // The ink's own chroma and hue, taken from the generator's solved body copy so
  // the re-solve moves lightness ONLY. Anything else here would be inventing a
  // second opinion about how chromatic dark text should be.
  const ink = hexToOklch(dark["--foreground"]);
  const accent = hexToOklch(dark["--primary"]);

  return {
    ...dark,
    ...ladder,
    ...solveCopy(ladder, "dark", ink, accent),
  };
}

/**
 * The full app token set a canvas implies — what the inner card, its copy and
 * its controls become while this gradient is on the window.
 *
 * Seeded from the PRIMARY stop's authored hue at the chroma the canvas actually
 * paints, so vibrancy modulates the card exactly as it modulates the gradient: a
 * near-neutral wash yields near-neutral chrome, and a vivid canvas yields chrome
 * that visibly belongs to it.
 */
export function deriveCanvasTokens(canvas: Canvas, resolved: ResolvedAppearance): ThemeTokens {
  const { C, h } = hexToOklch(canvas.stops[canvas.primaryIndex].hex);
  const chroma = effectiveChroma(C, resolved, canvas.vibrancy);
  const dark = generateThemeTokens({
    ...DEFAULT_THEME,
    seed: oklchToHex(SEED_CARRIER_L, chroma, h),
  });
  const dials = settled(resolved);
  return resolved === "dark"
    ? darkTokens(canvas, dark, dials)
    : lightTokens(canvas, chroma, h, dark, dials);
}

/**
 * The micro-label tier — the one color the canvas derives that is not a
 * {@link ThemeTokens} member.
 *
 * It takes the ALREADY-DERIVED set rather than the canvas, and that is the whole
 * signature: deriving the tokens a second time here to read two of them is a
 * second derivation that can disagree with the first, and the two hexes it reads
 * are precisely the ends this tier interpolates between.
 *
 * A lightness walk between two solved inks, so the tier cannot invert and cannot
 * fall out of gamut — both endpoints are already representable, and everything
 * between two representable colors at one hue and chroma is too. Chroma and hue
 * come from body: the two are within a rounding step of each other and taking
 * them from one end rather than interpolating keeps the three tiers exactly one
 * family.
 *
 * Solved in BOTH modes. It used to be light-only, on the grounds that the dark
 * ladder's secondary tier already read at the weight that was wanted — true
 * while `textWeight` was light-only, and false the moment it stopped being. A
 * tier that exists at one appearance and not the other would make the system
 * appearance change the NUMBER of copy rungs on screen as well as their weight.
 */
export function deriveLabelInk(tokens: ThemeTokens, resolved: ResolvedAppearance): string {
  const body = hexToOklch(tokens["--foreground"]);
  const secondary = hexToOklch(tokens["--muted-foreground"]);
  const t = copyFloors(resolved).labelTowardSecondary;
  return oklchToHex(lerp(body.L, secondary.L, t), body.C, body.h);
}

/**
 * The one flat color the main process needs for `BrowserWindow.backgroundColor`.
 *
 * The canvas's own base fill, which is literally the last layer of
 * {@link canvasBackground} — the color the window shows wherever no pool reaches,
 * and therefore the one Chromium should paint during a resize and before first
 * paint. Not `--background`: that is the CARD's rung, and with a canvas armed the
 * card no longer reaches the window's edge.
 *
 * `null` (nothing stored yet, or a stored canvas that failed to parse) yields the
 * shipped default, because a window is created long before any UI exists to
 * surface a read failure in.
 */
export function windowBackground(canvas: Canvas | null, resolved: ResolvedAppearance): string {
  return baseFillHex(canvas ?? DEFAULT_CANVAS, resolved);
}
