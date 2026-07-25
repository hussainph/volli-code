/**
 * The app-surface theme generator (docs/plans/theming-engine.md § Surface 3):
 * one seed color in, the full `globals.css` token set out.
 *
 * The load-bearing idea is that the user picks **hue and chroma, never
 * lightness**. Every `L` below is a constant in this file, and gamut mapping
 * gives up chroma rather than lightness to stay in sRGB — so the perceptual
 * lightness ladder the UI is built on is *identical* for a red seed, a blue
 * seed and a grey seed. That is what makes an unreadable theme structurally
 * impossible rather than merely discouraged: there is no input to this
 * function that can flatten two surfaces together or dim body text, because
 * no input touches the axis those depend on.
 *
 * Contrast floors are APCA, not WCAG 2. WCAG 2's contrast ratio badly
 * misjudges dark themes — it rates near-black pairs as far more separable
 * than they look — and this ladder lives almost entirely below L 0.35.
 * Borders are the exception: APCA low-clips below Lc ~10 and literally cannot
 * see a 1px edge at all, so edges are asserted in OKLCH ΔL instead.
 */

import type { ThemeDefinition } from "./definition";
import { apcaLc, hexToOklch, oklchToHex } from "./color";
import type { ThemeTokenName, ThemeTokens } from "./tokens";

/** Below this seed chroma the neutrals go fully grey — the muddy-black guard. */
const GREY_SEED_CHROMA = 0.02;

/** The accent's chroma window. Below 0.06 it stops reading as an accent at
 * all; above 0.20 it leaves sRGB at most hues and gamut-mapping just takes it
 * back, so a wider range would only be a lie in the UI. */
const ACCENT_CHROMA_RANGE = { min: 0.06, max: 0.2 } as const;

/** The neutrals' chroma window: enough tint to be felt, never enough to read
 * as a color. `--background` at C 0.014 is a near-black you can *sense* is
 * warm; at C 0.03 it is a brown. */
const NEUTRAL_CHROMA_RANGE = { min: 0.004, max: 0.014 } as const;

/** How much of the seed's chroma survives into the neutrals. */
const NEUTRAL_CHROMA_RATIO = 0.06;

/** The accent's fixed lightness. Ember `#e8652a` is an exact fixed point of
 * `oklch(0.661 C h)` — the brand color falls out of the math rather than
 * being pinned by hand. */
const PRIMARY_LIGHTNESS = 0.661;

/**
 * The neutral ladder: a fixed lightness plus a chroma multiplier per rung.
 * Chroma rises with lightness because a constant chroma reads as *draining*
 * of color as surfaces lighten — the lighter rungs need more of it to feel
 * like the same family.
 *
 * Order is darkest → lightest and is asserted: `L` must strictly increase.
 */
const LADDER: readonly { tokens: readonly ThemeTokenName[]; L: number; k: number }[] = [
  { tokens: ["--rail"], L: 0.155, k: 0.8 },
  { tokens: ["--background"], L: 0.178, k: 1.0 },
  { tokens: ["--card"], L: 0.2, k: 1.1 },
  { tokens: ["--popover"], L: 0.218, k: 1.1 },
  { tokens: ["--secondary", "--muted"], L: 0.226, k: 1.2 },
  { tokens: ["--accent"], L: 0.252, k: 1.3 },
  { tokens: ["--sidebar-border"], L: 0.255, k: 1.4 },
  { tokens: ["--border", "--input"], L: 0.269, k: 1.4 },
  { tokens: ["--border-hover"], L: 0.321, k: 1.5 },
  { tokens: ["--border-strong"], L: 0.349, k: 1.5 },
];

/**
 * `--destructive`, frozen in OKLCH. Hue-locked per the semantic escape list:
 * without it a red seed makes *delete* indistinguishable from *primary*, and
 * a green seed makes it read as success. These numbers are today's `#e5484d`
 * decomposed — it round-trips to that hex exactly — kept in OKLCH rather than
 * as a literal so a future light mode is a lightness change, not a new color.
 */
const DESTRUCTIVE = { L: 0.6256, C: 0.1933, h: 23.026 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Finds the lightness *nearest the background* at which `C`/`h` text clears
 * `targetLc` on it. Solving beats guessing: the answer moves with the seed's
 * chroma and with the background rung, and a hand-picked foreground that
 * happens to pass for ember silently fails for a saturated blue.
 *
 * The search evaluates the **emitted 8-bit hex**, not the continuous color,
 * so the floor holds for the value that actually reaches the DOM rather than
 * for an ideal that rounding then breaks.
 *
 * {@link apcaLc} returns a magnitude, so Lc as a function of text lightness is
 * V-shaped around the background's own lightness rather than monotonic: it is
 * ~0 at the vertex and rises along *both* arms. Only one arm exists for a given
 * background — a dark background can only be written on in something lighter —
 * so the arm is chosen from the background instead of assumed. Assuming it is
 * what would break the day #70's parameterized lightness gets pointed at a
 * light-mode ladder, and it would break *silently*: the old search returned its
 * upper bound whether or not anything cleared the target, so `#ffffff` at Lc 0
 * came back looking exactly like a solution. Hence the throw.
 *
 * Exported for the tests: both arms and the failure are unreachable through
 * {@link generateThemeTokens} today (every ladder background is a fixed
 * constant below L 0.5), which is precisely why they need testing directly.
 * Not part of the package's intended surface.
 */
export function solveLightnessForContrast(
  targetLc: number,
  C: number,
  h: number,
  background: string,
): number {
  // The vertex, and the far end of the arm leading away from it: white for a
  // dark background, black for a light one.
  const vertex = hexToOklch(background).L;
  const bound = vertex < 0.5 ? 1 : 0;
  if (apcaLc(oklchToHex(bound, C, h), background) < targetLc) {
    throw new Error(
      `No lightness of oklch(L ${C.toFixed(4)} ${h.toFixed(2)}) reaches Lc ${targetLc} on ${background}.`,
    );
  }

  // Walk in from the vertex (where Lc is 0) toward the known-passing bound,
  // keeping the nearest lightness that clears the target.
  let fail = vertex;
  let pass = bound;
  for (let i = 0; i < 40; i += 1) {
    const mid = (fail + pass) / 2;
    if (apcaLc(oklchToHex(mid, C, h), background) >= targetLc) pass = mid;
    else fail = mid;
  }
  return pass;
}

/**
 * Generates the complete token set from an authored theme.
 *
 * Pure and deterministic: the same definition always yields the same hexes,
 * and the result is never persisted (`{global theme, project override}` is
 * authoritative — VS Code's worst theming bug is writing the *resolved* theme
 * back over the user's intent).
 */
export function generateThemeTokens(theme: ThemeDefinition): ThemeTokens {
  // 1–3. Seed → hue and a clamped chroma. The seed's LIGHTNESS IS DISCARDED.
  const seed = hexToOklch(theme.seed);
  const neutralHue = seed.h;
  const neutralChroma =
    seed.C < GREY_SEED_CHROMA
      ? 0
      : clamp(seed.C * NEUTRAL_CHROMA_RATIO, NEUTRAL_CHROMA_RANGE.min, NEUTRAL_CHROMA_RANGE.max);

  // The accent follows the seed unless it has been unlocked (#75) — the one
  // thing a single seed cannot express is cool grey chrome with a warm accent.
  const unlockedAccent = theme.accent === null ? null : hexToOklch(theme.accent);
  const accentSource = unlockedAccent ?? seed;
  // The muddy-black guard again, and for the same reason. A colorless seed has
  // no hue — what `hexToOklch` reports for it is float residue — so forcing the
  // accent floor onto it paints --primary an arbitrary tint (grey #8a8a8a came
  // out a muddy olive) that jumps somewhere unrelated when the seed moves by
  // one bit. Grey in, grey out: a monochrome theme is a legitimate thing to
  // want, and the chroma floor exists to stop an accent looking washed out, not
  // to invent a color nobody asked for. An unlocked accent is always honored as
  // authored, saturated accent on grey chrome included — that pairing is the
  // entire point of #75.
  const accentChroma =
    unlockedAccent === null && seed.C < GREY_SEED_CHROMA
      ? 0
      : clamp(accentSource.C, ACCENT_CHROMA_RANGE.min, ACCENT_CHROMA_RANGE.max);

  // 4. The neutral ladder.
  const ladder = {} as Record<ThemeTokenName, string>;
  for (const { tokens, L, k } of LADDER) {
    const hex = oklchToHex(L, neutralChroma * k, neutralHue);
    for (const token of tokens) ladder[token] = hex;
  }
  const background = ladder["--background"]!;
  const sidebar = ladder["--card"]!;

  // 5. Foregrounds — solved against the surface they are actually drawn on.
  const foreground = oklchToHex(
    solveLightnessForContrast(90, neutralChroma, neutralHue, background),
    neutralChroma,
    neutralHue,
  );
  const mutedForeground = oklchToHex(
    solveLightnessForContrast(60, neutralChroma, neutralHue, background),
    neutralChroma,
    neutralHue,
  );
  const sidebarForeground = oklchToHex(
    solveLightnessForContrast(75, neutralChroma, neutralHue, sidebar),
    neutralChroma,
    neutralHue,
  );

  // 6–7. The accent and its label, solved together (see solveAccentPair).
  const { primary, primaryForeground } = solveAccentPair(accentChroma, accentSource.h);

  const tokens: ThemeTokens = {
    ...ladder,
    // 8. Hue-locked semantics — these ignore the seed entirely.
    "--destructive": oklchToHex(DESTRUCTIVE.L, DESTRUCTIVE.C, DESTRUCTIVE.h),
    "--destructive-foreground": "#ffffff",

    "--foreground": foreground,
    "--muted-foreground": mutedForeground,
    "--sidebar-foreground": sidebarForeground,
    "--primary": primary,
    "--primary-foreground": primaryForeground,

    // Aliases. Each mirrors a relationship authored in globals.css today:
    // the sidebar panel is a card, its hover state is the accent surface, and
    // every "…-foreground on a neutral surface" collapses to one value.
    "--sidebar": sidebar,
    "--sidebar-accent": ladder["--accent"]!,
    "--card-foreground": foreground,
    "--popover-foreground": foreground,
    "--secondary-foreground": foreground,
    "--accent-foreground": foreground,
    "--sidebar-accent-foreground": foreground,
    "--ring": primary,
    "--sidebar-primary": primary,
    "--sidebar-ring": primary,
    "--sidebar-primary-foreground": primaryForeground,
  };

  // 9. Overrides land last — after generation and after every floor above —
  // so an explicit override is honored verbatim even when it breaks one. The
  // user asked for it; the guards exist to stop the *math* producing something
  // unreadable, not to overrule a person.
  return { ...tokens, ...theme.overrides };
}

/** Lc floor for text on `--primary`. */
const PRIMARY_FOREGROUND_LC = 60;

/**
 * Solves `--primary` and `--primary-foreground` together, because at some
 * hues they cannot be solved apart.
 *
 * The label comes from {@link pickAccentLabel}.
 *
 * The awkward case is a saturated mid-green: at L 0.661 white reaches Lc ~60
 * and a dark label tops out near Lc 49, so *no* label clears the floor. The
 * only axis left is the button's own lightness, and step 9 of the spec says
 * exactly that — on failure adjust lightness, never chroma. So the accent is
 * nudged the smallest distance from PRIMARY_LIGHTNESS that makes its label
 * legible. Hue and chroma, the two things the user actually chose, are
 * untouched; the extremes (L 0 with white, L 1 with dark) always clear, so
 * the search always terminates on a legible pair.
 */
/**
 * Step 7's label choice: whichever of white or a near-black tint of the accent
 * hue reads better ON the button, with the APCA score that won.
 *
 * Exported because the comparison is the part worth testing in both
 * directions. At PRIMARY_LIGHTNESS white always wins, so a test driven only
 * through {@link generateThemeTokens} could never exercise the dark-label
 * branch — but the branch is not dead code: it is what keeps step 7 correct
 * for a light-mode ladder (#70 parameterizes lightness for exactly that), where
 * a button above the L ≈ 0.72 crossover genuinely needs the dark label.
 */
export function pickAccentLabel(primaryHex: string, hue: number): { hex: string; lc: number } {
  return ["#ffffff", oklchToHex(0.2, 0.05, hue)]
    .map((hex) => ({ hex, lc: apcaLc(hex, primaryHex) }))
    .reduce((best, next) => (next.lc > best.lc ? next : best));
}

function solveAccentPair(
  chroma: number,
  hue: number,
): { primary: string; primaryForeground: string } {
  const ideal = oklchToHex(PRIMARY_LIGHTNESS, chroma, hue);
  const idealLabel = pickAccentLabel(ideal, hue);
  if (idealLabel.lc >= PRIMARY_FOREGROUND_LC) {
    return { primary: ideal, primaryForeground: idealLabel.hex };
  }

  // The repair always searches DOWNWARD. PRIMARY_LIGHTNESS (0.661) sits below
  // the white/dark label crossover (L ≈ 0.72), so white is the better label at
  // every hue and chroma the accent can take — measured across 360 hues × 5
  // chromas in the tests, not assumed — and white only improves as the button
  // darkens. L 0 is therefore a known-legible bound and the search terminates.
  let legible = 0;
  let illegible = PRIMARY_LIGHTNESS;
  for (let i = 0; i < 40; i += 1) {
    const mid = (legible + illegible) / 2;
    if (pickAccentLabel(oklchToHex(mid, chroma, hue), hue).lc >= PRIMARY_FOREGROUND_LC)
      legible = mid;
    else illegible = mid;
  }

  const primary = oklchToHex(legible, chroma, hue);
  return { primary, primaryForeground: pickAccentLabel(primary, hue).hex };
}
