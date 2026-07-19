import {
  harnessLabel,
  type SessionActivityState,
  type SessionRecord,
  type Ticket,
  type TicketEvent,
} from "@volli/shared";

import {
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

export interface ActiveSessionListing {
  needsYou: ActiveSessionRow[];
  inProgress: ActiveSessionRow[];
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
  if (record === undefined || record.launchKind === "unknown") return "Terminal";
  if (record.launchKind === "shell") return "Shell";
  return harnessLabel(record.harnessId);
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
 * code owns fetching and navigation, while this module owns truthful tiering.
 */
export function buildActiveSessionListing(
  input: BuildActiveSessionListingInput,
): ActiveSessionListing {
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const needsYou: ActiveSessionRow[] = [];
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
          ? { payload: signal.payload, paneId: signaledPaneId }
          : null;
      if (attentionTab !== undefined) {
        const exactAttention =
          exactSignal === null
            ? null
            : { signal: exactSignal.payload.signal, reason: exactSignal.payload.reason };
        const targetPaneId = exactSignal === null ? attentionTab.activePaneId : exactSignal.paneId;
        needsYou.push(
          sessionRow(
            ticket,
            attentionTab,
            targetPaneId,
            recordsById.get(targetPaneId),
            tabActivity(attentionTab, input),
            exactAttention,
          ),
        );
      } else {
        needsYou.push({
          id: `ticket:${ticket.id}`,
          ticket,
          title: ticket.title,
          source: "No live session",
          activity: null,
          attention: null,
          target: null,
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

  inProgress.sort((a, b) => {
    const activity =
      ACTIVITY_PRIORITY[a.activity ?? "exited"] - ACTIVITY_PRIORITY[b.activity ?? "exited"];
    return activity !== 0 ? activity : b.ticket.updatedAt - a.ticket.updatedAt;
  });

  return { needsYou, inProgress };
}
