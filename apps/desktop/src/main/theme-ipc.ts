/**
 * The theming IPC surface: read the resolved terminal chain for a scope,
 * persist canvas and appearance at either scope, retain a project's terminal
 * override, and write terminal overlay edits.
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
import type { WebContents } from "electron";
import { broadcastAppStateChanged, broadcastDataChanged } from "./broadcast";
import { getAppContentsRole, isSettingsContents } from "./window-roles";
import { isHexColor, settingsWindowBackground } from "@volli/shared";
import { THEME_CHANNELS, THEME_IPC } from "./ipc-descriptors";
import type { GhosttyAppearancePayload, ResolvedAppearance } from "@volli/shared";
import type {
  AppearanceSetGlobalInput,
  AppearanceSetProjectInput,
  CanvasSetGlobalInput,
  CanvasSetProjectInput,
  FirstPaintHint,
  FirstPaintReport,
  ProjectCanvasWriteResult,
  Result,
  TerminalOverlayWriteInput,
  TerminalOverlayWriteResult,
  ThemeIpcChannel,
  ThemeSetProjectInput,
  ThemeSetProjectResult,
  ThemeStateInput,
  ThemeStatePayload,
  ThemeStateResult,
} from "../ipc/contract";
import type { DbHandle } from "./data-ipc";
import {
  getProjectById,
  updateProjectAppearance,
  updateProjectCanvas,
  updateProjectThemeOverride,
  setFirstPaintHint,
  setGlobalAppearance,
  setGlobalCanvas,
} from "@volli/host-core/db";
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
   * A renderer finished a paint. Only its own native edge follows that paint;
   * Settings may be editing a different scope from the workbench.
   */
  onFirstPaintChanged?(hint: FirstPaintHint, sender: WebContents): void;
  /**
   * The renderer painted its `--background` plane rung, which Browser Tab views
   * paint while the app owns them (VC-302). Live only: called before, and
   * regardless of, the hint's persistent write.
   */
  onPlaneBackgroundChanged?(color: string, sender: WebContents): void;
}

/** The desktop surfaces {@link desktopThemeHooks} repaints, as ports. */
export interface DesktopThemeSurfaces {
  /** App windows are matched to the reporting renderer, never repainted en masse. */
  windows: () => Iterable<{
    webContents: Pick<WebContents, "id">;
    setBackgroundColor(color: string): void;
  }>;
  /** The Browser Tab host, whose app-owned planes follow the theme (VC-302). */
  browserTabs: { setThemeBackground(color: string): void };
}

/**
 * The desktop's {@link ThemeIpcHooks}: only the sender's edge takes the hint's
 * `background` (the canvas base fill), and the workbench's Browser Tab planes
 * take only the main renderer's `--background` plane rung. The two are different colors, and a plane painted
 * the edge color shows as a slab of base fill inside the pane, so this pairing
 * is the one thing worth pinning here (VC-302). No try/catch: there is nothing
 * here to fail.
 */
export function desktopThemeHooks(surfaces: DesktopThemeSurfaces): ThemeIpcHooks {
  return {
    onFirstPaintChanged: (hint, sender) => {
      for (const window of surfaces.windows()) {
        if (window.webContents.id === sender.id) window.setBackgroundColor(hint.background);
      }
    },
    onPlaneBackgroundChanged: (color, sender) => {
      if (getAppContentsRole(sender) === "main") surfaces.browserTabs.setThemeBackground(color);
    },
  };
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
  const appearance = deps.appearance();
  if (projectId === null) {
    terminal = readGhosttyAppearance(deps.fs, appearance, null);
    payload = { projectOverride: null, projectId: null, terminal };
    return { ok: true, value: payload };
  }

  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  terminal = readGhosttyAppearance(deps.fs, appearance, project.ticketPrefix);
  payload = {
    projectOverride: project.themeOverride ?? null,
    projectId,
    terminal,
  };
  return { ok: true, value: payload };
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

    "volli:theme-set-project": (input: ThemeSetProjectInput): ThemeSetProjectResult => {
      const project = updateProjectThemeOverride(db, input.projectId, input.override, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      const state = buildThemeState(db, deps, input.projectId);
      if (!state.ok) return state;
      broadcastDataChanged();
      return { ok: true, project, value: state.value };
    },

    // ── the canvas ────────────────────────────────────────────────────────
    // WRITES ONLY, and every one of them answers with an ack rather than fresh
    // state: the global canvas and appearance are `app_state` rows and a
    // project's are `projects` columns, so `volli:data-bootstrap` already ships
    // every one of them. The caller holds what it just sent; a re-read here
    // would only be a second place for "what is the theme?" to be answered.

    "volli:theme-canvas-set-global": (input: CanvasSetGlobalInput, sender): Result => {
      setGlobalCanvas(db, input.canvas, deps.now());
      broadcastAppStateChanged("theme", JSON.stringify(input.canvas), sender.id);
      return { ok: true };
    },

    "volli:theme-appearance-set-global": (input: AppearanceSetGlobalInput, sender): Result => {
      setGlobalAppearance(db, input.appearance, deps.now());
      broadcastAppStateChanged("appearance", input.appearance, sender.id);
      return { ok: true };
    },

    "volli:theme-canvas-set-project": (input: CanvasSetProjectInput): ProjectCanvasWriteResult => {
      const project = updateProjectCanvas(db, input.projectId, input.canvas, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      // Untargeted: a project roster carries tickets/labels, not its theme columns.
      broadcastDataChanged();
      return { ok: true, project };
    },

    "volli:theme-appearance-set-project": (
      input: AppearanceSetProjectInput,
    ): ProjectCanvasWriteResult => {
      const project = updateProjectAppearance(db, input.projectId, input.appearance, deps.now());
      if (project === undefined) return { ok: false, error: "Unknown project" };
      broadcastDataChanged();
      return { ok: true, project };
    },

    "volli:theme-first-paint-set": (input: FirstPaintReport, sender): Result => {
      if (getAppContentsRole(sender) === null) return { ok: false, error: "Unknown app window" };
      const hint: FirstPaintHint = { appearance: input.appearance, background: input.background };
      if (isSettingsContents(sender)) {
        // Settings can preview App or any project without changing the next
        // workbench's first paint or the workbench's Browser Tab planes. Its
        // own edge is its plain sidebar rung in that appearance, never the
        // authored canvas it may be editing (VC-1228).
        hooks.onFirstPaintChanged?.(
          { appearance: hint.appearance, background: settingsWindowBackground(hint.appearance) },
          sender,
        );
        return { ok: true };
      }
      // First and on its own: a failed hint write must not leave Browser Tabs
      // on an old plane color. Settings never reaches this workbench-only path.
      const plane = input.planeBackground;
      if (plane !== undefined && isHexColor(plane)) hooks.onPlaneBackgroundChanged?.(plane, sender);
      setFirstPaintHint(db, hint, deps.now());
      hooks.onFirstPaintChanged?.(hint, sender);
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
