/**
 * Monaco editor theme application — the editor half of the theming choke
 * point, mirroring {@link refreshTerminalTokenTheme} for terminals.
 *
 * Theme *catalog* resolution lives in `editor-theme-catalog.ts`. This module
 * only remembers the desired catalog id and pushes it into Monaco once the
 * runtime is bound. Calls before bootstrap are safe no-ops that queue the id
 * for the next {@link bindMonacoEditorThemeHost}.
 */

import { DEFAULT_EDITOR_THEME_ID, resolveEditorThemeId } from "./editor-theme-catalog";

/** Narrow host: only what we need to activate a registered shiki theme. */
export interface MonacoEditorThemeHost {
  editor: {
    setTheme(themeName: string): void;
  };
}

let host: MonacoEditorThemeHost | null = null;
let pendingThemeId: string | null = null;

/**
 * Activate a Monaco/shiki catalog theme. Safe before Monaco loads: the id is
 * remembered and applied on the next {@link bindMonacoEditorThemeHost}.
 */
export function refreshMonacoEditorTheme(themeId: string): void {
  pendingThemeId = themeId;
  host?.editor.setTheme(themeId);
}

/**
 * End an Appearance Editor preview by resolving from **live** store inputs
 * (committed `editorThemeId` + app slug) and painting that id. Callers must
 * read the store at call time — never close over a stale resolved id — so a
 * successful commit then restore lands on the committed catalog theme.
 *
 * @returns the catalog id painted into Monaco
 */
export function restoreEditorThemeFromState(input: {
  editorThemeId: string | null;
  appThemeSlug: string;
}): string {
  const themeId = resolveEditorThemeId(input);
  refreshMonacoEditorTheme(themeId);
  return themeId;
}

/**
 * Activate `fallbackId` only when nothing has asked for a theme yet — used at
 * Monaco bootstrap so a pre-hydrate store refresh is not clobbered by the
 * shipped default.
 */
export function ensureMonacoEditorTheme(fallbackId: string): void {
  if (pendingThemeId === null) {
    refreshMonacoEditorTheme(fallbackId);
  }
}

/**
 * Bind the live Monaco API. Applies any theme queued by
 * {@link refreshMonacoEditorTheme} before the runtime existed.
 */
export function bindMonacoEditorThemeHost(monaco: MonacoEditorThemeHost): void {
  host = monaco;
  if (pendingThemeId !== null) {
    monaco.editor.setTheme(pendingThemeId);
  }
}

/**
 * DiffEditor ignores construction-time `theme` (`createDiffEditor` is not
 * patched by shikiToMonaco). Always call this before `createDiffEditor` so the
 * active catalog id is applied via `setTheme` — never pass `theme` in options,
 * and never `"volli-dark"` (#109 / #122).
 *
 * Uses `themeId` when provided (unknown ids fall through
 * {@link resolveEditorThemeId}); otherwise the pending refresh id, else
 * {@link DEFAULT_EDITOR_THEME_ID} via {@link ensureMonacoEditorTheme}.
 */
export function applyMonacoThemeForDiffEditor(
  monaco: MonacoEditorThemeHost,
  themeId?: string,
): void {
  let resolved: string;
  if (themeId !== undefined && themeId.length > 0) {
    resolved = resolveEditorThemeId({ editorThemeId: themeId, appThemeSlug: null });
    refreshMonacoEditorTheme(resolved);
  } else {
    ensureMonacoEditorTheme(DEFAULT_EDITOR_THEME_ID);
    resolved = activeMonacoEditorThemeId();
  }

  monaco.editor.setTheme(resolved);
}

/**
 * Catalog id for `editor.create` construction options. shikiToMonaco patches
 * `create` to honor `theme`, so hardcoding {@link DEFAULT_EDITOR_THEME_ID}
 * would clobber a committed Appearance selection on every remount.
 */
export function activeMonacoEditorThemeId(): string {
  return pendingThemeId ?? DEFAULT_EDITOR_THEME_ID;
}

/** Test-only: clear module state between cases. */
export function resetMonacoEditorThemeForTests(): void {
  host = null;
  pendingThemeId = null;
}
