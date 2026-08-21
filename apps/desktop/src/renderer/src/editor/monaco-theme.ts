/**
 * Monaco editor theme application — the editor half of the theming choke
 * point, mirroring {@link refreshTerminalTokenTheme} for terminals.
 *
 * Which theme that is lives in `editor-theme-catalog.ts`, keyed on appearance.
 * This module only remembers the desired id and pushes it into Monaco once the
 * runtime is bound. Calls before bootstrap are safe no-ops that queue the id
 * for the next {@link bindMonacoEditorThemeHost}.
 *
 * The queue/generation machinery survives the collapse to two themes because it
 * is about ASYNC LOADING, not about choosing: a light↔dark flip still has to
 * load a theme before activating it, and a flip back mid-load must not let the
 * outgoing theme paint over the incoming one.
 */

import { resolvedAppearance } from "@renderer/lib/resolved-appearance";

import { resolveEditorThemeId } from "./editor-theme-catalog";

/** Narrow host: only what we need to activate a registered shiki theme. */
export interface MonacoEditorThemeHost {
  editor: {
    setTheme(themeName: string): void;
  };
}

/** Load + define a catalog theme before `setTheme` (bound at Monaco bootstrap). */
export type MonacoEditorThemeEnsure = (themeId: string) => Promise<void>;

let host: MonacoEditorThemeHost | null = null;
let themeEnsure: MonacoEditorThemeEnsure | null = null;
let pendingThemeId: string | null = null;
/** Bumps on every refresh so superseded async applies do not paint a stale id. */
let applyGeneration = 0;

/**
 * Bind the catalog-theme loader used before `setTheme`. Call before
 * {@link bindMonacoEditorThemeHost} so a queued pending id can load first.
 */
export function bindMonacoEditorThemeEnsure(ensure: MonacoEditorThemeEnsure): void {
  themeEnsure = ensure;
}

/**
 * Ensure a catalog theme is loaded into the highlighter and defined in Monaco.
 * No-op when the ensure seam is unbound (tests / pre-bootstrap).
 */
export async function ensureMonacoEditorThemeLoaded(themeId: string): Promise<void> {
  await themeEnsure?.(themeId);
}

function reportThemeLoadFailure(themeId: string, error: unknown): void {
  console.warn(`[volli] failed to load Monaco theme "${themeId}":`, error);
}

async function applyPendingTheme(themeId: string): Promise<void> {
  const generation = ++applyGeneration;
  try {
    await themeEnsure?.(themeId);
  } catch (error) {
    reportThemeLoadFailure(themeId, error);
    return;
  }
  // A newer refresh bumps applyGeneration — do not paint a superseded id.
  if (generation !== applyGeneration) return;
  host?.editor.setTheme(themeId);
}

/**
 * Activate a Monaco/shiki catalog theme. Safe before Monaco loads: the id is
 * remembered and applied on the next {@link bindMonacoEditorThemeHost}.
 *
 * When a host is bound, loads the theme (if needed) then `setTheme`s — never
 * activates an undefined theme id.
 */
export function refreshMonacoEditorTheme(themeId: string): void {
  pendingThemeId = themeId;
  if (host === null) return;
  void applyPendingTheme(themeId);
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
 * {@link refreshMonacoEditorTheme} before the runtime existed (after ensure).
 */
export function bindMonacoEditorThemeHost(monaco: MonacoEditorThemeHost): void {
  host = monaco;
  if (pendingThemeId !== null) {
    void applyPendingTheme(pendingThemeId);
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
 *
 * Kick ensure+setTheme on both the module host and the handed-in monaco so a
 * DiffEditor created before the theme chunk lands still receives the id.
 */
export function applyMonacoThemeForDiffEditor(monaco: MonacoEditorThemeHost): void {
  ensureMonacoEditorTheme();
  const target = activeMonacoEditorThemeId();
  void (async () => {
    try {
      await ensureMonacoEditorThemeLoaded(target);
    } catch (error) {
      reportThemeLoadFailure(target, error);
      return;
    }
    if (pendingThemeId !== null && pendingThemeId !== target) return;
    monaco.editor.setTheme(target);
  })();
}

/**
 * Theme id for `editor.create` construction options.
 *
 * Falls back to the appearance stamped on `<html>` rather than to a constant.
 * Preload writes that class before the first frame, so an editor created before
 * the theme store hydrates is already built in the right mode instead of
 * flashing dark inside a light app and correcting a moment later.
 */
export function activeMonacoEditorThemeId(): string {
  return pendingThemeId ?? resolveEditorThemeId({ resolvedAppearance: resolvedAppearance() });
}

/** Test-only: clear module state between cases. */
export function resetMonacoEditorThemeForTests(): void {
  host = null;
  themeEnsure = null;
  pendingThemeId = null;
  applyGeneration = 0;
}
