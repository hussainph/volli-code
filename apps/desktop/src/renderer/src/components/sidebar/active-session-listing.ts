/**
 * The project sidebar's session listing: two bands, Active and Previous, built
 * from already-loaded board, terminal, durable-session and Session-signal state.
 * Pure — view code owns fetching, navigation and the clock; this module owns
 * which band a Session is in, what order it sits in, and when that answer next
 * changes on its own.
 *
 * **Every row is a Session.** The list never speaks for a ticket: a ticket with
 * no Session has nothing to say here, and the board is where its status lives.
 * An earlier rule guaranteed one row per Doing/Needs-Review ticket so the
 * navigator mirrored the board's claim, and the cost was a band that could fill
 * with ticket titles while every real Session sat below it in Previous. Active
 * showing nothing is the honest answer to nothing running.
 *
 * **Active** is recent work, in three groups: Sessions waiting on a human, then
 * Sessions working now, then Sessions that went quiet inside
 * {@link ACTIVE_QUIET_WINDOW_MS}. **Previous** is everything else the project's
 * Session listing returned: ended terminals, chats past the window, live panes
 * nobody has touched in half an hour.
 *
 * **Terminal quiet stamps are volatile.** `lastOutputAt` lives in the renderer
 * store and dies with the window, so after a relaunch a genuinely busy terminal
 * has no stamp at all. The stamp chain therefore ends in a deliberate bias
 * rather than a guess: a row nothing can date stays in Active. Keeping a live
 * Session visible is the failure worth having; a precise-looking timestamp
 * invented from `now` is not.
 *
 * **Every time boundary is the first instant its rule holds**, so
 * {@link ActiveSessionListing.nextBoundaryAt} is exactly when a caller must
 * recompute — one `setTimeout`, not a polling interval that stops mattering the
 * moment nothing is live.
 */
import {
  HARNESS_EVENT_GRACE_MS,
  PERSON_STARTED,
  sessionActivitySource,
  type ChatSessionRecord,
  type ChatWaitingReason,
  type SessionActivitySource,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionProvenance,
  type SessionRecord,
  type Ticket,
  type LatestSessionSignal,
} from "@volli/shared";

import { sessionSourceLabel } from "../ticket/session-history";
import { chatTabId } from "../ticket/ticket-chat-tab";
import {
  sessionActivityState,
  sessionPanes,
  WORKING_WINDOW_MS,
  type SessionContainer,
  type SessionPane,
  type SessionTab,
} from "../../stores/sessions";

/**
 * How long a Session that has gone quiet stays in Active. Long enough that
 * stepping away from a running agent does not reshuffle the list under you,
 * short enough that Active still means "recent".
 */
export const ACTIVE_QUIET_WINDOW_MS = 30 * 60_000;

/**
 * How long a ticket's Sessions linger in Previous after it lands in Done. The
 * ticket is finished; its Sessions are the trace of finishing it, and stay
 * reachable for one hour of "wait, what did it actually do".
 */
export const DONE_LINGER_MS = 60 * 60_000;

/** How old a Previous row gets before it counts as concluded business. */
export const PREVIOUS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Where a row's click lands — and, because a row is selected exactly when its
 * target is the tab in front of you, the only thing that makes a row look
 * current.
 *
 * The two kinds are different doors, not one door with an optional field. A
 * terminal tab can be split, so the row names the pane it speaks for and the
 * sessions store has to be told which pane is in front; a chat tab is one
 * surface, and reaching it means adopting the Session through the chat store
 * before the tab has anything behind it. A row with no target at all is a
 * Session whose tab is gone — an ended terminal — and it can only offer its
 * ticket.
 */
export type ActiveSessionTarget =
  | { kind: "terminal"; tabId: string; paneId: string }
  | { kind: "chat"; tabId: string; sessionId: string };

/** Which execution surface a row speaks for — one of the two axes the Previous band filters on. */
export type SessionRowKind = "terminal" | "chat";

/** Whose work a row is — the Previous band's second filter axis (VC-196). */
export type SessionRowScope = "project" | "ticket";

/**
 * Which scope a Session was created in. The immutable creation fact matters:
 * an archived ticket can leave its Session without a current `ticketId`, but
 * that does not turn the Ticket Session into a Project Session.
 */
export function sessionRowScope(session: { readonly bornTicketless: boolean }): SessionRowScope {
  return session.bornTicketless ? "project" : "ticket";
}

/**
 * Why this row needs a human. `blocked` is the agent's own voluntary `volli
 * session` signal and carries its words; `waiting` is the involuntary hook
 * channel, which is more reliable but has nothing to say beyond the fact.
 *
 * A legacy `done` signal is deliberately not attention. It may remain in the
 * durable protocol for terminal compatibility, but an agent yielding cannot
 * decide that the ticket is complete or ready for human review.
 *
 * This is what carries the needs-you signal now that there is no needs-you
 * band: a row with an attention sorts to the top of Active and draws its
 * attention dot from here, so the vocabulary is exactly the one the promoted
 * Needs-Review row has always spoken.
 */
export interface SessionAttention {
  signal: "blocked" | "waiting";
  reason: string | null;
}

export interface ActiveSessionRow {
  id: string;
  /**
   * The ticket this row belongs to, or `null` for a ticketless Session — a
   * project Project Session, or one whose ticket has left the board.
   */
  ticket: Ticket | null;
  title: string;
  /**
   * What is running here (`sessionSourceLabel`) — the harness, `Shell`, or the
   * chat adapter. The row shows it in its hover `title`, and in its meta line
   * only when there is no ticket whose status could stand there instead
   * (`session-band-row.tsx`). Still built for every row either way: which one
   * of those two it is, is the view's call and not the listing's.
   */
  source: string;
  /** Never `null`: every row here speaks for a Session, and a Session is always in some state. */
  activity: SessionActivityState;
  /**
   * Whether the row's activity is the harness's own report or the PTY
   * heuristic's guess — `silent` when hooks were expected and never arrived,
   * the one degradation the user was promised against.
   */
  activitySource: SessionActivitySource;
  attention: SessionAttention | null;
  /**
   * What a waiting CHAT is waiting for, straight off its record; `null` on
   * every other row, including a terminal waiting via the hook channel — that
   * channel reports only that someone is needed, never what for.
   *
   * The enum travels rather than a sentence because the words belong to the
   * view. This module decides which band a Session is in; it does not decide
   * how to ask a person for a decision.
   */
  waitingOn: ChatWaitingReason | null;
  /**
   * The newest activity this row can honestly date. Terminal output wins while
   * live; a durable Session fact is the fallback after relaunch. `null` means
   * neither source can name an age.
   */
  lastActivityAt: number | null;
  /**
   * Who started this Session (VC-131). Carried on every row of both bands — the
   * rule is that a Run-started Session is distinguishable *everywhere* a
   * Session appears, and a band that carried it on the loud rows only would
   * have made the quiet band the place a Run could hide.
   *
   * {@link PERSON_STARTED} is the overwhelming majority, and it draws nothing.
   */
  provenance: SessionProvenance;
  target: ActiveSessionTarget | null;
}

/**
 * Whether a ticketless row — a project terminal pane or a ticketless chat —
 * names the tab currently in front on Home.
 *
 * A terminal target additionally has to name the split pane in front, since a
 * tab can hold several; a chat target is one surface, so naming its tab
 * (`homeActiveTab`, the workspace store's record of which Home tab is in front)
 * is the whole answer.
 *
 * BOTH kinds are decided by `homeActiveTab` alone — which is what VC-54 changed
 * here, and it is a simplification rather than a translation. The terminal
 * branch used to read the terminal CONTAINER's `activeSessionId` instead,
 * because the old record could be `null` for a project that had never had a tab
 * in front and so could not be trusted to name the terminal. It then needed a
 * second clause to rule out a chat covering that terminal, since selecting a
 * chat deliberately leaves the container's ledger where it was.
 *
 * `homeActiveTab` has no null: it defaults to the permanent Board tab and every
 * path that puts a Session in front records it. So one comparison answers the
 * whole question, the chat-covering clause dissolves into it, and the Board tab
 * — which the container's ledger cannot represent at all — correctly lights
 * nothing. Before this, standing on the board lit whichever terminal row the
 * container still remembered, which claimed to be the thing you were looking at
 * while you were looking at the board.
 *
 * The container is still consulted, for the one fact only it holds: WHICH PANE
 * is in front inside a split tab.
 */
export function isProjectSessionRowSelected(
  row: ActiveSessionRow | PreviousSessionRow,
  /** Home is the page in front (nav only — which TAB is `homeActiveTab`'s job). */
  homeVisible: boolean,
  projectContainer: SessionContainer | undefined,
  homeActiveTab: string,
): boolean {
  if (!homeVisible || row.ticket !== null) return false;
  const target = row.target;
  if (target === null || homeActiveTab !== target.tabId) return false;
  if (target.kind === "chat") return true;
  const activeTab = projectContainer?.tabs.find(({ sessionId }) => sessionId === target.tabId);
  return activeTab?.activePaneId === target.paneId;
}

/**
 * The `lastOutputAt` entries {@link buildActiveSessionListing} can actually
 * read for one project — every tab root and every pane under the containers it
 * walks, and nothing else.
 *
 * The store keeps ONE flat output-stamp map for every live session in the app
 * and replaces it wholesale on each bump (a busy session bumps about once a
 * second), so a component subscribed to the map itself rebuilds this project's
 * whole listing whenever any OTHER project's terminal prints a line. Projecting
 * the map down to the keys the build can name is what makes that subscription
 * honest: shallow-compared, an irrelevant bump now yields the same object and
 * the listing is never rebuilt for it.
 *
 * Semantics-preserving by construction rather than by approximation — the raw
 * stamps come through untouched, so recency ordering and every quiet window are
 * computed from exactly the numbers they were before. It is a narrower
 * SUBSCRIPTION, not a coarser input.
 */
export function listingOutputStamps(input: {
  lastOutputAt: Readonly<Record<string, number>>;
  containers: Readonly<Record<string, SessionContainer>>;
  /** The project's ticket ids — the container keys its ticket Sessions live under. */
  ticketIds: Iterable<string>;
  /** The project's own id, which is the container key its Project Sessions live under. */
  projectOwnerId: string;
}): Record<string, number> {
  const stamps: Record<string, number> = {};
  const take = (sessionId: string): void => {
    const at = input.lastOutputAt[sessionId];
    if (at !== undefined) stamps[sessionId] = at;
  };
  const takeContainer = (ownerId: string): void => {
    const container = input.containers[ownerId];
    if (container === undefined) return;
    for (const tab of container.tabs) {
      // Both, and not just the panes: an exited tab is dated by its ROOT id
      // (`fileExitedTab`), which in a split tab is no longer any live pane.
      take(tab.sessionId);
      for (const pane of sessionPanes(tab.layout)) take(pane.sessionId);
    }
  };
  for (const ticketId of input.ticketIds) takeContainer(ticketId);
  takeContainer(input.projectOwnerId);
  return stamps;
}

/**
 * A Previous-band row. Deliberately smaller than {@link ActiveSessionRow}: this
 * band renders one line per Session, so it carries identity, when the Session
 * last did anything, and how to get back to it — and nothing a one-line row
 * cannot show.
 */
export interface PreviousSessionRow {
  id: string;
  ticket: Ticket | null;
  title: string;
  kind: SessionRowKind;
  /** Epoch ms of the last thing this Session did: a terminal's end or output, a chat's last fact. */
  endedOrQuietAt: number;
  /** See {@link ActiveSessionRow.provenance} — both bands carry it, for one reason. */
  provenance: SessionProvenance;
  target: ActiveSessionTarget | null;
  /**
   * Whether a cleanup rule matched this row and it is here only because
   * {@link SessionListingFilter.showCleaned} asked for it.
   */
  cleaned: boolean;
}

/**
 * The Previous band's rows, arranged the way it draws them: one entry per
 * ticket, plus a bare entry for each session that has no ticket to sit under.
 *
 * **Only Previous is grouped, and that is a decision rather than a first
 * step** (VC-69). Grouping Active was prototyped and rejected: same-ticket
 * concurrency is rare there (a typical Active band is a handful of rows on as
 * many different tickets), so a parent row is usually a container for one
 * child, and it puts a disclosure in front of a destination that is currently
 * one click away — on the one surface whose whole job is to be the fastest in
 * the app. Telling two live sessions on one ticket apart is a peeking problem,
 * not a hierarchy problem, and belongs to hover-peek (VC-30).
 *
 * What that buys, beyond the click: **no entry here ever carries an attention
 * cue, and none has to.** A Session needing a human is pinned to Active for as
 * long as it is asking ({@link activeGroup} short-circuits the quiet window on
 * `attention`), so nothing behind a collapsed ticket can be waiting on anyone.
 * A dot on a ticket entry would be a signal that is structurally always the
 * same, which is the kind of mark that teaches a reader to stop looking.
 */
export type PreviousListingEntry =
  | {
      kind: "session";
      /** Stable across rebuilds: the row's own id. */
      id: string;
      row: PreviousSessionRow;
    }
  | {
      kind: "ticket";
      /** Stable across rebuilds: the ticket's id, which is also the expansion key. */
      id: string;
      ticket: Ticket;
      /** This ticket's sessions, newest first. Never empty. */
      rows: PreviousSessionRow[];
      /**
       * The newest child's stamp — the recency a collapsed entry stands in for,
       * and the reason the entry does not have to be expanded to be placed.
       */
      newestAt: number;
    };

/**
 * Arranges an already-built Previous band into {@link PreviousListingEntry}s.
 *
 * Separate from {@link buildActiveSessionListing} rather than a field on it,
 * because it is a pure rearrangement of that function's own output: the band
 * has already been cleaned, filtered and sorted, and grouping must not be able
 * to change which rows survive or which order they are in. Keeping it a second
 * function is what makes that guarantee checkable — this one cannot see any of
 * the inputs those decisions were made from.
 *
 * **Order comes from first appearance, and that is the whole ordering rule.**
 * The band arrives sorted by recency, so a ticket lands at the rank of its most
 * recent session and its children are already newest-first. No second
 * comparator, and no way for the two orders to disagree.
 *
 * **Every ticket gets an entry, including one with a single session.** Skipping
 * those was tried and reverted: it saves nothing in the collapsed steady state
 * — one unparented session row and one single-session ticket row are both one
 * row — and it costs a band whose top level is sometimes a ticket and sometimes
 * a session. A uniform field is worth the rows it costs when expanded.
 *
 * Ticketless (project) sessions are never grouped with each other: they have no
 * ticket in common, only the absence of one, so they stay top-level as their
 * own `session` entries — which is also what VC-54's Home taxonomy asks for.
 */
export function groupPreviousByTicket(rows: readonly PreviousSessionRow[]): PreviousListingEntry[] {
  const entries: PreviousListingEntry[] = [];
  const byTicket = new Map<string, Extract<PreviousListingEntry, { kind: "ticket" }>>();
  for (const row of rows) {
    const ticket = row.ticket;
    if (ticket === null) {
      entries.push({ kind: "session", id: row.id, row });
      continue;
    }
    const existing = byTicket.get(ticket.id);
    if (existing === undefined) {
      const entry: Extract<PreviousListingEntry, { kind: "ticket" }> = {
        kind: "ticket",
        id: ticket.id,
        ticket,
        rows: [row],
        // The first row of a recency-sorted band IS the newest for this ticket,
        // so this is read once and never maximised over the rest.
        newestAt: row.endedOrQuietAt,
      };
      byTicket.set(ticket.id, entry);
      entries.push(entry);
      continue;
    }
    existing.rows.push(row);
  }
  return entries;
}

export interface ActiveSessionListing {
  active: ActiveSessionRow[];
  previous: PreviousSessionRow[];
  /**
   * Epoch ms of the next moment this listing changes with no new input — a row
   * ageing out of Active, a cleanup rule newly firing, a working row going
   * quiet, a hooked launch running out of grace to report. `null` when nothing
   * about the result depends on the clock any more.
   *
   * It is the COMPLETE answer, which is what lets a caller hold one timer and
   * no interval: every use of `now` inside the build either has its boundary
   * reported here or belongs to a row that cannot change on the clock at all.
   */
  nextBoundaryAt: number | null;
}

/**
 * What the Previous band shows. Cleanup decides what it *would* show; this
 * decides what it does — `showCleaned` being the escape hatch for the user who
 * knows a Session existed and wants to know where it went.
 */
export interface SessionListingFilter {
  /** Which kinds to show; `null` is every kind. */
  kinds: ReadonlySet<SessionRowKind> | null;
  /**
   * Which scopes to show; `null` is every scope. Independent of
   * {@link SessionListingFilter.kinds} — the two narrow different questions
   * (what a Session runs on, whose work it is) and a row must satisfy both.
   */
  scopes: ReadonlySet<SessionRowScope> | null;
  /** Whether cleaned-away rows come back, marked {@link PreviousSessionRow.cleaned}. */
  showCleaned: boolean;
}

export interface BuildActiveSessionListingInput {
  tickets: readonly Ticket[];
  containers: Readonly<Record<string, SessionContainer>>;
  /** Latest durable Session signal by ticket, fetched from Session Engine projections. */
  signalsByTicket: Readonly<Record<string, LatestSessionSignal>>;
  records: readonly SessionRecord[];
  /**
   * The project's project container — Sessions started outside any ticket.
   *
   * It arrives on its own key because {@link BuildActiveSessionListingInput.containers}
   * is walked BY TICKET, while the store files a project container in that same
   * flat map under the PROJECT's id (`ownerKey`: projectId for a project Session, ticketId
   * for ticket). A live project terminal therefore sat under a key no ticket
   * loop would ever ask for, and reached neither band — only its ended siblings
   * got in, via the durable records below. Absent reads as none.
   */
  projectContainer?: SessionContainer;
  /**
   * Chat Sessions across this project — structured Sessions with no terminal
   * attachment. They carry their own activity and recency, so they join both
   * bands on the same terms a terminal does; optional, and absent reads as
   * none. Defaults to `[]`.
   */
  chatSessions?: readonly ChatSessionRecord[];
  lastOutputAt: Readonly<Record<string, number>>;
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  /** Per-session harness reporting state; a missing entry means nothing reports here. */
  harness: Readonly<Record<string, SessionHarnessState>>;
  /**
   * Who started each Session, keyed by Session id and **sparse** — a miss is
   * the resting case (`stores/project-sessions.ts`). A listing built with this
   * absent marks nothing, which is the right failure: a band that cannot read
   * provenance should be quiet rather than guessing at a bolt.
   */
  provenance?: Readonly<Record<string, SessionProvenance>>;
  /**
   * ticketId → epoch ms it entered its CURRENT status. Two cleanup rules need
   * it and neither guesses without it: a ticket missing from this map is one
   * whose column history we do not have, so those rules stay silent for its
   * Sessions. Defaults to empty.
   */
  statusEnteredAt?: ReadonlyMap<string, number>;
  /** Defaults to every kind, cleaned rows hidden. */
  filter?: SessionListingFilter;
  now: number;
}

const EMPTY_STATUS_ENTERED_AT: ReadonlyMap<string, number> = new Map();
const NO_PROVENANCE: Readonly<Record<string, SessionProvenance>> = {};
const DEFAULT_FILTER: SessionListingFilter = { kinds: null, scopes: null, showCleaned: false };

function sessionSource(record: SessionRecord | undefined): string {
  return record === undefined ? "Terminal" : sessionSourceLabel({ kind: "terminal", record });
}

type ActivityInput = Pick<
  BuildActiveSessionListingInput,
  "lastOutputAt" | "parkState" | "harness" | "now"
>;

function paneActivity(pane: SessionPane, input: ActivityInput): SessionActivityState {
  return sessionActivityState(
    input.lastOutputAt[pane.sessionId] ?? null,
    pane.exitCode !== null,
    input.now,
    input.parkState[pane.sessionId]?.parked ?? false,
    input.harness[pane.sessionId]?.declared ?? null,
  );
}

/**
 * Where a pane's activity came from. A pane with no harness entry at all — a
 * bare shell, a session that predates the channel — is inferred, which is the
 * truth and never a complaint.
 */
function paneActivitySource(sessionId: string, input: ActivityInput): SessionActivitySource {
  const state = input.harness[sessionId];
  return state === undefined ? "inferred" : sessionActivitySource(state, input.now);
}

const ACTIVITY_PRIORITY: Record<SessionActivityState, number> = {
  waiting: 0,
  working: 1,
  idle: 2,
  parked: 3,
  exited: 4,
  // A pane never produces it (the stop fact is chat-side, VC-86); ranked last
  // so the map stays total without ever outranking a live state.
  stopped: 5,
};

/**
 * The Active band's sort groups, top to bottom. Data-driven so a future group
 * is an insert rather than a rewrite of the comparator.
 */
const ACTIVE_GROUP = { waiting: 0, working: 1, recent: 2 } as const;

type ActiveGroup = (typeof ACTIVE_GROUP)[keyof typeof ACTIVE_GROUP];

/** One of a tab's panes, with the activity it is currently in. */
interface PaneState {
  paneId: string;
  activity: SessionActivityState;
}

/**
 * A tab's panes with their activity, highest-priority first. The head is the
 * pane a row is promoted (or not) on — and it has to be the pane the rest of
 * the row describes too. Reading activity from the whole tab while reading its
 * source, its record and its click target from `activePaneId` let one row say
 * two things at once: in a split whose background pane had just declared
 * `input.needed`, that pane pulled the row to the top of Active while the
 * source line described the plain shell in front, so the row claimed a
 * harness-declared wait and reported that nothing was reporting — and the
 * click landed on the pane that wasn't asking for anything.
 */
function tabPaneStates(tab: SessionTab, input: ActivityInput): PaneState[] {
  return sessionPanes(tab.layout)
    .map((pane) => ({ paneId: pane.sessionId, activity: paneActivity(pane, input) }))
    .toSorted((a, b) => ACTIVITY_PRIORITY[a.activity] - ACTIVITY_PRIORITY[b.activity]);
}

/** The pane a tab's row speaks for when no agent signal names another. */
function tabSubject(tab: SessionTab, input: ActivityInput): PaneState {
  return tabPaneStates(tab, input)[0]!;
}

/**
 * A row for one live tab, every word of it about `subject` — the single pane
 * the row speaks for. Activity, where that activity came from, the durable
 * record behind the source label, and the pane a click opens are all read off
 * that one id here rather than chosen per call site, because choosing them
 * separately is how the row learned to contradict itself.
 */
function sessionRow(
  ticket: Ticket | null,
  tab: SessionTab,
  subject: PaneState,
  attention: SessionAttention | null,
  input: ActivityInput,
  recordsById: ReadonlyMap<string, SessionRecord>,
  provenance: SessionProvenance,
): ActiveSessionRow {
  return {
    id: `session:${tab.sessionId}`,
    ticket,
    title: tab.title,
    source: sessionSource(recordsById.get(subject.paneId)),
    activity: subject.activity,
    activitySource: paneActivitySource(subject.paneId, input),
    attention,
    waitingOn: null,
    lastActivityAt:
      input.lastOutputAt[subject.paneId] ?? recordsById.get(subject.paneId)?.lastActivityAt ?? null,
    provenance,
    target: { kind: "terminal", tabId: tab.sessionId, paneId: subject.paneId },
  };
}

/** A chat Session's row. Its activity is the adapter's own word, never a PTY heuristic. */
function chatRow(
  record: ChatSessionRecord,
  ticket: Ticket | null,
  provenance: SessionProvenance,
): ActiveSessionRow {
  return {
    id: `chat:${record.sessionId}`,
    ticket,
    title: record.title,
    source: sessionSourceLabel({ kind: "chat", record }),
    activity: record.activity,
    activitySource: "reported",
    attention: record.activity === "waiting" ? { signal: "waiting", reason: null } : null,
    // The record's two waiting fields move together by construction in main, so
    // this rides along with the attention above rather than being re-decided.
    waitingOn: record.waitingOn,
    lastActivityAt: record.lastActivityAt,
    provenance,
    // A chat Session's tab id is derivable from the Session, whether or not a
    // tab is open. For a ticket-owned Session this names its ticket-tab
    // destination; ticket-independent chat hosting belongs to Session 5.
    target: { kind: "chat", tabId: chatTabId(record.sessionId), sessionId: record.sessionId },
  };
}

/** The facts a cleanup rule may consult. Nothing here is derived from how a row renders. */
export interface SessionCleanupFacts {
  /** The Session's own ticket id; `null` for a ticketless Session. */
  ticketId: string | null;
  /** That ticket as the board currently knows it; `null` once it is no longer there. */
  ticket: Ticket | null;
  /** Epoch ms the Session was created, or `null` when nothing durable can date it. */
  createdAt: number | null;
  /** Epoch ms of the last thing the Session did. */
  endedOrQuietAt: number;
  /** Whether the Session's execution surface is still attached — a live PTY, an open chat. */
  attached: boolean;
  /** Whether the Session was created without a ticket, per the immutable creation event. */
  bornTicketless: boolean;
  statusEnteredAt: ReadonlyMap<string, number>;
  now: number;
}

/**
 * Sessions cleanup must never touch, whatever the rules say.
 *
 * A Session BORN ticketless has no ticket to fall back to: clean it and there
 * is no board row, no ticket rail, no second surface it can be reached from —
 * it is simply stranded. A Session that merely BECAME ticketless (its ticket
 * was deleted, `ON DELETE SET NULL`) is not exempt: its birth ticket is gone
 * from the board, which is exactly the situation rule (a) cleans, and
 * `bornTicketless` — folded from the immutable `session.created` event — is
 * what tells the two apart. An attached Session is not concluded business by
 * definition; a live pane vanishing out of the sidebar is the one outcome no
 * cleanup rule is worth.
 */
export function isCleanupExempt(
  facts: Pick<SessionCleanupFacts, "ticketId" | "attached" | "bornTicketless">,
): boolean {
  return (facts.ticketId === null && facts.bornTicketless) || facts.attached;
}

/**
 * Whether a Previous-band Session is concluded business — over, and not worth a
 * row. Four rules, in the order they can be decided:
 *
 * (a) its ticket is gone from the board (archived), so Session 4 preserves it
 * only behind Cleaned up and cannot reopen a ticket workspace; (b) the ticket
 * has been in Done for {@link DONE_LINGER_MS}; (c) the Session predates the
 * ticket's entry into its CURRENT column, so it traces some earlier stretch of
 * work rather than this one; (d) it is
 * {@link PREVIOUS_MAX_AGE_MS} old.
 *
 * (b) and (c) both need `statusEnteredAt`, which is a fact this module is given
 * rather than one it can derive. A ticket missing from that map is one whose
 * column history we do not have — both rules stay silent for it, because a
 * cleanup rule guessing is a Session disappearing for no reason.
 */
export function isConcludedBusiness(facts: SessionCleanupFacts): boolean {
  if (isCleanupExempt(facts)) return false;
  if (facts.ticket === null) return true;
  const enteredAt = facts.statusEnteredAt.get(facts.ticket.id);
  if (enteredAt !== undefined) {
    if (facts.ticket.status === "done" && facts.now - enteredAt >= DONE_LINGER_MS) return true;
    if (facts.createdAt !== null && facts.createdAt < enteredAt) return true;
  }
  return facts.now - facts.endedOrQuietAt >= PREVIOUS_MAX_AGE_MS;
}

/** An Active row with the keys it is sorted by. */
interface ActiveEntry {
  row: ActiveSessionRow;
  group: ActiveGroup;
  /** How recently this row did anything — the within-group sort key. */
  recency: number;
  /** The stamp the quiet window is measured from; `null` when nothing can date it. */
  quietAt: number | null;
}

/** A Previous-band candidate, before cleanup and filtering have had their say. */
interface PreviousCandidate {
  row: PreviousSessionRow;
  ticketId: string | null;
  createdAt: number | null;
  attached: boolean;
  bornTicketless: boolean;
}

/**
 * Which Active group a row belongs to, or `null` when it has aged out of Active
 * altogether. Order matters: an attention outranks everything (that is the
 * whole needs-you signal now), and the window is the last thing asked — so a
 * Session that asked a question stays up whatever its age, and every other row
 * leaves on the clock.
 */
function activeGroup(
  row: ActiveSessionRow,
  quietAt: number | null,
  attached: boolean,
  now: number,
): ActiveGroup | null {
  if (row.attention !== null) return ACTIVE_GROUP.waiting;
  if (row.activity === "working" && attached) return ACTIVE_GROUP.working;
  // Nothing can date this row — the post-relaunch live terminal — so it stays
  // rather than vanishing on the strength of a stamp we never had.
  if (quietAt === null) return ACTIVE_GROUP.recent;
  return now - quietAt < ACTIVE_QUIET_WINDOW_MS ? ACTIVE_GROUP.recent : null;
}

/**
 * Builds the sidebar's two session bands. See the module comment for what each
 * band means; this is the order the answer is assembled in:
 *
 *   1. every ticket's live tabs, plus the Needs-Review promotion that hands one
 *      of them the ticket's latest attention signal, plus its exited tabs; then
 *      the project's project container's tabs on the same terms, ticketless;
 *   2. durable terminal records and chat Sessions, which is where ended and
 *      ticketless Sessions enter;
 *   3. cleanup, filtering, ordering and the boundary clock.
 */
export function buildActiveSessionListing(
  input: BuildActiveSessionListingInput,
): ActiveSessionListing {
  const now = input.now;
  const filter = input.filter ?? DEFAULT_FILTER;
  const statusEnteredAt = input.statusEnteredAt ?? EMPTY_STATUS_ENTERED_AT;
  const chatSessions = input.chatSessions ?? [];
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const ticketsById = new Map(input.tickets.map((ticket) => [ticket.id, ticket]));
  /**
   * Who started one Session. The map is sparse and its holes ARE the resting
   * case, so a miss is {@link PERSON_STARTED} rather than an unknown — and the
   * shared frozen constant is handed back rather than a fresh literal, so the
   * memoised rows are not defeated by a new object per rebuild.
   */
  const provenanceOf = (sessionId: string): SessionProvenance =>
    (input.provenance ?? NO_PROVENANCE)[sessionId] ?? PERSON_STARTED;

  const activeEntries: ActiveEntry[] = [];
  const previousById = new Map<string, PreviousCandidate>();
  /** Pane ids the live layout already covers, so a durable record never doubles one. */
  const mountedPaneIds = new Set<string>();

  /** The documented terminal quiet-stamp chain: last output, else the durable end, else nothing. */
  const quietStamp = (paneId: string): number | null =>
    input.lastOutputAt[paneId] ?? recordsById.get(paneId)?.endedAt ?? null;

  /**
   * How recently a terminal row did anything, when no quiet stamp can say. A
   * ticket dates its own rows; a project Session tab has no ticket to borrow from and
   * falls back to the Session's own newest durable fact, then to 0 — a sort key
   * we could not establish, never a stamp invented from `now`.
   */
  const recencyFallback = (ticket: Ticket | null, paneId: string): number =>
    ticket?.updatedAt ?? recordsById.get(paneId)?.lastActivityAt ?? 0;

  /**
   * Whether a terminal row's Session was born without a ticket. The durable
   * record answers wherever we have one; otherwise a `null` ticket here means
   * the row came out of the PROJECT container, and a project container holding
   * a pane is itself proof of ticketless birth — the store files it under
   * `ownerKey({kind: "project"})`, a key only a Session created with no ticket
   * can ever land on. This matters because a live project Session pane's record is
   * routinely absent from `records` (that listing leads with ended Sessions),
   * and defaulting to `false` there would strip the cleanup exemption from
   * exactly the rows {@link isCleanupExempt} exists to protect.
   */
  const bornTicketlessOf = (ticket: Ticket | null, paneId: string): boolean =>
    recordsById.get(paneId)?.bornTicketless ?? ticket === null;

  /** Files one terminal tab's row into whichever band its state earns. */
  const fileTab = (row: ActiveSessionRow, ticket: Ticket | null, subject: PaneState): void => {
    const quietAt = quietStamp(subject.paneId);
    const attached = subject.activity !== "exited";
    const recency = quietAt ?? recencyFallback(ticket, subject.paneId);
    const group = activeGroup(row, quietAt, attached, now);
    if (group !== null) {
      activeEntries.push({ row, group, recency, quietAt });
      return;
    }
    previousById.set(row.id, {
      row: {
        id: row.id,
        ticket,
        title: row.title,
        kind: "terminal",
        endedOrQuietAt: recency,
        // Taken off the Active row rather than looked up again: the two bands
        // are one Session seen at two ages, so a second read is a second
        // chance for them to disagree.
        provenance: row.provenance,
        target: row.target,
        cleaned: false,
      },
      ticketId: ticket?.id ?? null,
      createdAt: recordsById.get(subject.paneId)?.createdAt ?? null,
      attached,
      bornTicketless: bornTicketlessOf(ticket, subject.paneId),
    });
  };

  /**
   * Files an exited tab into Previous. It is a concluded Session the layout can
   * still reopen, so it keeps its target — but it is over, and Previous is
   * where over lives.
   */
  const fileExitedTab = (tab: SessionTab, ticket: Ticket | null): void => {
    previousById.set(`session:${tab.sessionId}`, {
      row: {
        id: `session:${tab.sessionId}`,
        ticket,
        title: tab.title,
        kind: "terminal",
        endedOrQuietAt: quietStamp(tab.sessionId) ?? recencyFallback(ticket, tab.sessionId),
        provenance: provenanceOf(tab.sessionId),
        target: { kind: "terminal", tabId: tab.sessionId, paneId: tab.activePaneId },
        cleaned: false,
      },
      ticketId: ticket?.id ?? null,
      createdAt: recordsById.get(tab.sessionId)?.createdAt ?? null,
      attached: false,
      bornTicketless: bornTicketlessOf(ticket, tab.sessionId),
    });
  };

  // 1. Live tabs, one row each, plus the Needs-Review promotion.
  for (const ticket of input.tickets) {
    const container = input.containers[ticket.id];
    const tabs = container?.tabs ?? [];
    for (const tab of tabs) {
      for (const pane of sessionPanes(tab.layout)) mountedPaneIds.add(pane.sessionId);
    }
    const liveTabs = tabs.filter((tab) => tabSubject(tab, input).activity !== "exited");

    let promotedTabId: string | null = null;
    if (ticket.status === "needs_review") {
      const signal = input.signalsByTicket[ticket.id];
      // A CLI signal names the exact pane that raised it. Only a signal whose
      // pane is still in some tab can be routed to a row, so `exact` stands for
      // both facts at once: there is a signal, and we found where it lives.
      let signaledTab: SessionTab | undefined;
      let exact: (LatestSessionSignal & { signal: "blocked" }) | null = null;
      // `done` is retained in the durable signal vocabulary for compatibility,
      // but it is not a product attention state. Only a blocked signal can
      // choose and promote an exact pane in the Session navigator.
      if (signal?.signal === "blocked") {
        signaledTab = tabs.find((tab) =>
          sessionPanes(tab.layout).some((pane) => pane.sessionId === signal.sessionId),
        );
        if (signaledTab !== undefined) exact = { ...signal, signal: "blocked" };
      }
      const fallbackTab =
        liveTabs.find((tab) => tab.sessionId === container?.activeSessionId) ?? liveTabs.at(-1);
      const attentionTab = signaledTab ?? fallbackTab;
      if (attentionTab !== undefined) {
        promotedTabId = attentionTab.sessionId;
        const paneStates = tabPaneStates(attentionTab, input);
        let subject: PaneState;
        if (exact === null) {
          subject = paneStates[0]!;
        } else {
          // `signaledTab` was found BY this pane's presence in it, so the
          // lookup cannot miss.
          const signaledPaneId = exact.sessionId;
          subject = paneStates.find((pane) => pane.paneId === signaledPaneId)!;
        }
        // The agent's own signal wins where there is one: a hook payload knows
        // that a human is needed, but only the CLI signal knows what for.
        const attention: SessionAttention | null =
          exact !== null
            ? { signal: "blocked", reason: exact.reason }
            : subject.activity === "waiting"
              ? { signal: "waiting", reason: null }
              : null;
        fileTab(
          sessionRow(
            ticket,
            attentionTab,
            subject,
            attention,
            input,
            recordsById,
            provenanceOf(attentionTab.sessionId),
          ),
          ticket,
          subject,
        );
      }
    }

    for (const tab of liveTabs) {
      if (tab.sessionId === promotedTabId) continue;
      const subject = tabSubject(tab, input);
      const row = sessionRow(
        ticket,
        tab,
        subject,
        subject.activity === "waiting" ? { signal: "waiting", reason: null } : null,
        input,
        recordsById,
        provenanceOf(tab.sessionId),
      );
      fileTab(row, ticket, subject);
    }

    for (const tab of tabs) {
      if (tab.sessionId === promotedTabId) continue;
      if (tabSubject(tab, input).activity !== "exited") continue;
      fileExitedTab(tab, ticket);
    }
  }

  // 1b. The project's project container, on exactly the terms a ticket's tabs
  // get. A Project Session has no ticket, so it can never be the Needs-Review
  // promotion; but it is a terminal the user started and is watching, and a
  // band that omits it is wrong about what is running. Ended Project Sessions
  // already arrived through the durable records below; this is the live half
  // that had no route in.
  const projectSessionTabs = input.projectContainer?.tabs ?? [];
  for (const tab of projectSessionTabs) {
    for (const pane of sessionPanes(tab.layout)) mountedPaneIds.add(pane.sessionId);
  }
  for (const tab of projectSessionTabs) {
    const subject = tabSubject(tab, input);
    if (subject.activity === "exited") {
      fileExitedTab(tab, null);
      continue;
    }
    fileTab(
      sessionRow(
        null,
        tab,
        subject,
        subject.activity === "waiting" ? { signal: "waiting", reason: null } : null,
        input,
        recordsById,
        provenanceOf(tab.sessionId),
      ),
      null,
      subject,
    );
  }

  // 2a. Durable terminal records: every ended Session the live layout is not
  // already showing. Split panes never stand alone as a row, and a record with
  // no end is either mounted above or a live-looking leftover nothing can date.
  for (const record of input.records) {
    if (record.endedAt === null || record.placement === "split") continue;
    if (mountedPaneIds.has(record.id)) continue;
    const ticket = record.ticketId === null ? null : (ticketsById.get(record.ticketId) ?? null);
    previousById.set(`session:${record.id}`, {
      row: {
        id: `session:${record.id}`,
        ticket,
        title: record.title,
        kind: "terminal",
        endedOrQuietAt: record.endedAt,
        provenance: provenanceOf(record.id),
        target: null,
        cleaned: false,
      },
      ticketId: record.ticketId,
      createdAt: record.createdAt,
      attached: false,
      bornTicketless: record.bornTicketless,
    });
  }

  // 2b. Chat Sessions, which carry their own activity and recency.
  for (const record of chatSessions) {
    const ticket = record.ticketId === null ? null : (ticketsById.get(record.ticketId) ?? null);
    const row = chatRow(record, ticket, provenanceOf(record.sessionId));
    const group = activeGroup(row, record.lastActivityAt, record.live, now);
    if (group !== null) {
      activeEntries.push({
        row,
        group,
        recency: record.lastActivityAt,
        quietAt: record.lastActivityAt,
      });
      continue;
    }
    previousById.set(row.id, {
      row: {
        id: row.id,
        ticket,
        title: record.title,
        kind: "chat",
        endedOrQuietAt: record.lastActivityAt,
        provenance: row.provenance,
        target: row.target,
        cleaned: false,
      },
      ticketId: record.ticketId,
      createdAt: record.createdAt,
      attached: record.live,
      bornTicketless: record.bornTicketless,
    });
  }

  // 3. Cleanup, filtering, ordering, and the one boundary the caller waits on.
  let nextBoundaryAt: number | null = null;
  const considerBoundary = (at: number): void => {
    if (at <= now) return;
    if (nextBoundaryAt === null || at < nextBoundaryAt) nextBoundaryAt = at;
  };

  // The two boundaries the ACTIVITY derivation moves on, for every pane the
  // walk above read one from. They are the reason a caller once needed a
  // polling clock on top of `nextBoundaryAt`: neither is a band boundary, so
  // neither was reported, and both change what a row says with no new input —
  // `working` decays to `idle` a fixed window after the last output (which also
  // drops the row out of the Active band's working group, a visible reorder),
  // and a hooked launch that never delivered stops reading as `inferred` and
  // starts reading as `silent` once its grace window is up. Reporting them here
  // is what makes this field the whole answer its own doc comment promises.
  //
  // Deliberately over-inclusive: a stamp on a parked or harness-declared pane
  // cannot actually flip anything, and a boundary that changes nothing costs
  // one recompute that finds nothing — while a missing one leaves a row saying
  // the wrong word until something unrelated happens to move.
  for (const paneId of mountedPaneIds) {
    const lastOutput = input.lastOutputAt[paneId];
    // +1: both windows are inclusive (`<=`), so the first instant the answer
    // differs is one millisecond past the window's end.
    if (lastOutput !== undefined) considerBoundary(lastOutput + WORKING_WINDOW_MS + 1);
    const startedAt = input.harness[paneId]?.startedAt;
    if (startedAt !== undefined && startedAt !== null) {
      considerBoundary(startedAt + HARNESS_EVENT_GRACE_MS + 1);
    }
  }

  for (const entry of activeEntries) {
    // Only the two groups the window actually holds can age out of Active on
    // their own; an attention row leaves when its agent moves, not on a clock.
    if (entry.group !== ACTIVE_GROUP.working && entry.group !== ACTIVE_GROUP.recent) continue;
    if (entry.quietAt !== null) considerBoundary(entry.quietAt + ACTIVE_QUIET_WINDOW_MS);
  }

  const previous: PreviousSessionRow[] = [];
  for (const candidate of previousById.values()) {
    if (filter.kinds !== null && !filter.kinds.has(candidate.row.kind)) continue;
    // Before cleanup rather than after: a row the reader has narrowed away is
    // not a row whose cleanup boundary anyone is waiting on, so skipping here
    // keeps `nextBoundaryAt` about the list actually on screen.
    if (filter.scopes !== null && !filter.scopes.has(sessionRowScope(candidate))) continue;
    const cleaned = isConcludedBusiness({
      ticketId: candidate.ticketId,
      ticket: candidate.row.ticket,
      createdAt: candidate.createdAt,
      endedOrQuietAt: candidate.row.endedOrQuietAt,
      attached: candidate.attached,
      bornTicketless: candidate.bornTicketless,
      statusEnteredAt,
      now,
    });
    if (cleaned) {
      if (filter.showCleaned) previous.push({ ...candidate.row, cleaned: true });
      continue;
    }
    const ticket = candidate.row.ticket;
    // Only a row cleanup can reach has a cleanup boundary to wait for.
    if (ticket !== null && !isCleanupExempt(candidate)) {
      const enteredAt = statusEnteredAt.get(ticket.id);
      if (ticket.status === "done" && enteredAt !== undefined) {
        considerBoundary(enteredAt + DONE_LINGER_MS);
      }
      considerBoundary(candidate.row.endedOrQuietAt + PREVIOUS_MAX_AGE_MS);
    }
    previous.push(candidate.row);
  }

  activeEntries.sort((a, b) => a.group - b.group || b.recency - a.recency);
  previous.sort((a, b) => b.endedOrQuietAt - a.endedOrQuietAt);

  return { active: activeEntries.map((entry) => entry.row), previous, nextBoundaryAt };
}
