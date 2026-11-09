/** Client appearance preferences. Additive app_state key; N−1 ignores it.
 * Typography is applied at boot, never added to the two-field first-paint hint.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { appStateStorage } from "@renderer/lib/app-state-storage";
import { useThemeStore } from "./theme";

type Style = "macos" | "modern";
const valid = (value: unknown): value is Style => value === "macos" || value === "modern";
interface StyleState {
  global: Style;
  projects: Record<string, Style>;
  motion: boolean;
  setStyle(style: Style | null, projectId?: string): void;
  setMotion(enabled: boolean): void;
}

export const useStyleStore = create<StyleState>()(
  persist(
    (set) => ({
      global: "macos",
      projects: {},
      motion: true,
      setStyle: (style, projectId) =>
        set((state) => {
          if (projectId === undefined) return { global: style ?? "macos" };
          const projects = { ...state.projects };
          if (style === null) delete projects[projectId];
          else projects[projectId] = style;
          return { projects };
        }),
      setMotion: (motion) => set({ motion }),
    }),
    {
      name: "volli:style",
      storage: createJSONStorage(() => appStateStorage),
      skipHydration: true,
      partialize: ({ global, projects, motion }) => ({ global, projects, motion }),
      merge: (persisted, current) => {
        const data = persisted as Partial<StyleState> | null;
        return {
          ...current,
          global: valid(data?.global) ? data.global : "macos",
          projects: Object.fromEntries(
            Object.entries(data?.projects ?? {}).filter(([, value]) => valid(value)),
          ),
          motion: data?.motion !== false,
        };
      },
    },
  ),
);

/** Called once after bootstrap has seeded app_state and selected a scope. */
export async function startStylePreferences(): Promise<void> {
  await useStyleStore.persist.rehydrate();
  const paint = () => {
    const state = useStyleStore.getState();
    const projectId = useThemeStore.getState().projectId;
    const style = (projectId === null ? undefined : state.projects[projectId]) ?? state.global;
    document.documentElement.style.setProperty(
      "--ui-font",
      style === "modern"
        ? '"Mona Sans Variable", system-ui, sans-serif'
        : "system-ui, -apple-system, sans-serif",
    );
    const motion = state.motion ? "on" : "off";
    if (document.documentElement.dataset.motion !== motion) {
      document.documentElement.dataset.motion = motion;
      window.dispatchEvent(new Event("volli-motion-change"));
    }
  };
  paint();
  useStyleStore.subscribe(paint);
  useThemeStore.subscribe((state, previous) => {
    if (state.projectId !== previous.projectId) paint();
  });
}
