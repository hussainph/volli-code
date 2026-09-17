/**
 * What Configure → Appearance says a project has chosen for its TERMINAL
 * surface.
 *
 * Two surfaces used to live here and both left. The APP surface went when the
 * seed system died: a workspace's gradient is a whole `Canvas` on its
 * `projects` row (migration 014) rather than a field in an override, and the
 * canvas editor owns it. The EDITOR surface went in VC-123: the editor has one
 * light theme and one dark one, picked by the resolved appearance, so a project
 * that wants a light editor overrides its APPEARANCE — there is no editor id
 * left to store.
 *
 * What remains is the terminal, whose source of truth is not an override row at
 * all but the project's ghostty overlay FILE. So the only thing this module
 * still owns is the edit set that write takes
 * ({@link projectTerminalOverlayEdits}) and the choice the control shows
 * ({@link projectTerminalChoice}).
 *
 * A third function went with the vendored theme catalog (VC-413): the seed a
 * "Custom" mode opened its picker on. There is no picker and no Custom mode —
 * nothing to seed.
 *
 * Pure: overrides and choices in, overrides and choices out. No DOM, no IPC.
 */

import type { GhosttyAppearancePayload, OverlayEdits } from "@volli/shared";

/** The terminal surface's two states — a ghostty theme name, or whatever the config chain resolves. */
export type ProjectTerminalChoice = { kind: "inherit" } | { kind: "theme"; name: string };

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
