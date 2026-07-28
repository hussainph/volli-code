/**
 * The theming IPC surface: read the resolved terminal chain for a scope, persist
 * the canvas and appearance at either scope, set the editor theme, set a
 * project's per-surface override, and write terminal overlay edits.
 *
 * Two shapes worth naming up front, because they are what keep the design's
 * rules true at the boundary rather than only inside it:
 *
 *  - **Only AUTHORED inputs cross this seam.** No channel here carries a
 *    generated token set: the generator runs in the renderer at render time and
 *    the resolved set is stored nowhere.
 *  - **The renderer names a SCOPE, never a path.** An overlay write says
 *    "global" or "this project"; main maps that onto a file under
 *    `<userData>/volli/`, and the write path (`theme-overlay.ts`) guards it
 *    again. There is no request the renderer can send that reaches the user's
 *    own ghostty config (decision #67).
 *
 * The canvas half is WRITES and no reads: what is stored is `app_state` rows and
 * `projects` columns, and `volli:data-bootstrap` already ships both.
 * `volli:theme-state` exists only because the terminal chain has to be resolved
 * off the filesystem, and the canvas has no such need.
 *
 * Registered through the shared guard→body→envelope registry (issue #98):
 * `THEME_IPC` (@volli/shared) supplies the validators, this module supplies
 * only the handler bodies, and a failed db open degrades every channel to a
 * typed `{ ok: false, error }` — same stance as data-ipc.ts and volli-fs.ts.
 */

import type Database from "better-sqlite3";
import { THEME_CHANNELS, THEME_IPC } from "@volli/shared";
import type {
  AppearanceSetGlobalInput,
  AppearanceSetProjectInput,
  CanvasSetGlobalInput,
  CanvasSetProjectInput,
  FirstPaintHint,
  GhosttyAppearancePayload,
  ProjectCanvasWriteResult,
  ResolvedAppearance,
  Result,
  ThemeIpcChannel,
  ThemeSetGlobalEditorInput,
  ThemeSetProjectInput,
  ThemeSetProjectResult,
  ThemeStateInput,
  ThemeStatePayload,
  ThemeStateResult,
  TerminalOverlayWriteInput,
  TerminalOverlayWriteResult,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import {
  getProjectById,
  updateProjectAppearance,
  updateProjectCanvas,
  updateProjectThemeOverride,
} from "./db/projects-repo";
import {
  getGlobalEditorThemeId,
  setFirstPaintHint,
  setGlobalAppearance,
  setGlobalCanvas,
  setGlobalEditorThemeId,
} from "./db/theme-repo";
import { readGhosttyAppearance } from "./ghostty-config";
import type { FsDeps } from "./fs-deps";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";
import { writeGlobalTerminalOverlay, writeProjectTerminalOverlay } from "./theme-overlay";
import type { OverlayWriteResult } from "./theme-overlay";

/**
 * The injected seams, so the whole surface is testable against a temp
 * `userData` dir and a fake home.
 *
 * One `fs`, not one per collaborator: this module reads the ghostty chain and
 * writes Volli's overlay, and those used to arrive as two separately-built dep
 * bags carrying duplicate `readFile`/`userDataDir` fields that nothing kept in
 * agreement. `FsDeps` is a superset of both slices, so `readGhosttyAppearance`
 * and the overlay writers each still see only what their own `Pick` allows.
 */
export interface ThemeIpcDeps {
  fs: FsDeps;
  now: () => number;
  /**
   * The mode the window is actually wearing, read fresh per call.
   *
   * A ghostty `theme = light:X,dark:Y` pair resolves to one half or the other,
   * so a chain read that cannot name a mode has to assume one — and the
   * assumption `parseGhosttyTerminalPrefs` used to bake in was `dark`. Main
   * knows the answer (`window-theme.ts` resolves it from the `first-paint` hint
   * and the stored global pair), so it passes it rather than defaulting; a
   * thunk because the user can flip the mode long after these handlers are
   * registered.
   */
  appearance: () => ResolvedAppearance;
}

/**
 * Side effects main owns that a theming write has to trigger. Kept separate
 * from {@link ThemeIpcDeps} (which is filesystem seams) because these are
 * Electron-level, and passing them in keeps this module free of `BrowserWindow`.
 */
export interface ThemeIpcHooks {
  /**
   * The renderer finished a paint and recorded what it resolved. Main repaints
   * every window's `backgroundColor` from it — Chromium paints that color during
   * resizes and before first paint, so a stale one flashes the previous palette
   * at exactly the moments the user notices. Taking the color the renderer
   * actually painted beats re-deriving one in main and hoping the two agree.
   */
  onFirstPaintChanged?(hint: FirstPaintHint): void;
}

/** A project's ticket prefix (the per-project overlay's file name), or a typed error. */
function resolvePrefix(
  db: Database.Database,
  projectId: string,
): { ok: true; prefix: string } | { ok: false; error: string } {
  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  return { ok: true, prefix: project.ticketPrefix };
}

/**
 * The full resolved state for a scope. `projectId` null resolves the global
 * scope — the terminal chain then stops at Volli's global overlay, exactly
 * like `volli:ghostty-config-get`.
 */
function buildThemeState(
  db: Database.Database,
  deps: ThemeIpcDeps,
  projectId: string | null,
): ThemeStateResult {
  let terminal: GhosttyAppearancePayload;
  let payload: ThemeStatePayload;
  const editorThemeId = getGlobalEditorThemeId(db);
  const appearance = deps.appearance();
  if (projectId === null) {
    terminal = readGhosttyAppearance(deps.fs, appearance, null);
    payload = {
      editorThemeId,
      projectOverride: null,
      projectId: null,
      terminal,
    };
    return { ok: true, value: payload };
  }

  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  terminal = readGhosttyAppearance(deps.fs, appearance, project.ticketPrefix);
  payload = {
    editorThemeId,
    projectOverride: project.themeOverride ?? null,
    projectId,
    terminal,
  };
  return { ok: true, value: payload };
}

/**
 * The state a WRITE answers with: the scope the caller is in, not the scope the
 * write targeted (#123).
 *
 * A global write made while the window is showing a project used to answer with
 * `projectId: null`, and the renderer adopts that payload wholesale — so
 * picking an app-wide theme silently dropped the project scope and repainted
 * every overriding project to the global theme until you switched away and
 * back. The write is still global; only the answer is scoped.
 *
 * A `projectId` that no longer resolves degrades to the global scope instead of
 * failing: the write ALREADY succeeded, so a typed error here would make the
 * renderer roll back to a theme that is no longer what is stored. A project
 * that has gone has no scope left to describe, and global is what the window is
 * about to be told it is in anyway.
 */
function stateForCaller(
  db: Database.Database,
  deps: ThemeIpcDeps,
  projectId: string | null,
): ThemeStateResult {
  const scoped = buildThemeState(db, deps, projectId);
  return scoped.ok ? scoped : buildThemeState(db, deps, null);
}

/**
 * Registers every theming channel. A degraded db answers all of them with the
 * open failure: theming reads the projects table and `app_state`, so there is
 * no honest partial mode, and a hanging `invoke()` is never acceptable.
 */
export function registerThemeIpcHandlers(
  handle: DbHandle,
  deps: ThemeIpcDeps,
  hooks: ThemeIpcHooks = {},
): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(THEME_CHANNELS, handle.error);
    return;
  }

  const db = handle.db;

  const handlers: IpcHandlerTable<ThemeIpcChannel> = {
    "volli:theme-state": (input: ThemeStateInput): ThemeStateResult =>
      buildThemeState(db, deps, input.projectId ?? null),

    "volli:theme-set-global-editor": (input: ThemeSetGlobalEditorInput): ThemeStateResult => {
      setGlobalEditorThemeId(db, input.editorThemeId, deps.now());
      // The caller's scope, not the write's — see `stateForCaller`.
      return stateForCaller(db, deps, input.projectId ?? null);
    },

    "volli:theme-set-project": (input: ThemeSetProjectInput): ThemeSetProjectResult => {
      const project = updateProjectThemeOverride(db, input.projectId, input.override, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      const state = buildThemeState(db, deps, input.projectId);
      if (!state.ok) return state;
      return { ok: true, project, value: state.value };
    },

    // ── the canvas ────────────────────────────────────────────────────────
    // WRITES ONLY, and every one of them answers with an ack rather than fresh
    // state: the global canvas and appearance are `app_state` rows and a
    // project's are `projects` columns, so `volli:data-bootstrap` already ships
    // every one of them. The caller holds what it just sent; a re-read here
    // would only be a second place for "what is the theme?" to be answered.

    "volli:theme-canvas-set-global": (input: CanvasSetGlobalInput): Result => {
      setGlobalCanvas(db, input.canvas, deps.now());
      return { ok: true };
    },

    "volli:theme-appearance-set-global": (input: AppearanceSetGlobalInput): Result => {
      setGlobalAppearance(db, input.appearance, deps.now());
      return { ok: true };
    },

    "volli:theme-canvas-set-project": (input: CanvasSetProjectInput): ProjectCanvasWriteResult => {
      const project = updateProjectCanvas(db, input.projectId, input.canvas, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      return { ok: true, project };
    },

    "volli:theme-appearance-set-project": (
      input: AppearanceSetProjectInput,
    ): ProjectCanvasWriteResult => {
      const project = updateProjectAppearance(db, input.projectId, input.appearance, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      return { ok: true, project };
    },

    "volli:theme-first-paint-set": (input: FirstPaintHint): Result => {
      setFirstPaintHint(db, input, deps.now());
      // After the write, so a window never repaints to a background that failed
      // to persist.
      hooks.onFirstPaintChanged?.(input);
      return { ok: true };
    },

    "volli:theme-terminal-overlay-write": (
      input: TerminalOverlayWriteInput,
    ): TerminalOverlayWriteResult => {
      // Scope → file. The renderer never supplies a path, and the write itself
      // is guarded again inside theme-overlay.ts.
      let written: OverlayWriteResult;
      let prefix: string | null = null;
      if (input.scope === "global") {
        written = writeGlobalTerminalOverlay(deps.fs, input.edits);
      } else {
        const resolved = resolvePrefix(db, input.projectId);
        if (!resolved.ok) return resolved;
        prefix = resolved.prefix;
        written = writeProjectTerminalOverlay(deps.fs, prefix, input.edits);
      }
      if (!written.ok) return written;
      // Re-read rather than predict: the renderer repaints from the same
      // resolution the terminal will use, with no second round trip. The
      // directory watch also fires, which is what re-themes OTHER windows.
      return {
        ok: true,
        path: written.path,
        terminal: readGhosttyAppearance(deps.fs, deps.appearance(), prefix),
      };
    },
  };

  registerGuardedIpcHandlers(THEME_IPC, handlers);
}
