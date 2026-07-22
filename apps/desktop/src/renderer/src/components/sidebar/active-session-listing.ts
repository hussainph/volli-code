import {
  type SessionActivityState,
  type SessionRecord,
  type Ticket,
  type TicketEvent,
} from "@volli/shared";

import { sessionSourceLabel } from "../ticket/session-history";
import {
  findSessionPane,
  findTabBySessionId,
  sessionActivityState,
  sessionPanes,
  type SessionContainer,
  type SessionPane,
  type SessionTab,
} from "../../stores/sessions";

export interface ActiveSessionTarget {
  tabId: string;
  paneId: string;
}

export interface ActiveSessionRow {
  id: string;
  ticket: Ticket;
  title: string;
  source: string;
  activity: SessionActivityState | null;
  attention: { signal: "done" | "blocked"; reason: string | null } | null;
  target: ActiveSessionTarget | null;
}

/**
 * How a settled session concluded. `failed`/`done` are only claimed when a
 * still-mounted pane's exit code is known; `ended` is the honest label when the
 * session survives only as a durable record (no exit code is persisted, so we
 * never guess success — see the reserved `exit_code` fast-follow in the PR).
 */
export type SessionOutcome = "failed" | "done" | "ended";

/**
 * A concluded ticket session in the sidebar's settled tail. Backed by a durable
 * {@link SessionRecord} (not an ephemeral tab), so it survives tab-close and app
 * relaunch — the record's documented purpose is "trace and resume seed", which
 * is exactly what makes this row the fourth resume surface (issue #78):
 * `resumable` marks the ones carrying a harness session to resume from.
 */
export interface SettledSessionRow {
  id: string;
  ticket: Ticket;
  title: string;
  source: string;
  outcome: SessionOutcome;
  /** Epoch ms the session ended — the durable, tick-stable sort key. */
  endedAt: number;
  /** The record carries a harness session id, so it can be resumed. */
  resumable: boolean;
  /** Set when a still-mounted tab lets activation reopen the exact terminal. */
  target: ActiveSessionTarget | null;
}

export interface ActiveSessionListing {
  needsYou: ActiveSessionRow[];
  inProgress: ActiveSessionRow[];
  settled: SettledSessionRow[];
}

export interface BuildActiveSessionListingInput {
  tickets: readonly Ticket[];
  containers: Readonly<Record<string, SessionContainer>>;
  eventsByTicket: Readonly<Record<string, readonly TicketEvent[]>>;
  records: readonly SessionRecord[];
  lastOutputAt: Readonly<Record<string, number>>;
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  now: number;
}

/**
 * How far back the settled tail reaches. Beyond this window a concluded session
 * is history, not a live loose end — deep history stays in the ticket rail's
 * History drawer, so the sidebar tail never grows unbounded.
 */
export const SETTLED_RECENCY_MS = 24 * 60 * 60 * 1000;

function sessionSource(record: SessionRecord | undefined): string {
  return record === undefined ? "Terminal" : sessionSourceLabel(record);
}

function paneActivity(
  pane: SessionPane,
  input: Pick<BuildActiveSessionListingInput, "lastOutputAt" | "parkState" | "now">,
): SessionActivityState {
  return sessionActivityState(
    input.lastOutputAt[pane.sessionId] ?? null,
    pane.exitCode !== null,
    input.now,
    input.parkState[pane.sessionId]?.parked ?? false,
  );
}

const ACTIVITY_PRIORITY: Record<SessionActivityState, number> = {
  working: 0,
  idle: 1,
  parked: 2,
  exited: 3,
};

/**
 * Needs-you ordering: a hard stop (`blocked`) outranks a finished-and-waiting
 * review (`done`), which outranks a bare "review this ticket" prompt with no
 * mapped signal. Data-driven so a future hook-derived state is an insert, not a
 * rewrite (mirrors {@link ACTIVITY_PRIORITY}).
 */
const NEEDS_YOU_PRIORITY = { blocked: 0, done: 1, bare: 2 } as const;

function tabActivity(
  tab: SessionTab,
  input: Pick<BuildActiveSessionListingInput, "lastOutputAt" | "parkState" | "now">,
): SessionActivityState {
  return sessionPanes(tab.layout)
    .map((pane) => paneActivity(pane, input))
    .toSorted((a, b) => ACTIVITY_PRIORITY[a] - ACTIVITY_PRIORITY[b])[0]!;
}

function sessionRow(
  ticket: Ticket,
  tab: SessionTab,
  paneId: string,
  record: SessionRecord | undefined,
  activity: SessionActivityState,
  attention: ActiveSessionRow["attention"],
): ActiveSessionRow {
  return {
    id: `session:${tab.sessionId}`,
    ticket,
    title: tab.title,
    source: sessionSource(record),
    activity,
    attention,
    target: { tabId: tab.sessionId, paneId },
  };
}

/** A needs-you row plus its ordering keys; kept together so the sort is honest. */
interface NeedsYouEntry {
  row: ActiveSessionRow;
  priority: number;
  recency: number;
}

function latestSessionSignal(events: readonly TicketEvent[]): TicketEvent | undefined {
  let latest: TicketEvent | undefined;
  for (const event of events) {
    if (event.payload.kind !== "session_signal") continue;
    if (latest === undefined || event.createdAt >= latest.createdAt) latest = event;
  }
  return latest;
}

/**
 * The settled tail (T3-style) built from durable records rather than the
 * ephemeral tab tree: a record with an `endedAt` inside {@link SETTLED_RECENCY_MS}
 * is a recently-concluded session. Split-pane records never stand alone as a
 * row, done-ticket sessions ended deliberately (out of scope), and any session
 * already surfaced above (a promoted needs-review attention tab) is not
 * repeated. When a tab is still mounted the row gains a nav target and a known
 * outcome from the exited pane; otherwise it degrades to a record-only "Ended".
 */
function buildSettled(
  input: BuildActiveSessionListingInput,
  ticketsById: Map<string, Ticket>,
  claimed: ReadonlySet<string>,
): SettledSessionRow[] {
  const rows: SettledSessionRow[] = [];
  for (const record of input.records) {
    if (record.ticketId === null || record.endedAt === null) continue;
    if (record.placement === "split") continue;
    if (record.endedAt < input.now - SETTLED_RECENCY_MS) continue;
    if (claimed.has(record.id)) continue;
    const ticket = ticketsById.get(record.ticketId);
    if (ticket === undefined || (ticket.status !== "doing" && ticket.status !== "needs_review")) {
      continue;
    }

    const mounted = findTabBySessionId(input.containers, record.id);
    let outcome: SessionOutcome = "ended";
    let target: ActiveSessionTarget | null = null;
    if (mounted !== null) {
      target = { tabId: record.id, paneId: record.id };
      const rootPane = findSessionPane(mounted.tab.layout, record.id);
      if (rootPane !== null && rootPane.exitCode !== null) {
        outcome = rootPane.exitCode === 0 ? "done" : "failed";
      }
    }

    rows.push({
      id: `settled:${record.id}`,
      ticket,
      title: mounted?.tab.title ?? record.title,
      source: sessionSourceLabel(record),
      outcome,
      endedAt: record.endedAt,
      resumable: record.harnessSessionId !== null,
      target,
    });
  }
  rows.sort((a, b) => b.endedAt - a.endedAt);
  return rows;
}

/**
 * Builds the project sidebar's attention-first session list from already-loaded
 * board, terminal, durable-session, and event state. The result is pure: view
 * code owns fetching and navigation, while this module owns truthful tiering and
 * lifecycle ordering — Needs You (blocked → done → bare), In Progress (working →
 * idle → parked), then a durable Settled tail of recently concluded sessions.
 */
export function buildActiveSessionListing(
  input: BuildActiveSessionListingInput,
): ActiveSessionListing {
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const ticketsById = new Map(input.tickets.map((ticket) => [ticket.id, ticket]));
  const needsYouEntries: NeedsYouEntry[] = [];
  const inProgress: ActiveSessionRow[] = [];

  for (const ticket of input.tickets) {
    const container = input.containers[ticket.id];
    if (ticket.status === "needs_review") {
      const signal = latestSessionSignal(input.eventsByTicket[ticket.id] ?? []);
      const signaledPaneId = signal?.actorContext?.sessionId;
      const signaledTab = container?.tabs.find(
        (tab) =>
          signaledPaneId !== undefined &&
          sessionPanes(tab.layout).some((pane) => pane.sessionId === signaledPaneId),
      );
      const liveTabs = (container?.tabs ?? []).filter(
        (tab) => tabActivity(tab, input) !== "exited",
      );
      const fallbackTab =
        liveTabs.find((tab) => tab.sessionId === container?.activeSessionId) ?? liveTabs.at(-1);
      const attentionTab = signaledTab ?? fallbackTab;
      const exactSignal =
        signaledTab !== undefined &&
        signaledPaneId !== undefined &&
        signal?.payload.kind === "session_signal"
          ? { payload: signal.payload, paneId: signaledPaneId, createdAt: signal.createdAt }
          : null;
      if (attentionTab !== undefined) {
        const exactAttention =
          exactSignal === null
            ? null
            : { signal: exactSignal.payload.signal, reason: exactSignal.payload.reason };
        const targetPaneId = exactSignal === null ? attentionTab.activePaneId : exactSignal.paneId;
        needsYouEntries.push({
          row: sessionRow(
            ticket,
            attentionTab,
            targetPaneId,
            recordsById.get(targetPaneId),
            tabActivity(attentionTab, input),
            exactAttention,
          ),
          priority:
            exactAttention === null
              ? NEEDS_YOU_PRIORITY.bare
              : NEEDS_YOU_PRIORITY[exactAttention.signal],
          recency: exactSignal?.createdAt ?? ticket.updatedAt,
        });
      } else {
        needsYouEntries.push({
          row: {
            id: `ticket:${ticket.id}`,
            ticket,
            title: ticket.title,
            source: "No live session",
            activity: null,
            attention: null,
            target: null,
          },
          priority: NEEDS_YOU_PRIORITY.bare,
          recency: ticket.updatedAt,
        });
      }

      for (const tab of container?.tabs ?? []) {
        if (tab === attentionTab) continue;
        const activity = tabActivity(tab, input);
        if (activity === "exited") continue;
        inProgress.push(
          sessionRow(
            ticket,
            tab,
            tab.activePaneId,
            recordsById.get(tab.activePaneId),
            activity,
            null,
          ),
        );
      }
      continue;
    }

    if (ticket.status !== "doing") continue;
    for (const tab of container?.tabs ?? []) {
      const activity = tabActivity(tab, input);
      if (activity === "exited") continue;
      inProgress.push(
        sessionRow(
          ticket,
          tab,
          tab.activePaneId,
          recordsById.get(tab.activePaneId),
          activity,
          null,
        ),
      );
    }
  }

  needsYouEntries.sort((a, b) => a.priority - b.priority || b.recency - a.recency);
  const needsYou = needsYouEntries.map((entry) => entry.row);

  inProgress.sort((a, b) => {
    const activity =
      ACTIVITY_PRIORITY[a.activity ?? "exited"] - ACTIVITY_PRIORITY[b.activity ?? "exited"];
    return activity !== 0 ? activity : b.ticket.updatedAt - a.ticket.updatedAt;
  });

  // Everything already surfaced above must not reappear in the settled tail.
  const claimed = new Set<string>();
  for (const row of [...needsYou, ...inProgress]) {
    if (row.target !== null) {
      claimed.add(row.target.tabId);
      claimed.add(row.target.paneId);
    }
  }
  const settled = buildSettled(input, ticketsById, claimed);

  return { needsYou, inProgress, settled };
}
