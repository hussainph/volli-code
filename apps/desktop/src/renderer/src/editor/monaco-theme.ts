/**
 * Monaco editor theme application — the editor half of the theming choke
 * point, mirroring {@link refreshTerminalTokenTheme} for terminals.
 *
 * Theme *catalog* resolution lives in `editor-theme-catalog.ts`. This module
 * only remembers the desired catalog id and pushes it into Monaco once the
 * runtime is bound. Calls before bootstrap are safe no-ops that queue the id
 * for the next {@link bindMonacoEditorThemeHost}.
 */

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

/** Test-only: clear module state between cases. */
export function resetMonacoEditorThemeForTests(): void {
  host = null;
  pendingThemeId = null;
}
