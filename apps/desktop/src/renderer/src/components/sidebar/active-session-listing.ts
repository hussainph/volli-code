import {
  type SessionActivityState,
  type SessionRecord,
  type Ticket,
  type TicketEvent,
} from "@volli/shared";

import { sessionSourceLabel } from "../ticket/session-history";
import {
  findSessionPane,
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

/**
 * How a concluded run ended. `failed`/`done` are only claimed when an exit code
 * was actually observed (a still-mounted pane's, or the durable record's
 * `exitCode`); `ended` is the honest label when the outcome is unknown.
 */
export type SessionOutcome = "failed" | "done" | "ended";

/**
 * A Doing ticket's most recent concluded run, carried by its Active fallback
 * row when nothing is live. Backed by a durable {@link SessionRecord} where one
 * is known — the record's documented purpose is "trace and resume seed", which
 * makes this row the fourth resume surface (issue #78): `resumable` marks a
 * harness session to resume from.
 */
export interface LastRun {
  outcome: SessionOutcome;
  /**
   * Epoch ms the run ended; `null` when only a still-mounted exited tab is
   * known and its durable record hasn't been re-read yet.
   */
  endedAt: number | null;
  /** The run's record carries a harness session id, so it can be resumed. */
  resumable: boolean;
}

export interface ActiveSessionRow {
  id: string;
  ticket: Ticket;
  title: string;
  source: string;
  activity: SessionActivityState | null;
  attention: { signal: "done" | "blocked"; reason: string | null } | null;
  /** Present on a concluded Active fallback row — see {@link LastRun}. */
  lastRun: LastRun | null;
  target: ActiveSessionTarget | null;
}

export interface ActiveSessionListing {
  needsYou: ActiveSessionRow[];
  active: ActiveSessionRow[];
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

/** Concluded fallback rows (activity `null`) sort after every live state. */
const CONCLUDED_PRIORITY = 4;

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
    lastRun: null,
    target: { tabId: tab.sessionId, paneId },
  };
}

function outcomeFromExitCode(exitCode: number | null): SessionOutcome {
  return exitCode === null ? "ended" : exitCode === 0 ? "done" : "failed";
}

/**
 * The Active fallback row for a Doing ticket with nothing live — the tier
 * guarantees every Doing ticket a presence (the board says it's in flight, so
 * the navigator must too, especially after an app relaunch kills every PTY).
 * Prefers a still-mounted exited tab (it can reopen the exact terminal and
 * knows its exit code); otherwise degrades to the ticket's most recent durable
 * record (split panes never stand alone as a row); otherwise a bare row.
 */
function lastRunRow(
  ticket: Ticket,
  input: BuildActiveSessionListingInput,
  recordsById: ReadonlyMap<string, SessionRecord>,
): ActiveSessionRow {
  const container = input.containers[ticket.id];
  const tabs = container?.tabs ?? [];
  // Every tab here is exited — live ones already produced their own rows.
  const mounted = tabs.find((tab) => tab.sessionId === container?.activeSessionId) ?? tabs.at(-1);
  if (mounted !== undefined) {
    const record = recordsById.get(mounted.sessionId);
    const pane = findSessionPane(mounted.layout, mounted.activePaneId);
    return {
      id: `ticket:${ticket.id}`,
      ticket,
      title: mounted.title,
      source: sessionSource(record),
      activity: null,
      attention: null,
      lastRun: {
        outcome: outcomeFromExitCode(pane?.exitCode ?? record?.exitCode ?? null),
        endedAt: record?.endedAt ?? null,
        resumable: record?.harnessSessionId != null,
      },
      target: { tabId: mounted.sessionId, paneId: mounted.activePaneId },
    };
  }

  let latest: SessionRecord | undefined;
  for (const record of input.records) {
    if (record.ticketId !== ticket.id || record.endedAt === null) continue;
    if (record.placement === "split") continue;
    if (latest === undefined || record.endedAt > (latest.endedAt ?? 0)) latest = record;
  }
  if (latest !== undefined) {
    return {
      id: `ticket:${ticket.id}`,
      ticket,
      title: latest.title,
      source: sessionSourceLabel(latest),
      activity: null,
      attention: null,
      lastRun: {
        outcome: outcomeFromExitCode(latest.exitCode),
        endedAt: latest.endedAt,
        resumable: latest.harnessSessionId !== null,
      },
      target: null,
    };
  }

  return {
    id: `ticket:${ticket.id}`,
    ticket,
    title: ticket.title,
    source: "No live session",
    activity: null,
    attention: null,
    lastRun: null,
    target: null,
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
 * Builds the project sidebar's attention-first session list from already-loaded
 * board, terminal, durable-session, and event state. The result is pure: view
 * code owns fetching and navigation, while this module owns truthful tiering and
 * lifecycle ordering — Needs You (blocked → done → bare), then Active (working →
 * idle → parked → concluded), where every Doing ticket is guaranteed a row:
 * its live tabs when it has them, else one last-run fallback row.
 */
export function buildActiveSessionListing(
  input: BuildActiveSessionListingInput,
): ActiveSessionListing {
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const needsYouEntries: NeedsYouEntry[] = [];
  const active: ActiveSessionRow[] = [];

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
            lastRun: null,
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
        active.push(
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
    let liveRows = 0;
    for (const tab of container?.tabs ?? []) {
      const activity = tabActivity(tab, input);
      if (activity === "exited") continue;
      active.push(
        sessionRow(
          ticket,
          tab,
          tab.activePaneId,
          recordsById.get(tab.activePaneId),
          activity,
          null,
        ),
      );
      liveRows += 1;
    }
    // The tier guarantees every Doing ticket a presence: nothing live means one
    // concluded fallback row instead of silence.
    if (liveRows === 0) active.push(lastRunRow(ticket, input, recordsById));
  }

  needsYouEntries.sort((a, b) => a.priority - b.priority || b.recency - a.recency);
  const needsYou = needsYouEntries.map((entry) => entry.row);

  // Lifecycle order: live rows by activity, then concluded fallback rows (a
  // null activity) by how recently they ended.
  const activityRank = (row: ActiveSessionRow): number =>
    row.activity === null ? CONCLUDED_PRIORITY : ACTIVITY_PRIORITY[row.activity];
  active.sort((a, b) => {
    const rank = activityRank(a) - activityRank(b);
    if (rank !== 0) return rank;
    const recencyA = a.lastRun?.endedAt ?? a.ticket.updatedAt;
    const recencyB = b.lastRun?.endedAt ?? b.ticket.updatedAt;
    return recencyB - recencyA;
  });

  return { needsYou, active };
}
