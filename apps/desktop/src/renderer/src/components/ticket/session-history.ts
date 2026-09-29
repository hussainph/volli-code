import { canResumeTerminalRecord, sessionSourceLabel } from "@volli/session-presentation";
import {
  applyHeldOrder,
  isListableSession,
  isSessionUnread,
  type SessionOrderMember,
  type SessionOrderPhase,
  type ChatSessionRecord,
  type HarnessAdapterLookup,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionListingIdentity,
  type SessionListingRow,
  type SessionProvenance,
  type SessionRecord,
} from "@volli/shared";

import { nextAgeChangeAt } from "../../lib/relative-time";
import {
  sessionActivityDotState,
  sessionActivityIsLive,
  sessionAttentionRank,
} from "../ui/session-activity-status";
import type { StatusDotState } from "../ui/status-dot";
import {
  WORKING_WINDOW_MS,
  sessionActivityState,
  sessionPanes,
  type SessionTab,
} from "../../stores/sessions";

/**
 * The chip's displayed status: the honest PTY-derived {@link SessionActivityState}
 * states, plus `setup` — a synthetic state (not PTY-derived) shown while the
 * ticket's worktree ensure pipeline is in its `setting-up` phase, so the rail
 * reads as "the agent's setup script is running" rather than a generic
 * `working`.
 */
export type TicketSessionStatus = SessionActivityState | "setup";

/** The view model shared by the current-session and historical-session lists. */
export interface TicketSessionRow {
  record: SessionRecord;
  title: string;
  status: TicketSessionStatus;
  isOpen: boolean;
  isRoot: boolean;
  tabId?: string;
}

export interface TicketSessionRowsInput {
  /** The ticket's durable records — one per pane, live or ended. */
  records: readonly SessionRecord[];
  /** The ticket's currently-open tabs, from the unified sessions store. */
  tabs: readonly SessionTab[];
  lastOutputAt: Readonly<Record<string, number>>;
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  /**
   * Per-session harness reporting state, straight off the sessions store — the
   * same map the sidebar's listing reads. A missing entry means nothing reports
   * for that pane, which is the honest default.
   */
  harness: Readonly<Record<string, SessionHarnessState>>;
  /** Whether the ticket's worktree ensure pipeline is running its setup script. */
  settingUp: boolean;
  now: number;
}

/**
 * The `lastOutputAt` entries {@link buildTicketSessionRows} can actually read
 * for one ticket — a stamp per DURABLE TERMINAL RECORD it walks, and nothing
 * else.
 *
 * The store keeps one flat output-stamp map for every live session in the app
 * and replaces it wholesale on each bump (a busy session bumps about once a
 * second), so a panel subscribed to the map itself re-derived this ticket's
 * whole roster whenever any session anywhere printed a line — including every
 * session of every other ticket and project, none of which it can name.
 *
 * The key set is this panel's own and deliberately not the sidebar's
 * (`listingOutputStamps`, which walks live CONTAINERS): the rail's rows come
 * from the durable per-ticket listing, and a live pane whose record has not
 * landed in that cache yet contributes no row and so can be read by nothing
 * here. Shallow-compared, an irrelevant bump now yields the same object.
 *
 * A narrower SUBSCRIPTION, not a coarser input: the raw stamps ride through
 * untouched, so every status is derived from exactly the numbers it was before.
 */
export function ticketOutputStamps(input: {
  lastOutputAt: Readonly<Record<string, number>>;
  /** The ticket's durable listing rows, as the records store caches them. */
  rows: readonly SessionListingRow[];
}): Record<string, number> {
  const stamps: Record<string, number> = {};
  for (const row of input.rows) {
    if (row.kind !== "terminal") continue;
    const at = input.lastOutputAt[row.record.id];
    if (at !== undefined) stamps[row.record.id] = at;
  }
  return stamps;
}

/**
 * Who started each of a ticket's Sessions, keyed by Session id (VC-131).
 *
 * The rail splits its listing rows into two record arrays and builds its own
 * view rows from those, so the row wrapper — which is where provenance rides,
 * beside `usage`, because it is a fact about the Session rather than about the
 * attachment — is gone by the time a row is drawn. This is the one read that
 * keeps it, in the same sparse shape the sidebar's store uses: a miss is the
 * resting case, so a ticket nobody automated contributes an empty object and
 * the rail gains no weight from this feature at all.
 */
export function ticketSessionProvenance(
  rows: readonly SessionListingRow[],
): Readonly<Record<string, SessionProvenance>> {
  const provenance: Record<string, SessionProvenance> = {};
  for (const row of rows) {
    if (row.provenance.kind === "user") continue;
    provenance[row.kind === "terminal" ? row.record.id : row.record.sessionId] = row.provenance;
  }
  return provenance;
}

/** What an open pane knows about itself, indexed by {@link livePanesById}. */
interface LivePane {
  exitCode: number | null;
  /** The live TAB title — the root pane's row prefers it so optimistic renames show. */
  tabTitle: string;
  /** The tab's root session id, which is what a row activates. */
  tabId: string;
}

/**
 * paneSessionId → its live state, for EVERY pane of every open tab (not just
 * tab roots): each split pane has its own durable record, so without this a
 * live split pane would render as an inert "Exited" row.
 *
 * Shared by the row build and {@link nextTicketSessionStatusChangeAt}, which
 * has to know the same thing about the same panes — a boundary derived from a
 * second, differently-written walk is a boundary that can disagree with the
 * word it is supposed to be the expiry of.
 */
function livePanesById(tabs: readonly SessionTab[]): Map<string, LivePane> {
  const liveById = new Map<string, LivePane>();
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      liveById.set(pane.sessionId, {
        exitCode: pane.exitCode,
        tabTitle: tab.title,
        tabId: tab.sessionId,
      });
    }
  }
  return liveById;
}

/**
 * The rail's session rows: one per durable record, each carrying the status the
 * rail chip shows. Pure and clock-injected so the derivation is unit-testable
 * without the panel around it (the same split as the sidebar's
 * `active-session-listing`) — and, more to the point, so BOTH surfaces reach
 * `sessionActivityState` through the same argument list. A rail that fed it only
 * PTY facts was structurally unable to show a blocked agent while the sidebar,
 * reading the same store, sorted that session to the top of its Active band.
 */
export function buildTicketSessionRows(input: TicketSessionRowsInput): TicketSessionRow[] {
  const liveById = livePanesById(input.tabs);

  return input.records.map((record) => {
    const live = liveById.get(record.id);
    const isOpen = live !== undefined;
    const isRoot = live !== undefined && live.tabId === record.id;
    // Status derives from THIS pane's own exit code + output, not the tab root's.
    const exited = live !== undefined ? live.exitCode !== null : true;
    const activity = sessionActivityState(
      input.lastOutputAt[record.id] ?? null,
      exited,
      input.now,
      input.parkState[record.id]?.parked ?? false,
      input.harness[record.id]?.declared ?? null,
    );
    // While the worktree's ensure pipeline is running its setup script, an open
    // pane's honest `working` status is less informative than naming what it's
    // actually doing — `setup` overrides it for every currently-open, NOT-YET-
    // EXITED row; an exited/crashed pane shows its real exited status even
    // during setup, rather than lying that setup is still in progress.
    const status: TicketSessionStatus = isOpen && !exited && input.settingUp ? "setup" : activity;
    // Root pane rows prefer the live tab title (optimistic rename shows before
    // the refetch); non-root pane rows show their own durable record title.
    const title = isRoot ? live.tabTitle : record.title;
    return { record, title, isOpen, isRoot, tabId: live?.tabId, status };
  });
}

/**
 * The first instant a status {@link buildTicketSessionRows} just produced reads
 * differently with no new input, or `null` when none of them can.
 *
 * There is exactly one clock-driven transition in this derivation, and it is
 * the last rung of {@link sessionActivityState}: an open pane that printed
 * something recently says `working` and, a fixed window after that last line,
 * says `idle` — with nothing having happened in between. That is the whole
 * reason this panel used to hold a one-second interval, re-deriving every row
 * sixty times a minute against the chance that this one instant had passed. The
 * derivation can simply say when it is.
 *
 * `exited` is the only fact excluded, because it is the only one that makes a
 * row's word permanent — the rest of the walk is deliberately over-inclusive.
 * A parked pane, a pane whose harness is declaring its own state, and a row
 * showing `setup` all outrank output recency and so cannot actually flip here,
 * but each of those is a fact that can stop being true while the timer is
 * armed, and a boundary that changes nothing costs one recompute that finds
 * nothing — while a missing one leaves a row saying the wrong word until
 * something unrelated happens to move.
 */
export function nextTicketSessionStatusChangeAt(input: TicketSessionRowsInput): number | null {
  const liveById = livePanesById(input.tabs);
  let soonest: number | null = null;
  for (const record of input.records) {
    const live = liveById.get(record.id);
    if (live === undefined || live.exitCode !== null) continue;
    const lastOutput = input.lastOutputAt[record.id];
    if (lastOutput === undefined) continue;
    // +1: the window is inclusive (`<=` in `sessionActivityState`), so the
    // first instant the answer differs is one millisecond past its end.
    const at = lastOutput + WORKING_WINDOW_MS + 1;
    // Already past: the row reads `idle` now and stays `idle` until a new line
    // of output moves the stamp, which is an input change, not a clock one.
    if (at <= input.now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/**
 * Current is intentionally strict: only an open, non-exited PTY belongs in
 * the working set. Exited-but-still-open panes stay activatable from history.
 */
export function groupSessionRows(rows: readonly TicketSessionRow[]): {
  current: TicketSessionRow[];
  history: TicketSessionRow[];
} {
  const current: TicketSessionRow[] = [];
  const history: TicketSessionRow[] = [];
  for (const row of rows) {
    (row.isOpen && row.status !== "exited" ? current : history).push(row);
  }
  return { current, history };
}

/**
 * Whether `row` can be resumed (interrupt/resume, issue #78) — the listing-row
 * door onto the portable rule.
 *
 * A chat row never qualifies: there is no terminal to resume as, only a future
 * deep-activation path this is not it. Everything else the rule decides —
 * agent launch, actually ended, a harness that knows how to resume — belongs to
 * {@link canResumeTerminalRecord} in `@volli/session-presentation`, so the
 * sidebar, the ticket rail and a closed terminal's saved record cannot drift
 * into three answers about one Session.
 *
 * Capability, not a command line: the resume line names the generated wrapper
 * by absolute path, and those paths are main's alone.
 *
 * `lookup` is a parameter rather than a hard-wired `getHarnessAdapter` because
 * this used to consult the built-ins only, on the since-retired grounds that
 * "the renderer has no channel over which a registered manifest's adapter could
 * reach it." It has one — `launchAdapter` reads the hydrated catalog as well —
 * and a first-class-only lookup here silently denies Resume to every BYO
 * session that can genuinely be resumed. Pass `launchAdapter`; the parameter
 * exists so a test can say what this process knows instead of inheriting it
 * from a module singleton.
 */
export function canResumeSession(
  row: SessionListingIdentity,
  lookup: HarnessAdapterLookup,
): boolean {
  return row.kind === "chat" ? false : canResumeTerminalRecord(row.record, lookup);
}

/**
 * The newest resumable record among `rows`, or `null` if none qualify — a chat
 * row is filtered out by {@link canResumeSession} before it ever reaches the
 * comparison. Compares `createdAt` directly rather than trusting input order —
 * the store (`listTicketSessions`, `created_at DESC`) already hands these back
 * newest-first, but this stays correct even if a caller passes an
 * unordered/filtered subset.
 */
export function latestResumableSession(
  rows: readonly SessionListingRow[],
  lookup: HarnessAdapterLookup,
): SessionRecord | null {
  let latest: SessionRecord | null = null;
  for (const row of rows) {
    if (row.kind !== "terminal" || !canResumeSession(row, lookup)) continue;
    if (latest === null || row.record.createdAt > latest.createdAt) latest = row.record;
  }
  return latest;
}

/** Title + truthful source metadata make collapsed history easy to recover. */
export function filterSessionHistory(
  rows: readonly TicketSessionRow[],
  query: string,
): TicketSessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    `${row.title}\n${sessionSourceLabel({ kind: "terminal", record: row.record })}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/**
 * A ticket-rail row for a chat Session. There is no PTY behind it, so there is
 * nothing to resume — opening the Session is already everything a resume would
 * buy. `isOpen` preserves `groupSessionRows`'s current/history behavior from
 * whether the Session's structured attachment is open; the finer state the
 * record carries (`activity`, `lastActivityAt`) is what the rail's row trails
 * with, so a chat and a terminal report themselves in one vocabulary.
 */
export interface TicketChatSessionRow {
  record: ChatSessionRecord;
  title: string;
  isOpen: boolean;
  /**
   * Whether the Session is still work rather than a record of work — which is
   * what decides whether it belongs among the live rows (VC-406).
   *
   * NOT `isOpen`, and that was the defect. The roster used to split on the
   * attachment, so a Session whose tab you closed — including one BLOCKED on a
   * permission prompt — folded under the Earlier caret and stopped being on the
   * page at all. `sessionActivityIsLive` is the domain's own answer and the
   * same one Home's roster reads.
   */
  isLive: boolean;
}

/**
 * Chat Sessions for a ticket, named and grouped the same way a terminal
 * record's rail row is.
 *
 * A Subagent Session inherits its parent's Ticket, so the ticket's own listing
 * returns it — and this roster drops it (VC-279). It is a child of one turn in
 * one chat and is reached from that chat's Activity Island; a rail that listed
 * it would grow by however many helpers the ticket's agents happened to open,
 * and "History" would fill with the trace of one Session's fan-out rather than
 * with the Sessions someone worked in. The cached listing behind this keeps
 * them, which is what the rail's usage block counts.
 */
export function buildTicketChatSessionRows(
  records: readonly ChatSessionRecord[],
): TicketChatSessionRow[] {
  return records
    .filter((record) => isListableSession(record))
    .map((record) => ({
      record,
      title: record.title,
      isOpen: record.live,
      isLive: sessionActivityIsLive(record.activity),
    }));
}

/** {@link filterSessionHistory}'s title+source match, over chat rows instead of durable records. */
export function filterChatSessionHistory(
  rows: readonly TicketChatSessionRow[],
  query: string,
): TicketChatSessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    `${row.title}\n${sessionSourceLabel({ kind: "chat", record: row.record })}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/**
 * One rendered row of the rail: a terminal row (rename, resume, activate) or a
 * chat row (rename, activate, title, and current/history placement — a chat
 * Session is durable, so even a closed one opens onto its own history, which is
 * why it offers no resume). Discriminated the same way `SessionListingRow` is, one
 * layer up the view model.
 */
export type SessionRailRow =
  | { kind: "terminal"; row: TicketSessionRow }
  | { kind: "chat"; row: TicketChatSessionRow };

/**
 * The rail's two row kinds in one list, newest first. Ordering is by creation,
 * across both kinds, rather than by concatenation: `listForTicket` hands its
 * rows back newest-first already, and appending the chat ones would sink every
 * chat Session below every terminal one however recent it is.
 */
export function mergeSessionRailRows(
  terminal: readonly TicketSessionRow[],
  chat: readonly TicketChatSessionRow[],
): SessionRailRow[] {
  const rows: SessionRailRow[] = [
    ...terminal.map((row): SessionRailRow => ({ kind: "terminal", row })),
    ...chat.map((row): SessionRailRow => ({ kind: "chat", row })),
  ];
  return rows.toSorted((a, b) => b.row.record.createdAt - a.row.record.createdAt);
}

/**
 * The dot state one rail row draws — the same vocabulary for both kinds, which
 * is what lets the column be read down rather than row by row.
 *
 * A terminal's `setup` is not an activity the shared map knows (it is the
 * worktree's ensure script, named rather than reported by a PTY), so it is
 * spelled here; everything else goes through `sessionActivityDotState`, so this
 * surface states the activity and decides nothing.
 */
export function sessionRailRowDotState(row: SessionRailRow): StatusDotState {
  if (row.kind === "chat") return sessionActivityDotState(row.row.record.activity);
  return row.row.status === "setup" ? "setup" : sessionActivityDotState(row.row.status);
}

/**
 * Past this many rows a roster stops being scannable and earns its filter
 * (VC-406, the reviewed proposal's rule).
 *
 * Counted over the WHOLE roster — live rows and record together — because one
 * query reaches both halves, so what doing without it costs is the total. One
 * constant for both scopes: Home's roster and the Ticket's are the same object
 * at two scopes, and a rail that showed its filter at four rows on one page and
 * at five on the other would be two designs.
 */
export const SESSION_ROSTER_FILTER_THRESHOLD = 4;

/**
 * The live rows in the order a reader should meet them: whatever is asking for
 * a person first, everything else left as it arrived (VC-406).
 *
 * Applied to the CURRENT list alone. The record is a chronology — nothing in it
 * is asking for anybody — and an attention order over finished work would only
 * make it harder to date. `toSorted` is stable by specification, so "newest
 * first within a rank" is a property of this function rather than of the engine
 * running it.
 *
 * WHICH SURFACE USES WHICH (VC-30). This is a re-sort on every build, so a row
 * moves under the pointer that is reaching for it. The in-ticket rail therefore
 * draws {@link orderSessionRailRowsByHold} instead — the HELD order both
 * sidebars share (D7), which lifts on the same events and then keeps still
 * while a person is pointing at it. This rule stays because Home's roster is
 * not a hover surface: it is read top-down in a glance, has no peek and no
 * hold, and attention-first is exactly what it wants.
 */
export function orderSessionRailRowsByAttention(rows: readonly SessionRailRow[]): SessionRailRow[] {
  return rows.toSorted(
    (left, right) =>
      sessionAttentionRank(sessionRailRowDotState(left)) -
      sessionAttentionRank(sessionRailRowDotState(right)),
  );
}

/**
 * The row id the peek and the held order address a rail row by — the same
 * `chat:` / `session:` ids the sidebar's listing mints
 * (`sidebar/active-session-listing.ts`, read back by
 * `session-peek/peek-subject.ts`).
 *
 * One vocabulary across both sidebars is what lets one committed order and one
 * peek controller serve them: a row id that meant something different here
 * would make the rail's members unaddressable by the shared rules.
 */
export function sessionRailRowId(row: SessionRailRow): string {
  return row.kind === "chat" ? `chat:${row.row.record.sessionId}` : `session:${row.row.record.id}`;
}

/** The bare Session id a rail row stands for. */
export function sessionRailRowSessionId(row: SessionRailRow): string {
  return row.kind === "chat" ? row.row.record.sessionId : row.row.record.id;
}

/**
 * What a rail row is doing, in the held order's three-word vocabulary (D7):
 * asking for a person, working, or neither.
 *
 * Derived from {@link sessionRailRowDotState} rather than from a second read of
 * the record, so the order lifts a row on exactly the state its own mark is
 * drawing.
 */
export function sessionRailRowPhase(row: SessionRailRow): SessionOrderPhase {
  const state = sessionRailRowDotState(row);
  if (state === "waiting") return "waiting";
  if (state === "working" || state === "setup" || state === "starting") return "working";
  return "resting";
}

/** The rail's membership for `stores/session-order.ts`, in its current order. */
export function sessionRailOrderMembers(rows: readonly SessionRailRow[]): SessionOrderMember[] {
  return rows.map((row) => ({ id: sessionRailRowId(row), phase: sessionRailRowPhase(row) }));
}

/**
 * The live rows in the order the rail's own key last committed to (D7,
 * amendment A2) — a row the order does not name keeps its place at the end,
 * which is `applyHeldOrder`'s rule and not a second one.
 */
export function orderSessionRailRowsByHold(
  rows: readonly SessionRailRow[],
  order: readonly string[],
): SessionRailRow[] {
  const identified = rows.map((row) => ({ id: sessionRailRowId(row), row }));
  return applyHeldOrder(order, identified).map((entry) => entry.row);
}

/**
 * Which of a ticket's Sessions have unread work, by Session id (VC-30).
 *
 * Read off the LISTING rows, for the reason {@link ticketSessionProvenance}
 * above is: unread rides on the row wrapper (`SessionListingRow.read`, sparse —
 * absent is read), and the rail splits its listing into two record arrays
 * before it builds view rows, so the wrapper is gone by the time a row is
 * drawn. A ticket nobody has left work in contributes an empty set.
 */
export function ticketSessionUnreadIds(rows: readonly SessionListingRow[]): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const row of rows) {
    if (!isSessionUnread(row.read)) continue;
    unread.add(row.kind === "terminal" ? row.record.id : row.record.sessionId);
  }
  return unread;
}

/**
 * The instant a History row's relative stamp is measured from: when a chat
 * Session last said anything, when a terminal Session ended — or, for a record
 * that somehow never got an end stamp, when it was created, which is the
 * oldest instant that is certainly true of it.
 *
 * One definition, because the row that PRINTS the stamp and the timer that
 * waits for it to change have to be reading the same number. Two copies of
 * `endedAt ?? createdAt` is how a column ends up refreshing on a boundary
 * belonging to a different date than the one on screen.
 */
export function sessionRailRowStampAt(row: SessionRailRow): number {
  return row.kind === "chat"
    ? row.row.record.lastActivityAt
    : (row.row.record.endedAt ?? row.row.record.createdAt);
}

/**
 * The instant a LIVE row's age is measured from — when the Session last did
 * anything (VC-406).
 *
 * A separate reading from {@link sessionRailRowStampAt}, and deliberately so:
 * that one dates an ENDING, which a live row does not have. A chat carries its
 * own `lastActivityAt`; a terminal's equivalent is the last line it printed,
 * which the sessions store holds and the panel already subscribes to in
 * narrowed form (`ticketOutputStamps`). A pane that has printed nothing at all
 * falls back to when it was created, which is the oldest instant that is
 * certainly true of it — never a fabricated "now".
 */
export function sessionRailRowActivityAt(
  row: SessionRailRow,
  lastOutputAt: Readonly<Record<string, number>>,
): number {
  if (row.kind === "chat") return row.row.record.lastActivityAt;
  return lastOutputAt[row.row.record.id] ?? row.row.record.createdAt;
}

/**
 * The soonest instant any of `rows` prints a different age than it does at
 * `now`, or `null` for an empty list.
 *
 * {@link nextAgeChangeAt} is documented against `compactAge`, and these rows
 * print `relativeTime`; the boundary is the same instant either way. The two
 * formatters walk one ladder — `compactAge` is `relativeTime` with the strings
 * shortened, not the buckets changed — and past the four-week rollup both
 * render an absolute date whose only moving part is the year.
 */
export function nextSessionRailAgeChangeAt(
  rows: readonly SessionRailRow[],
  now: number,
  /**
   * Which instant each row's age is read from. Defaults to the ending the
   * record holds; the live rows pass {@link sessionRailRowActivityAt} instead,
   * because the timer and the text on screen have to be waiting on the same
   * number — two readings is how a column refreshes on a boundary belonging to
   * a stamp it is not printing.
   */
  stampAt: (row: SessionRailRow) => number = sessionRailRowStampAt,
): number | null {
  let soonest: number | null = null;
  for (const row of rows) {
    const at = nextAgeChangeAt(stampAt(row), now);
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
