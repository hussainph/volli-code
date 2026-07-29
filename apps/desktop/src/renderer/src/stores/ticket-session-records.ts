/**
 * The one shared cache of a ticket's DURABLE session records
 * (`api.sessions.listForTicket`), keyed by ticketId. `TicketSessionsPanel`
 * (the rail) and the exited-pane resume overlay (`session-split-layout.tsx`)
 * both need this list — the rail to render History rows, the overlay to know
 * whether a just-exited pane's own record is resumable (interrupt/resume,
 * issue #78) — and neither is guaranteed to be mounted whenever the other
 * needs fresh data (the rail unmounts when the rail is collapsed or terminal
 * focus is active). Centralizing the fetch here means every consumer reads
 * the same cache instead of each re-issuing `listForTicket` on its own.
 */
import { create } from "zustand";
import { errorMessage, type HarnessId, type SessionRecord } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";

interface TicketSessionRecordsState {
  /** ticketId → its durable session records, newest-first (mirrors `listTicketSessions`). */
  byTicket: Record<string, SessionRecord[]>;
  /** Re-fetches `ticketId`'s records from main and replaces the cached list. Toasts on failure. */
  refresh(ticketId: string): Promise<void>;
  /** Optimistic local rename ahead of the persist round-trip (mirrors the rail's prior behavior). */
  renameLocally(ticketId: string, sessionId: string, title: string): void;
  /**
   * Folds a wrapper announce into the cached record — main has already written
   * it, so this is a mirror rather than an optimistic guess. Without it the rail
   * keeps naming the harness that opened the terminal until something else
   * happens to refetch, which is the staleness the announce exists to end.
   */
  setActiveHarness(ticketId: string, sessionId: string, harnessId: HarnessId): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createTicketSessionRecordsStore() {
  return create<TicketSessionRecordsState>()((set) => ({
    byTicket: {},

    async refresh(ticketId) {
      try {
        const result = await window.api.sessions.listForTicket({ ticketId });
        if (!result.ok) {
          toastError(`Couldn't load sessions: ${result.error}`);
          return;
        }
        set((state) => ({ byTicket: { ...state.byTicket, [ticketId]: result.sessions } }));
      } catch (error) {
        toastError(`Couldn't load sessions: ${errorMessage(error)}`);
      }
    },

    renameLocally(ticketId, sessionId, title) {
      set((state) => {
        const records = state.byTicket[ticketId];
        if (records === undefined) return state;
        return {
          byTicket: {
            ...state.byTicket,
            [ticketId]: records.map((record) =>
              // Object.assign, not spread: oxc(no-map-spread) bans spreads in
              // map callbacks; a fresh target object keeps this copy-on-write.
              record.id === sessionId ? Object.assign({}, record, { title }) : record,
            ),
          },
        };
      });
    },

    setActiveHarness(ticketId, sessionId, harnessId) {
      set((state) => {
        const records = state.byTicket[ticketId];
        if (records === undefined) return state;
        return {
          byTicket: {
            ...state.byTicket,
            // `activeHarnessId`, never `harnessId`: the launch is history and
            // this is what is running. Object.assign for the same lint reason
            // the rename above gives.
            [ticketId]: records.map((record) =>
              record.id === sessionId
                ? Object.assign({}, record, { activeHarnessId: harnessId })
                : record,
            ),
          },
        };
      });
    },
  }));
}

export const useTicketSessionRecordsStore = createTicketSessionRecordsStore();
