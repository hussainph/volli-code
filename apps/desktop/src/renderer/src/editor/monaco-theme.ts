/**
 * Monaco editor theme application — the editor half of the theming choke
 * point, mirroring {@link refreshTerminalTokenTheme} for terminals.
 *
 * Theme *catalog* resolution lives in `editor-theme-catalog.ts`. This module
 * only remembers the desired catalog id and pushes it into Monaco once the
 * runtime is bound. Calls before bootstrap are safe no-ops that queue the id
 * for the next {@link bindMonacoEditorThemeHost}.
 *
 * Catalog themes beyond the bootstrap default load on demand: refresh queues
 * the id, awaits {@link ensureMonacoEditorThemeLoaded}, then `setTheme` so
 * Appearance preview never flashes an undefined theme.
 */

import { DEFAULT_EDITOR_THEME_ID, resolveEditorThemeId } from "./editor-theme-catalog";

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
 * the active catalog id is applied via `setTheme` — never pass `theme` in
 * options, and never `"volli-dark"` (#109 / #122).
 *
 * Uses `themeId` when provided (unknown ids fall through
 * {@link resolveEditorThemeId}); otherwise the pending refresh id, else
 * {@link DEFAULT_EDITOR_THEME_ID} via {@link ensureMonacoEditorTheme}.
 *
 * Kick ensure+setTheme on both the module host and the handed-in monaco so a
 * DiffEditor created before the theme chunk lands still receives the id.
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

  const target = resolved;
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
 * Catalog id for `editor.create` construction options. The shiki adapter
 * patches `create` to honor `theme`, so hardcoding {@link DEFAULT_EDITOR_THEME_ID}
 * would clobber a committed Appearance selection on every remount.
 */
export function activeMonacoEditorThemeId(): string {
  return pendingThemeId ?? DEFAULT_EDITOR_THEME_ID;
}

/** Test-only: clear module state between cases. */
export function resetMonacoEditorThemeForTests(): void {
  host = null;
  themeEnsure = null;
  pendingThemeId = null;
  applyGeneration = 0;
}
