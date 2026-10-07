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
 * (`packages/host-core/src/session-control/activity-watch.ts`), and this store subscribes to it
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
import {
  errorMessage,
  sessionReadStateOf,
  type HarnessId,
  type SessionListingRow,
  type SessionReadState,
} from "@volli/shared";

import { sessionListingReaderForTicket } from "@renderer/lib/session-listing-reader";
import { toastError } from "@renderer/lib/toast";
import type { SessionActivityNotice } from "../../../ipc/contract";
import type { ListingRefreshOptions } from "./project-sessions";
import { markSessionRead } from "./session-read-mark";

/** The Session id a listing row answers to, whichever shape it arrived in. */
function rowSessionId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

/** One row's read state, with the resting answer for a row that carries none. */
export function sessionRowReadState(
  rows: readonly SessionListingRow[] | undefined,
  sessionId: string,
): SessionReadState {
  return sessionReadStateOf(rows?.find((row) => rowSessionId(row) === sessionId)?.read);
}

/** Whether one ticket's baseline roster is still on its way, usable, or unavailable. */
export type TicketSessionListingState = "loading" | "loaded" | "failed";

/**
 * The request state a ticket-roster reader needs alongside its rows.
 *
 * A few callers can seed rows directly while restoring an already-known
 * Session, so an array without a recorded state is still a landed answer rather
 * than permission to paint a skeleton over it. Every read this store owns
 * writes both facts together; this fallback only keeps that handoff honest.
 */
export function ticketSessionListingStateOf(
  state: {
    byTicket: Readonly<Record<string, readonly SessionListingRow[]>>;
    listingState?: Readonly<Record<string, TicketSessionListingState>>;
  },
  ticketId: string,
): TicketSessionListingState {
  return (
    state.listingState?.[ticketId] ??
    (state.byTicket[ticketId] === undefined ? "loading" : "loaded")
  );
}

export interface TicketSessionRecordsState {
  /** ticketId → its Session listing rows, newest-first (mirrors `listTicketSessions`). */
  byTicket: Record<string, SessionListingRow[]>;
  /** The baseline outcome per ticket; absent means no read has been requested. */
  listingState: Readonly<Record<string, TicketSessionListingState>>;
  /** The latest failed baseline's detail, cleared when a read starts or lands. */
  listingError: Readonly<Record<string, string | null>>;
  /** Re-fetches `ticketId`'s rows from main and replaces the cached list. Toasts on failure. */
  refresh(ticketId: string, options?: ListingRefreshOptions): Promise<void>;
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
  /**
   * Marks one of this ticket's Sessions read or unread (VC-30) — the rail's own
   * door to the same receipt the sidebar writes.
   *
   * Optimistic, like `renameLocally` above and for the same reason: nothing
   * else moves these rows until main publishes, so the dot has to answer the
   * keypress locally. A refused write puts the old state back and toasts
   * (AGENTS.md: surface every failed mutation), and the authoritative row
   * arrives on `volli:session-activity` for every window.
   */
  setSessionRead(ticketId: string, sessionId: string, unread: boolean): Promise<void>;
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
    listingState: {},
    listingError: {},

    refresh(ticketId, options = {}) {
      const existing = inFlight.get(ticketId);
      if (existing !== undefined) return existing;
      const quiet = options.quiet === true;
      // VC-383's roster has four facts, not one convenient `undefined` test:
      // no entry has never been read, `loading` owns the skeleton, `loaded`
      // earns an empty sentence, and `failed` must stand the skeleton down.
      // Keeping this beside the rows makes the distinction reusable by another
      // client instead of re-derived by every JSX consumer.
      // A quiet read (VC-713: a remote ticket's poll, focus or reconnect
      // re-read) keeps the rows on screen while it runs and, failing, keeps
      // them and says nothing: nobody is waiting on it, and the next is due.
      if (!quiet || ticketSessionListingStateOf(get(), ticketId) !== "loaded") {
        set((state) => ({
          listingState: { ...state.listingState, [ticketId]: "loading" },
          listingError: { ...state.listingError, [ticketId]: null },
        }));
      }
      const failed = (message: string): void => {
        if (quiet && ticketSessionListingStateOf(get(), ticketId) === "loaded") return;
        if (!quiet) toastError(`Couldn't load sessions: ${message}`);
        set((state) => ({
          listingState: { ...state.listingState, [ticketId]: "failed" },
          listingError: { ...state.listingError, [ticketId]: message },
        }));
      };
      const pending = (async () => {
        try {
          const result = await sessionListingReaderForTicket(ticketId).listForTicket({ ticketId });
          if (!result.ok) {
            failed(result.error);
            return;
          }
          set((state) => ({
            byTicket: { ...state.byTicket, [ticketId]: result.sessions },
            listingState: { ...state.listingState, [ticketId]: "loaded" },
            listingError: { ...state.listingError, [ticketId]: null },
          }));
        } catch (error) {
          failed(errorMessage(error));
        }
      })().finally(() => inFlight.delete(ticketId));
      inFlight.set(ticketId, pending);
      return pending;
    },

    ensure(ticketId) {
      // Only a successful baseline is warm. A failed read deliberately remains
      // retryable on the next caller; `inFlight` still shares callers that all
      // arrive on that frame, without a timer or an automatic retry loop.
      if (ticketSessionListingStateOf(get(), ticketId) === "loaded") return Promise.resolve();
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
              // The row is copied WHOLE and only its record replaced, so every
              // field beside it rides across untouched: `usage` is what the
              // Session spent, `provenance` is who started it, `read` (VC-30)
              // is whether anybody has seen its last turn — renaming a Session
              // or re-reading its harness changes none of the three. Copying
              // rather than re-listing the fields is also what keeps `read`'s
              // ABSENCE intact: its resting state is the missing key, and a
              // hand-written `read: row.read` would put `undefined` on a row
              // main published without one.
              if (row.kind === "chat") {
                return row.record.sessionId === sessionId
                  ? Object.assign({}, row, {
                      record: Object.assign({}, row.record, { title }),
                    })
                  : row;
              }
              return row.record.id === sessionId
                ? Object.assign({}, row, { record: Object.assign({}, row.record, { title }) })
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
                ? Object.assign({}, row, {
                    record: Object.assign({}, row.record, { activeHarnessId: harnessId }),
                  })
                : row,
            ),
          },
        };
      });
    },

    setSessionRead(ticketId, sessionId, unread) {
      // Shared with the project listing through `session-read-mark.ts`: the
      // optimistic stamp, the toast and the conditional revert are one rule,
      // and this store contributes only how a row is read and written here.
      return markSessionRead(
        { sessionId, unread },
        {
          readState: () => sessionRowReadState(get().byTicket[ticketId], sessionId),
          write: (read) => {
            set((state) => {
              const rows = state.byTicket[ticketId];
              if (rows === undefined) return state;
              return {
                byTicket: {
                  ...state.byTicket,
                  [ticketId]: rows.map((row) => {
                    if (rowSessionId(row) !== sessionId) return row;
                    const marked = read.unreadSince === null ? {} : { read };
                    // Object.assign, not a spread in a map callback (the lint
                    // rule `renameLocally` above records), and the key is
                    // DELETED rather than set to undefined when a Session is
                    // read: absence is the resting state everywhere else in
                    // this row's life.
                    const { read: _dropped, ...rest } = row;
                    return Object.assign({}, rest, marked) as SessionListingRow;
                  }),
                },
              };
            });
          },
        },
      );
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
