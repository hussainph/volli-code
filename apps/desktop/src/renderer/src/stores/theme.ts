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

import { DEFAULT_THEME, EMPTY_PROJECT_THEME_OVERRIDE, errorMessage } from "@volli/shared";
import type {
  GhosttyAppearancePayload,
  ProjectThemeOverride,
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
import { applyTheme as applyThemeToDom, resolveActiveTheme } from "@renderer/theme/apply";
import { BUILTIN_THEMES } from "@renderer/theme/catalog";
import { writeThrough } from "@renderer/stores/mutate";

/** Which scope a commit writes to (#69). The per-project entry point ships with Configure. */
export type ThemeScope = { kind: "global" } | { kind: "project"; projectId: string };

/** The preload theming surface this store needs — narrow, and fake-able in tests. */
export interface ThemeGateway {
  state(input: { projectId?: string }): Promise<ThemeStateResult>;
  setGlobal(theme: ThemeDefinition): Promise<ThemeStateResult>;
  setProject(
    projectId: string,
    override: ProjectThemeOverride | null,
  ): Promise<ThemeSetProjectResult>;
}

/** The seams the store drives: the IPC bridge, and the DOM repaint. */
export interface ThemeStoreDeps {
  gateway: ThemeGateway;
  /** Generates and writes the CSS custom properties. Injected so the store stays testable headlessly. */
  applyTheme(theme: ThemeDefinition): void;
}

const defaultDeps: ThemeStoreDeps = {
  gateway: {
    state: (input) => window.api.theme.state(input),
    setGlobal: (theme) => window.api.theme.setGlobal(theme),
    setProject: (projectId, override) => window.api.theme.setProject(projectId, override),
  },
  applyTheme: (theme) => applyThemeToDom(theme),
};

interface ThemeState {
  /** True once the authored state has been read from main at least once. */
  hydrated: boolean;
  /** The authored global theme — authoritative, never a resolved token set. */
  global: ThemeDefinition;
  /** The project the current override belongs to; null for the global scope. */
  projectId: string | null;
  /** That project's per-surface override, or null when it inherits everything. */
  projectOverride: ProjectThemeOverride | null;
  /** The resolved ghostty chain for the current scope (provenance + overlay paths). */
  terminal: GhosttyAppearancePayload | null;
  /** In-flight preview. Memory-only: it is painted, never written. */
  preview: ThemeDefinition | null;
  favorites: string[];
  /** Applied theme slugs, most recent first. */
  recents: string[];

  hydrate(projectId?: string | null): Promise<void>;
  acceptTerminal(payload: GhosttyAppearancePayload): void;
  acceptGlobalTerminal(payload: GhosttyAppearancePayload): void;
  startPreview(theme: ThemeDefinition): void;
  cancelPreview(): void;
  commitPreview(scope: ThemeScope): Promise<boolean>;
  setGlobalTheme(theme: ThemeDefinition): Promise<boolean>;
  toggleFavorite(slug: string): void;
}

/** The inputs that decide what is on screen right now. */
type EffectiveThemeInput = Pick<ThemeState, "preview" | "global" | "projectOverride">;

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
}: EffectiveThemeInput): ThemeDefinition {
  if (preview !== null) return preview;
  return resolveActiveTheme(global, projectOverride, BUILTIN_THEMES).app.value;
}

/** What a scope has STORED — as opposed to what a preview is showing. */
type AppliedThemeInput = Pick<ThemeState, "global" | "projectId" | "projectOverride">;

/**
 * The theme actually persisted for `scope`, ignoring any running preview —
 * what the picker tags as "Current", and what Escape puts back. Tagging the
 * *effective* theme instead would walk the tag down the list with the cursor,
 * hiding the one thing the tag exists to state.
 */
export function appliedTheme(
  { global, projectId, projectOverride }: AppliedThemeInput,
  scope: ThemeScope,
): ThemeDefinition {
  // The store holds exactly one scope's override at a time; a picker scoped to
  // a project the store isn't showing has no override to read, and must not
  // borrow another project's.
  if (scope.kind === "global" || scope.projectId !== projectId) return global;
  return resolveActiveTheme(global, projectOverride, BUILTIN_THEMES).app.value;
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
         */
        let painted: string | null = null;
        const repaint = (): void => {
          const theme = effectiveTheme(get());
          const key = JSON.stringify(theme);
          if (key === painted) return;
          painted = key;
          deps.applyTheme(theme);
        };

        /** Adopt a fresh authoritative payload from main and repaint from it. */
        const accept = (value: ThemeStatePayload): void => {
          set({
            global: value.theme,
            projectId: value.projectId,
            projectOverride: value.projectOverride,
            terminal: value.terminal,
            hydrated: true,
          });
          repaint();
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
          const base = get().projectOverride ?? EMPTY_PROJECT_THEME_OVERRIDE;
          set({ recents: noteRecentTheme(get().recents, theme.slug) });
          const result = await writeThrough("save the theme", () =>
            deps.gateway.setProject(projectId, { ...base, appThemeSlug: theme.slug }),
          );
          if (result === null) {
            repaint();
            return false;
          }
          accept(result.value);
          return true;
        };

        return {
          hydrated: false,
          global: DEFAULT_THEME,
          projectId: null,
          projectOverride: null,
          terminal: null,
          preview: null,
          favorites: [],
          recents: [],

          async hydrate(projectId) {
            let result: ThemeStateResult;
            try {
              result = await deps.gateway.state(
                projectId === undefined || projectId === null ? {} : { projectId },
              );
            } catch (error) {
              // A theme read failure is not fatal — the shipped default is
              // already painted by globals.css — but it is still a failure the
              // user must see, or their chosen theme silently "resets".
              toastError(`Could not load the theme: ${errorMessage(error)}`);
              return;
            }
            if (!result.ok) {
              toastError(`Could not load the theme: ${result.error}`);
              return;
            }
            accept(result.value);
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
            set({ preview: theme });
            repaint();
          },

          cancelPreview() {
            // Nothing to undo but the paint: a preview never wrote anywhere.
            if (get().preview === null) return;
            set({ preview: null });
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
            set({
              preview: null,
              global: theme,
              recents: noteRecentTheme(get().recents, theme.slug),
            });
            repaint();
            const result = await writeThrough("save the theme", () =>
              deps.gateway.setGlobal(theme),
            );
            if (result === null) {
              // Put the user back on the theme that is actually stored rather
              // than leaving them looking at one that isn't. `writeThrough`
              // has already surfaced the failure.
              set({ global: previous });
              repaint();
              return false;
            }
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
