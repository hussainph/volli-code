/**
 * The one app-wide reading of the global Done-TTL (`retention.getTtlDays`).
 *
 * ── WHY A STORE ───────────────────────────────────────────────────────────
 * It is one setting, and it used to be read per surface: every ticket's
 * repository card read it on mount AND on every planning broadcast (the
 * "In Done for N+ days" line), and the Settings pane heard it again. Opening
 * tickets in a row spent one identical read per ticket for a number that
 * cannot vary between them (VC-373).
 *
 * One cache answers all of them. {@link RetentionTtlState.ensure} reads it at
 * most once — concurrent askers share the read, a landed value is never
 * re-read — and the settings write records the value main answered with
 * ({@link RetentionTtlState.adopt}), so the write IS the invalidation: main
 * clamps what it stores (`setRetentionTtlDays`), and adopting its answer keeps
 * every reader on the clamped truth without a second round trip.
 *
 * The value is not pushed: retention broadcasts (`{ kind: "retention" }`)
 * re-hydrate the board and move per-ticket retention STATE, but the days
 * setting itself changes only through the one settings write, which adopts.
 */
import { create } from "zustand";
import { errorMessage } from "@volli/shared";

import type { RetentionTtlResult } from "../../../ipc/contract";

interface RetentionTtlState {
  /** The setting in days, or `null` while it has never been read. */
  ttlDays: number | null;
  /**
   * Answers with the setting, reading it only when nothing has landed.
   *
   * Resolves main's outcome rather than swallowing it: the rail treats the
   * line as decoration and ignores a failure, while the Settings pane owns
   * the value and must still report a read that failed. A failed read leaves
   * the cache empty, so the next asker genuinely retries.
   */
  ensure(): Promise<RetentionTtlResult>;
  /** Records the value a settings write answered with — main's clamped days. */
  adopt(days: number): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createRetentionTtlStore() {
  /**
   * The one read in flight, if any. Module-local to the instance rather than
   * store state: nothing renders from it, and a promise must not outlive the
   * factory that made it.
   */
  let inFlight: Promise<RetentionTtlResult> | null = null;

  return create<RetentionTtlState>()((set, get) => ({
    ttlDays: null,

    ensure() {
      const landed = get().ttlDays;
      if (landed !== null) return Promise.resolve({ ok: true, days: landed });
      if (inFlight !== null) return inFlight;
      inFlight = (async (): Promise<RetentionTtlResult> => {
        try {
          const result = await window.api.retention.getTtlDays();
          if (result.ok) set({ ttlDays: result.days });
          return result;
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    adopt(days) {
      set({ ttlDays: days });
    },
  }));
}

export const useRetentionTtlStore = createRetentionTtlStore();
