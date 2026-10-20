import { create } from "zustand";
import { isExperimentOn, useExperimentsStore } from "./experiments";

export interface HostModelTarget {
  readonly hostId: string;
  readonly hostName: string;
}

/** One picker, owned by HostsChrome while cloud is on. */
export const useHostModelSheet = create<{
  target: HostModelTarget | null;
  open(target: HostModelTarget): void;
  close(): void;
}>()((set) => ({
  target: null,
  open: (target) => {
    if (isExperimentOn(useExperimentsStore.getState().snapshot, "cloud")) set({ target });
  },
  close: () => set({ target: null }),
}));
