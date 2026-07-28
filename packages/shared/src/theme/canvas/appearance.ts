/**
 * `auto`, answered — and the vocabulary that answer is drawn from.
 *
 * Its own module because it is the seam between a preference and everything
 * that renders: `Appearance` is what a user picks and {@link ResolvedAppearance}
 * is what the gradient transform, the token ladder and the ink flip actually
 * run against. Keeping the resolution here and pure — the caller reads
 * `matchMedia`, this decides — is what lets "did someone forget to resolve
 * `auto`?" be a compile-time question instead of a rendering bug.
 */

import type { Appearance, ResolvedAppearance } from "./types";

/** Resolves `auto` against the system preference; an explicit choice wins over it. */
export function resolveAppearance(
  appearance: Appearance,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  return appearance === "auto" ? (systemPrefersDark ? "dark" : "light") : appearance;
}

/**
 * The closed appearance vocabulary — the same three words migration 014's
 * `CHECK` admits, and the same three {@link Appearance} names.
 *
 * Exported because main's repo layer parses this enum back out of `app_state`
 * and off a `projects` column, and a second hand-written copy of a three-word
 * list is how a value becomes storable but not re-sendable.
 */
export function isAppearance(value: unknown): value is Appearance {
  return value === "light" || value === "dark" || value === "auto";
}
