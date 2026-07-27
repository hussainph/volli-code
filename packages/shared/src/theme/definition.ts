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

/**
 * The layer painted behind the whole window — the chrome band and the sidebar
 * as well as the framed content card (#31/#74).
 *
 * `stops` is AUTHORED, not derived at render time: a theme file is a shareable
 * artifact and what it says is what it holds (#71). Both halves of keeping that
 * safe live elsewhere — the three-stop ceiling is enforced at the storage
 * boundary by `isThemeCanvas`, and the legibility band is applied on READ, by
 * `canvasLayerBackground`, which is the only path from a stop to the screen.
 */
export type ThemeCanvas =
  /** Flat fill of the generated `--rail`; the default, and pixel-identical to no canvas at all. */
  | { kind: "solid" }
  /** A derived vertical ramp, capped at three stops (Arc's own ceiling). */
  | { kind: "gradient"; stops: string[] }
  /** A derived multi-radial composite — same stops, no single axis. */
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
 *
 * **Grain ships OFF**, and every built-in inherits that. Dogfooding the layer
 * at its original 0.35 made the app measurably harder to read, and the reason
 * is not the mean lift § Grain quantifies (0.15 Lc — imperceptible) but the
 * VARIANCE: per-pixel luminance jitter in the gaps around antialiased glyph
 * edges. "Never above text" is not sufficient protection, because text drawn
 * over a textured backdrop still has noise in every counter and sidebearing.
 * The slider keeps the effect one click away for anyone who wants it, and grain
 * stays exactly where it is: inside the framed card (#31), beneath page
 * content.
 *
 * This comment used to say its natural home was over the canvas layer. That was
 * wrong, and the canvas landing (#74) is what showed why. In the Arc
 * arrangement the canvas is a full-window layer, so it is *precisely* the
 * surface the sidebar's nav labels are drawn on — texturing it would put
 * per-pixel jitter under the very text this finding is about, which makes it
 * the worst place for grain rather than the best. The rule generalizes: the
 * finding is about spatial FREQUENCY, not about tint. A gradient moving ~0.0012
 * L across a 13px glyph is constant at the scale of an antialiased edge; noise
 * changing pixel to pixel is not. Low-frequency lightness variation under text
 * is safe; high-frequency variation is not.
 */
export const DEFAULT_THEME: ThemeDefinition = {
  name: "Ember",
  slug: "ember",
  seed: "#e8652a",
  accent: null,
  grain: 0,
  canvas: { kind: "solid" },
  overrides: {},
  appearance: "dark",
};
