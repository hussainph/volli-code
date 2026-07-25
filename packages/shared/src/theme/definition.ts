/**
 * The authored half of a theme (decision #71): a plain, JSON-serializable
 * record of *intent* — a seed color, an optional unlocked accent, grain, a
 * canvas layer, and a sparse map of token overrides for the two or three
 * places where taste beats math. The full token set is DERIVED from this by
 * the generator; it is never stored.
 *
 * That last sentence is a load-bearing rule, not a preference. VS Code's
 * most-complained-about theming bug is auto-switching writing the *resolved*
 * theme back into the user's setting, destroying their intent
 * (microsoft/vscode#196119). `{global theme, project override}` is
 * authoritative here; the resolved tokens are recomputed at render time and
 * persisted nowhere.
 */

import type { ThemeTokenName } from "./tokens";

/** The layer painted behind the framed content card (#31/#74). */
export type ThemeCanvas =
  /** Flat fill of the generated `--background`; the default. */
  | { kind: "solid" }
  /** A derived gradient, capped at three stops (Arc's own ceiling). */
  | { kind: "gradient"; stops: string[] }
  /** A derived mesh gradient. */
  | { kind: "mesh"; stops: string[] };

/**
 * A theme as authored and persisted. `seed` supplies hue and chroma only —
 * its lightness is discarded, because every `L` in the ladder is a
 * generator-owned constant (that is what makes an unreadable theme
 * structurally impossible rather than merely discouraged).
 */
export interface ThemeDefinition {
  /** Display name, shown in the picker. */
  name: string;
  /** Stable slug — the theme's identity in persistence and its file name. */
  slug: string;
  /** Seed hex (`#rgb` or `#rrggbb`). Hue + chroma are used; lightness is not. */
  seed: string;
  /** `null` = the accent follows the seed's hue; a hex unlocks it (#75). */
  accent: string | null;
  /** Grain overlay opacity multiplier, 0–1. */
  grain: number;
  /** The canvas layer behind the content card. */
  canvas: ThemeCanvas;
  /**
   * Sparse post-generation overrides. Applied last — after generation and
   * after the verify/repair pass — so an override is honored verbatim even
   * when it breaks a contrast floor. Usually empty.
   */
  overrides: Partial<Record<ThemeTokenName, string>>;
  /** Grouping/filtering hint for the picker (Warp's failure to group by its own metadata is a live user complaint). */
  appearance: "dark" | "light";
}

/**
 * Volli's shipped default: the ember brand seed. `#E8652A` is an exact fixed
 * point of the accent math — the current brand color falls out of the
 * generator rather than being pinned by hand — and its hue tints the neutral
 * ladder to the warm near-blacks specified in
 * docs/plans/theming-engine.md § Surface 3.
 */
export const DEFAULT_THEME: ThemeDefinition = {
  name: "Ember",
  slug: "ember",
  seed: "#e8652a",
  accent: null,
  grain: 0.35,
  canvas: { kind: "solid" },
  overrides: {},
  appearance: "dark",
};
