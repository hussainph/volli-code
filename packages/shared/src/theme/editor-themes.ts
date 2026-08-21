/**
 * The two shipped Monaco/shiki editor themes, and the appearance that chooses
 * between them.
 *
 * There is no editor theme *preference* (VC-123). The editor wears light or
 * dark because the APP is light or dark — the same `ResolvedAppearance` preload
 * stamps on `<html>` before the first frame and every other surface derives
 * from. A catalog of 22 dark themes behind a picker answered a question nobody
 * asked ("which dark theme?") and could not answer the one they did ("why is
 * there a dark rectangle in my light app?").
 *
 * Vitesse ships both halves as a designed pair, which is what makes the
 * light↔dark flip read as one editor changing clothes rather than two editors.
 *
 * The static shiki importers live in `apps/desktop/.../editor-theme-catalog.ts`
 * and must assert the same set, so the shipped bundle and this vocabulary
 * cannot drift. There are no labels any more: nothing names a theme at a user.
 *
 * Pure: string ids only, no shiki / Electron / DOM imports.
 */

import type { ResolvedAppearance } from "./canvas/types";

/**
 * The shipped theme per resolved appearance — the whole editor-theming
 * decision, as one lookup.
 */
const EDITOR_THEME_BY_APPEARANCE = {
  light: "vitesse-light",
  dark: "vitesse-dark",
} as const satisfies Record<ResolvedAppearance, string>;

/**
 * Every catalog id Volli ships and will accept over IPC — exactly two, one per
 * appearance. Ordered light-then-dark to match {@link ResolvedAppearance}'s
 * reading order, not by preference: neither is a "default".
 */
export const SHIPPED_EDITOR_THEME_IDS = [
  EDITOR_THEME_BY_APPEARANCE.light,
  EDITOR_THEME_BY_APPEARANCE.dark,
] as const;

export type ShippedEditorThemeId = (typeof SHIPPED_EDITOR_THEME_IDS)[number];

const SHIPPED_EDITOR_THEME_ID_SET: ReadonlySet<string> = new Set(SHIPPED_EDITOR_THEME_IDS);

/**
 * The theme the editor wears at this appearance. Total over
 * {@link ResolvedAppearance}, so there is no "nothing chosen" case to fall back
 * from — `auto` is already answered by the time this is asked.
 */
export function editorThemeForAppearance(resolved: ResolvedAppearance): ShippedEditorThemeId {
  return EDITOR_THEME_BY_APPEARANCE[resolved];
}

/**
 * True when `id` is one of {@link SHIPPED_EDITOR_THEME_IDS}.
 *
 * Retired catalog ids (`one-dark-pro`, `nord`, …) return false on purpose: a
 * persisted row naming one is from a build that had a picker, and the honest
 * reading of it now is "no opinion", which resolves through
 * {@link editorThemeForAppearance} like everything else.
 */
export function isShippedEditorThemeId(id: string): id is ShippedEditorThemeId {
  return SHIPPED_EDITOR_THEME_ID_SET.has(id);
}
