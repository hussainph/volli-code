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
 * `volli:session-activity` closed that (`packages/host-core/src/session-control/activity-watch.ts`):
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
  isListableSession,
  isSessionUnread,
  sessionReadStateOf,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionProvenance,
  type SessionReadState,
  type SessionRecord,
} from "@volli/shared";

import { sessionListingReaderForProject } from "@renderer/lib/session-listing-reader";
import { toastError } from "@renderer/lib/toast";
import type { SessionActivityNotice } from "../../../ipc/contract";
import { markSessionRead } from "./session-read-mark";
import { launchStore } from "./launch";

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
   * through `sessionProvenanceOf` (`@volli/shared`), which turns a miss back
   * into the resting answer.
   */
  provenance: Readonly<Record<string, SessionProvenance>>;
  /**
   * Which Sessions have unread work, keyed by Session id — sparse for exactly
   * the reason `provenance` above is (VC-30). Unread rides on the listing ROW
   * and this store keeps the records rather than the wrapper, so the fact needs
   * one place to live; a project where every Session has been seen carries an
   * empty object here, which is what the resting case should cost.
   *
   * OPTIONAL, unlike `provenance`, because rows seeded from elsewhere (the lab,
   * a restore of a known Session) predate it and a missing map must read as
   * "nothing unread" rather than "unknown". Read it through {@link sessionReadOf}
   * or {@link unreadSessionIds}, never directly.
   */
  read?: Readonly<Record<string, SessionReadState>>;
}

export const EMPTY_PROJECT_SESSION_ROWS: ProjectSessionRows = {
  terminal: [],
  chat: [],
  provenance: {},
  read: {},
};

/** One Session's read state, with the resting answer for a Session nobody marked. */
export function sessionReadOf(
  rows: ProjectSessionRows | undefined,
  sessionId: string,
): SessionReadState {
  return sessionReadStateOf(rows?.read?.[sessionId]);
}

/**
 * Every Session in this project with unread work (VC-30).
 *
 * The shape both sidebars want: membership rules ask "is this one of them"
 * rather than "how long has it been", and a set keeps the sparse map from
 * leaking into every consumer.
 */
export function unreadSessionIds(rows: ProjectSessionRows | undefined): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const [sessionId, read] of Object.entries(rows?.read ?? {})) {
    if (isSessionUnread(read)) unread.add(sessionId);
  }
  return unread;
}

/** Whether a project's baseline listing is still in flight, usable, or failed. */
export type ProjectSessionListingState = "loading" | "loaded" | "failed";

/**
 * Whether a surface must hold the project's Session rows rather than explain
 * them. `undefined` is deliberately pending: it means the baseline has never
 * been requested, not that a Project has no agents. Home and the sidebar share
 * this selector so VC-383 cannot leave one surface honest while the other turns
 * the same unread listing into an empty sentence.
 */
export function projectSessionListingPending(
  listingState: ProjectSessionListingState | undefined,
): boolean {
  return listingState === undefined || listingState === "loading";
}

/**
 * The chat rows a surface may DRAW as a listing (VC-279) — every one except a
 * Subagent Session, which is reached from the chat that delegated it.
 *
 * ── THE ROWS ARE COMPLETE, THE LISTINGS ARE NOT ───────────────────────────
 * This cache holds every child on purpose, and most of its consumers want them.
 * A new surface reading `rows.chat` is choosing between two questions, so here
 * is what each existing one chose and why:
 *
 *  - DRAWS ROWS, so it narrows: Home's Sessions page (`home-rail.tsx`).
 *  - DRAWS ROWS but takes them WHOLE: the sidebar's bands
 *    (`active-sessions.tsx`). It narrows inside `buildActiveSessionListing`,
 *    because it first reads the children to keep a parent that is only busy
 *    through them out of the quiet band — a listing that was handed the
 *    filtered rows could not see the work it is describing.
 *  - NEEDS THE CHILDREN: the board's rings (a working child lights its
 *    Ticket), the island's own feed (`use-island-agents.ts`), the usage count
 *    (a child spent real money), Home's tab restore (a promoted child is a tab
 *    that must survive a relaunch), and `childSessionIds` below.
 *
 * A model that already applies the rule keeps applying it — ⌘K and the ticket
 * rail read their rows from elsewhere entirely, so the guarantee cannot live
 * at this door alone. This is the door, not the only lock.
 */
export function listableChats(rows: ProjectSessionRows | undefined): readonly ChatSessionRecord[] {
  return (rows?.chat ?? []).filter((record) => isListableSession(record));
}

/**
 * The Sessions one Session started (VC-183's `session_start`, VC-9's
 * `delegate`), read off the listing's provenance: a child is a row whose
 * provenance names `sessionId` as its parent. In listing order, which is the
 * order the sidebar shows them.
 */
export function childSessionIds(
  rows: ProjectSessionRows | undefined,
  sessionId: string,
): ReadonlySet<string> {
  const children = new Set<string>();
  if (rows === undefined) return children;
  for (const chat of rows.chat) {
    const provenance = rows.provenance[chat.sessionId];
    if (provenance?.kind === "session" && provenance.parentSessionId === sessionId) {
      children.add(chat.sessionId);
    }
  }
  return children;
}

/** A chat Session's title from the listing, or null for one it does not carry. */
export function sessionTitleOf(
  rows: ProjectSessionRows | undefined,
  sessionId: string,
): string | null {
  return rows?.chat.find((chat) => chat.sessionId === sessionId)?.title ?? null;
}

/** The Session id a listing row answers to, whichever shape it arrived in. */
function rowSessionId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

/**
 * Every named project's rows as one global listing.
 *
 * The command palette is the app's one cross-project Session surface, and it
 * used to build this list from its own `sessions.list` call per project on
 * every single open (VC-385). That is the question this store already holds
 * the answer to, pushed and kept fresh, so the palette reads the cache and
 * folds it here instead.
 *
 * A project with no entry contributes nothing rather than an empty project:
 * "not read yet" and "has no Sessions" stay different, exactly as
 * `listingState` keeps them apart for every other consumer.
 */
export function mergedProjectSessionRows(
  byProject: Readonly<Record<string, ProjectSessionRows>>,
  projectIds: readonly string[],
): ProjectSessionRows {
  const terminal: SessionRecord[] = [];
  const chat: ChatSessionRecord[] = [];
  const provenance: Record<string, SessionProvenance> = {};
  const read: Record<string, SessionReadState> = {};
  for (const projectId of projectIds) {
    const rows = byProject[projectId];
    if (rows === undefined) continue;
    terminal.push(...rows.terminal);
    chat.push(...rows.chat);
    Object.assign(provenance, rows.provenance);
    Object.assign(read, rows.read ?? {});
  }
  return { terminal, chat, provenance, read };
}

interface ProjectSessionsState {
  byProject: Readonly<Record<string, ProjectSessionRows>>;
  /** Baseline outcome by project; absent means no listing has been requested. */
  listingState: Readonly<Record<string, ProjectSessionListingState>>;
  /**
   * Reads the whole listing for one project and replaces its rows.
   *
   * The baseline, not the heartbeat. Callers fire it when a window first shows
   * a project and when something outside the Session ledger could have changed
   * which rows exist at all (a ticket archived out from under them); the push
   * channel carries everything after that.
   */
  refresh(projectId: string, options?: ListingRefreshOptions): Promise<void>;
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
   * {@link applyActivity} for several notices in one store write (VC-1078).
   *
   * Every `byProject` reader re-derives on a write, and the sidebar's listing
   * walks the whole project per derivation, so a burst of pushes must cost one
   * write, not one each. Notices fold in order, so a later row for a Session
   * wins. A notice that changes nothing — the same row pushed again — keeps
   * every identity, and a batch of nothing but those writes nothing at all.
   */
  applyActivities(notices: readonly SessionActivityNotice[]): void;
  /** Ephemeral exact-Session views can follow the shared intake without
   * manufacturing an incomplete project baseline or another host subscription. */
  subscribeActivity(listener: (notice: SessionActivityNotice) => void): () => void;
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
  /**
   * Marks one Session read or unread (VC-30).
   *
   * Optimistic: the local map moves first so the dot answers the keypress in
   * the same frame, then the receipt is persisted. A failure puts the old state
   * back and toasts (AGENTS.md: surface every failed mutation) — the optimistic
   * write is the only thing moving this dot, so a refused write would otherwise
   * leave every sidebar asserting a receipt main does not have.
   *
   * The authoritative answer arrives afterwards as an ordinary
   * `volli:session-activity` upsert, which is also how the OTHER window learns.
   */
  setSessionRead(projectId: string, sessionId: string, unread: boolean): Promise<void>;
}

/**
 * How a listing read behaves (VC-713). `quiet` is a read nobody asked for —
 * the remote listing's poll, focus or reconnect re-read: it keeps the rows on
 * screen while it runs (no skeleton) and, failing, keeps them and says nothing,
 * since the next read is already scheduled and no person is waiting on it.
 */
export interface ListingRefreshOptions {
  quiet?: boolean;
}

/**
 * Whether two JSON-safe values say the same thing. A pushed row arrives
 * through structured clone, so it is a new object even when nothing moved;
 * this is what lets a repeat push keep the identity every reader memoises on.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(
    (key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]),
  );
}

/** A row's record, with the one field that moves on every durable fact set aside. */
function withoutRecency(record: SessionRecord | ChatSessionRecord): Record<string, unknown> {
  const { lastActivityAt: _recency, ...rest } = record;
  return rest;
}

/** The read stamp a row asks this store to keep, or `undefined` for the resting case. */
function pushedReadOf(row: SessionListingRow): SessionReadState | undefined {
  return isSessionUnread(row.read) ? sessionReadStateOf(row.read) : undefined;
}

/**
 * What one pushed row would change in a project's rows (VC-1078):
 *
 *  - `none` — the row says what the store already holds;
 *  - `recency` — it differs only in `lastActivityAt`, which a Session mid-turn
 *    moves on every durable fact it writes (up to ~16 times a second) and
 *    which moves no band, no group and no word the sidebar draws;
 *  - `material` — anything else: activity, attention, a title, read state, a
 *    Session the rows have not seen, or one crossing between the two lists.
 */
type ActivityChange = "none" | "recency" | "material";

function activityChangeOf(
  rows: ProjectSessionRows | undefined,
  notice: SessionActivityNotice,
): ActivityChange {
  if (rows === undefined) return "material";
  const row = notice.row;
  const sessionId = rowSessionId(row);
  if (row.provenance.kind !== "user" && !sameJson(rows.provenance[sessionId], row.provenance)) {
    return "material";
  }
  if (!sameJson(rows.read?.[sessionId], pushedReadOf(row))) return "material";
  const held: SessionRecord | ChatSessionRecord | undefined =
    row.kind === "terminal"
      ? rows.terminal.find((record) => record.id === sessionId)
      : rows.chat.find((record) => record.sessionId === sessionId);
  if (held === undefined) return "material";
  if (held.lastActivityAt === row.record.lastActivityAt && sameJson(held, row.record)) {
    return "none";
  }
  return sameJson(withoutRecency(held), withoutRecency(row.record)) ? "recency" : "material";
}

/**
 * Folds pushed rows into one project's rows, copying only what moves.
 *
 * Each array and map is copied at most once per batch, and only if a notice
 * actually changes it; a record that arrives equal to the one held keeps the
 * held object. Rows are replaced IN PLACE, so a Session's position in its list
 * never depends on how often it pushes — a Session the rows never saw is
 * appended, exactly as before.
 */
function foldActivity(
  current: ProjectSessionRows,
  notices: readonly SessionActivityNotice[],
): ProjectSessionRows {
  let terminal = current.terminal;
  let chat = current.chat;
  let provenance = current.provenance;
  let read = current.read;
  let ownTerminal: SessionRecord[] | null = null;
  let ownChat: ChatSessionRecord[] | null = null;
  let ownProvenance: Record<string, SessionProvenance> | null = null;
  let ownRead: Record<string, SessionReadState> | null = null;
  let moved = false;

  const terminalCopy = (): SessionRecord[] => {
    ownTerminal ??= [...terminal];
    terminal = ownTerminal;
    moved = true;
    return ownTerminal;
  };
  const chatCopy = (): ChatSessionRecord[] => {
    ownChat ??= [...chat];
    chat = ownChat;
    moved = true;
    return ownChat;
  };

  for (const { row } of notices) {
    const sessionId = rowSessionId(row);
    // Provenance is immutable — decided at birth, never rewritten — so a
    // push can only ever confirm what the baseline already had. It is still
    // folded rather than assumed, because the Session a push introduces may
    // be one the baseline fetch never saw: a Run started after this window
    // opened arrives here first, and dropping its mark would leave the
    // newest Run on the board as the one row with no bolt.
    if (row.provenance.kind !== "user" && !sameJson(provenance[sessionId], row.provenance)) {
      ownProvenance ??= { ...provenance };
      ownProvenance[sessionId] = row.provenance;
      provenance = ownProvenance;
      moved = true;
    }
    // Unread, unlike provenance, MOVES: a turn ending makes a Session
    // unread and opening it makes it read again, and both arrive here. So
    // the pushed row is the whole answer for that Session — a resting one
    // must clear the entry rather than leave the old stamp standing.
    const pushedRead = pushedReadOf(row);
    if (!sameJson(read?.[sessionId], pushedRead)) {
      ownRead ??= { ...read };
      if (pushedRead === undefined) delete ownRead[sessionId];
      else ownRead[sessionId] = pushedRead;
      read = ownRead;
      moved = true;
    }
    // A Session can CROSS the two lists: it starts as a chat row and
    // becomes a terminal row the first time a terminal attaches to it
    // (`sessionListingRow`'s precedence). So the id is dropped from the
    // other list on every apply rather than only inserted into its own —
    // without that, one Session would be listed twice, once in each shape,
    // and the older shape would never move again.
    if (row.kind === "terminal") {
      const at = terminal.findIndex((record) => record.id === sessionId);
      if (at === -1) terminalCopy().push(row.record);
      else if (!sameJson(terminal[at], row.record)) terminalCopy()[at] = row.record;
      const crossed = chat.findIndex((record) => record.sessionId === sessionId);
      if (crossed !== -1) chatCopy().splice(crossed, 1);
    } else {
      const at = chat.findIndex((record) => record.sessionId === sessionId);
      if (at === -1) chatCopy().push(row.record);
      else if (!sameJson(chat[at], row.record)) chatCopy()[at] = row.record;
      const crossed = terminal.findIndex((record) => record.id === sessionId);
      if (crossed !== -1) terminalCopy().splice(crossed, 1);
    }
  }
  if (!moved) return current;
  return { terminal, chat, provenance, read: read ?? {} };
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createProjectSessionsStore() {
  /**
   * Baseline fetches in flight, per project. Module-scope-per-store rather than
   * store state: nothing renders from it, and putting it in state would make
   * every consumer re-render twice per fetch for a fact none of them show.
   */
  const inFlight = new Map<string, Promise<void>>();
  const activityObservers = new Set<(notice: SessionActivityNotice) => void>();
  /**
   * The newest read per project (VC-713). A remote listing is re-read on a
   * poll, a focus and a reconnect, and a read can land after a later one: only
   * the newest read's answer is applied, so an older answer never paints over
   * a newer one.
   */
  const latestRead = new Map<string, number>();
  let reads = 0;

  return create<ProjectSessionsState>()((set, get) => ({
    byProject: {},
    listingState: {},

    async refresh(projectId, options = {}) {
      const quiet = options.quiet === true;
      const thisRead = ++reads;
      latestRead.set(projectId, thisRead);
      const current = () => latestRead.get(projectId) === thisRead;
      if (!quiet) {
        set((state) => ({
          listingState: { ...state.listingState, [projectId]: "loading" },
        }));
      }
      const failed = (message: string): void => {
        if (!current()) return;
        if (!quiet) toastError(`Couldn't load sessions: ${message}`);
        // A quiet read keeps loaded rows standing; it only stands down a
        // skeleton an earlier, superseded read left behind.
        else if (get().listingState[projectId] !== "loading") return;
        set((state) => ({
          listingState: { ...state.listingState, [projectId]: "failed" },
        }));
      };
      try {
        const result = await sessionListingReaderForProject(projectId).list({ projectId });
        if (!result.ok) {
          failed(result.error);
          return;
        }
        if (!current()) return;
        const provenance: Record<string, SessionProvenance> = {};
        const read: Record<string, SessionReadState> = {};
        for (const row of result.sessions) {
          // Only a Session with something to say takes a slot. `user` is the
          // overwhelming majority and it says nothing, so it is stored as its
          // own absence — see `ProjectSessionRows.provenance`.
          if (row.provenance.kind !== "user") provenance[rowSessionId(row)] = row.provenance;
          // The same sparseness for the same reason: a read Session is the
          // resting case and stores nothing (VC-30).
          if (isSessionUnread(row.read)) read[rowSessionId(row)] = sessionReadStateOf(row.read);
        }
        const rows: ProjectSessionRows = {
          terminal: result.sessions.flatMap((row) => (row.kind === "terminal" ? [row.record] : [])),
          chat: result.sessions.flatMap((row) => (row.kind === "chat" ? [row.record] : [])),
          provenance,
          read,
        };
        set((state) => ({
          byProject: { ...state.byProject, [projectId]: rows },
          listingState: { ...state.listingState, [projectId]: "loaded" },
        }));
      } catch (error) {
        failed(errorMessage(error));
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
      get().applyActivities([notice]);
    },

    applyActivities(notices) {
      if (notices.length === 0) return;
      set((state) => {
        let byProject: Record<string, ProjectSessionRows> | null = null;
        const byProjectId = new Map<string, SessionActivityNotice[]>();
        for (const notice of notices) {
          const grouped = byProjectId.get(notice.projectId);
          if (grouped === undefined) byProjectId.set(notice.projectId, [notice]);
          else grouped.push(notice);
        }
        for (const [projectId, projectNotices] of byProjectId) {
          const current = state.byProject[projectId];
          // See `applyActivity`'s doc: no baseline, no project.
          if (current === undefined) continue;
          const next = foldActivity(current, projectNotices);
          if (next === current) continue;
          byProject ??= { ...state.byProject };
          byProject[projectId] = next;
        }
        return byProject === null ? state : { byProject };
      });
      // A toast can name a Session on an unvisited project. Its baseline must
      // stay absent, but the already-received row is still authoritative for
      // that one ephemeral view. This is the existing intake, not a new feed.
      for (const notice of notices) {
        for (const observer of activityObservers) observer(notice);
      }
    },

    subscribeActivity(listener) {
      activityObservers.add(listener);
      return () => {
        activityObservers.delete(listener);
      };
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
            [projectId]: {
              terminal,
              chat: current.chat,
              provenance: current.provenance,
              read: current.read,
            },
          },
        };
      });
    },

    setSessionRead(projectId, sessionId, unread) {
      // The optimistic stamp, the toast and the conditional revert are
      // `session-read-mark.ts`' — shared with the ticket rail, which marks the
      // same Sessions. This store contributes only how a row is read and
      // written here.
      return markSessionRead(
        { sessionId, unread },
        {
          readState: () => sessionReadOf(get().byProject[projectId], sessionId),
          write: (read) => {
            set((state) => {
              const current = state.byProject[projectId];
              if (current === undefined) return state;
              const next = { ...current.read };
              if (read.unreadSince === null) delete next[sessionId];
              else next[sessionId] = read;
              return {
                byProject: { ...state.byProject, [projectId]: { ...current, read: next } },
              };
            });
          },
        },
      );
    },
  }));
}

export const useProjectSessionsStore = createProjectSessionsStore();

/**
 * How long a push that moves nothing but `lastActivityAt` may wait (VC-1078).
 *
 * Main publishes a Session's row on every durable fact it writes, debounced to
 * 60 ms per Session, so each running Session can push ~16 rows a second — and
 * nearly all of them say only "still working, newer stamp". The stamp moves no
 * band and no group; what reads it does so at minute grain (age labels, the
 * quiet window). Folding those once a second instead of once a push is what
 * keeps ten running Sessions from re-deriving a 5,000-row listing hundreds of
 * times a second.
 */
const ACTIVITY_RECENCY_FLUSH_MS = 1_000;
/**
 * The ceiling on a frame-batched flush: `requestAnimationFrame` does not run
 * in a hidden window, and a material change must still land there.
 */
const ACTIVITY_FRAME_FALLBACK_MS = 100;

/** Batches pushed notices into store writes; see {@link createSessionActivityIntake}. */
export interface SessionActivityIntake {
  push(notice: SessionActivityNotice): void;
  /** Applies everything pending now, in one write. */
  flush(): void;
  /** Applies what is pending and stops every timer. */
  dispose(): void;
}

/**
 * The renderer's door for `volli:session-activity` (VC-1078).
 *
 * Pushes are coalesced per Session — each row is that Session's whole answer,
 * so the newest one wins — and applied in one store write:
 *
 *  - on the next animation frame when any pending row changes something the
 *    sidebar draws (`material`), so a turn opening or a question being asked
 *    still lands in the frame it arrived in;
 *  - otherwise within {@link ACTIVITY_RECENCY_FLUSH_MS}, for rows that only
 *    move `lastActivityAt`. A material flush carries any of those along.
 */
export function createSessionActivityIntake(
  store: Pick<typeof useProjectSessionsStore, "getState">,
): SessionActivityIntake {
  const pending = new Map<string, SessionActivityNotice>();
  let frame: number | null = null;
  let frameFallback: ReturnType<typeof setTimeout> | null = null;
  let recencyTimer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (frameFallback !== null) clearTimeout(frameFallback);
    if (recencyTimer !== null) clearTimeout(recencyTimer);
    frame = null;
    frameFallback = null;
    recencyTimer = null;
  };

  const flush = (): void => {
    cancel();
    if (pending.size === 0) return;
    const notices = [...pending.values()];
    pending.clear();
    store.getState().applyActivities(notices);
  };

  return {
    push(notice) {
      const change = activityChangeOf(store.getState().byProject[notice.projectId], notice);
      // Deleted first so the Map's order is arrival order of each Session's
      // newest row.
      const key = `${notice.projectId}\u0000${rowSessionId(notice.row)}`;
      pending.delete(key);
      pending.set(key, notice);
      if (change === "material") {
        if (frameFallback !== null) return;
        if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
        frameFallback = setTimeout(flush, ACTIVITY_FRAME_FALLBACK_MS);
        return;
      }
      recencyTimer ??= setTimeout(flush, ACTIVITY_RECENCY_FLUSH_MS);
    },
    flush,
    dispose: flush,
  };
}

/**
 * Wires the single `api.sessions.onActivity` subscription into the store.
 *
 * Mounted once from an always-mounted site, exactly as `subscribeHarnessEvents`
 * and `subscribeWorktreePhases` are and for the same reason: the pushes address
 * live state that outlives every surface reading it, and a per-surface
 * subscription would double-apply notices whenever two of them were mounted.
 * Every notice goes through {@link createSessionActivityIntake}, so a burst of
 * pushes costs one store write per frame rather than one each.
 *
 * Returns the unsubscribe function for the caller's effect cleanup.
 */
export function subscribeProjectSessionActivity(): () => void {
  if (launchStore() === "cloud") return () => {};
  const intake = createSessionActivityIntake(useProjectSessionsStore);
  const off = window.api.sessions.onActivity((notice) => intake.push(notice));
  return () => {
    off();
    intake.dispose();
  };
}
