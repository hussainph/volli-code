/**
 * One shared, push-fed cache of a project's Session listing rows.
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
 * Two surfaces now answer "what is running in this project?" — the sidebar's
 * Active band and the board's active-session indicator — and before this store
 * only the sidebar did, out of local component state it filled itself. A second
 * consumer would have meant a second `sessions.list` fetch on a second timer,
 * two answers to one question that could disagree for as long as their polls
 * were out of phase, and twice the IPC. `ticket-session-records.ts` is the same
 * argument already settled once, for a ticket's rows.
 *
 * ── WHY IT IS PUSHED, NOT POLLED ──────────────────────────────────────────
 * The sidebar used to re-read the whole listing every ten seconds, because chat
 * activity was the one Session fact main could not announce: a turn opening, a
 * question being asked and an attachment closing all happened over there and
 * moved nothing over here. Ten seconds is a long time to be told an agent is
 * idle while it is working.
 *
 * `volli:session-activity` closed that (`main/session-control/activity-watch.ts`):
 * main re-derives a Session's listing row whenever its durable history moves and
 * pushes the row — the same row the fetch returns, so applying one is an upsert
 * and never a translation. The fetch survives as the BASELINE only: a window
 * that has just opened has missed every push that came before it, so it reads
 * the listing once per project and lets the channel carry it from there.
 *
 * ── WHAT IT DOES NOT OWN ──────────────────────────────────────────────────
 * Terminal liveness. A PTY's working/idle is output recency, which the renderer
 * already learns first-hand through `volli:terminal-data` and keeps in
 * `stores/sessions.ts`; that is the freshest source in the process and this
 * store must never be read in preference to it. The rows here carry a
 * terminal's durable IDENTITY (title, harness, when it ended) — not its pulse.
 */
import { create } from "zustand";
import {
  errorMessage,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionProvenance,
  type SessionRecord,
} from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import type { SessionActivityNotice } from "../../../ipc/contract";

/** One project's rows, split into the two shapes every consumer wants them in. */
export interface ProjectSessionRows {
  terminal: readonly SessionRecord[];
  chat: readonly ChatSessionRecord[];
  /**
   * Who started each Session, keyed by Session id — and **sparse on purpose**
   * (VC-131). Provenance rides on the listing ROW rather than inside either
   * record (`SessionListingRow`), and this store keeps the two records and
   * discards the wrapper, so it needs one place to keep the fact.
   *
   * A map with a hole for the resting case, rather than an entry reading
   * `{ kind: "user" }` for every Session: a project where nobody has ever run
   * an Automation carries an empty object here, which is the same shape the
   * rail's "no persistent weight" criterion asks for said in data. Read it
   * through {@link sessionProvenanceOf}, which turns a miss back into the
   * resting answer.
   */
  provenance: Readonly<Record<string, SessionProvenance>>;
}

/**
 * One Session's provenance out of a sparse map — the resting case on a miss.
 *
 * Written once here rather than spelled `?? PERSON_STARTED` at each of the four
 * surfaces that draw a mark: the map's holes ARE the resting case, and a caller
 * that read the miss as "unknown" instead would be one `undefined` check away
 * from drawing a bolt on a Session nobody automated.
 */
export function sessionProvenanceOf(
  provenance: Readonly<Record<string, SessionProvenance>>,
  sessionId: string,
): SessionProvenance {
  return provenance[sessionId] ?? PERSON_STARTED;
}

export const EMPTY_PROJECT_SESSION_ROWS: ProjectSessionRows = {
  terminal: [],
  chat: [],
  provenance: {},
};

/** The Session id a listing row answers to, whichever shape it arrived in. */
function rowSessionId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

interface ProjectSessionsState {
  byProject: Readonly<Record<string, ProjectSessionRows>>;
  /**
   * Reads the whole listing for one project and replaces its rows.
   *
   * The baseline, not the heartbeat. Callers fire it when a window first shows
   * a project and when something outside the Session ledger could have changed
   * which rows exist at all (a ticket archived out from under them); the push
   * channel carries everything after that.
   */
  refresh(projectId: string): Promise<void>;
  /**
   * {@link refresh}, but at most once per project and never twice at a time.
   *
   * Two surfaces now need this project's rows and neither owns the other: the
   * sidebar's bands and the board's active-session indicator mount together and
   * would otherwise each issue the same baseline fetch on the same frame. The
   * guard is on the FETCH rather than on the result, because two calls racing
   * before the first resolves is exactly the shape the collision takes.
   */
  ensure(projectId: string): Promise<void>;
  /**
   * Folds one pushed row in, replacing any row with the same Session id.
   *
   * A notice for a project this store has never fetched is DROPPED rather than
   * seeding a partial project: a listing built from pushes alone would hold
   * only the Sessions that happened to move since the window opened, and a
   * consumer cannot tell that apart from a project with one Session in it. The
   * baseline fetch is what makes a project's rows complete, so nothing may
   * exist here before it lands.
   */
  applyActivity(notice: SessionActivityNotice): void;
  /**
   * Repoints one terminal row's running harness after a wrapper announce.
   *
   * Its own action rather than a push through {@link applyActivity} because a
   * harness announce is not a durable Session fact — it never moves the ledger,
   * so `activity-watch.ts` cannot see it, and without this the sidebar keeps
   * naming the harness a terminal was launched with after the user has quit it
   * and started another in the same shell.
   */
  setActiveHarness(projectId: string, sessionId: string, harnessId: string): void;
}

/** Replaces the row with `sessionId` in `rows`, or appends it. */
function upsert<Row>(
  rows: readonly Row[],
  row: Row,
  idOf: (row: Row) => string,
  sessionId: string,
): readonly Row[] {
  const index = rows.findIndex((candidate) => idOf(candidate) === sessionId);
  if (index === -1) return [...rows, row];
  return rows.map((candidate, at) => (at === index ? row : candidate));
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createProjectSessionsStore() {
  /**
   * Baseline fetches in flight, per project. Module-scope-per-store rather than
   * store state: nothing renders from it, and putting it in state would make
   * every consumer re-render twice per fetch for a fact none of them show.
   */
  const inFlight = new Map<string, Promise<void>>();

  return create<ProjectSessionsState>()((set, get) => ({
    byProject: {},

    async refresh(projectId) {
      try {
        const result = await window.api.sessions.list({ projectId });
        if (!result.ok) {
          toastError(`Couldn't load sessions: ${result.error}`);
          return;
        }
        const provenance: Record<string, SessionProvenance> = {};
        for (const row of result.sessions) {
          // Only a Session with something to say takes a slot. `user` is the
          // overwhelming majority and it says nothing, so it is stored as its
          // own absence — see `ProjectSessionRows.provenance`.
          if (row.provenance.kind !== "user") provenance[rowSessionId(row)] = row.provenance;
        }
        const rows: ProjectSessionRows = {
          terminal: result.sessions.flatMap((row) => (row.kind === "terminal" ? [row.record] : [])),
          chat: result.sessions.flatMap((row) => (row.kind === "chat" ? [row.record] : [])),
          provenance,
        };
        set((state) => ({ byProject: { ...state.byProject, [projectId]: rows } }));
      } catch (error) {
        toastError(`Couldn't load sessions: ${errorMessage(error)}`);
      }
    },

    ensure(projectId) {
      if (get().byProject[projectId] !== undefined) return Promise.resolve();
      const existing = inFlight.get(projectId);
      if (existing !== undefined) return existing;
      const pending = get()
        .refresh(projectId)
        .finally(() => inFlight.delete(projectId));
      inFlight.set(projectId, pending);
      return pending;
    },

    applyActivity(notice) {
      set((state) => {
        const current = state.byProject[notice.projectId];
        // See the action's doc: no baseline, no project.
        if (current === undefined) return state;
        const row = notice.row;
        // A Session can CROSS the two lists: it starts as a chat row and
        // becomes a terminal row the first time a terminal attaches to it
        // (`sessionListingRow`'s precedence). So the id is dropped from the
        // other list on every apply rather than only inserted into its own —
        // without that, one Session would be listed twice, once in each shape,
        // and the older shape would never move again.
        // Provenance is immutable — decided at birth, never rewritten — so a
        // push can only ever confirm what the baseline already had. It is still
        // folded rather than assumed, because the Session a push introduces may
        // be one the baseline fetch never saw: a Run started after this window
        // opened arrives here first, and dropping its mark would leave the
        // newest Run on the board as the one row with no bolt.
        const provenance =
          row.provenance.kind === "user"
            ? current.provenance
            : { ...current.provenance, [rowSessionId(row)]: row.provenance };
        const next: ProjectSessionRows =
          row.kind === "terminal"
            ? {
                terminal: upsert(
                  current.terminal,
                  row.record,
                  (record) => record.id,
                  row.record.id,
                ),
                chat: current.chat.filter((record) => record.sessionId !== row.record.id),
                provenance,
              }
            : {
                terminal: current.terminal.filter((record) => record.id !== row.record.sessionId),
                chat: upsert(
                  current.chat,
                  row.record,
                  (record) => record.sessionId,
                  row.record.sessionId,
                ),
                provenance,
              };
        return { byProject: { ...state.byProject, [notice.projectId]: next } };
      });
    },

    setActiveHarness(projectId, sessionId, harnessId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined) return state;
        let moved = false;
        // Object.assign, not spread: oxc(no-map-spread) bans spreads in map
        // callbacks. `moved` keeps an announce for a session this project does
        // not hold from minting a fresh array identity every consumer re-derives on.
        const terminal = current.terminal.map((record) => {
          if (record.id !== sessionId || record.activeHarnessId === harnessId) return record;
          moved = true;
          return Object.assign({}, record, { activeHarnessId: harnessId });
        });
        if (!moved) return state;
        return {
          byProject: {
            ...state.byProject,
            [projectId]: { terminal, chat: current.chat, provenance: current.provenance },
          },
        };
      });
    },
  }));
}

export const useProjectSessionsStore = createProjectSessionsStore();

/**
 * Wires the single `api.sessions.onActivity` subscription into the store.
 *
 * Mounted once from an always-mounted site, exactly as `subscribeHarnessEvents`
 * and `subscribeWorktreePhases` are and for the same reason: the pushes address
 * live state that outlives every surface reading it, and a per-surface
 * subscription would double-apply notices whenever two of them were mounted.
 *
 * Returns the unsubscribe function for the caller's effect cleanup.
 */
export function subscribeProjectSessionActivity(): () => void {
  return window.api.sessions.onActivity((notice) => {
    useProjectSessionsStore.getState().applyActivity(notice);
  });
}
