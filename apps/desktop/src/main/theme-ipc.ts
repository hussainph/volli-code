/**
 * The theming IPC surface (docs/plans/theming-engine.md § Persistence,
 * application, IPC): read the resolved state, set the global theme, set a
 * project's per-surface override, and write terminal overlay edits.
 *
 * Two shapes worth naming up front, because they are what keep the design's
 * rules true at the boundary rather than only inside it:
 *
 *  - **Only AUTHORED inputs cross this seam.** `volli:theme-state` answers with
 *    `{global theme, project override}` and the resolved *terminal* config; it
 *    never carries a generated token set, because the generator runs in the
 *    renderer at render time and the resolved set is stored nowhere.
 *  - **The renderer names a SCOPE, never a path.** An overlay write says
 *    "global" or "this project"; main maps that to a file under
 *    `<userData>/volli/ghostty/`. Combined with `theme-overlay.ts`'s guard,
 *    there is no request the renderer can send that reaches the user's own
 *    ghostty config (decision #67).
 *
 * Registered through the shared guard→body→envelope registry (issue #98):
 * `THEME_IPC` (@volli/shared) supplies the validators, this module supplies
 * only the handler bodies, and a failed db open degrades every channel to a
 * typed `{ ok: false, error }` — same stance as data-ipc.ts and volli-fs.ts.
 */

import type Database from "better-sqlite3";
import { DEFAULT_THEME, THEME_CHANNELS, THEME_IPC } from "@volli/shared";
import type {
  GhosttyAppearancePayload,
  ThemeDefinition,
  ThemeIpcChannel,
  ThemeSetGlobalInput,
  ThemeSetProjectInput,
  ThemeSetProjectResult,
  ThemeStateInput,
  ThemeStatePayload,
  ThemeStateResult,
  TerminalOverlayWriteInput,
  TerminalOverlayWriteResult,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { getProjectById, updateProjectThemeOverride } from "./db/projects-repo";
import { getGlobalTheme, setGlobalTheme } from "./db/theme-repo";
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
}

/**
 * Side effects main owns that a theming write has to trigger. Kept separate
 * from {@link ThemeIpcDeps} (which is filesystem seams) because these are
 * Electron-level, and passing them in keeps this module free of `BrowserWindow`.
 */
export interface ThemeIpcHooks {
  /**
   * The persisted global theme changed. `src/main/index.ts` repaints every
   * window's `backgroundColor` from it — Chromium paints that color during
   * resizes and before first paint, so a stale one flashes the previous palette
   * at exactly the moments the user notices.
   */
  onGlobalThemeChanged?(theme: ThemeDefinition): void;
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
  if (projectId === null) {
    terminal = readGhosttyAppearance(deps.fs, null);
    payload = {
      // No stored theme (or an unreadable one) degrades to the shipped default
      // rather than failing to paint — a theme is read before any UI exists to
      // surface a failure in.
      theme: getGlobalTheme(db) ?? DEFAULT_THEME,
      projectOverride: null,
      projectId: null,
      terminal,
    };
    return { ok: true, value: payload };
  }

  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  terminal = readGhosttyAppearance(deps.fs, project.ticketPrefix);
  payload = {
    theme: getGlobalTheme(db) ?? DEFAULT_THEME,
    projectOverride: project.themeOverride ?? null,
    projectId,
    terminal,
  };
  return { ok: true, value: payload };
}

/**
 * Registers the 4 theming channels. A degraded db answers all of them with the
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

    "volli:theme-set-global": (input: ThemeSetGlobalInput): ThemeStateResult => {
      // The AUTHORED definition only — `setGlobalTheme` serializes field by
      // field, so a resolved token set cannot reach storage even if one rode
      // along on the request.
      setGlobalTheme(db, input.theme, deps.now());
      // After the write, so a window never repaints to a theme that failed to
      // persist — and the renderer's own repaint is driven by its optimistic
      // apply, not by this.
      hooks.onGlobalThemeChanged?.(input.theme);
      return buildThemeState(db, deps, null);
    },

    "volli:theme-set-project": (input: ThemeSetProjectInput): ThemeSetProjectResult => {
      const project = updateProjectThemeOverride(db, input.projectId, input.override, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      const state = buildThemeState(db, deps, input.projectId);
      if (!state.ok) return state;
      return { ok: true, project, value: state.value };
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
        terminal: readGhosttyAppearance(deps.fs, prefix),
      };
    },
  };

  registerGuardedIpcHandlers(THEME_IPC, handlers);
}
