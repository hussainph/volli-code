/**
 * The generator's input: a seed color, an optional unlocked accent, and a
 * sparse map of token overrides for the two or three places where taste beats
 * math. The full token set is DERIVED from this by `generateThemeTokens`; it is
 * never stored.
 *
 * That last sentence is a load-bearing rule, not a preference. VS Code's
 * most-complained-about theming bug is auto-switching writing the *resolved*
 * theme back into the user's setting, destroying their intent
 * (microsoft/vscode#196119). What is authoritative here is `{canvas,
 * appearance}` per scope; the resolved tokens are recomputed at render time and
 * persisted nowhere.
 *
 * This used to be the whole authored theme — a name, a slug, a grain dial, a
 * canvas and an appearance alongside the three fields below — because a theme
 * was also a catalogue entry you picked by name. The canvas replaced that whole
 * surface, so what is left is exactly what the generator reads. Nothing here is
 * a catalogue identity any more.
 */

import type { ThemeTokenName } from "./tokens";

/**
 * A base ladder as authored. `seed` supplies hue and chroma only — its
 * lightness is discarded, because every `L` in the ladder is a generator-owned
 * constant (that is what makes an unreadable theme structurally impossible
 * rather than merely discouraged).
 */
export interface ThemeDefinition {
  /** Seed hex (`#rgb` or `#rrggbb`). Hue + chroma are used; lightness is not. */
  seed: string;
  /** `null` = the accent follows the seed's hue; a hex unlocks it (#75). */
  accent: string | null;
  /**
   * Sparse post-generation overrides. Applied last — after generation and
   * after the verify/repair pass — so an override is honored verbatim even
   * when it breaks a contrast floor. Usually empty.
   */
  overrides: Partial<Record<ThemeTokenName, string>>;
}

/**
 * Volli's shipped default: the ember brand seed. `#E8652A` is an exact fixed
 * point of the accent math — the current brand color falls out of the
 * generator rather than being pinned by hand — and its hue tints the neutral
 * ladder to the warm near-blacks the canvas builds its chrome from.
 */
export const DEFAULT_THEME: ThemeDefinition = {
  seed: "#e8652a",
  accent: null,
  overrides: {},
};
