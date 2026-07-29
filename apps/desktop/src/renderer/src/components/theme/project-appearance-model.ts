/**
 * What Configure → Appearance says a project has chosen for its EDITOR and
 * TERMINAL surfaces, and what the stored override becomes when that changes.
 *
 * The app surface is no longer here. It used to offer a tri-state — inherit, an
 * auto-tint seeded from the project's own rail color, or a named theme from the
 * catalogue — and all three died with the seed system: there is no catalogue to
 * name, no slug to store, and a workspace's own gradient is a whole `Canvas` on
 * its `projects` row (migration 014) rather than a field in this override. The
 * canvas editor owns that surface now.
 *
 * What remains is the same shape it always had:
 *
 *  - **Inherit** — the project sets nothing and follows the global choice. This
 *    is the default every project starts in (#72), and it is the ABSENCE of a
 *    value, not a stored "inherit" marker.
 *  - **A named theme** — an editor catalog id.
 *
 * One rule is load-bearing rather than merely documented: **an all-inheriting
 * override collapses to `null`.** A project that reset every surface must read
 * exactly like one that never set anything — otherwise "does this project
 * override anything?" has two answers.
 *
 * The terminal surface is deliberately NOT part of the override here: its
 * source of truth is the project's ghostty overlay FILE, so the only thing this
 * module owns for it is the edit set that write takes
 * ({@link projectTerminalOverlayEdits}).
 *
 * Pure: overrides and choices in, overrides and choices out. No DOM, no IPC.
 */

import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverrideEmpty,
  type GhosttyAppearancePayload,
  type OverlayEdits,
  type ProjectThemeOverride,
} from "@volli/shared";

/** The editor surface's two states — a Monaco/shiki catalog id, or the global choice. */
export type ProjectEditorChoice = { kind: "inherit" } | { kind: "theme"; themeId: string };

/** The terminal surface's two states — a ghostty theme name, or whatever the config chain resolves. */
export type ProjectTerminalChoice = { kind: "inherit" } | { kind: "theme"; name: string };

/** A project that has no override at all inherits every surface. */
const NO_OVERRIDE: ProjectThemeOverride = EMPTY_PROJECT_THEME_OVERRIDE;

/**
 * What the editor-surface control shows.
 *
 * Takes only the field it reads rather than a whole override, because the two
 * shapes that carry it are now different: the migration-013 row this module
 * writes, and `theme/apply.ts`'s renderer-side resolution input, which merges
 * that row with the migration-014 canvas columns. Both answer this question the
 * same way, and neither should have to be converted to ask it.
 */
export function projectEditorChoice(
  override: { editorThemeId: string | null } | null,
): ProjectEditorChoice {
  const editorThemeId = (override ?? NO_OVERRIDE).editorThemeId;
  return editorThemeId === null ? { kind: "inherit" } : { kind: "theme", themeId: editorThemeId };
}

/** All-inheriting overrides are stored as no override at all. */
function collapse(override: ProjectThemeOverride): ProjectThemeOverride | null {
  return isProjectThemeOverrideEmpty(override) ? null : override;
}

/** The override to store when the editor surface moves to `choice`. */
export function withProjectEditorChoice(
  override: ProjectThemeOverride | null,
  choice: ProjectEditorChoice,
): ProjectThemeOverride | null {
  const base = override ?? NO_OVERRIDE;
  return collapse({
    ...base,
    editorThemeId: choice.kind === "inherit" ? null : choice.themeId,
  });
}

/**
 * The ghostty overlay edits a terminal choice implies, for
 * `theme.writeProjectOverlay`.
 *
 * Inherit is a key REMOVAL (`null`), never a written-out default: the project
 * overlay is the last layer in the chain, so leaving a key behind would pin
 * the terminal to whatever Volli last wrote instead of letting the user's own
 * ghostty config win again — the same "revert only ever removes a key" rule
 * the global Appearance rows follow (#67).
 */
export function projectTerminalOverlayEdits(choice: ProjectTerminalChoice): OverlayEdits {
  return { theme: choice.kind === "inherit" ? null : choice.name };
}

/**
 * What the terminal-surface control shows — read from the resolved chain's
 * PROVENANCE, not from the stored override.
 *
 * The terminal's source of truth is the project's ghostty overlay file, and
 * main computes provenance next to the merge the terminal is actually painted
 * with (#67). So "does this project override its terminal?" is answered by
 * `theme` having been won by the project layer, which stays true for a key the
 * user hand-wrote into that file — the same honesty rule the global rows
 * follow (#68: the overlay takes any ghostty key, and Volli honors it).
 */
export function projectTerminalChoice(
  payload: GhosttyAppearancePayload | null,
): ProjectTerminalChoice {
  const name = payload?.prefs.themeName ?? null;
  if (name === null || payload?.provenance["theme"] !== "volli-project") return { kind: "inherit" };
  return { kind: "theme", name };
}

/**
 * The name Custom opens on for the terminal: whatever the project is ALREADY
 * showing, so switching to Custom pins the look you were looking at instead of
 * changing it. `null` when no layer in the chain names a theme at all — the
 * terminal is then wearing the token-derived fallback, which has no catalog
 * name, and Volli must not invent one: writing an unrequested `theme = …` into
 * a file the user owns is exactly what the overlay design exists to avoid
 * (#67). The picker opens empty there and the first pick is the first write.
 */
export function terminalCustomSeed(payload: GhosttyAppearancePayload | null): string | null {
  return payload?.prefs.themeName ?? null;
}
