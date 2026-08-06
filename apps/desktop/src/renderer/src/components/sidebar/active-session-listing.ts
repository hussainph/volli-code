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
  sessionActivitySource,
  type ChatSessionRecord,
  type ChatWaitingReason,
  type SessionActivitySource,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionRecord,
  type Ticket,
  type LatestSessionSignal,
} from "@volli/shared";

import { sessionSourceLabel } from "../ticket/session-history";
import { chatTabId } from "../ticket/ticket-chat-tab";
import {
  sessionActivityState,
  sessionPanes,
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

/** Which execution surface a row speaks for — the axis the Previous band filters on. */
export type SessionRowKind = "terminal" | "chat";

/**
 * Why this row needs a human. `blocked`/`done` are the agent's own voluntary
 * `volli session` signals and carry its words; `waiting` is the involuntary
 * hook channel, which is more reliable but has nothing to say beyond the fact.
 *
 * This is what carries the needs-you signal now that there is no needs-you
 * band: a row with an attention sorts to the top of Active and draws its
 * attention dot from here, so the vocabulary is exactly the one the promoted
 * Needs-Review row has always spoken.
 */
export interface SessionAttention {
  signal: "done" | "blocked" | "waiting";
  reason: string | null;
}

export interface ActiveSessionRow {
  id: string;
  /**
   * The ticket this row belongs to, or `null` for a ticketless Session — a
   * project scratch Session, or one whose ticket has left the board.
   */
  ticket: Ticket | null;
  title: string;
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
  target: ActiveSessionTarget | null;
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
  target: ActiveSessionTarget | null;
  /**
   * Whether a cleanup rule matched this row and it is here only because
   * {@link SessionListingFilter.showCleaned} asked for it.
   */
  cleaned: boolean;
}

export interface ActiveSessionListing {
  active: ActiveSessionRow[];
  previous: PreviousSessionRow[];
  /**
   * Epoch ms of the next moment this listing changes with no new input — a row
   * ageing out of Active, or a cleanup rule newly firing. `null` when nothing
   * about the result depends on the clock any more.
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
   * The project's scratch container — Sessions started outside any ticket.
   *
   * It arrives on its own key because {@link BuildActiveSessionListingInput.containers}
   * is walked BY TICKET, while the store files a scratch container in that same
   * flat map under the PROJECT's id (`ownerKey`: projectId for scratch, ticketId
   * for ticket). A live scratch terminal therefore sat under a key no ticket
   * loop would ever ask for, and reached neither band — only its ended siblings
   * got in, via the durable records below. Absent reads as none.
   */
  scratchContainer?: SessionContainer;
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
const DEFAULT_FILTER: SessionListingFilter = { kinds: null, showCleaned: false };

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
    target: { kind: "terminal", tabId: tab.sessionId, paneId: subject.paneId },
  };
}

/** A chat Session's row. Its activity is the adapter's own word, never a PTY heuristic. */
function chatRow(record: ChatSessionRecord, ticket: Ticket | null): ActiveSessionRow {
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
    // A chat Session's tab id is derivable from the Session — it exists whether
    // or not a tab is open on it right now, which is what lets a chat that has
    // never been adopted still say where it belongs.
    target: { kind: "chat", tabId: chatTabId(record.sessionId), sessionId: record.sessionId },
  };
}

/** The facts a cleanup rule may consult. Nothing here is derived from how a row renders. */
export interface SessionCleanupFacts {
  /** The Session's own ticket id; `null` for a ticketless (scratch) Session. */
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
 * (a) its ticket is gone from the board (archived), so the row navigates
 * nowhere; (b) the ticket has been in Done for {@link DONE_LINGER_MS}; (c) the
 * Session predates the ticket's entry into its CURRENT column, so it traces
 * some earlier stretch of work rather than this one; (d) it is
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
 *      the project's scratch container's tabs on the same terms, ticketless;
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

  const activeEntries: ActiveEntry[] = [];
  const previousById = new Map<string, PreviousCandidate>();
  /** Pane ids the live layout already covers, so a durable record never doubles one. */
  const mountedPaneIds = new Set<string>();

  /** The documented terminal quiet-stamp chain: last output, else the durable end, else nothing. */
  const quietStamp = (paneId: string): number | null =>
    input.lastOutputAt[paneId] ?? recordsById.get(paneId)?.endedAt ?? null;

  /**
   * How recently a terminal row did anything, when no quiet stamp can say. A
   * ticket dates its own rows; a scratch tab has no ticket to borrow from and
   * falls back to the Session's own newest durable fact, then to 0 — a sort key
   * we could not establish, never a stamp invented from `now`.
   */
  const recencyFallback = (ticket: Ticket | null, paneId: string): number =>
    ticket?.updatedAt ?? recordsById.get(paneId)?.lastActivityAt ?? 0;

  /**
   * Whether a terminal row's Session was born without a ticket. The durable
   * record answers wherever we have one; otherwise a `null` ticket here means
   * the row came out of the SCRATCH container, and a scratch container holding
   * a pane is itself proof of ticketless birth — the store files it under
   * `ownerKey({kind: "scratch"})`, a key only a Session created with no ticket
   * can ever land on. This matters because a live scratch pane's record is
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
      let exact: LatestSessionSignal | null = null;
      if (signal !== undefined) {
        signaledTab = tabs.find((tab) =>
          sessionPanes(tab.layout).some((pane) => pane.sessionId === signal.sessionId),
        );
        if (signaledTab !== undefined) exact = signal;
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
            ? { signal: exact.signal, reason: exact.reason }
            : subject.activity === "waiting"
              ? { signal: "waiting", reason: null }
              : null;
        fileTab(
          sessionRow(ticket, attentionTab, subject, attention, input, recordsById),
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
      );
      fileTab(row, ticket, subject);
    }

    for (const tab of tabs) {
      if (tab.sessionId === promotedTabId) continue;
      if (tabSubject(tab, input).activity !== "exited") continue;
      fileExitedTab(tab, ticket);
    }
  }

  // 1b. The project's scratch container, on exactly the terms a ticket's tabs
  // get. A scratch Session has no ticket, so it can never be the Needs-Review
  // promotion; but it is a terminal the user started and is watching, and a
  // band that omits it is wrong about what is running. Ended scratch Sessions
  // already arrived through the durable records below; this is the live half
  // that had no route in.
  const scratchTabs = input.scratchContainer?.tabs ?? [];
  for (const tab of scratchTabs) {
    for (const pane of sessionPanes(tab.layout)) mountedPaneIds.add(pane.sessionId);
  }
  for (const tab of scratchTabs) {
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
    const row = chatRow(record, ticket);
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

  for (const entry of activeEntries) {
    // Only the two groups the window actually holds can age out of Active on
    // their own; an attention row leaves when its agent moves, not on a clock.
    if (entry.group !== ACTIVE_GROUP.working && entry.group !== ACTIVE_GROUP.recent) continue;
    if (entry.quietAt !== null) considerBoundary(entry.quietAt + ACTIVE_QUIET_WINDOW_MS);
  }

  const previous: PreviousSessionRow[] = [];
  for (const candidate of previousById.values()) {
    if (filter.kinds !== null && !filter.kinds.has(candidate.row.kind)) continue;
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
