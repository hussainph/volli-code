/**
 * What Configure → Appearance says a project has chosen for each surface, and
 * what the stored override becomes when the user changes that choice.
 *
 * The UI's vocabulary is a per-surface tri-state (#69: resolution is per
 * surface, so the CHOICE has to be per surface too):
 *
 *  - **Inherit** — the project sets nothing and follows the global choice.
 *    This is the default every project starts in (#72), and it is the ABSENCE
 *    of a value, not a stored "inherit" marker.
 *  - **Custom → auto-tint** — the app surface only: the global theme reseeded
 *    from the project's own color (#72), which is what Custom opens with
 *    pre-selected. Only the SEED is stored, never the tinted theme it derives
 *    (theme/apply.ts builds that at render time).
 *  - **Custom → a named theme** — an app-theme slug, or an editor catalog id.
 *
 * Two rules are load-bearing here rather than merely documented:
 *
 *  - **Inherit clears every field that surface can set.** For the app surface
 *    that is the slug AND the seed: an override carrying only a seed *is* the
 *    auto-tint state, so dropping the slug alone would leave the project
 *    tinted after the user asked for the global theme back.
 *  - **An all-inheriting override collapses to `null`.** A project that reset
 *    every surface must read exactly like one that never set anything —
 *    otherwise "does this project override anything?" has two answers.
 *
 * The terminal surface is deliberately NOT part of the override here: its
 * source of truth is the project's ghostty overlay FILE, so the only thing
 * this module owns for it is the edit set that write takes
 * ({@link projectTerminalOverlayEdits}).
 *
 * Pure: overrides and choices in, overrides and choices out. No DOM, no IPC.
 */

import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverrideEmpty,
  projectColor,
  type OverlayEdits,
  type ProjectThemeOverride,
} from "@volli/shared";

/** The app surface's tri-state. `theme` wins over a retained seed (see theme/apply.ts). */
export type ProjectAppChoice =
  | { kind: "inherit" }
  | { kind: "auto-tint"; seed: string }
  | { kind: "theme"; slug: string };

/** The editor surface's two states — a Monaco/shiki catalog id, or the global choice. */
export type ProjectEditorChoice = { kind: "inherit" } | { kind: "theme"; themeId: string };

/** The terminal surface's two states — a ghostty theme name, or whatever the config chain resolves. */
export type ProjectTerminalChoice = { kind: "inherit" } | { kind: "theme"; name: string };

/** A project that has no override at all inherits every surface. */
const NO_OVERRIDE: ProjectThemeOverride = EMPTY_PROJECT_THEME_OVERRIDE;

/**
 * What the app-surface control shows. A named theme is the more specific
 * statement of intent, so it wins over a seed the project is still carrying —
 * exactly the precedence `resolveActiveTheme` paints with, which is what keeps
 * the control from claiming one thing while the window shows another.
 */
export function projectAppChoice(override: ProjectThemeOverride | null): ProjectAppChoice {
  const current = override ?? NO_OVERRIDE;
  if (current.appThemeSlug !== null) return { kind: "theme", slug: current.appThemeSlug };
  if (current.seed !== null) return { kind: "auto-tint", seed: current.seed };
  return { kind: "inherit" };
}

/** What the editor-surface control shows. */
export function projectEditorChoice(override: ProjectThemeOverride | null): ProjectEditorChoice {
  const editorThemeId = (override ?? NO_OVERRIDE).editorThemeId;
  return editorThemeId === null ? { kind: "inherit" } : { kind: "theme", themeId: editorThemeId };
}

/** All-inheriting overrides are stored as no override at all. */
function collapse(override: ProjectThemeOverride): ProjectThemeOverride | null {
  return isProjectThemeOverrideEmpty(override) ? null : override;
}

/**
 * The override to store when the app surface moves to `choice`.
 *
 * A seed already stored survives a switch to a named theme: the user can go
 * back to auto-tint without Volli having to re-derive (or silently re-pick) a
 * seed it once agreed with them on. Inherit is the one transition that drops
 * it, because there the seed is the very thing being turned off.
 */
export function withProjectAppChoice(
  override: ProjectThemeOverride | null,
  choice: ProjectAppChoice,
): ProjectThemeOverride | null {
  const base = override ?? NO_OVERRIDE;
  switch (choice.kind) {
    case "inherit":
      return collapse({ ...base, appThemeSlug: null, seed: null });
    case "auto-tint":
      return collapse({ ...base, appThemeSlug: null, seed: choice.seed });
    case "theme":
      return collapse({ ...base, appThemeSlug: choice.slug });
  }
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
 * #72's pre-selected Custom option: the global theme reseeded from the color
 * the project already wears in the rail. Derived from `colorIndex` here and
 * STORED as a seed, so a later palette edit can never silently re-tint a
 * project the user had already tuned.
 */
export function autoTintChoice(colorIndex: number): ProjectAppChoice {
  return { kind: "auto-tint", seed: projectColor(colorIndex) };
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
