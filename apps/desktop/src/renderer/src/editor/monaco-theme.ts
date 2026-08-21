/**
 * Monaco editor theme application — the editor half of the theming choke
 * point, mirroring {@link refreshTerminalTokenTheme} for terminals.
 *
 * Monaco boots with Vitesse Light and Vitesse Dark already registered. This
 * module only remembers which half of that fixed pair the resolved app
 * appearance selected and pushes it into Monaco once the runtime is bound.
 * Calls before bootstrap are safe no-ops that queue the id for the next
 * {@link bindMonacoEditorThemeHost}.
 */

import { editorThemeForAppearance, type ShippedEditorThemeId } from "@volli/shared";

import { resolvedAppearance } from "@renderer/lib/resolved-appearance";

/** Narrow host: only what we need to activate an already-registered shiki theme. */
export interface MonacoEditorThemeHost {
  editor: {
    setTheme(themeName: string): void;
  };
}

let host: MonacoEditorThemeHost | null = null;
let pendingThemeId: ShippedEditorThemeId | null = null;

/**
 * Activate one half of the fixed Vitesse pair. Safe before Monaco loads: the
 * id is remembered and applied on the next {@link bindMonacoEditorThemeHost}.
 */
export function refreshMonacoEditorTheme(themeId: ShippedEditorThemeId): void {
  pendingThemeId = themeId;
  host?.editor.setTheme(themeId);
}

/**
 * Activate the appearance's theme only when nothing has asked for one yet —
 * used at Monaco bootstrap so a pre-hydrate store refresh is not clobbered.
 */
export function ensureMonacoEditorTheme(): void {
  if (pendingThemeId === null) {
    refreshMonacoEditorTheme(activeMonacoEditorThemeId());
  }
}

/**
 * Bind the live Monaco API. Applies any theme queued by
 * {@link refreshMonacoEditorTheme} before the runtime existed.
 */
export function bindMonacoEditorThemeHost(monaco: MonacoEditorThemeHost): void {
  host = monaco;
  if (pendingThemeId !== null) {
    host.editor.setTheme(pendingThemeId);
  }
}

/**
 * DiffEditor ignores construction-time `theme` (`createDiffEditor` is not
 * patched by the shiki adapter). Always call this before `createDiffEditor` so
 * the active id is applied via `setTheme` — never pass `theme` in options, and
 * never `"volli-dark"` (#109 / #122).
 *
 * Takes no theme id: there is nothing to choose. It uses the pending refresh id
 * when the store has already spoken, and the appearance's theme otherwise.
 */
export function applyMonacoThemeForDiffEditor(monaco: MonacoEditorThemeHost): void {
  ensureMonacoEditorTheme();
  monaco.editor.setTheme(activeMonacoEditorThemeId());
}

/**
 * Theme id for `editor.create` construction options.
 *
 * Falls back to the appearance stamped on `<html>` rather than to a constant.
 * Preload writes that class before the first frame, so an editor created before
 * the theme store hydrates is already built in the right mode instead of
 * flashing dark inside a light app and correcting a moment later.
 */
export function activeMonacoEditorThemeId(): ShippedEditorThemeId {
  return pendingThemeId ?? editorThemeForAppearance(resolvedAppearance());
}

/** Test-only: clear module state between cases. */
export function resetMonacoEditorThemeForTests(): void {
  host = null;
  pendingThemeId = null;
}
