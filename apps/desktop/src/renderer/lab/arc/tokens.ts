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
  apcaLc,
  DEFAULT_THEME,
  generateThemeTokens,
  hexToOklch,
  neutralChroma,
  oklchToHex,
  solveLightnessForContrast,
  type ThemeTokenName,
  type ThemeTokens,
} from "@volli/shared";

import {
  effectiveChroma,
  effectiveStopHexes,
  type ArcCanvasState,
  type ArcResolvedMode,
} from "./model";

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

  /**
   * How far the ladder's rungs are pushed APART, as a multiplier on each rung's
   * drop below `--background`.
   *
   * The rungs above were mirrored from `generate.ts` step for step, and that is
   * where they inherited a spacing that does not survive the mirror. Perceptual
   * step size is not symmetric about mid-grey: the dark ladder separates `--rail`
   * from `--background` by ΔL 0.020 near L 0.17 and it reads clearly; the same
   * 0.020 near L 0.94 is a surface you have to hunt for. It is why the tab strip
   * and the tab on it were one shape in light mode, and why "UI elements in the
   * inner space lose contrast" was a report about every panel at once rather
   * than about any one of them.
   *
   * The multiplier FADES OUT as the drop grows, and that shape is the whole
   * design. A flat multiplier fixes the surfaces and wrecks the bottom of the
   * ladder in the same stroke — the border rungs are already far from paper, so
   * scaling them equally turns hairlines into rules and quietly delivers the
   * heavier borders that were explicitly not asked for. Fading it means the
   * rungs that are invisible get the correction and the rungs that already work
   * are left alone; `--border-strong`, the furthest, does not move at all.
   */
  spread: { min: 1, max: 2.6 },
} as const;

/**
 * What light-mode copy is held to, as a function of `state.textWeight`.
 *
 * The dark ladder gets ONE floor per role because it only ever paints on
 * near-black; light mode gets a range because the owner's judgment is the input
 * here. Measured on the shipped default before this existed: secondary copy
 * scored Lc 60.3 on `--background` — its declared floor — but **57.0 on
 * `--card`**, which is the surface the ticket rail and every panel actually
 * paint it on. So it was missing its own contract on the surface that matters,
 * and reading faint was not a matter of taste.
 *
 * Two fixes, and they are independent. The floors move (below), AND the solve
 * moves to `--card`: a token solved against the lightest rung in the ladder is
 * guaranteed to under-deliver on every rung beneath it.
 *
 * `label` is its own tier because the micro-labels (PRIORITY, DOING) are
 * uppercase at 11px — the smallest, widest-tracked text in the app, and the
 * least forgiving of a low score. It sits ABOVE secondary and just below body.
 *
 * Every range below is centred so that `textWeight` 0.5 gives **90 / 85 / 75 on
 * the card** — the arrangement the owner chose. That is the anchor: a later
 * adjustment to one range should be checked against this line rather than
 * against whatever the previous adjustment happened to leave behind.
 */
export const LIGHT_FLOORS = {
  /**
   * Body copy, on `--background` — deliberately NOT moved to the card with the
   * others, because this one token is already the answer.
   *
   * The ink it produces (#352a26 on the shipped default) is the branch and
   * base-branch text the owner named as the thing he liked, and a floor is a
   * means to an ink rather than the other way round. Re-solving the same 90
   * against `--card` looks like the consistent choice and is not: APCA's curve
   * is steep at the paper end, so one rung of surface costs a great deal of
   * text — the identical floor reaches for #0d0503 there, a stark near-black
   * nobody asked for and visibly heavier than the text being matched.
   */
  body: 90,
  /**
   * Secondary copy, on `--card`: the old floor at 0, near-body at 1.
   *
   * This is the one that was genuinely broken. It declared 60, cleared it on
   * `--background` (60.3) and missed it on `--card` (57.0) — and `--card` is
   * where the ticket rail, the panels and the popovers actually paint it.
   *
   * The ceiling is set by `body`, not by taste: body scores about 84.6 on the
   * card (its 90 is measured a rung up), so a secondary allowed past that would
   * end up DARKER than the copy it is subordinate to. 82 leaves the tier intact
   * at the very top of the dial with a couple of Lc to spare.
   */
  secondary: { min: 68, max: 82 },
  /**
   * Micro-labels — a POSITION between body and secondary, not a floor of their
   * own. 0 is body's exact ink, 1 is secondary's.
   *
   * Stated relatively because that is what the owner asked for: "I like the
   * colour of the branch text, that could be used across the board" is a
   * request about a specific ink, and any absolute Lc that reproduces it does
   * so only for the surface and tint it was measured against. This holds at
   * every spread, tint and hue instead — and it cannot invert the hierarchy or
   * run out of color space the way a fourth independent solve can, since both
   * of its endpoints are already-solved inks.
   *
   * The travel runs BACKWARDS against the weight dial (0.55 → 0.10): turning
   * copy weight up means moving labels toward body, which is a smaller
   * fraction, not a larger one.
   */
  labelTowardSecondary: { min: 0.55, max: 0.1 },
  /** Sidebar nav. Unmoved — `lab.css` flips it to the canvas ink anyway. */
  sidebar: 75,
} as const;

/** {@link LIGHT_FLOORS} with the weight applied — the numbers actually solved for. */
export function lightFloors(textWeight: number): {
  /** Lc, on `--background`. */
  body: number;
  /** Lc, on `--card`. */
  secondary: number;
  /** A fraction from body's ink toward secondary's — not an Lc. */
  labelTowardSecondary: number;
  /** Lc, on `--sidebar`. */
  sidebar: number;
} {
  const t = Math.min(1, Math.max(0, textWeight));
  const { body, secondary, labelTowardSecondary, sidebar } = LIGHT_FLOORS;
  return {
    body,
    secondary: lerp(secondary.min, secondary.max, t),
    labelTowardSecondary: lerp(labelTowardSecondary.min, labelTowardSecondary.max, t),
    sidebar,
  };
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * A rung's authored lightness → its lightness at this spread — see
 * {@link LIGHT_LADDER.spread}.
 *
 * Built once per derivation and returned as a closure because the fade needs
 * the ladder's FULL depth to normalize against, and re-deriving that inside the
 * loop would compute the same constant eleven times while making the rule
 * itself harder to read than the one sentence it is.
 *
 * The top rung is the origin, so `--background` is a fixed point at every
 * setting: paper is the one surface with nowhere to go, and a ladder whose
 * lightest rung drifted with a spacing control would turn a spacing control
 * into a brightness control.
 */
function spreadFactor(surfaceSpread: number): (L: number) => number {
  const { min, max } = LIGHT_LADDER.spread;
  const gain = lerp(min, max, Math.min(1, Math.max(0, surfaceSpread)));
  const rungs = LIGHT_LADDER.rungs;
  const paper = rungs[0].L;
  const deepest = paper - rungs[rungs.length - 1].L;
  return (L) => {
    const drop = paper - L;
    // Full gain at the paper end, none at the far end, linear between.
    return paper - drop * lerp(gain, 1, drop / deepest);
  };
}

/**
 * `solveLightnessForContrast`, made safe to hand a floor that a dial can push
 * past what the hue can physically deliver.
 *
 * That solver THROWS when no lightness reaches the target, which is right for
 * the generator (a floor it cannot meet is a bug in the ladder) and wrong here:
 * `textWeight` is a slider, and the top of its travel asks for Lc 98 from a
 * chromatic ink on tinted paper — reachable at some hues and tints, not at
 * others, with the boundary somewhere in the middle of the dial. A thrown error
 * there would blank the lab mid-drag.
 *
 * So the ceiling is measured first and the ask is clamped to it, by the same
 * expression the solver guards with. The result is a dial that stops moving
 * when the color space runs out instead of falling off it.
 */
function solveClamped(targetLc: number, C: number, h: number, surface: string): number {
  const bound = hexToOklch(surface).L < 0.5 ? 1 : 0;
  const ceiling = apcaLc(oklchToHex(bound, C, h), surface);
  return solveLightnessForContrast(Math.min(targetLc, ceiling), C, h, surface);
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

  // `cardTint` mixes the paper toward the canvas AS PAINTED, which is a
  // different move from turning the ladder's chroma up and reaches somewhere
  // turning it up cannot. Chroma alone runs into the sRGB boundary at L 0.955
  // — the ceiling `tintGain` documents — and the boundary is closer at warm
  // hues than cool ones, so past it the paper stops tinting evenly around the
  // wheel. A mix brings the canvas's LIGHTNESS along with its chroma, walking
  // the rung a little away from the boundary at exactly the moment it asks for
  // more color, so the same fraction reads as the same amount of canvas at
  // every hue.
  //
  // Mixing toward the primary's painted color rather than its authored one is
  // what keeps vibrancy in charge: at vibrancy 0 the canvas is a near-neutral
  // wash, so mixing 5% of it in is 5% of nearly nothing, and quiet stays quiet.
  const canvas = hexToOklch(effectiveStopHexes(state, "light")[state.primaryIndex]);
  const mix = Math.min(1, Math.max(0, state.cardTint));

  const spread = spreadFactor(state.surfaceSpread);

  const ladder = {} as Record<ThemeTokenName, string>;
  for (const { tokens, L, k } of LIGHT_LADDER.rungs) {
    // Spread first, mix second. They pull on the same axis and the order is not
    // arbitrary: spread is a statement about the ladder's own proportions and
    // mix is a statement about how far the whole thing sits from the canvas, so
    // spreading a mixed ladder would have the tint decide the spacing.
    //
    // Every rung then moves by the same fraction toward the same target, so the
    // gaps scale by (1 − mix) and their ORDER cannot change — which is what
    // keeps the veil solves (whose window depends on a rung pair's gap) valid
    // at every tint.
    const hex = oklchToHex(lerp(spread(L), canvas.L, mix), lerp(tint * k, canvas.C, mix), hue);
    for (const token of tokens) ladder[token] = hex;
  }
  const card = ladder["--card"];
  const sidebar = ladder["--sidebar"];
  const floors = lightFloors(state.textWeight);

  // Every foreground here is solved against a CARD surface and nothing else.
  // Secondary copy also appears on the canvas — in a sidebar that gave up its
  // fill to sit on it — but that is not this token's problem to carry: one
  // value cannot serve near-white paper and a mid-tone gradient at once, and
  // trying collapses body and secondary onto the same hex while still missing
  // the floor the gradient needs. `lab.css` flips the on-canvas subtrees to the
  // canvas ink instead, which is the arrangement the port will formalize as
  // dedicated tokens.
  //
  // Secondary moves to `--card` and body stays on `--background` — see
  // LIGHT_FLOORS for why the asymmetry is the point rather than an oversight.
  // In short: `--background` is the LIGHTEST rung, so a floor met only there is
  // met nowhere else, and secondary copy lives a rung down on every panel, rail
  // and popover in the app. Body's floor already lands on the ink the owner
  // wanted, and re-solving it one rung down would trade that ink for a
  // near-black in the name of consistency.
  const foregroundL = solveClamped(floors.body, tint, hue, ladder["--background"]);
  const mutedForegroundL = solveClamped(floors.secondary, tint, hue, card);
  const sidebarForegroundL = solveClamped(floors.sidebar, tint, hue, sidebar);

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
    // Accent-as-text, held to the same surface as the copy tiers for the same
    // reason: it is a link and a button label inside panels, not a headline on
    // the page's lightest rung.
    "--primary-text": oklchToHex(solveClamped(60, accent.C, accent.h, card), accent.C, accent.h),
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

/**
 * The micro-label tier — the one color in this module that is not a
 * {@link ThemeTokens} member.
 *
 * `ThemeTokens` is a closed record over `THEME_TOKEN_NAMES`, and adding a name
 * to it is an edit to `@volli/shared` that the whole app compiles against. That
 * edit belongs to the port, not to a lab that is still deciding whether the
 * tier should exist at all — so this returns a bare hex and `paint.ts` writes
 * it as a `--lab-` property that only the seam reads.
 *
 * Null in dark mode, and null is the answer rather than a fallback color: the
 * dark ladder's secondary tier already reads at the weight the owner wanted
 * from the light one, so there is nothing to override and the seam should not
 * match at all.
 */
export function deriveArcLabelInk(state: ArcCanvasState, resolved: ArcResolvedMode): string | null {
  if (resolved === "dark") return null;
  const tokens = deriveArcTokens(state, resolved);
  const body = hexToOklch(tokens["--foreground"]);
  const secondary = hexToOklch(tokens["--muted-foreground"]);
  // A lightness walk between two solved inks, so the tier cannot invert and
  // cannot fall out of gamut — both endpoints are already representable, and
  // everything between two representable colors at one hue and chroma is too.
  // Chroma and hue come from body: the two are within a rounding step of each
  // other (same `tint`, same `hue`) and taking them from one end rather than
  // interpolating keeps the three tiers exactly one family.
  const t = lightFloors(state.textWeight).labelTowardSecondary;
  return oklchToHex(lerp(body.L, secondary.L, t), body.C, body.h);
}
