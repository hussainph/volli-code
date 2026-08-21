/**
 * Theming state for the renderer: what the user AUTHORED, what a workspace
 * overrides, and what is merely being previewed right now.
 *
 * Three rules are load-bearing here.
 *
 *  - **The resolved token set is never stored.** This store holds
 *    `{canvas, appearance}` per scope and derives the rest at render time (see
 *    `theme/canvas-paint.ts`). VS Code's most-complained-about theming bug is
 *    auto-switching writing the *resolved* theme back over the user's authored
 *    intent; the shape here makes that unrepresentable.
 *  - **Preview is memory-only.** `startPreview` repaints the live DOM and writes
 *    NOTHING — not to SQLite, not to `app_state`, not anywhere. Only
 *    `commitPreview` persists, and `cancelPreview` restores the pre-preview look
 *    by simply forgetting the preview, because nothing else ever changed.
 *  - **Nothing here goes through zustand `persist`.** It used to, for the
 *    picker's favorites and recents; both died with the picker. Every value in
 *    this store is either authored state that lives in SQLite behind
 *    `window.api.theme` (main reads it too — the window background follows it,
 *    before any renderer exists) or derived from it.
 *
 * ## Where each value comes IN
 *
 * There is deliberately no `canvas.state()` IPC read. The global canvas and
 * appearance are `app_state` rows and a workspace's are `projects` columns, so
 * `volli:data-bootstrap` already ships all of it in the one round trip the app
 * makes anyway — {@link ThemeState.hydrateGlobal} takes the rows and the
 * project scope arrives through {@link ThemeState.hydrate}. A second read path
 * would be a second answer to "what is the theme?".
 *
 * `volli:theme-state` is still read, for the two surfaces that are NOT the
 * canvas: the resolved ghostty chain and the global editor theme id.
 */

import {
  APPEARANCE_APP_STATE_KEY,
  DEFAULT_CANVAS,
  errorMessage,
  isAppearance,
  parseCanvas,
  THEME_APP_STATE_KEY,
  windowBackground,
} from "@volli/shared";
import type {
  Appearance,
  Canvas,
  GhosttyAppearancePayload,
  Project,
  ProjectThemeOverride,
  ResolvedAppearance,
} from "@volli/shared";
import type {
  ProjectCanvasWriteResult,
  Result,
  ThemeSetProjectResult,
  ThemeStatePayload,
  ThemeStateResult,
} from "../../../ipc/contract";
import { create } from "zustand";

import { toastError } from "@renderer/lib/toast";
import {
  resolveActiveTheme,
  type ActiveTheme,
  type ProjectSurfaceOverride,
} from "@renderer/theme/apply";
import {
  paintCanvas,
  systemPrefersDark,
  type PaintCanvasOptions,
} from "@renderer/theme/canvas-paint";
import { beginScopeRepaint, shouldEaseScopeRepaint } from "@renderer/theme/scope-transition";
import { resolveEditorThemeId } from "@renderer/editor/editor-theme-catalog";
import { refreshMonacoEditorTheme } from "@renderer/editor/monaco-theme";
import { writeThrough } from "@renderer/stores/mutate";

/** Which scope a commit writes to (#69). */
export type ThemeScope = { kind: "global" } | { kind: "project"; projectId: string };

/**
 * The scope a hydrate is switching to: the workspace, and the two migration-014
 * columns its row carries. Passed IN rather than read, because the row already
 * arrived in the bootstrap payload and the theme store must not hold a second
 * copy of the projects list to look it up in.
 */
export interface ThemeProjectScope {
  projectId: string;
  canvas: Canvas | null;
  appearance: Appearance | null;
}

/** The preload theming surface this store needs — narrow, and fake-able in tests. */
export interface ThemeGateway {
  /** The resolved ghostty chain + the global editor id for a scope. NOT the canvas. */
  state(input: { projectId?: string }): Promise<ThemeStateResult>;
  setGlobalCanvas(canvas: Canvas): Promise<Result>;
  setGlobalAppearance(appearance: Appearance): Promise<Result>;
  /**
   * Both workspace writes resolve with the **authoritative row**, re-read after
   * the update — not a bare ok. That row is the point: a workspace's canvas and
   * appearance are columns the projects store holds, and it is the only copy
   * (see `projects.ts`'s selection listener, which builds every scope from it).
   * A write that persisted without handing the fresh row back left that copy
   * stale, so the next workspace switch rebuilt the scope from a `null` column
   * and the override silently reverted to the global canvas.
   */
  setProjectCanvas(projectId: string, canvas: Canvas | null): Promise<ProjectCanvasWriteResult>;
  setProjectAppearance(
    projectId: string,
    appearance: Appearance | null,
  ): Promise<ProjectCanvasWriteResult>;
  /**
   * Records what was actually painted so the NEXT launch can build its window
   * with the right edge color and the right mode class before anything runs. A
   * cache, never an authority — `{canvas, appearance}` stays the pair.
   */
  setFirstPaint(hint: { appearance: ResolvedAppearance; background: string }): Promise<Result>;
  setProject(
    projectId: string,
    override: ProjectThemeOverride | null,
  ): Promise<ThemeSetProjectResult>;
}

/**
 * Where a freshly-written workspace row goes.
 *
 * A registrar rather than an import, because the dependency between these two
 * stores is one-directional and has to stay that way: `projects.ts` imports
 * this module to hand a scope over on selection. Reaching back the other way
 * would close the cycle, so the projects store registers itself here instead
 * and this module keeps knowing nothing about it.
 *
 * Null until something registers — the store persists exactly as before, and a
 * headless test simply observes no adoption.
 */
let projectRowSink: ((project: Project) => void) | null = null;

/** Called by `projects.ts` at module scope. */
export function setProjectRowSink(sink: (project: Project) => void): void {
  projectRowSink = sink;
}

/** The seams the store drives: the IPC bridge, and the DOM / Monaco repaint. */
export interface ThemeStoreDeps {
  gateway: ThemeGateway;
  /**
   * Derives and writes every custom property, and moves the mode class.
   * Injected so the store stays testable headlessly. `options.transient` marks
   * one frame of a running gesture — see `theme/apply.ts`.
   */
  paintCanvas(canvas: Canvas, resolved: ResolvedAppearance, options?: PaintCanvasOptions): void;
  /** Activates a Monaco/shiki catalog id (queued until Monaco boots). */
  refreshEditorTheme(themeId: string): void;
  /**
   * Runs ONE swap as an eased whole-window repaint (#69,
   * theme/scope-transition.ts). Handed the {@link paintCanvas} call rather than
   * called before it: the view transition captures the window as it stands when
   * it starts, so a swap made outside its callback lands in the OLD capture and
   * animates from itself to itself. Used only for a scope change or a light↔dark
   * flip — never for an authoring edit or a preview, where instant is the
   * correct feedback.
   */
  beginScopeRepaint(applyTokens: () => void): void;
  /**
   * What the system was asking for when this window was built — main's
   * `nativeTheme` reading, handed over on the process arguments. Called exactly
   * once, for the initial state, because that snapshot cannot go stale
   * unobserved: a later flip arrives at {@link ThemeState.noteSystemAppearance}
   * instead.
   */
  systemPrefersDark(): boolean;
}

const defaultDeps: ThemeStoreDeps = {
  gateway: {
    state: (input) => window.api.theme.state(input),
    setGlobalCanvas: (canvas) => window.api.theme.setGlobalCanvas(canvas),
    setGlobalAppearance: (appearance) => window.api.theme.setGlobalAppearance(appearance),
    setProjectCanvas: (projectId, canvas) => window.api.theme.setProjectCanvas(projectId, canvas),
    setProjectAppearance: (projectId, appearance) =>
      window.api.theme.setProjectAppearance(projectId, appearance),
    setFirstPaint: (hint) => window.api.theme.setFirstPaint(hint),
    setProject: (projectId, override) => window.api.theme.setProject(projectId, override),
  },
  // Point-free on purpose. An arrow re-listing the parameters is how the
  // `transient` flag came to be silently dropped here: a shorter function is
  // assignable to a longer signature, so the mistake typechecks.
  paintCanvas,
  refreshEditorTheme: (themeId) => refreshMonacoEditorTheme(themeId),
  beginScopeRepaint,
  systemPrefersDark: () => systemPrefersDark(),
};

interface ThemeState {
  /** True once authored state has been read at least once. */
  hydrated: boolean;
  /** The authored global canvas — authoritative, never a resolved token set. */
  globalCanvas: Canvas;
  /**
   * The authored global light/dark/auto choice.
   *
   * Since VC-123 this also decides the EDITOR's theme, resolved. There is no
   * `editorThemeId` beside it any more: one row answers "light or dark?" for
   * the canvas, the terminal fallback and Monaco alike.
   */
  globalAppearance: Appearance;
  /** The workspace the current override belongs to; null for the global scope. */
  projectId: string | null;
  /** That workspace's per-surface override, or null when it inherits everything. */
  projectOverride: ProjectSurfaceOverride | null;
  /** The resolved ghostty chain for the current scope (provenance + overlay paths). */
  terminal: GhosttyAppearancePayload | null;
  /**
   * In-flight canvas preview. Memory-only: it is painted, never written.
   * Re-targeted from the dead picker's hover preview to the canvas editor's
   * live drag — same mechanism, same rules, a different authoring surface.
   */
  preview: Canvas | null;
  /** In-flight appearance preview, independent of {@link preview} exactly as the stored pair is. */
  previewAppearance: Appearance | null;
  /** What `auto` resolves against. Held in state so resolution stays pure and selectors stay stable. */
  systemPrefersDark: boolean;

  /** Seeds the global canvas + appearance from the bootstrap payload's raw `app_state` rows. */
  hydrateGlobal(appState: Record<string, string>): void;
  /** Reads the terminal chain + editor id for a scope, adopting the workspace's canvas columns with it. */
  hydrate(scope?: ThemeProjectScope | null): Promise<void>;
  /** The system flipped light↔dark: re-resolve and repaint every scope on `auto`. */
  noteSystemAppearance(prefersDark: boolean): void;
  acceptTerminal(payload: GhosttyAppearancePayload): void;
  acceptGlobalTerminal(payload: GhosttyAppearancePayload): void;
  startPreview(canvas: Canvas): void;
  startAppearancePreview(appearance: Appearance): void;
  cancelPreview(): void;
  commitPreview(scope: ThemeScope): Promise<boolean>;
  setGlobalCanvas(canvas: Canvas): Promise<boolean>;
  setGlobalAppearance(appearance: Appearance): Promise<boolean>;
  /** One workspace's canvas; `null` puts it back to inheriting the global one. */
  setProjectCanvas(projectId: string, canvas: Canvas | null): Promise<boolean>;
  /** One workspace's appearance; `null` puts it back to inheriting. */
  setProjectAppearance(projectId: string, appearance: Appearance | null): Promise<boolean>;
}

/** The inputs that decide what is on screen right now. */
type ActiveThemeInput = Pick<
  ThemeState,
  | "preview"
  | "previewAppearance"
  | "globalCanvas"
  | "globalAppearance"
  | "projectOverride"
  | "systemPrefersDark"
>;

/**
 * The four surfaces in force, previews folded in.
 *
 * **Never read this straight from a zustand selector.** It builds a fresh
 * `ActiveTheme` on every call, and zustand v5 compares selector snapshots with
 * `Object.is` — a fresh object there is an infinite render loop ("The result of
 * getSnapshot should be cached"), not a wasted allocation. Components read
 * {@link effectiveCanvas} / {@link effectiveAppearance}, which hand back a
 * reference the state already holds and a string respectively.
 */
export function activeTheme({
  preview,
  previewAppearance,
  globalCanvas,
  globalAppearance,
  projectOverride,
  systemPrefersDark: prefersDark,
}: ActiveThemeInput): ActiveTheme {
  // A preview outranks BOTH scopes: it is what the user is looking at, and the
  // whole point is that the window already wears it before anything is saved.
  // Layered as an override rather than by replacing the global, so previewing a
  // canvas in a workspace that overrides the appearance keeps that appearance.
  const override: ProjectSurfaceOverride | null =
    preview === null && previewAppearance === null
      ? projectOverride
      : {
          canvas: preview ?? projectOverride?.canvas ?? null,
          appearance: previewAppearance ?? projectOverride?.appearance ?? null,
          terminalThemeName: projectOverride?.terminalThemeName ?? null,
        };
  return resolveActiveTheme(globalCanvas, globalAppearance, override, prefersDark);
}

/**
 * The canvas currently painted — a reference the state already holds, so it is
 * safe as a zustand selector result. See {@link activeTheme}.
 */
export function effectiveCanvas(state: ActiveThemeInput): Canvas {
  return activeTheme(state).canvas.value;
}

/** The resolved mode currently painted. A string, so stable by value. */
export function effectiveAppearance(state: ActiveThemeInput): ResolvedAppearance {
  return activeTheme(state).resolved;
}

/**
 * What a scope has STORED, ignoring any running preview — what an editor tags as
 * "Current", and what Escape puts back.
 */
export function appliedCanvas(
  state: Pick<ThemeState, "globalCanvas" | "projectId" | "projectOverride">,
  scope: ThemeScope,
): Canvas {
  // The store holds exactly one scope's override at a time; an editor scoped to
  // a workspace the store isn't showing has no override to read, and must not
  // borrow another workspace's.
  if (scope.kind === "global" || scope.projectId !== state.projectId) return state.globalCanvas;
  return state.projectOverride?.canvas ?? state.globalCanvas;
}

/**
 * The migration-014 columns + the migration-013 row, as one resolution input.
 *
 * The two halves genuinely come from different places (see this module's
 * header), and this is the only place that fact is allowed to show.
 */
function surfaceOverride(
  scope: ThemeProjectScope | null,
  legacy: ProjectThemeOverride | null,
): ProjectSurfaceOverride | null {
  const canvas = scope?.canvas ?? null;
  const appearance = scope?.appearance ?? null;
  const terminalThemeName = legacy?.terminalThemeName ?? null;
  if (canvas === null && appearance === null && terminalThemeName === null) {
    return null;
  }
  return { canvas, appearance, terminalThemeName };
}

/**
 * Factory so tests can inject headless deps. Unlike the ui/workspace stores
 * there is no `persist` middleware and so no `skipHydration`: every value here
 * comes from SQLite through the bootstrap payload or `volli:theme-state`.
 */
export function createThemeStore({ deps = defaultDeps }: { deps?: ThemeStoreDeps } = {}) {
  return create<ThemeState>()((set, get) => {
    /**
     * Repaint from whatever the state now says is effective — but only when that
     * has actually changed. Every paint invalidates the terminals' token-derived
     * palette (see theme/apply.ts), so a redundant one makes every live terminal
     * re-theme for nothing; and the paths below deliberately overlap (an
     * optimistic paint followed by the authoritative payload echoing the same
     * canvas back).
     *
     * Monaco follows the same choke point, one resolution later.
     */
    let painted: string | null = null;
    /**
     * Whether what is on the document right now was written by a TRANSIENT
     * paint — one frame of a running gesture, which skipped the terminal
     * refresh and the first-paint hint.
     *
     * Without this the skip would be permanent. A drag's last frame paints the
     * exact canvas the release then commits, so the committing repaint would
     * find its key unchanged, take the early return, and the terminals would
     * keep the palette they had before the drag until something else moved.
     */
    let paintedInFlight = false;
    /** The last id handed to Monaco, so an unchanged mode does not re-theme it. */
    let paintedEditor: string | null = null;
    /**
     * Which `hydrate` call is the current one. Scope reads overlap at boot
     * (main.tsx reads the global scope immediately; boot() reads the restored
     * workspace's scope once it knows it) and at every workspace switch — so the
     * LAST call issued wins, whatever order the payloads come back in.
     */
    let hydrateGeneration = 0;

    const repaint = (options: { eased?: boolean; transient?: boolean } = {}): void => {
      const state = get();
      const active = activeTheme(state);
      // Keyed on the canvas AND the mode, because one canvas paints two
      // different windows: a light↔dark flip moves every derived value while the
      // authored gradient is byte-identical.
      const key = `${active.resolved}|${JSON.stringify(active.canvas.value)}`;
      const transient = options.transient === true;
      // A committing paint runs even when the key is unchanged, as long as what
      // is on the document got there in flight: the properties are already
      // right, but the deferred half of that paint has still never happened.
      if (key !== painted || (paintedInFlight && !transient)) {
        painted = key;
        paintedInFlight = transient;
        // Eased only when there is an actual swap to ease: a scope change that
        // resolves to the same canvas at the same mode repaints nothing, and a
        // 300ms crossfade of a window against an identical copy of itself is
        // latency with nothing to show for it.
        //
        // The eased path re-reads the store instead of painting the `active`
        // resolved above, because its callback runs a frame later, inside the
        // view transition. What should be on screen when the swap actually
        // happens is what the store says then — and the hint recorded below,
        // which is always written from the newest state, would otherwise be
        // able to describe a different canvas than the one painted.
        if (options.eased === true) {
          deps.beginScopeRepaint(() => {
            const current = activeTheme(get());
            deps.paintCanvas(current.canvas.value, current.resolved, { transient });
          });
        } else {
          deps.paintCanvas(active.canvas.value, active.resolved, { transient });
        }
        // The hint describes the NEXT launch's window, so it may only ever
        // describe something STORED. Keyed on a preview being in flight rather
        // than on this paint being transient, because those come apart: a
        // payload landing mid-drag (`accept`, an editor-preview end) repaints
        // durably off state that still has the preview layered on it, and
        // caching that would have the next launch open on a colour the user
        // never chose. It is also an IPC round trip per pointer event.
        if (state.preview === null && state.previewAppearance === null) {
          recordFirstPaint(active.canvas.value, active.resolved);
        }
      }

      // Monaco rides the same choke point, one resolution later: the editor
      // has no stored value of its own, so "which theme?" is entirely a
      // restatement of the mode this paint just resolved. Guarded on the id
      // rather than on the key above, because a canvas change at an unchanged
      // mode must not make every open editor re-theme.
      const editorId = resolveEditorThemeId({ resolvedAppearance: active.resolved });
      if (editorId !== paintedEditor) {
        paintedEditor = editorId;
        deps.refreshEditorTheme(editorId);
      }
    };

    /**
     * Caches what was painted so the NEXT launch's window is built with the
     * right edge color and the right mode class, before any renderer exists.
     *
     * Never awaited and never blocking: the window is already correct, this only
     * matters at the launch after next. A failure still surfaces — a hint that
     * silently stopped updating would show up as a boot flash nobody could
     * explain.
     */
    const recordFirstPaint = (canvas: Canvas, resolved: ResolvedAppearance): void => {
      const hint = { appearance: resolved, background: windowBackground(canvas, resolved) };
      // Started inside a promise so a SYNCHRONOUS throw lands in the same
      // `.catch` as a rejection. `window.api` is not guaranteed to exist in
      // every host this store is constructed in (the renderer's own tests run
      // headless), and a paint is not the place to find that out by crashing.
      void Promise.resolve()
        .then(() => deps.gateway.setFirstPaint(hint))
        .then((result) => {
          if (!result.ok) toastError(`Couldn't save the window appearance: ${result.error}`);
        })
        .catch((error: unknown) => {
          toastError(`Couldn't save the window appearance: ${errorMessage(error)}`);
        });
    };

    /**
     * Adopt a fresh authoritative payload and repaint from it.
     *
     * This is the ONE place a payload can change which workspace's theme is in
     * force, so it is also the one place that can tell a scope change from a
     * canvas change — and the eased repaint (#69) is decided here, before the
     * state moves, while the outgoing scope and mode are still readable.
     */
    const accept = (value: ThemeStatePayload, scope: ThemeProjectScope | null): void => {
      const previous = get();
      const override = surfaceOverride(scope, value.projectOverride);
      const next: ActiveThemeInput = { ...previous, projectOverride: override };
      const eased = shouldEaseScopeRepaint({
        hydrated: previous.hydrated,
        from: previous.projectId,
        to: value.projectId,
        fromAppearance: activeTheme(previous).resolved,
        toAppearance: activeTheme(next).resolved,
      });
      set({
        projectId: value.projectId,
        projectOverride: override,
        terminal: value.terminal,
        hydrated: true,
      });
      repaint({ eased });
    };

    /**
     * An optimistic local change, eased when it flips the mode.
     *
     * Every write below paints before it persists — the canvas editor's whole
     * point is that the window is already wearing the gradient by the time you
     * let go of the orb — so each one needs the same "did this change the mode?"
     * question answered around its `set`.
     *
     * Gated on `painted` rather than on `hydrated`, and the difference is not
     * cosmetic. `hydrated` means the `volli:theme-state` read has landed, which
     * is a fact about the TERMINAL chain; what a crossfade needs to know is
     * whether there is a previous look to come from. The canvas rows arrive
     * first (`hydrateGlobal`), so keying on `hydrated` would hard-cut the first
     * mode flip after boot whenever that read was slow — and would ease the very
     * first paint if it were fast.
     */
    /**
     * The preview paint waiting for the next animation frame, if any.
     *
     * A drag delivers pointer events faster than the display refreshes — a
     * trackpad runs well past 120Hz — and every one of them used to reach the
     * DOM. Only the last write before a frame is ever seen, so the rest were
     * document-wide style recalculations nobody could look at.
     *
     * Coalesced by keeping ONE frame in flight and letting later requests ride
     * it, rather than by cancelling and re-requesting: re-requesting on every
     * event starves at any pointer rate above the refresh rate, because the
     * callback is cancelled before it can run and the window stops following
     * the pointer at all. The frame reads the store when it fires, so it always
     * paints the newest preview — the state is never what is deferred, only the
     * paint is.
     */
    let previewFrame: number | null = null;

    const schedulePreviewPaint = (): void => {
      // Headless — the renderer's own tests run under vitest's `node`
      // environment — there are no frames to coalesce onto, so the paint is
      // immediate. What a preview paints is under test; when it paints is not.
      if (typeof requestAnimationFrame !== "function") {
        repaint({ transient: true });
        return;
      }
      if (previewFrame !== null) return;
      previewFrame = requestAnimationFrame(() => {
        previewFrame = null;
        repaint({ transient: true });
      });
    };

    /**
     * Drops a queued preview frame, for every path that paints authoritatively.
     *
     * A frame surviving into a commit repaints from state the commit has
     * already cleared, so the window would snap back to the stored canvas for
     * one frame on every release — and, worse, would leave the document showing
     * a transient paint after the committing one had already run.
     */
    const dropPendingPreviewPaint = (): void => {
      if (previewFrame === null) return;
      cancelAnimationFrame(previewFrame);
      previewFrame = null;
    };

    /**
     * `ease: false` forces the hard cut for a change that moved the mode but is
     * not a transition — see {@link ThemeState.hydrateGlobal}, the only caller
     * that passes it.
     */
    const setAndRepaint = (patch: Partial<ThemeState>, { ease = true } = {}): void => {
      dropPendingPreviewPaint();
      const hadPainted = painted !== null;
      const before = activeTheme(get()).resolved;
      set(patch);
      const after = activeTheme(get()).resolved;
      repaint({ eased: ease && hadPainted && before !== after });
    };

    /**
     * The migration-013 row for this scope — now just the terminal name.
     *
     * The canvas and appearance writes below rebuild the whole override, so
     * without this they would drop the terminal half of a project that had one.
     */
    const legacyOverrideFor = (projectId: string): ProjectThemeOverride | null => {
      const state = get();
      if (state.projectId !== projectId) return null;
      const terminalThemeName = state.projectOverride?.terminalThemeName ?? null;
      return terminalThemeName === null ? null : { terminalThemeName };
    };

    return {
      hydrated: false,
      globalCanvas: DEFAULT_CANVAS,
      globalAppearance: "auto",
      projectId: null,
      projectOverride: null,
      terminal: null,
      preview: null,
      previewAppearance: null,
      systemPrefersDark: deps.systemPrefersDark(),

      hydrateGlobal(appState) {
        // A row that is absent, unparseable, or still holds the seed system's
        // `ThemeDefinition` all read the same: no canvas stored, so the shipped
        // default. That IS decision 7 — reset to the default canvas, no
        // seed→canvas conversion — falling out of the guard rather than needing
        // a migration to do it.
        let stored: Canvas | null = null;
        const raw = appState[THEME_APP_STATE_KEY];
        if (raw !== undefined && raw.length > 0) {
          try {
            stored = parseCanvas(JSON.parse(raw));
          } catch {
            stored = null;
          }
        }
        const appearance = appState[APPEARANCE_APP_STATE_KEY];
        // NEVER eased, and that is the same rule as "the first paint is not a
        // transition" — it just has to be said here, because by the time these
        // rows land something may already have painted. `volli:theme-state` can
        // beat the bootstrap payload back (main.tsx asks for it the moment the
        // renderer exists; this arrives with `boot()`), and that read's
        // `accept` repaints from a store that has never seen an authored row:
        // the shipped canvas at `auto`, which on a dark machine is a dark
        // window. Crossfading from THAT to the user's stored look would ease
        // out of a placeholder — a 300ms fade from a theme nobody chose, on
        // every launch that loses the race. There is no previous look here by
        // definition: this IS the previous look arriving.
        setAndRepaint(
          {
            globalCanvas: stored ?? DEFAULT_CANVAS,
            globalAppearance: isAppearance(appearance) ? appearance : "auto",
          },
          { ease: false },
        );
      },

      async hydrate(scope) {
        const generation = ++hydrateGeneration;
        let result: ThemeStateResult;
        try {
          result = await deps.gateway.state(
            scope === undefined || scope === null ? {} : { projectId: scope.projectId },
          );
        } catch (error) {
          // A read failure is not fatal — globals.css already painted the
          // default — but it is still a failure the user must see, or their
          // chosen canvas silently "resets".
          toastError(`Couldn't load the theme: ${errorMessage(error)}`);
          return;
        }
        // Superseded while in flight: adopting this payload would repaint the
        // app in a scope it has already left. Silent by design — the read didn't
        // fail, it just stopped being the answer to the question being asked.
        if (generation !== hydrateGeneration) return;
        if (!result.ok) {
          toastError(`Couldn't load the theme: ${result.error}`);
          return;
        }
        accept(result.value, scope ?? null);
      },

      noteSystemAppearance(prefersDark) {
        if (get().systemPrefersDark === prefersDark) return;
        setAndRepaint({ systemPrefersDark: prefersDark });
      },

      /** Adopt an appearance resolved for THIS store's scope — e.g. the one main hands back from an overlay write. */
      acceptTerminal(payload) {
        set({ terminal: payload });
      },

      /**
       * The `volli:ghostty-config-changed` broadcast, which main resolves for the
       * GLOBAL scope only: that channel has no project context and the watch
       * fires at every window at once. Swallowing it whole while a workspace
       * scope is loaded would overwrite that workspace's provenance, overlay path
       * and layered values with global ones — and fail silently. So a workspace
       * scope re-requests its own resolution and the payload is dropped.
       */
      acceptGlobalTerminal(payload) {
        const state = get();
        if (state.projectId === null) {
          set({ terminal: payload });
          return;
        }
        void get().hydrate({
          projectId: state.projectId,
          canvas: state.projectOverride?.canvas ?? null,
          appearance: state.projectOverride?.appearance ?? null,
        });
      },

      startPreview(canvas) {
        // The STATE moves now and the paint moves on the next frame. Everything
        // reading this store — the editor's own controls, and the next event in
        // the same drag building on where the last one landed — sees the new
        // canvas immediately; only the document's ~50 properties wait.
        //
        // Deliberately not `setAndRepaint`: that path is for authoritative
        // changes, and it drops exactly the frame this one is scheduling. A
        // canvas preview also cannot flip the mode, so there is nothing here for
        // the eased repaint it arms.
        set({ preview: canvas });
        schedulePreviewPaint();
      },

      startAppearancePreview(appearance) {
        setAndRepaint({ previewAppearance: appearance });
      },

      cancelPreview() {
        // Nothing to undo but the paint: a preview never wrote anywhere.
        const state = get();
        if (state.preview === null && state.previewAppearance === null) return;
        setAndRepaint({ preview: null, previewAppearance: null });
      },

      /** What was being previewed becomes what is stored, in the given scope. */
      async commitPreview(scope) {
        const { preview, previewAppearance } = get();
        if (preview === null && previewAppearance === null) return false;
        // The gesture is over. A frame still queued would fire against state
        // that no longer holds a preview and repaint the pre-drag canvas.
        dropPendingPreviewPaint();
        set({ preview: null, previewAppearance: null });
        const writes: Promise<boolean>[] = [];
        if (preview !== null) {
          writes.push(
            scope.kind === "global"
              ? get().setGlobalCanvas(preview)
              : get().setProjectCanvas(scope.projectId, preview),
          );
        }
        if (previewAppearance !== null) {
          writes.push(
            scope.kind === "global"
              ? get().setGlobalAppearance(previewAppearance)
              : get().setProjectAppearance(scope.projectId, previewAppearance),
          );
        }
        const settled = (await Promise.all(writes)).every(Boolean);
        // The gesture's last frame was a transient paint, and every write path
        // above is supposed to end in an authoritative one that supersedes it —
        // but `setProjectCanvas` skips its repaint entirely when the committed
        // workspace is not the scope the store currently holds. Left there, the
        // document keeps a paint whose deferred half never ran: the terminals
        // stay on the pre-drag palette and the first-paint hint is never
        // recorded. Deduped on the key, so in the ordinary case this is free.
        repaint();
        return settled;
      },

      async setGlobalCanvas(canvas) {
        const previous = get().globalCanvas;
        setAndRepaint({ preview: null, globalCanvas: canvas });
        const result = await writeThrough("save the canvas", () =>
          deps.gateway.setGlobalCanvas(canvas),
        );
        if (result === null) {
          // Put the user back on what is actually stored rather than leaving
          // them looking at something that isn't. `writeThrough` already
          // surfaced the failure.
          setAndRepaint({ globalCanvas: previous });
          return false;
        }
        return true;
      },

      async setGlobalAppearance(appearance) {
        const previous = get().globalAppearance;
        setAndRepaint({ previewAppearance: null, globalAppearance: appearance });
        const result = await writeThrough("save the appearance", () =>
          deps.gateway.setGlobalAppearance(appearance),
        );
        if (result === null) {
          setAndRepaint({ globalAppearance: previous });
          return false;
        }
        return true;
      },

      async setProjectCanvas(projectId, canvas) {
        const state = get();
        // A write aimed at a workspace this store isn't showing persists without
        // repainting: there is nothing of that workspace's on screen to move,
        // and adopting its canvas here would paint one project's window with
        // another's.
        const inScope = state.projectId === projectId;
        const previous = state.projectOverride;
        if (inScope) {
          setAndRepaint({
            preview: null,
            projectOverride: surfaceOverride(
              { projectId, canvas, appearance: previous?.appearance ?? null },
              legacyOverrideFor(projectId),
            ),
          });
        }
        const result = await writeThrough("save the canvas", () =>
          deps.gateway.setProjectCanvas(projectId, canvas),
        );
        if (result === null) {
          if (inScope) setAndRepaint({ projectOverride: previous });
          return false;
        }
        // The projects store holds the ONLY copy of this row, and every scope
        // is rebuilt from it. Without this the write survives in SQLite and
        // dies in memory.
        projectRowSink?.(result.project);
        return true;
      },

      async setProjectAppearance(projectId, appearance) {
        const state = get();
        const inScope = state.projectId === projectId;
        const previous = state.projectOverride;
        if (inScope) {
          setAndRepaint({
            previewAppearance: null,
            projectOverride: surfaceOverride(
              { projectId, canvas: previous?.canvas ?? null, appearance },
              legacyOverrideFor(projectId),
            ),
          });
        }
        const result = await writeThrough("save the appearance", () =>
          deps.gateway.setProjectAppearance(projectId, appearance),
        );
        if (result === null) {
          if (inScope) setAndRepaint({ projectOverride: previous });
          return false;
        }
        // Same reason as the canvas write above.
        projectRowSink?.(result.project);
        return true;
      },
    };
  });
}

/** App-wide singleton; components import this directly. */
export const useThemeStore = createThemeStore();
