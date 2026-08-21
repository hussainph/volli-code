/**
 * The fixed Monaco/shiki Vitesse pair, chosen by resolved app appearance.
 *
 * There is no editor theme preference (VC-123). The editor wears light or dark
 * because the app is light or dark — the same `ResolvedAppearance` preload
 * stamps on `<html>` before the first frame and every other surface derives
 * from. The old picker catalog asked which dark theme somebody preferred; it
 * could not answer why a light app contained a dark editor.
 *
 * Vitesse ships both halves as a designed pair. Their static shiki imports live
 * beside Monaco bootstrap in `apps/desktop/.../editor/monaco-runtime.ts`, so
 * both are registered before an editor can paint.
 *
 * Pure: string ids only, no shiki / Electron / DOM imports.
 */

import type { ResolvedAppearance } from "./canvas/types";

/** The entire editor-theming decision: one Vitesse half for each resolved mode. */
const EDITOR_THEME_BY_APPEARANCE = {
  light: "vitesse-light",
  dark: "vitesse-dark",
} as const satisfies Record<ResolvedAppearance, string>;

export type ShippedEditorThemeId =
  (typeof EDITOR_THEME_BY_APPEARANCE)[keyof typeof EDITOR_THEME_BY_APPEARANCE];

/** The theme the editor wears at this resolved appearance. */
export function editorThemeForAppearance(resolved: ResolvedAppearance): ShippedEditorThemeId {
  return EDITOR_THEME_BY_APPEARANCE[resolved];
}
