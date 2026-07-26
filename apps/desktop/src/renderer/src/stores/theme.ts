/**
 * Theming state for the renderer: what the user AUTHORED, what a project
 * overrides, and what is merely being previewed right now.
 *
 * Three rules from docs/plans/theming-engine.md are load-bearing here.
 *
 *  - **The resolved token set is never stored.** This store holds
 *    `{global theme, project override}` and derives the rest at render time
 *    (see `effectiveTheme` + `theme/apply.ts`). VS Code's most-complained-about
 *    theming bug is auto-switching writing the *resolved* theme back over the
 *    user's authored intent; the shape here makes that unrepresentable.
 *  - **Preview is memory-only.** `startPreview` repaints the live DOM and
 *    writes NOTHING — not to SQLite, not to `app_state`, not anywhere. Only
 *    `commitPreview` persists, and `cancelPreview` restores the pre-preview
 *    look by simply forgetting the preview, because nothing else ever changed.
 *  - **Favorites and Recents persist through `app_state`**, like every other
 *    renderer preference (#29) — never localStorage.
 *
 * The theme itself is NOT persisted through this store's `persist` middleware:
 * it lives in SQLite behind `window.api.theme`, because main needs to read it
 * too (the window background follows it, before any renderer exists).
 */

import { DEFAULT_THEME, errorMessage } from "@volli/shared";
import type {
  CustomThemeListResult,
  CustomThemeWriteResult,
  GhosttyAppearancePayload,
  ProjectThemeOverride,
  Result,
  ShippedEditorThemeId,
  ThemeDefinition,
  ThemeSetProjectResult,
  ThemeStatePayload,
  ThemeStateResult,
} from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";
import { toastError } from "@renderer/lib/toast";
import {
  MAX_RECENT_THEMES,
  noteRecentTheme,
  toggleFavoriteTheme,
} from "@renderer/components/theme/theme-picker-model";
import {
  withProjectAppChoice,
  withProjectEditorChoice,
  type ProjectAppChoice,
} from "@renderer/components/theme/project-appearance-model";
import { applyTheme as applyThemeToDom, resolveActiveTheme } from "@renderer/theme/apply";
import { BUILTIN_THEMES, mergeThemeCatalog } from "@renderer/theme/catalog";
import { resolveEditorThemeId } from "@renderer/editor/editor-theme-catalog";
import { refreshMonacoEditorTheme } from "@renderer/editor/monaco-theme";
import { writeThrough } from "@renderer/stores/mutate";

/** Which scope a commit writes to (#69). The per-project entry point ships with Configure. */
export type ThemeScope = { kind: "global" } | { kind: "project"; projectId: string };

/** The preload theming surface this store needs — narrow, and fake-able in tests. */
export interface ThemeGateway {
  state(input: { projectId?: string }): Promise<ThemeStateResult>;
  setGlobal(theme: ThemeDefinition): Promise<ThemeStateResult>;
  setGlobalEditor(editorThemeId: ShippedEditorThemeId | null): Promise<ThemeStateResult>;
  setProject(
    projectId: string,
    override: ProjectThemeOverride | null,
  ): Promise<ThemeSetProjectResult>;
  /**
   * The user's own theme files (#71). Every verb names a SLUG — main owns the
   * path — and the two writers answer with the FRESH catalog, so this store
   * adopts what the directory now holds instead of predicting it.
   */
  listCustomThemes(): Promise<CustomThemeListResult>;
  saveCustomTheme(theme: ThemeDefinition): Promise<CustomThemeWriteResult>;
  deleteCustomTheme(slug: string): Promise<CustomThemeListResult>;
  openCustomTheme(slug: string): Promise<Result>;
}

/** The seams the store drives: the IPC bridge, and the DOM / Monaco repaint. */
export interface ThemeStoreDeps {
  gateway: ThemeGateway;
  /** Generates and writes the CSS custom properties. Injected so the store stays testable headlessly. */
  applyTheme(theme: ThemeDefinition): void;
  /** Activates a Monaco/shiki catalog id (queued until Monaco boots). */
  refreshEditorTheme(themeId: string): void;
}

const defaultDeps: ThemeStoreDeps = {
  gateway: {
    state: (input) => window.api.theme.state(input),
    setGlobal: (theme) => window.api.theme.setGlobal(theme),
    setGlobalEditor: (editorThemeId) => window.api.theme.setGlobalEditor(editorThemeId),
    setProject: (projectId, override) => window.api.theme.setProject(projectId, override),
    listCustomThemes: () => window.api.theme.listCustomThemes(),
    saveCustomTheme: (theme) => window.api.theme.saveCustomTheme(theme),
    deleteCustomTheme: (slug) => window.api.theme.deleteCustomTheme(slug),
    openCustomTheme: (slug) => window.api.theme.openCustomTheme(slug),
  },
  applyTheme: (theme) => applyThemeToDom(theme),
  refreshEditorTheme: (themeId) => refreshMonacoEditorTheme(themeId),
};

interface ThemeState {
  /** True once the authored state has been read from main at least once. */
  hydrated: boolean;
  /** The authored global theme — authoritative, never a resolved token set. */
  global: ThemeDefinition;
  /**
   * Global Monaco/shiki theme id from `app_state`. `null` means derive from
   * the active app theme slug via {@link resolveEditorThemeId}.
   */
  editorThemeId: ShippedEditorThemeId | null;
  /** The project the current override belongs to; null for the global scope. */
  projectId: string | null;
  /** That project's per-surface override, or null when it inherits everything. */
  projectOverride: ProjectThemeOverride | null;
  /** The resolved ghostty chain for the current scope (provenance + overlay paths). */
  terminal: GhosttyAppearancePayload | null;
  /** In-flight preview. Memory-only: it is painted, never written. */
  preview: ThemeDefinition | null;
  /** The user's own themes, as last read from `<userData>/volli/themes`. */
  customThemes: ThemeDefinition[];
  favorites: string[];
  /** Applied theme slugs, most recent first. */
  recents: string[];

  hydrate(projectId?: string | null): Promise<void>;
  loadCustomThemes(): Promise<void>;
  saveCustomTheme(theme: ThemeDefinition, scope: ThemeScope): Promise<boolean>;
  deleteCustomTheme(slug: string): Promise<boolean>;
  openCustomThemeFile(slug: string): Promise<boolean>;
  acceptTerminal(payload: GhosttyAppearancePayload): void;
  acceptGlobalTerminal(payload: GhosttyAppearancePayload): void;
  startPreview(theme: ThemeDefinition): void;
  cancelPreview(): void;
  commitPreview(scope: ThemeScope): Promise<boolean>;
  /**
   * Live Monaco preview for Settings → Editor — paints a catalog id and
   * updates `paintedEditor`, writing nothing. Must go through this store so
   * App-theme preview and Editor restore stay coherent.
   */
  startEditorPreview(themeId: string): void;
  /**
   * End an Editor preview by restoring Monaco from the same resolution
   * `repaint` uses (`effectiveTheme`, not only `global.slug`).
   */
  endEditorPreview(): void;
  setGlobalTheme(theme: ThemeDefinition): Promise<boolean>;
  setEditorTheme(editorThemeId: ShippedEditorThemeId | null): Promise<boolean>;
  /**
   * One project's app surface: Inherit, #72's auto-tint seed, or a named
   * theme. The picker's Enter still commits through `commitPreview` (it has a
   * preview to end and a Recent to note); this is the entry point for the
   * choices that have no preview — going back to Inherit, and turning the
   * auto-tint on.
   */
  setProjectAppChoice(projectId: string, choice: ProjectAppChoice): Promise<boolean>;
  /**
   * One project's editor surface — `null` puts it back to inheriting the
   * global choice (#69). The project-scope twin of {@link setEditorTheme}; a
   * non-null id must be a SHIPPED catalog id or main rejects the write.
   */
  setProjectEditorTheme(
    projectId: string,
    editorThemeId: ShippedEditorThemeId | null,
  ): Promise<boolean>;
  toggleFavorite(slug: string): void;
}

/** Built-ins plus customs — colliding shipped slugs omitted (same rule as the picker). */
function themeCatalog(customThemes: ThemeDefinition[]): readonly ThemeDefinition[] {
  return mergeThemeCatalog(BUILTIN_THEMES, customThemes);
}

/** The inputs that decide what is on screen right now. */
type EffectiveThemeInput = Pick<
  ThemeState,
  "preview" | "global" | "projectOverride" | "customThemes"
>;

/**
 * The app-surface theme currently in force: the preview if one is running,
 * otherwise the per-surface global → project resolution. Derived on every read
 * rather than stored, which is what keeps the authored intent authoritative.
 *
 * Read as a zustand selector, so every path has to return a STABLE reference
 * for unchanged state — v5 reads selectors through `useSyncExternalStore` and
 * an `Object.is`-fresh snapshot each render loops forever. Three of the paths
 * hand back an object the state already holds; the fourth (#72's derived tint)
 * is memoized on its inputs in theme/apply.ts.
 */
export function effectiveTheme({
  preview,
  global,
  projectOverride,
  customThemes,
}: EffectiveThemeInput): ThemeDefinition {
  if (preview !== null) return preview;
  return resolveActiveTheme(global, projectOverride, themeCatalog(customThemes), null).app.value;
}

/** What a scope has STORED — as opposed to what a preview is showing. */
type AppliedThemeInput = Pick<
  ThemeState,
  "global" | "projectId" | "projectOverride" | "customThemes"
>;

/**
 * The theme actually persisted for `scope`, ignoring any running preview —
 * what the picker tags as "Current", and what Escape puts back. Tagging the
 * *effective* theme instead would walk the tag down the list with the cursor,
 * hiding the one thing the tag exists to state.
 */
export function appliedTheme(
  { global, projectId, projectOverride, customThemes }: AppliedThemeInput,
  scope: ThemeScope,
): ThemeDefinition {
  // The store holds exactly one scope's override at a time; a picker scoped to
  // a project the store isn't showing has no override to read, and must not
  // borrow another project's.
  if (scope.kind === "global" || scope.projectId !== projectId) return global;
  return resolveActiveTheme(global, projectOverride, themeCatalog(customThemes), null).app.value;
}

/** Persisted slice: the library's memory of your taste, not the theme itself. */
type PersistedThemeState = Pick<ThemeState, "favorites" | "recents">;

/** Rehydrated JSON was written by a past build — trust nothing about its shape. */
function sanitizeSlugs(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, limit);
}

/**
 * Factory so tests can inject an in-memory storage and headless deps. As in
 * stores/ui.ts, `skipHydration` applies only to the real singleton: a real boot
 * round-trips through main before the store can rehydrate, whereas an injected
 * test storage is synchronous.
 */
export function createThemeStore({
  deps = defaultDeps,
  storage,
}: { deps?: ThemeStoreDeps; storage?: StateStorage } = {}) {
  return create<ThemeState>()(
    persist(
      (set, get) => {
        /**
         * Repaint from whatever the state now says is effective — but only
         * when that has actually changed. Every paint invalidates the
         * terminals' token-derived palette (see theme/apply.ts), so a
         * redundant one makes every live terminal re-theme for nothing; and
         * the paths below deliberately overlap (an optimistic paint followed
         * by the authoritative payload echoing the same theme back).
         *
         * Monaco follows the same choke point: resolve the active editor id
         * (project override → global authored → derive from app slug) and
         * refresh whenever that resolved id changes.
         */
        let painted: string | null = null;
        let paintedEditor: string | null = null;
        let persistedEditorThemeId: ShippedEditorThemeId | null = null;
        /**
         * Which `hydrate` call is the current one. Scope reads overlap at boot
         * (main.tsx reads the global scope immediately; boot() reads the
         * restored project's scope once it knows it) and at every project
         * switch — so the LAST call issued wins, whatever order the payloads
         * come back in. Without this, a slow global read could land after a
         * project read and quietly put the app back on global scope.
         */
        let hydrateGeneration = 0;
        let editorWriteGeneration = 0;
        let editorWriteQueue: Promise<void> = Promise.resolve();
        const repaint = (): void => {
          const state = get();
          const theme = effectiveTheme(state);
          const key = JSON.stringify(theme);
          if (key !== painted) {
            painted = key;
            deps.applyTheme(theme);
          }

          const active = resolveActiveTheme(
            state.global,
            state.projectOverride,
            themeCatalog(state.customThemes),
            state.editorThemeId,
          );
          const editorId = resolveEditorThemeId({
            editorThemeId: active.editor.value,
            appThemeSlug: theme.slug,
          });
          if (editorId !== paintedEditor) {
            paintedEditor = editorId;
            deps.refreshEditorTheme(editorId);
          }
        };

        /** Adopt a fresh authoritative payload from main and repaint from it. */
        const accept = (value: ThemeStatePayload): void => {
          persistedEditorThemeId = value.editorThemeId;
          set({
            global: value.theme,
            editorThemeId: value.editorThemeId,
            projectId: value.projectId,
            projectOverride: value.projectOverride,
            terminal: value.terminal,
            hydrated: true,
          });
          repaint();
        };

        /**
         * The override a per-surface write merges onto. The store holds
         * exactly ONE scope's override (see `appliedTheme`), so a write aimed
         * at a project it isn't showing has nothing of that project's to
         * merge onto — and borrowing the loaded project's fields would write
         * one project's look onto another. An all-inheriting base is the only
         * honest answer there.
         */
        const overrideBaseFor = (projectId: string): ProjectThemeOverride | null => {
          const state = get();
          return state.projectId === projectId ? state.projectOverride : null;
        };

        /**
         * A project's app surface, leaving its other surfaces exactly as they
         * were (#69: resolution is per surface, never per token — so a write
         * must be per surface too).
         */
        const setProjectAppTheme = async (
          projectId: string,
          theme: ThemeDefinition,
        ): Promise<boolean> => {
          const next = withProjectAppChoice(overrideBaseFor(projectId), {
            kind: "theme",
            slug: theme.slug,
          });
          const previousRecents = get().recents;
          set({ recents: noteRecentTheme(previousRecents, theme.slug) });
          const result = await writeThrough("save the theme", () =>
            deps.gateway.setProject(projectId, next),
          );
          if (result === null) {
            // A theme that did not save was not applied — Recent must describe
            // what is stored, not what was attempted. (And it PERSISTS, so an
            // un-rolled-back entry would outlive the session that failed.)
            set({ recents: previousRecents });
            repaint();
            return false;
          }
          accept(result.value);
          return true;
        };

        return {
          hydrated: false,
          global: DEFAULT_THEME,
          editorThemeId: null,
          projectId: null,
          projectOverride: null,
          terminal: null,
          preview: null,
          customThemes: [],
          favorites: [],
          recents: [],

          async hydrate(projectId) {
            const generation = ++hydrateGeneration;
            let result: ThemeStateResult;
            try {
              result = await deps.gateway.state(
                projectId === undefined || projectId === null ? {} : { projectId },
              );
            } catch (error) {
              // A theme read failure is not fatal — the shipped default is
              // already painted by globals.css — but it is still a failure the
              // user must see, or their chosen theme silently "resets".
              toastError(`Couldn't load the theme: ${errorMessage(error)}`);
              return;
            }
            // Superseded while in flight: adopting this payload would repaint
            // the app in a scope it has already left. Silent by design — the
            // read didn't fail, it just stopped being the answer to the
            // question being asked.
            if (generation !== hydrateGeneration) return;
            if (!result.ok) {
              toastError(`Couldn't load the theme: ${result.error}`);
              return;
            }
            accept(result.value);
            // The library is part of the theme state: a picker that opened
            // before this landed would show the shipped six and silently omit
            // every theme the user made.
            await get().loadCustomThemes();
          },

          /** Re-reads `<userData>/volli/themes`. The files are hand-editable, so this is never assumed to be current. */
          async loadCustomThemes() {
            const result = await writeThrough("load your themes", () =>
              deps.gateway.listCustomThemes(),
            );
            if (result !== null) set({ customThemes: result.themes });
          },

          /**
           * Explicit save (#73): the draft becomes a file of the user's own,
           * and then becomes the applied theme.
           *
           * Order matters. The file is written FIRST, and the theme is applied
           * only if that succeeded — applying a theme whose file failed to
           * write would leave the app wearing something that exists nowhere,
           * which is the same lie the preview path exists to avoid. Applying at
           * all is the honest half: the user has been looking at this theme the
           * whole time they were editing it, so a save that dropped them back
           * onto the old one would read as the save having failed.
           */
          async saveCustomTheme(theme, scope) {
            const written = await writeThrough("save the theme", () =>
              deps.gateway.saveCustomTheme(theme),
            );
            if (written === null) return false;
            set({ customThemes: written.themes });
            // Through the preview path, so committing an edited theme is the
            // same write as committing a picked one — including its optimistic
            // paint and its rollback.
            get().startPreview(theme);
            const committed = await get().commitPreview(scope);
            // The file is already on disk — keep the editor and live app on the
            // draft the user was saving rather than snapping back to stored.
            if (!committed) get().startPreview(theme);
            return committed;
          },

          /** Deletes a theme file, adopting the catalog the delete hands back. */
          async deleteCustomTheme(slug) {
            const result = await writeThrough("delete the theme", () =>
              deps.gateway.deleteCustomTheme(slug),
            );
            if (result === null) return false;
            set({ customThemes: result.themes });
            return true;
          },

          /** Opens a theme's JSON in the user's editor — #71's "the file is the full interface". */
          async openCustomThemeFile(slug) {
            return (
              (await writeThrough("open the theme file", () =>
                deps.gateway.openCustomTheme(slug),
              )) !== null
            );
          },

          /** Adopt an appearance resolved for THIS store's scope — e.g. the one main hands back from an overlay write. */
          acceptTerminal(payload) {
            set({ terminal: payload });
          },

          /**
           * The `volli:ghostty-config-changed` broadcast, which main resolves
           * for the GLOBAL scope only (see `registerGhosttyConfigIpc`): that
           * channel has no project context and the watch fires at every window
           * at once. Swallowing it whole while a project scope is loaded would
           * overwrite that project's provenance, overlay path and layered
           * values with global ones — and fail silently, the row just quietly
           * stops saying `Set by this project`. So a project scope re-requests
           * its own resolution through `volli:theme-state`, which CAN map a
           * project to its layer, and the payload is dropped.
           */
          acceptGlobalTerminal(payload) {
            const { projectId } = get();
            if (projectId === null) {
              set({ terminal: payload });
              return;
            }
            void get().hydrate(projectId);
          },

          startPreview(theme) {
            // Force the editor half even when the resolved catalog id matches
            // `paintedEditor`: an Editor-picker restore that bypassed this
            // store (or any out-of-band Monaco paint) can leave Monaco on the
            // wrong theme while the tracker still says the preview id. Re-
            // highlighting the same App theme must refresh, not skip.
            paintedEditor = null;
            set({ preview: theme });
            repaint();
          },

          cancelPreview() {
            // Nothing to undo but the paint: a preview never wrote anywhere.
            if (get().preview === null) return;
            set({ preview: null });
            repaint();
          },

          startEditorPreview(themeId) {
            if (themeId.length === 0) {
              get().endEditorPreview();
              return;
            }
            paintedEditor = themeId;
            deps.refreshEditorTheme(themeId);
          },

          endEditorPreview() {
            // Always re-resolve and paint: a no-op skip on `paintedEditor`
            // would leave Monaco stuck after a bypassed preview paint. Use
            // the same inputs as `repaint` — effective (preview-aware) app
            // slug, not only the stored global.
            paintedEditor = null;
            repaint();
          },

          /** Enter: what was being previewed becomes what is stored, in the given scope. */
          async commitPreview(scope) {
            const theme = get().preview;
            if (theme === null) return false;
            set({ preview: null });
            return scope.kind === "global"
              ? await get().setGlobalTheme(theme)
              : await setProjectAppTheme(scope.projectId, theme);
          },

          async setGlobalTheme(theme) {
            // Optimistic: the picker's whole point is that the app is already
            // wearing the theme by the time you press Enter.
            const previous = get().global;
            const previousRecents = get().recents;
            set({
              preview: null,
              global: theme,
              recents: noteRecentTheme(previousRecents, theme.slug),
            });
            repaint();
            const result = await writeThrough("save the theme", () =>
              deps.gateway.setGlobal(theme),
            );
            if (result === null) {
              // Put the user back on the theme that is actually stored rather
              // than leaving them looking at one that isn't — Recent included,
              // or a theme that never saved would still rank as the last one
              // applied. `writeThrough` has already surfaced the failure.
              set({ global: previous, recents: previousRecents });
              repaint();
              return false;
            }
            accept(result.value);
            return true;
          },

          async setEditorTheme(editorThemeId) {
            const generation = ++editorWriteGeneration;
            set({ editorThemeId });
            repaint();
            const write = editorWriteQueue.then(() =>
              writeThrough("save the editor theme", () =>
                deps.gateway.setGlobalEditor(editorThemeId),
              ),
            );
            editorWriteQueue = write.then(() => undefined);
            const result = await write;
            if (result !== null) {
              persistedEditorThemeId = result.value.editorThemeId;
            }
            if (generation !== editorWriteGeneration) {
              return result !== null;
            }
            if (result === null) {
              set({ editorThemeId: persistedEditorThemeId });
              repaint();
              return false;
            }
            accept(result.value);
            return true;
          },

          async setProjectAppChoice(projectId, choice) {
            const next = withProjectAppChoice(overrideBaseFor(projectId), choice);
            const result = await writeThrough("save the theme", () =>
              deps.gateway.setProject(projectId, next),
            );
            if (result === null) return false;
            accept(result.value);
            return true;
          },

          async setProjectEditorTheme(projectId, editorThemeId) {
            const next = withProjectEditorChoice(
              overrideBaseFor(projectId),
              editorThemeId === null
                ? { kind: "inherit" }
                : { kind: "theme", themeId: editorThemeId },
            );
            const result = await writeThrough("save the editor theme", () =>
              deps.gateway.setProject(projectId, next),
            );
            if (result === null) return false;
            accept(result.value);
            return true;
          },

          toggleFavorite(slug) {
            set({ favorites: toggleFavoriteTheme(get().favorites, slug) });
          },
        };
      },
      {
        name: "volli:theme",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
        skipHydration: storage === undefined,
        partialize: (state): PersistedThemeState => ({
          favorites: state.favorites,
          recents: state.recents,
        }),
        merge: (persisted, current) => {
          const stored =
            typeof persisted === "object" && persisted !== null
              ? (persisted as Partial<PersistedThemeState>)
              : {};
          return {
            ...current,
            // No cap on favorites: starring is deliberate, and silently
            // dropping one would be worse than a long list.
            favorites: sanitizeSlugs(stored.favorites, Number.POSITIVE_INFINITY),
            recents: sanitizeSlugs(stored.recents, MAX_RECENT_THEMES),
          };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useThemeStore = createThemeStore();
