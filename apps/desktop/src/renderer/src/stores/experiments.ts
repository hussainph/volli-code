/**
 * The renderer's projection of the host's experiment registry (VC-576).
 *
 * The host owns the flags (`settings.experiments`, `main/experiments.ts`); this
 * store only holds the last snapshot it answered, so a surface behind a flag can
 * ask "is `cloud` on?" without a fetch of its own. Two writers, both the host's
 * own answer: the first read (`ensure`, on the first flagged surface to mount)
 * and Settings → Experimental, which hands over the snapshot every save returns
 * so a flag flips live.
 *
 * Until an answer lands every flag reads OFF. That is the safe direction: a
 * flagged surface that appears a beat late is invisible to a person with the
 * flag off, and one that appeared on a guess would not be.
 *
 * A failed read is kept off and logged, never toasted. Nobody asked for this
 * read — it is the app checking whether to draw something — so there is no
 * person waiting on it and nothing a toast could ask them to do (CLAUDE.md's
 * one exception to surfacing failures). Opening Settings retries a failed boot
 * read; Settings → Experimental reports its own page-read failures.
 */
import { create } from "zustand";
import {
  errorMessage,
  EXPERIMENTS,
  type ExperimentId,
  type ExperimentSnapshot,
} from "@volli/shared";

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

export interface ExperimentsState {
  /** The host's last answer; `null` until one lands. */
  snapshot: ExperimentSnapshot | null;
  /** Shares an in-flight or successful read; a failed read can be retried. */
  ensure(): Promise<void>;
  /** Adopts a snapshot the host just answered (Settings → Experimental's saves). */
  receive(snapshot: ExperimentSnapshot): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createExperimentsStore(
  read: () => Promise<ExperimentSnapshot> = () => sessionRpcClient().settings.experiments.query(),
) {
  let pending: Promise<void> | null = null;
  return create<ExperimentsState>()((set, get) => ({
    snapshot: null,
    ensure() {
      if (pending !== null) return pending;
      pending = (async () => {
        try {
          const snapshot = await read();
          // A save that landed while the read was in flight is newer than it.
          if (get().snapshot === null) set({ snapshot });
        } catch (error) {
          console.warn("[volli] Couldn't read experiments:", errorMessage(error));
        }
      })().finally(() => {
        if (get().snapshot === null) pending = null;
      });
      return pending;
    },
    receive(snapshot) {
      set({ snapshot });
    },
  }));
}

/** The app's one experiments store. */
export const useExperimentsStore = createExperimentsStore();

/** Settings visibility comes from the host, never the client's build or stored intent. */
export function hasVisibleExperiments(snapshot: ExperimentSnapshot | null): boolean {
  return snapshot !== null && EXPERIMENTS.some(({ id }) => snapshot[id].visible !== false);
}

/** Whether a flag is on, per the host's last answer. Off until one lands. */
export function isExperimentOn(snapshot: ExperimentSnapshot | null, id: ExperimentId): boolean {
  return snapshot?.[id].enabled === true;
}
