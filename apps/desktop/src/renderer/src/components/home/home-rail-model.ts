/**
 * Home's rail pages (VC-55).
 *
 * The ticket workspace's rail one scope up, and deliberately its own enum
 * rather than a widening of `TicketRailMode`: the two rails answer about
 * different things (a ticket's changes and files against a project's venue and
 * its own Sessions), and `ticket-rail-model.ts` owns a persisted vocabulary
 * with its own retired pages to keep readable. One store key each, so neither
 * can rehydrate the other's page.
 *
 * The Sessions page's row shape lives here too, for the reason every pure
 * module in this renderer does: which Sessions a project's own listing holds,
 * what each one's liveness is and how they order are decisions, and a decision
 * inside a `.tsx` is a decision no test can reach.
 */
import {
  isListableSession,
  venueLooseCount,
  type ChatSessionRecord,
  type SessionHarnessState,
  type SessionRecord,
  type VenueSnapshot,
} from "@volli/shared";

import { SESSION_ROSTER_FILTER_THRESHOLD } from "@renderer/components/ticket/session-history";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import {
  SESSION_ACTIVITY_LABEL,
  sessionActivityDotState,
  sessionActivityIsLive,
  sessionAttentionRank,
} from "@renderer/components/ui/session-activity-status";
import {
  WORKING_WINDOW_MS,
  sessionActivityState,
  sessionPanes,
  type SessionTab,
} from "@renderer/stores/sessions";

/**
 * Home's rail pages.
 *
 * THREE, NOT FOUR (VC-406). The roster of the project's own Sessions was a
 * page of its own beside Now, and the two answered one question twice: Now
 * described the Session in FRONT, the page beside it listed the Sessions there
 * ARE, and a reader looking for "what is running on this project" had to know
 * which of two tabs held the half they wanted. The roster lives on Now, under
 * the two cards, exactly as the Ticket rail's roster lives on its Now — one
 * scope up, the same page, the same shape.
 */
export type HomeRailMode = "now" | "files" | "search";

/** The pill's words. */
export const HOME_RAIL_MODE_LABELS: Record<HomeRailMode, string> = {
  now: "Now",
  files: "Files",
  search: "Search",
};

/** Page order in the pill, resting page first; new pages append to preserve keyboard order. */
export const HOME_RAIL_MODES: readonly HomeRailMode[] = ["now", "files", "search"];

/** The resting page: where the Session runs, what it is, and what it has named. */
export const DEFAULT_HOME_RAIL_MODE: HomeRailMode = "now";

/**
 * Pages this build no longer offers, and where their reader should land.
 *
 * A retired page is not the same as a corrupt value, and a relaunch is the one
 * moment the difference shows: someone who left the rail on the Sessions page
 * is looking for the roster, and the roster is on Now. Falling through to the
 * default happens to land there too — spelled out so that a page retired to
 * somewhere OTHER than the default cannot silently take the default's answer.
 *
 * A `Map`, NOT AN OBJECT LITERAL, and that is a correctness requirement rather
 * than a taste: persisted JSON is attacker-shaped input in the only sense that
 * matters here — it can hold any string, including the ones every ordinary
 * object already answers to. An object literal inherits `Object.prototype`, so
 * a stored `"__proto__"` reads back as `Object.prototype` and a stored
 * `"toString"` as a function — both truthy, both returned in place of a page,
 * so the `??` default never runs and the rail rehydrates onto a value that is
 * not a `HomeRailMode` at all. A `Map` holds only what was put in it.
 */
const RETIRED_HOME_RAIL_MODES: ReadonlyMap<string, HomeRailMode> = new Map([
  // VC-406: consolidated into Now, which now carries the roster it held.
  ["sessions", "now"],
]);

/**
 * Validate a rehydrated page. Persisted JSON a past build wrote can hold
 * anything, including a page this build no longer offers.
 */
export function sanitizeHomeRailMode(raw: unknown): HomeRailMode {
  if (typeof raw !== "string") return DEFAULT_HOME_RAIL_MODE;
  // Membership in the page list rather than a hand-written disjunction: a page
  // added to the pill must not need a second edit here to survive a relaunch.
  if ((HOME_RAIL_MODES as readonly string[]).includes(raw)) return raw as HomeRailMode;
  return RETIRED_HOME_RAIL_MODES.get(raw) ?? DEFAULT_HOME_RAIL_MODE;
}

/** One row of the Sessions page. */
export interface HomeSessionRow {
  id: string;
  kind: "chat" | "terminal";
  title: string;
  /** Activity, in the app's one dot vocabulary. */
  state: StatusDotState;
  /**
   * That state in words — what the row's quiet second line leads with (VC-406).
   *
   * The app's own vocabulary, never this surface's: both kinds say what
   * {@link SESSION_ACTIVITY_LABEL} says, so a Session that reads "Interrupted"
   * in the sidebar cannot read "Died" here, and a terminal that reads "Waiting
   * for you" on its Ticket's rail cannot read "Open" here.
   *
   * A terminal USED TO say "Open", on the grounds that this listing carries a
   * terminal's durable identity and never its pulse. The identity half is still
   * true — the rows come from `stores/project-sessions.ts` — but the pulse is
   * not unavailable, only unread: `stores/sessions.ts` holds the same output,
   * park and harness facts the Ticket roster derives from, for every scope at
   * once. The caller passes this project's slice of them
   * ({@link HomeTerminalPulse}) and the word is derived, not guessed.
   */
  stateLabel: string;
  /** Newest fact about the Session — what its age is measured from. */
  at: number;
  /** Whether a tab is holding it right now. */
  open: boolean;
  /**
   * Whether the Session is still one you could work in — the lifecycle fact,
   * which is NOT the same question as whether a tab happens to be holding it
   * (VC-406).
   *
   * A chat Session is durable and outlives every attachment it has ever had, so
   * closing its tab ends nothing: `ChatSessionRecord` has no `exited` at all,
   * and the one activity that means somebody ENDED the work is `stopped`
   * (VC-86). `interrupted` deliberately stays live — the last turn died and
   * nobody decided that (VC-324), so it is a Session to go back to rather than
   * a record of one that finished.
   *
   * A TERMINAL is the opposite kind of thing: a PTY dies with its tab and with
   * the app, so a terminal row is live only while a live pane is holding it —
   * and, once that is established, only while its canonical activity is not
   * itself over. Both halves are needed: the pane answers "is there still a
   * process", and `sessionActivityState` answers "is the process still work",
   * which a harness that declared `stopped` can deny about a pane that is
   * technically still attached.
   */
  live: boolean;
  /**
   * Whether this row is a door back to the Session, or only a record that it
   * happened.
   *
   * A chat always is: its transcript is durable, so a closed one is re-adopted
   * and given a tab. A TERMINAL only is while a tab still holds it — a PTY dies
   * with the app and with its own close, so a closed terminal row has nothing
   * behind it to bring forward. That has to reach the DOM rather than being
   * absorbed by a handler that quietly does nothing: `ui/list-row.tsx` draws an
   * inert row for `onActivate: null`, and a row that hovers and depresses and
   * then goes nowhere is, in that file's own words, a lie the pointer tells.
   */
  reopenable: boolean;
  /**
   * For a terminal held by a live pane, the TAB that holds it; `null` for every
   * other row.
   *
   * A durable terminal record is a PANE, not a tab: a split's second pane has a
   * record of its own, and neither the workspace (which brings a TAB forward)
   * nor a split drop (whose payload's `sessionId` "for a TERMINAL is also its
   * tab id") can be handed a pane id. The ticket rail carries the same field
   * for the same reason; without it a live split pane is either invisible here
   * or a row that opens nothing.
   */
  tabId: string | null;
}

/** What one live pane of an open tab knows about itself. */
export interface HomeLivePane {
  /** `null` while the pane's PTY is live; the shell's exit code once it is gone. */
  exitCode: number | null;
  /** The tab holding this pane — what activation and a drop actually take. */
  tabId: string;
}

/**
 * The live facts a terminal row's state is derived from — this project's slice
 * of `stores/sessions.ts`, passed in rather than read here so the derivation
 * stays pure and clock-injected (VC-406).
 *
 * The same argument list `buildTicketSessionRows` assembles, because it must be:
 * a second, differently-fed derivation of one Session's state is exactly how
 * Home came to call a blocked agent "Open" while its Ticket's rail called it
 * "Waiting for you".
 */
export interface HomeTerminalPulse {
  /** Every pane of every open tab in this project's scope, by pane session id. */
  panes: ReadonlyMap<string, HomeLivePane>;
  /** sessionId → when that pane last printed. Narrow it with {@link homeTerminalIndex}. */
  lastOutputAt: Readonly<Record<string, number>>;
  /** sessionId → warm-park state; a missing entry means not parked. */
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  /** sessionId → what that pane's harness has reported; a missing entry means nothing reports. */
  harness: Readonly<Record<string, SessionHarnessState>>;
  /** The clock the working→idle window is measured against. */
  now: number;
}

/** A pulse that knows nothing — the honest shape for a scope with no open tabs. */
export const EMPTY_HOME_TERMINAL_PULSE: HomeTerminalPulse = {
  panes: new Map(),
  lastOutputAt: {},
  parkState: {},
  harness: {},
  now: 0,
};

/**
 * paneSessionId → its live state, for EVERY pane of every open tab — not just
 * the tab roots.
 *
 * Home used to pass the root ids alone (`tabs.map((tab) => tab.sessionId)`),
 * which is the sessions store's index of TABS and not of Sessions: a split's
 * second pane has its own durable record, so it appeared in the project's
 * listing and, matching no root id, rendered as an inert "Exited" row while its
 * PTY was printing. `session-history.ts` walks panes for the same reason.
 */
export function homeLivePanes(tabs: readonly SessionTab[]): Map<string, HomeLivePane> {
  const byPane = new Map<string, HomeLivePane>();
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      byPane.set(pane.sessionId, { exitCode: pane.exitCode, tabId: tab.sessionId });
    }
  }
  return byPane;
}

/**
 * The entries of one of the sessions store's flat per-session maps that THIS
 * project's terminal records can actually name.
 *
 * `ticketOutputStamps` in `session-history.ts` is the same narrowing, and its
 * comment is the argument: the store keeps one map for every live session in
 * the app and replaces it wholesale on each bump (a busy session bumps about
 * once a second), so a rail subscribed to the map itself re-derived its whole
 * roster whenever any session anywhere — in any other project, on any ticket —
 * printed a line. Shallow-compared, an irrelevant bump now yields an equal
 * object and Home does not re-render at all.
 *
 * Generic over the value because Home narrows three maps this way (output,
 * park, harness) and three copies of one loop is three places to forget one.
 * A narrower SUBSCRIPTION, not a coarser input: the values ride through
 * untouched, so every state is derived from exactly the facts it was before.
 */
export function homeTerminalIndex<T>(
  index: Readonly<Record<string, T>>,
  terminals: readonly SessionRecord[],
): Record<string, T> {
  const narrowed: Record<string, T> = {};
  for (const record of terminals) {
    const value = index[record.id];
    if (value !== undefined) narrowed[record.id] = value;
  }
  return narrowed;
}

/**
 * The project's Sessions, newest first, whatever kind they are.
 *
 * One list rather than two: they are the same thing at this scope — work the
 * user started on the project itself — and splitting by execution surface would
 * ask the reader to know which kind a Session was before they could find it.
 * The leading dot and the title carry the difference.
 *
 * "Work the user started" is also what keeps Subagent Sessions out of it
 * (VC-279): a delegated child is work an agent started inside one turn, and it
 * is reached from that turn's chat. Dropped here rather than by the page, so
 * the rule sits where the row shape does and a test can reach it.
 *
 * A chat states its own activity; a terminal's is DERIVED, from `pulse` — the
 * same facts and the same selector the Ticket roster uses
 * ({@link homeTerminalActivity}). Pure and clock-injected for the reason
 * `buildTicketSessionRows` is: a state a surface computes inside its own render
 * is a state no test can reach, and this one was wrong.
 */
export function homeSessionRows(
  chats: readonly ChatSessionRecord[],
  terminals: readonly SessionRecord[],
  openChatIds: readonly string[],
  pulse: HomeTerminalPulse,
): readonly HomeSessionRow[] {
  const rows: HomeSessionRow[] = [
    ...chats
      .filter((row) => isListableSession(row))
      .map((row) => ({
        id: row.sessionId,
        kind: "chat" as const,
        title: row.title,
        state: chatState(row),
        stateLabel: SESSION_ACTIVITY_LABEL[row.activity],
        at: row.lastActivityAt,
        open: openChatIds.includes(row.sessionId),
        live: chatSessionIsLive(row),
        // Durable history, so a closed one is a door like any other.
        reopenable: true,
        tabId: null,
      })),
    ...terminals.map((row) => {
      const pane = pulse.panes.get(row.id);
      const open = pane !== undefined;
      const activity = homeTerminalActivity(row, pulse);
      // Both halves of the terminal question (see `HomeSessionRow.live`): a
      // process, and work. `exited` and `stopped` are the two ways an activity
      // says there is none.
      const live = open && sessionActivityIsLive(activity);
      return {
        id: row.id,
        kind: "terminal" as const,
        title: row.title,
        // The activity IS the dot vocabulary — `SessionActivityState` is a
        // subset of `StatusDotState`, and the Ticket rail's live rows spend it
        // the same way. Passing it through `sessionActivityDotState` here would
        // flatten `parked` and `exited` into one grey `idle`, which is the
        // distinction the finer words exist to draw.
        state: activity,
        stateLabel: SESSION_ACTIVITY_LABEL[activity],
        at: row.lastActivityAt,
        open,
        live,
        // Nothing to bring forward once no pane holds the record.
        reopenable: open,
        tabId: pane?.tabId ?? null,
      };
    }),
  ];
  return rows.toSorted((left, right) => right.at - left.at);
}

/**
 * One terminal's canonical activity — `sessionActivityState`'s answer, from the
 * same five facts the Ticket roster feeds it (VC-406).
 *
 * THE POINT IS THAT THERE IS NO SECOND DERIVATION. Home used to answer
 * "ready/Open" for every open, non-ended record, which is not a coarser reading
 * of the same facts but a different question: a pane blocked at a permission
 * prompt, a pane SIGSTOP'd by the warm-park tier and a pane printing a build
 * log all read identically, and the blocked one — the single row on the page
 * asking for a person — sorted wherever its record's age happened to put it.
 *
 * `exited` is the one fact assembled rather than passed. A pane is gone when no
 * live pane holds it, when the pane it holds has an exit code, or when the
 * durable record carries an end stamp; the Ticket rail reads the first two (it
 * walks a ticket's own live tabs), and the third is kept because Home's rows
 * come from a durable listing that outlives every tab in the window and
 * `endedAt` is that listing's own word for over.
 */
function homeTerminalActivity(record: SessionRecord, pulse: HomeTerminalPulse) {
  const pane = pulse.panes.get(record.id);
  const exited = pane === undefined || pane.exitCode !== null || record.endedAt !== null;
  return sessionActivityState(
    pulse.lastOutputAt[record.id] ?? null,
    exited,
    pulse.now,
    pulse.parkState[record.id]?.parked ?? false,
    pulse.harness[record.id]?.declared ?? null,
  );
}

/**
 * The first instant a row {@link homeSessionRows} just produced says a
 * different word with no new input, or `null` when none of them can.
 *
 * `nextTicketSessionStatusChangeAt`'s argument, at Home's scope: there is
 * exactly one clock-driven transition in this derivation — the last rung of
 * `sessionActivityState`, where a pane that printed recently says `working` and
 * then, a fixed window after that line, says `idle` with nothing having
 * happened. A caller that arms one timer on this instant re-renders once per
 * visible change; the alternative is a one-second interval re-deriving the
 * whole roster sixty times a minute against the chance that this instant has
 * passed.
 *
 * Deliberately over-inclusive except for `exited`: a parked pane and a pane
 * whose harness is declaring its own state both outrank output recency and so
 * cannot actually flip here, but each of those facts can stop being true while
 * the timer is armed — and a boundary that changes nothing costs one recompute
 * that finds nothing, while a missing one leaves a row saying the wrong word
 * until something unrelated happens to move.
 */
export function nextHomeSessionStatusChangeAt(
  terminals: readonly SessionRecord[],
  pulse: HomeTerminalPulse,
): number | null {
  let soonest: number | null = null;
  for (const record of terminals) {
    const pane = pulse.panes.get(record.id);
    if (pane === undefined || pane.exitCode !== null || record.endedAt !== null) continue;
    const lastOutput = pulse.lastOutputAt[record.id];
    if (lastOutput === undefined) continue;
    // +1: the window is inclusive (`<=` in `sessionActivityState`), so the first
    // instant the answer differs is one millisecond past its end.
    const at = lastOutput + WORKING_WINDOW_MS + 1;
    // Already past: the row reads `idle` now and stays `idle` until a new line
    // moves the stamp, which is an input change rather than a clock one.
    if (at <= pulse.now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/**
 * A chat row's dot: waiting outranks working, a turn that died says so
 * (VC-324), and between turns is simply idle. The words are the record's own
 * — `activity` already ranked them; this only spends the dot's vocabulary.
 */
function chatState(row: ChatSessionRecord): StatusDotState {
  // The shared mapping (VC-324): this used to be a private copy whose `idle`
  // default swallowed `interrupted`, so a chat whose last turn died read as
  // merely quiet on Home and as dead in the sidebar.
  return sessionActivityDotState(row.activity);
}

/**
 * Whether a chat Session is still work rather than a record of work — the
 * domain's own answer, read off the record it is a fact about.
 *
 * The predicate is {@link sessionActivityIsLive}'s, shared with the Ticket
 * rail's roster: a second copy of it is how one surface keeps folding a blocked
 * Session into its history after the other stops.
 */
export function chatSessionIsLive(record: ChatSessionRecord): boolean {
  return sessionActivityIsLive(record.activity);
}

/**
 * The roster split Home's Now page draws: what is still running, and the record
 * of what is over (VC-406).
 *
 * ATTENTION FIRST, THEN RECENCY. `rows` arrives newest-first; the live half is
 * re-ordered by {@link sessionAttentionRank} with that order kept as the
 * tiebreak, so a Session blocked on a person is the first row on the page and
 * everything that is merely quiet stays chronological. The record is left
 * strictly chronological — nothing in it is asking for anybody, and an
 * attention order over finished work would only make the column harder to date.
 *
 * `toSorted` is stable by specification, which is what makes "recency within a
 * rank" a property of this function rather than of the engine running it.
 */
export function partitionHomeSessionRows(rows: readonly HomeSessionRow[]): {
  live: readonly HomeSessionRow[];
  earlier: readonly HomeSessionRow[];
} {
  const live: HomeSessionRow[] = [];
  const earlier: HomeSessionRow[] = [];
  for (const row of rows) (row.live ? live : earlier).push(row);
  return {
    live: live.toSorted(
      (left, right) => sessionAttentionRank(left.state) - sessionAttentionRank(right.state),
    ),
    earlier,
  };
}

/**
 * Past this many rows the roster stops being scannable and earns its filter.
 *
 * The Ticket rail's own number ({@link SESSION_ROSTER_FILTER_THRESHOLD}), not a
 * second copy of it: the two rosters are one object at two scopes, and this
 * name is kept only so the Home page reads in its own vocabulary.
 */
export const HOME_SESSION_FILTER_THRESHOLD = SESSION_ROSTER_FILTER_THRESHOLD;

/**
 * Rows matching `query`, case-insensitively; every row when the query is blank.
 *
 * Over exactly the two things the row DRAWS — its title and its state word —
 * so "waiting" finds the Sessions that are, and a row can never be hidden for a
 * reason the reader cannot see on it. The record is searched with the live
 * rows: a filter that stopped at the fold would answer "no matching sessions"
 * about a roster that holds one.
 */
export function filterHomeSessionRows(
  rows: readonly HomeSessionRow[],
  query: string,
): readonly HomeSessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) =>
    `${row.title}\n${row.stateLabel}`.toLocaleLowerCase().includes(needle),
  );
}

/**
 * What Home's checkout footer says at its right edge while the body under it is
 * folded (VC-406) — the Main checkout's answer to `worktreeGlance`.
 *
 * ONE FACT, CHOSEN BY PRIORITY, and the priority is the Ticket footer's: a
 * fault leads, because every other fact about the tree is unreadable while it
 * stands and the body under the row is where its Retry lives. Then what is
 * loose, then that nothing is.
 *
 * THE DOT IS QUIET FOR LOCAL STATE, for the reason `worktree-glance-model.ts`
 * gives: uncommitted work is the resting condition of a checkout someone is
 * working in, and a tone lit for it would be lit nearly always.
 *
 * `null` before the first read has landed — the row then shows the branch
 * alone, which is true, rather than a placeholder fact, which would not be.
 */
export interface HomeCheckoutGlance {
  phrase: string;
  tone: StatusDotState;
}

export function homeCheckoutGlance(input: {
  venue: VenueSnapshot | null;
  failed: boolean;
}): HomeCheckoutGlance | null {
  if (input.failed) return { phrase: "Unreadable", tone: "error" };
  if (input.venue === null) return null;
  const loose = venueLooseCount(input.venue.files);
  // "Uncommitted" is the word the Ticket footer uses for the same condition;
  // the count rides it here because Home's body has no state strip to carry it.
  if (loose > 0) return { phrase: `${loose} uncommitted`, tone: "idle" };
  return { phrase: "Clean", tone: "idle" };
}

/**
 * How many trailing segments of a venue path the rail's card shows.
 *
 * Two, because that is what tells the two venues apart: a main checkout ends
 * `…/code/volli-code` and a worktree ends `…/volli-code-f3732f45/VC-81-auto-title`,
 * and the segment above the last is what says which kind of place this is.
 */
const VENUE_PATH_SEGMENTS = 2;

/**
 * A venue path shortened from the FRONT.
 *
 * `truncate` cuts the end, which on a path is precisely the part worth reading:
 * `/Users/phalasiya/Desktop/cod…` names the person and hides the project. Every
 * path this card shows starts with the same home prefix and differs at its
 * tail, so the tail is what it shows — with the whole path one hover away.
 */
export function venuePathTail(path: string, segments: number = VENUE_PATH_SEGMENTS): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}
