/**
 * Veils: how an opaque surface survives the canvas layer moving in underneath
 * it (#74, docs/plans/theming-engine.md § Canvas + shaders).
 *
 * Once the backdrop is a gradient rather than a flat `--rail`, every surface
 * that sat on it has to choose. Staying opaque hides the canvas the user just
 * picked. Going plainly transparent breaks the ladder — the sidebar is a
 * *lighter* rung than the rail, so transparency would visibly darken it. And a
 * fixed translucent tint drifts: measured over the band, a constant
 * `--sidebar-accent` fill reads as a bright patch at the dark end (ΔL 0.147)
 * and nearly vanishes at the light end (ΔL 0.074).
 *
 * A veil is the fourth answer. For a token `T` painted over a base `B`, the
 * generator solves the color `C` such that `C` at {@link VEIL_ALPHA} over `B`
 * composites to `T` **byte-exactly**. In `solid` mode that is literally today's
 * pixel; over a gradient the surface keeps its *relative* rung instead of its
 * absolute one, holding ΔL 0.047–0.062 across the whole band. Material weight
 * encodes hierarchy, made structural.
 */

import type { ThemeTokenName, ThemeTokens } from "./tokens";

/**
 * A veil's opacity — and the reason there is exactly one number here.
 *
 * The solve is `C = (T − B(1−α)) / α`, so α divides. Thinner veils push `C`
 * out of sRGB at the hues where the rung being reproduced sits furthest from
 * the surface under it; 0.10 is the lowest alpha that keeps every solved color
 * representable at every hue, which is asserted rather than assumed.
 */
export const VEIL_ALPHA = 0.1;

/**
 * Each veil, and the surface it composites over. Order matters: a veil may be
 * stacked on another veil's *result*, and never more than two SURFACES deep —
 * Apple's rule that a light translucent surface never sits on another one.
 * (`--sidebar-border-veil` is an edge rather than a surface, so it does not
 * spend a level; it is one hairline drawn on the second one.)
 *
 * The hairline is a veil for the same reason as everything else here, and the
 * alternative is worth naming because it is the obvious one: a flat white at
 * 7% — what macOS actually draws — would hold its weight over the ramp just as
 * well, but it composites to `#2b2423` rather than `--sidebar-border`'s
 * `#29211d`, and that two-step drift would be the one thing in the whole layer
 * that made `canvas: solid` stop being pixel-identical. Solving it instead
 * keeps both properties at once.
 */
const VEILS = [
  { name: "--sidebar-veil", target: "--sidebar", base: "--rail" },
  { name: "--sidebar-accent-veil", target: "--sidebar-accent", base: "--sidebar" },
  { name: "--sidebar-border-veil", target: "--sidebar-border", base: "--sidebar" },
] as const satisfies readonly { name: string; target: ThemeTokenName; base: ThemeTokenName }[];

/** The veil custom-property names, mirroring `globals.css` exactly as {@link ThemeTokenName} does. */
export const THEME_VEIL_TOKEN_NAMES = VEILS.map((veil) => veil.name);

/** One veil custom-property name. */
export type ThemeVeilTokenName = (typeof VEILS)[number]["name"];

/** A resolved veil set: every name mapped to an `rgb(R G B / a)` string. */
export type ThemeVeilTokens = Record<ThemeVeilTokenName, string>;

/** One `#rrggbb` channel, 0–255. */
function channel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/**
 * Generates the veil set for an already-generated token set.
 *
 * Solved in 8-bit sRGB rather than in OKLCH, deliberately: what has to match is
 * the *composited byte*, and the compositor works in gamma-encoded channels. A
 * perceptually-solved veil would land a step or two off and the pixel-identity
 * guarantee for `kind: "solid"` would quietly stop being true.
 */
export function generateVeilTokens(tokens: ThemeTokens): ThemeVeilTokens {
  const solved = VEILS.map(({ name, target, base }) => {
    const channels = [0, 1, 2].map((index) =>
      Math.round(
        (channel(tokens[target], index) - channel(tokens[base], index) * (1 - VEIL_ALPHA)) /
          VEIL_ALPHA,
      ),
    );
    return [name, `rgb(${channels.join(" ")} / ${VEIL_ALPHA})`] as const;
  });
  return Object.fromEntries(solved) as ThemeVeilTokens;
}
