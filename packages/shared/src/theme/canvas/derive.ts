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
import {
  generateAccentTokens,
  generateThemeTokens,
  solveLightnessOrCeiling,
  solveStatusTokens,
  type AccentTokens,
} from "../generate";
import type { ThemeTokens } from "../tokens";
import { copyFloors } from "./floors";
import { accentChroma, baseFillHex, effectiveChroma, effectiveStopHexes } from "./gradient";
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
  "--foreground" | "--muted-foreground" | "--sidebar-foreground" | "--primary-text"
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

  return {
    "--foreground": at(floors.body, ladder["--background"]),
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
 * `accent` arrives already solved and is shared with the dark path unchanged:
 * `--primary` and `--primary-foreground` are a solved PAIR whose floor is
 * measured on the button itself, so the button holds whatever page it sits on.
 *
 * The four hue-locked semantics are the opposite case: hue-locked and still not
 * carryable, because they are SOLVED against the card, and this path's card is
 * the one thing that is not the dark path's. Copying them here is precisely the
 * hand-written `dark:` twin, moved into the generator. `--destructive` was the
 * one member this path did copy across, back when it was frozen outright; it is
 * solved now, so nothing crosses and the dark set is no longer a parameter.
 */
function lightTokens(
  canvas: Canvas,
  seedChroma: number,
  hue: number,
  accent: AccentTokens,
  dials: SettledDials,
): ThemeTokens {
  const tint = lightTint(seedChroma, canvas.vibrancy);
  const painted = hexToOklch(effectiveStopHexes(canvas, "light")[canvas.primaryIndex]);
  const ladder = buildLightLadder(painted, tint, hue, dials);

  return {
    ...ladder,
    ...solveCopy(ladder, "light", { C: tint, h: hue }, hexToOklch(accent["--primary"])),
    ...accent,
    ...solveStatusTokens(ladder["--card"]),
  };
}

/**
 * The dark path — the opposite construction, and deliberately so. The light one
 * BUILDS a ladder from authored rungs because light has no shipped counterpart;
 * this one starts from the generator's output and moves it, because dark does.
 *
 * What the ladder does NOT touch: the accent family, which the spread replaces
 * wholesale with the one solved off the canvas's own chroma.
 *
 * The hue-locked family is re-solved rather than carried, even here where the
 * mode matches: `dark` holds them solved against the SHIPPED ladder's card, and
 * the whole job of `buildDarkLadder` is to move that card toward the canvas.
 */
function darkTokens(
  canvas: Canvas,
  dark: ThemeTokens,
  accent: AccentTokens,
  dials: SettledDials,
): ThemeTokens {
  const painted = hexToOklch(effectiveStopHexes(canvas, "dark")[canvas.primaryIndex]);
  const ladder = buildDarkLadder(dark, painted, dials);
  // The ink's own chroma and hue, taken from the generator's solved body copy so
  // the re-solve moves lightness ONLY. Anything else here would be inventing a
  // second opinion about how chromatic dark text should be.
  const ink = hexToOklch(dark["--foreground"]);

  return {
    ...dark,
    ...ladder,
    ...accent,
    ...solveCopy(ladder, "dark", ink, hexToOklch(accent["--primary"])),
    ...solveStatusTokens(ladder["--card"]),
  };
}

/**
 * The full app token set a canvas implies — what the inner card, its copy and
 * its controls become while this gradient is on the window.
 *
 * TWO seeds, not one, and the split is the load-bearing part.
 *
 * The NEUTRALS take the chroma the canvas actually paints, so vibrancy modulates
 * the card exactly as it modulates the gradient: a near-neutral wash yields
 * near-neutral chrome, and a vivid canvas yields chrome that visibly belongs to
 * it. That chroma is deliberately capped and per-mode (`effectiveChroma`) —
 * every rung of the ladder inherits from it, and a ladder built from a saturated
 * seed is a window full of brown greys.
 *
 * The ACCENT takes the same vibrancy curve without that ceiling
 * (`accentChroma`), because the numbers holding the background down are about
 * being a *background*. Seeding both families at one number made the app's own
 * brand color unreachable in dark at every setting of the slider; seeding the
 * ladder at the accent's number would warm every grey in the window. So they are
 * two calls at two chromas through one construction — the same carrier hex, the
 * same solvers — and each family is taken from the call that was seeded for it.
 *
 * The accent's call carries no appearance, and that is a statement rather than a
 * saving: one accent serves both modes, so a light↔dark flip repaints every
 * surface in the window and leaves the one color the user recognizes it by
 * exactly where it was.
 */
export function deriveCanvasTokens(canvas: Canvas, resolved: ResolvedAppearance): ThemeTokens {
  const { C, h } = hexToOklch(canvas.stops[canvas.primaryIndex].hex);
  const chroma = effectiveChroma(C, resolved, canvas.vibrancy);
  const seed = (seedChroma: number) => oklchToHex(SEED_CARRIER_L, seedChroma, h);
  const dark = generateThemeTokens({ ...DEFAULT_THEME, seed: seed(chroma) });
  const accent = generateAccentTokens(seed(accentChroma(C, canvas.vibrancy)));
  const dials = settled(resolved);
  return resolved === "dark"
    ? darkTokens(canvas, dark, accent, dials)
    : lightTokens(canvas, chroma, h, accent, dials);
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
