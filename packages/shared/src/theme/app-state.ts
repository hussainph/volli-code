/**
 * The `app_state` keys theming writes, and the one codec small enough to live
 * beside them — the global editor theme id.
 *
 * What is authoritative is `{canvas, appearance}`: the canvas under
 * {@link THEME_APP_STATE_KEY} and the appearance beside it, with each project's
 * columns (migration 014) overriding both per surface. The resolved token set is
 * DERIVED from that pair at render time and persisted nowhere — VS Code's
 * most-complained-about theming bug (microsoft/vscode#196119) is auto-switching
 * writing the *resolved* theme back over the user's authored intent.
 *
 * The keys are stated here rather than in main's repo layer because both sides
 * read them: main writes the rows, and the renderer reads the same rows back out
 * of the bootstrap payload. Two hand-typed copies of a key string is one too
 * many.
 *
 * Pure: string constants and shape guards only, no Node/DOM.
 */

import { isShippedEditorThemeId, type ShippedEditorThemeId } from "./editor-themes";

/** The `app_state` key the authored global canvas lives under (#29's kv table). */
export const THEME_APP_STATE_KEY = "theme";

/**
 * The `app_state` key for the global Monaco/shiki editor theme id.
 * Absent or null means “derive from the resolved appearance” — never a resolved
 * token set.
 */
export const THEME_EDITOR_APP_STATE_KEY = "theme_editor";

/**
 * The string stored under {@link THEME_EDITOR_APP_STATE_KEY}. Empty means
 * “derive from the app” (same as a missing row); a non-empty value is the
 * authored catalog id.
 */
export function serializeGlobalEditorThemeId(editorThemeId: ShippedEditorThemeId | null): string {
  return editorThemeId !== null && isShippedEditorThemeId(editorThemeId) ? editorThemeId : "";
}

/**
 * Reads the authored global editor theme id back out of `app_state`. Null for
 * absent, empty, “clear back to derive”, or a non-catalog value (corrupt /
 * hand-edited row) — the renderer maps that through `resolveEditorThemeId`.
 * Only {@link isShippedEditorThemeId} values survive.
 */
export function parseGlobalEditorThemeId(
  raw: string | undefined | null,
): ShippedEditorThemeId | null {
  if (raw === undefined || raw === null || raw.length === 0) return null;
  return isShippedEditorThemeId(raw) ? raw : null;
}
