/** Non-persisted UI state: which rail section the main view is showing. */
import { create } from "zustand";

export type NavKey = "board" | "sessions" | "files" | "settings";

interface UiState {
  activeNav: NavKey;
  setActiveNav(nav: NavKey): void;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: "board",
  setActiveNav: (nav) => set({ activeNav: nav }),
}));
