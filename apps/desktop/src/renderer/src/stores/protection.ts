/**
 * The Protection experiment's switch, as the renderer reads it (VC-480).
 *
 * One app-wide boolean that main owns (`volli:protection-get`/`-set`). While it
 * is on, Configure's Authority entry draws the simple Protection page in its
 * place; while it is off, nothing anywhere changes. It is read at most once per
 * renderer: whoever asks first pays for the read, everyone after shares it, and
 * a write records the value main answered with rather than reading again.
 *
 * `enabled` is `null` until the read lands. Readers that only need "is the
 * experiment on" use {@link useProtectionExperiment}, which treats an unread
 * flag as off — the old surface is the safe one to draw while waiting.
 */
import * as React from "react";
import { create } from "zustand";

import { writeThrough } from "@renderer/stores/mutate";

interface ProtectionState {
  /** Whether the experiment is on, or `null` until the first read lands. */
  enabled: boolean | null;
  /**
   * Reads the switch unless it has already landed. Concurrent callers share
   * one read; a failed read is toasted and leaves `enabled` null.
   */
  load(): Promise<void>;
  /** Writes the switch. Resolves whether main accepted it; a refusal is toasted. */
  setEnabled(next: boolean): Promise<boolean>;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createProtectionStore() {
  /** The one read in flight, if any. Nothing renders from it. */
  let inFlight: Promise<void> | null = null;

  return create<ProtectionState>()((set, get) => ({
    enabled: null,

    load() {
      if (get().enabled !== null) return Promise.resolve();
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        const result = await writeThrough("read the Protection setting", () =>
          window.api.protection.get(),
        );
        // A write that landed while this read was in flight is newer than it.
        if (result !== null && get().enabled === null) set({ enabled: result.enabled });
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async setEnabled(next) {
      const result = await writeThrough(next ? "turn Protection on" : "turn Protection off", () =>
        window.api.protection.set(next),
      );
      if (result === null) return false;
      set({ enabled: result.enabled });
      return true;
    },
  }));
}

export const useProtectionStore = createProtectionStore();

/** The switch as stored, reading it on first use. `null` while unread. */
export function useProtectionSetting(): boolean | null {
  const enabled = useProtectionStore((store) => store.enabled);
  React.useEffect(() => {
    if (enabled === null) void useProtectionStore.getState().load();
  }, [enabled]);
  return enabled;
}

/** Whether the Protection experiment is on. False until the switch has been read. */
export function useProtectionExperiment(): boolean {
  return useProtectionSetting() === true;
}
