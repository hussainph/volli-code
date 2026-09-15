/**
 * The one shared cache of a ticket's Session listing rows
 * (`api.sessions.listForTicket`), keyed by ticketId. `TicketSessionsPanel`
 * (the rail) and the exited-pane resume overlay (`session-split-layout.tsx`)
 * both need this list — the rail to render History rows, the overlay to know
 * whether a just-exited pane's own record is resumable (interrupt/resume,
 * issue #78) — and neither is guaranteed to be mounted whenever the other
 * needs fresh data (the rail unmounts when the rail is collapsed or terminal
 * focus is active). Centralizing the fetch here means every consumer reads
 * the same cache instead of each re-issuing `listForTicket` on its own.
 *
 * ── WHY THE FETCH IS THE BASELINE ONLY (VC-373) ───────────────────────────
 * Main already pushes the answer: `volli:session-activity` carries
 * `{ projectId, ticketId, row }` for every durable Session change
 * (`main/session-control/activity-watch.ts`), and this store subscribes to it
 * ({@link subscribeTicketSessionActivity}) exactly as `stores/project-sessions.ts`
 * does. A create, a split, a rename, an exit and an agent's own turn all land
 * here as an upsert within a frame or two. So the fetch survives as the
 * BASELINE only — a window that has just opened has missed every push that
 * came before it — and {@link TicketSessionRecordsState.ensure} reads it once
 * per ticket while a door that genuinely needs a re-read asks
 * {@link TicketSessionRecordsState.refresh}, which never issues a second read
 * while one for the same ticket is in flight.
 */
import { create } from "zustand";
import { errorMessage, type HarnessId, type SessionListingRow } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import type { SessionActivityNotice } from "../../../ipc/contract";

/** The Session id a listing row answers to, whichever shape it arrived in. */
function rowSessionId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

interface TicketSessionRecordsState {
  /** ticketId → its Session listing rows, newest-first (mirrors `listTicketSessions`). */
  byTicket: Record<string, SessionListingRow[]>;
  /** Re-fetches `ticketId`'s rows from main and replaces the cached list. Toasts on failure. */
  refresh(ticketId: string): Promise<void>;
  /**
   * {@link refresh}, but only for a ticket this cache has never read.
   *
   * The mount baseline: a window that has just opened has missed every push,
   * so a ticket's rows are read once and `volli:session-activity` carries the
   * list from there. A second mount — a rail page flip, a ticket re-open —
   * paints from the same cache without re-asking main, and a read already in
   * flight for the ticket is shared rather than repeated.
   */
  ensure(ticketId: string): Promise<void>;
  /**
   * Folds one pushed row in, replacing any row with the same Session id.
   *
   * A notice for a ticket this cache has never read is DROPPED rather than
   * seeding a partial ticket, the same rule `project-sessions.applyActivity`
   * states for a project: a listing built from pushes alone would hold only
   * the Sessions that happened to move since the window opened, and a consumer
   * cannot tell that apart from a ticket with one Session in it. The baseline
   * read is what makes a ticket's rows complete, so nothing may exist here
   * before it lands.
   *
   * The id is compared across KINDS as well as within one: a Session can cross
   * from a chat row to a terminal row the first time a terminal attaches to it
   * (`sessionListingRow`'s precedence), so the incoming row replaces whatever
   * shape sat at that id rather than being added beside it.
   */
  applyActivity(notice: SessionActivityNotice): void;
  /**
   * Optimistic local rename ahead of the persist round-trip, for a row of
   * either kind — `title` is the one field both records carry, and both kinds
   * rename from the same surfaces (`renameTerminalSession`, `renameChatSession`).
   * The rewrite stays inside the matched row's own kind: a chat row is retitled
   * as a chat row, never coerced into the terminal shape beside it.
   */
  renameLocally(ticketId: string, sessionId: string, title: string): void;
  /**
   * Folds a wrapper announce into the cached record — main has already written
   * it, so this is a mirror rather than an optimistic guess. Without it the rail
   * keeps naming the harness that opened the terminal until something else
   * happens to refetch, which is the staleness the announce exists to end.
   * Terminal rows only — `activeHarnessId` is a PTY-wrapper fact a chat row's
   * `ChatSessionRecord` has no field for.
   */
  setActiveHarness(ticketId: string, sessionId: string, harnessId: HarnessId): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createTicketSessionRecordsStore() {
  /**
   * Reads in flight, per ticket. Module-scope-per-store rather than store state:
   * nothing renders from it, and putting it in state would re-render every
   * consumer twice per read for a fact none of them show. `TicketDetail` and
   * the rail both ask on the same frame a ticket opens, which is exactly the
   * collision this collapses.
   */
  const inFlight = new Map<string, Promise<void>>();

  return create<TicketSessionRecordsState>()((set, get) => ({
    byTicket: {},

    refresh(ticketId) {
      const existing = inFlight.get(ticketId);
      if (existing !== undefined) return existing;
      const pending = (async () => {
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
      })().finally(() => inFlight.delete(ticketId));
      inFlight.set(ticketId, pending);
      return pending;
    },

    ensure(ticketId) {
      // A landed entry is the whole answer, however it landed (a baseline read
      // or a push); the channel carries it from here. `refresh` itself shares
      // any read already in flight, so a cold `ensure` racing another asker is
      // one read.
      if (get().byTicket[ticketId] !== undefined) return Promise.resolve();
      return get().refresh(ticketId);
    },

    applyActivity(notice) {
      const ticketId = notice.ticketId;
      // A Board Session's row belongs to no ticket cache — see the action's doc.
      if (ticketId === null) return;
      set((state) => {
        const rows = state.byTicket[ticketId];
        if (rows === undefined) return state;
        const id = rowSessionId(notice.row);
        const index = rows.findIndex((row) => rowSessionId(row) === id);
        return {
          byTicket: {
            ...state.byTicket,
            [ticketId]:
              index === -1
                ? [notice.row, ...rows]
                : rows.map((row, at) => (at === index ? notice.row : row)),
          },
        };
      });
    },

    renameLocally(ticketId, sessionId, title) {
      set((state) => {
        const rows = state.byTicket[ticketId];
        if (rows === undefined) return state;
        return {
          byTicket: {
            ...state.byTicket,
            // Object.assign, not spread: oxc(no-map-spread) bans spreads in map
            // callbacks; a fresh target object keeps this copy-on-write. Each
            // kind is rebuilt as itself — the id it answers to differs (`id` vs
            // `sessionId`) and so does everything else on the record.
            [ticketId]: rows.map((row) => {
              // `usage` and `provenance` are carried across untouched on every
              // rebuilt row. One is a measurement of what the Session spent and
              // the other is who started it; renaming a Session or re-reading
              // its harness changes neither. Dropping `provenance` here would
              // take a Run's bolt off the row the moment somebody retitled it.
              if (row.kind === "chat") {
                return row.record.sessionId === sessionId
                  ? {
                      kind: "chat" as const,
                      record: Object.assign({}, row.record, { title }),
                      usage: row.usage,
                      provenance: row.provenance,
                    }
                  : row;
              }
              return row.record.id === sessionId
                ? {
                    kind: "terminal" as const,
                    record: Object.assign({}, row.record, { title }),
                    usage: row.usage,
                    provenance: row.provenance,
                  }
                : row;
            }),
          },
        };
      });
    },

    setActiveHarness(ticketId, sessionId, harnessId) {
      set((state) => {
        const rows = state.byTicket[ticketId];
        if (rows === undefined) return state;
        return {
          byTicket: {
            ...state.byTicket,
            // `activeHarnessId`, never `harnessId`: the launch is history and
            // this is what is running. Object.assign for the same lint reason
            // the rename above gives.
            [ticketId]: rows.map((row) =>
              row.kind === "terminal" && row.record.id === sessionId
                ? {
                    kind: "terminal" as const,
                    record: Object.assign({}, row.record, { activeHarnessId: harnessId }),
                    usage: row.usage,
                    provenance: row.provenance,
                  }
                : row,
            ),
          },
        };
      });
    },
  }));
}

export const useTicketSessionRecordsStore = createTicketSessionRecordsStore();

/**
 * Wires the single `api.sessions.onActivity` subscription into this store.
 *
 * Mounted once from an always-mounted site, exactly as
 * `subscribeProjectSessionActivity` is and for the same reason: the pushes
 * address a cache that outlives every surface reading it — the rail unmounts
 * whenever it is collapsed or another rail page is in front, and the store
 * must still fold in what happened while it was gone.
 *
 * Returns the unsubscribe function for the caller's effect cleanup.
 */
export function subscribeTicketSessionActivity(): () => void {
  return window.api.sessions.onActivity((notice) => {
    useTicketSessionRecordsStore.getState().applyActivity(notice);
  });
}
