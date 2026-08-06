import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import {
  displayTicketId,
  errorMessage,
  type ChatSessionRecord,
  type LatestSessionSignal,
  type Project,
  type SessionActivityState,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import {
  buildActiveSessionListing,
  type ActiveSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const EMPTY_TICKETS: readonly Ticket[] = [];
const EMPTY_TICKET_TABS: Record<string, { files: string[]; active: string }> = {};

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
};

/** Re-indexes the batched durable Session projection for the pure listing model. */
function indexSignalsByTicket(
  signals: readonly LatestSessionSignal[],
): Record<string, LatestSessionSignal> {
  const byTicket: Record<string, LatestSessionSignal> = {};
  for (const signal of signals) {
    byTicket[signal.ticketId] = signal;
  }
  return byTicket;
}

function SessionRow({
  project,
  row,
  now,
  active,
  needsAttention,
  onActivate,
}: {
  project: Project;
  row: ActiveSessionRow;
  now: number;
  active: boolean;
  needsAttention: boolean;
  onActivate(): void;
}) {
  const attentionLabel =
    row.attention?.signal === "blocked"
      ? row.attention.reason === null
        ? "Blocked"
        : `Blocked · ${row.attention.reason}`
      : row.attention?.signal === "done"
        ? row.attention.reason === null
          ? "Ready for review"
          : `Ready · ${row.attention.reason}`
        : row.attention?.signal === "waiting"
          ? "Waiting for you"
          : // The ticket sits in Needs Review and nothing has said why. A state,
            // not an instruction — "Needs review" restated the column name back
            // at the reader and read as a task.
            "In review";
  // A session whose hooks never arrived states that, in place of an activity it
  // would only be guessing at. Every other row keeps its activity word: a Known
  // harness never promised to report, so inference there is not news.
  const activityLabel =
    row.activity === null
      ? row.source
      : row.activitySource === "silent"
        ? `${row.source} · Not reporting`
        : `${row.source} · ${ACTIVITY_LABEL[row.activity]}`;
  const stateLabel = needsAttention
    ? attentionLabel
    : row.lastRun !== null
      ? row.lastRun.endedAt === null
        ? "Ended"
        : `Ended · ${relativeTime(row.lastRun.endedAt, now)}`
      : activityLabel;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        onClick={onActivate}
        // Every dimmed thing in the row is promoted together on hover/selected
        // (#74's vibrancy rule). It is not decoration: the row's fill is a VEIL
        // now, so at the canvas band's ceiling this text measures Lc 58.3
        // un-promoted — under the floor — and 88.2 promoted.
        className="h-auto min-h-10 items-start gap-2 py-2 [&:hover_.session-row-dim]:text-sidebar-accent-foreground [&[data-active=true]_.session-row-dim]:text-sidebar-accent-foreground"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            needsAttention
              ? "bg-amber-500"
              : row.activity === "working"
                ? "bg-emerald-500"
                : "bg-muted-foreground/40",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "session-row-dim truncate text-xs transition-colors",
                row.lastRun !== null ? "text-muted-foreground" : "text-sidebar-foreground",
              )}
            >
              {row.title}
            </span>
            {row.lastRun?.resumable ? (
              <ArrowClockwiseIcon
                aria-label="Resumable"
                className="session-row-dim size-3 shrink-0 text-muted-foreground/70 transition-colors"
              />
            ) : null}
          </span>
          <span className="session-row-dim flex min-w-0 items-center gap-1 text-label text-muted-foreground transition-colors">
            <span className="shrink-0 font-mono">
              {displayTicketId(project.ticketPrefix, row.ticket.ticketNumber)}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">{stateLabel}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SessionTier({
  label,
  tier,
  rows,
  project,
  now,
  openTicketId,
  activeTabId,
  onActivate,
}: {
  label: string;
  tier: "needs-you" | "active";
  rows: readonly ActiveSessionRow[];
  project: Project;
  now: number;
  openTicketId: string | null;
  activeTabId: string | null;
  onActivate(row: ActiveSessionRow): void;
}) {
  if (rows.length === 0) return null;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 pt-1 pb-0.5 text-label font-medium text-muted-foreground uppercase">
        <span>{label}</span>
        <span aria-label={`${rows.length} ${label.toLocaleLowerCase()}`}>{rows.length}</span>
      </div>
      <SidebarMenu>
        {rows.map((row) => (
          <SessionRow
            key={row.id}
            project={project}
            row={row}
            now={now}
            needsAttention={tier === "needs-you"}
            active={
              openTicketId === row.ticket.id &&
              (row.target === null || activeTabId === row.target.tabId)
            }
            onActivate={() => onActivate(row)}
          />
        ))}
      </SidebarMenu>
    </li>
  );
}

/**
 * Attention-first navigator for the selected project's ticket sessions. The
 * rows come from the resident session model, not ticket-status stand-ins:
 * Needs Review promotes the exact latest signaled session when possible; every
 * live tab remains independently reachable under Active, and a Doing ticket
 * with nothing live keeps one last-run row there (outcome + resume seed), so
 * the tier always mirrors the board's Doing column — even right after a
 * relaunch killed every PTY.
 */
export function ActiveSessions({ project }: { project: Project }) {
  const tickets = useBoardStore((state) => state.ticketsByProject[project.id]) ?? EMPTY_TICKETS;
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const containers = useSessionsStore((state) => state.byOwner);
  const openChatTabs = useChatSessionsStore((state) => state.openTabs);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
  const parkState = useSessionsStore((state) => state.parkState);
  const harness = useSessionsStore((state) => state.harness);
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  const ticketTabs = useWorkspaceStore(
    (state) => state.byProject[project.id]?.ticketTabs ?? EMPTY_TICKET_TABS,
  );
  const openTicketWorkspace = useWorkspaceStore((state) => state.openTicketWorkspace);
  const openTicketSession = useWorkspaceStore((state) => state.openTicketSession);
  const [records, setRecords] = React.useState<SessionRecord[]>([]);
  const [chatSessions, setChatSessions] = React.useState<ChatSessionRecord[]>([]);
  const [signalsByTicket, setSignalsByTicket] = React.useState<Record<string, LatestSessionSignal>>(
    {},
  );
  const [now, setNow] = React.useState(() => Date.now());

  const projectTicketIds = React.useMemo(
    () => new Set(tickets.map((ticket) => ticket.id)),
    [tickets],
  );
  // Which of this project's Sessions are live on this surface — the key the one
  // fetch below re-reads the durable listing on. Both kinds count: a chat has no
  // PTY pane to name, so a signature made of panes alone left a Doing ticket
  // reading "No live session" while a chat streamed inside it.
  const liveSignature = React.useMemo(
    () =>
      [
        ...Object.values(containers).flatMap((container) =>
          container.tabs
            .filter(
              (tab) =>
                tab.scope.kind === "ticket" &&
                tab.scope.projectId === project.id &&
                projectTicketIds.has(tab.scope.ticketId),
            )
            .flatMap((tab) => sessionPanes(tab.layout).map((pane) => pane.sessionId)),
        ),
        ...Object.entries(openChatTabs)
          .filter(([ticketId]) => projectTicketIds.has(ticketId))
          .flatMap(([, sessionIds]) => sessionIds),
      ].join(","),
    [containers, openChatTabs, project.id, projectTicketIds],
  );
  const needsReviewIds = React.useMemo(
    () => tickets.filter((ticket) => ticket.status === "needs_review").map((ticket) => ticket.id),
    [tickets],
  );

  const sessionsFetch = useLatestAsync();
  React.useEffect(() => {
    const token = sessionsFetch.claim();
    window.api.sessions
      .list({ projectId: project.id })
      .then((result) => {
        if (!sessionsFetch.isCurrent(token)) return;
        if (!result.ok) {
          toastError(`Couldn't load active sessions: ${result.error}`);
          return;
        }
        setRecords(result.sessions.flatMap((row) => (row.kind === "terminal" ? [row.record] : [])));
        setChatSessions(
          result.sessions.flatMap((row) => (row.kind === "chat" ? [row.record] : [])),
        );
      })
      .catch((error: unknown) => {
        if (sessionsFetch.isCurrent(token))
          toastError(`Couldn't load active sessions: ${errorMessage(error)}`);
      });
    return () => sessionsFetch.invalidate();
  }, [project.id, liveSignature, sessionsFetch]);

  // A session's harness can change without its PTYs changing at all — quitting
  // opencode and starting claude in the same shell is one terminal, one live
  // pane, one signature. The refetch above is keyed on `liveSignature`, so it
  // never fires for that switch; patch the record the announce names instead,
  // or the row keeps naming the harness the session was launched with.
  React.useEffect(
    () =>
      window.api.sessions.onHarnessChange((notice) => {
        setRecords((current) =>
          current.map((record) =>
            record.id === notice.sessionId
              ? { ...record, activeHarnessId: notice.harnessId }
              : record,
          ),
        );
      }),
    [],
  );

  const signalsFetch = useLatestAsync();
  const loadAttentionSignals = React.useCallback(() => {
    const token = signalsFetch.claim();
    if (needsReviewIds.length === 0) {
      setSignalsByTicket({});
      return;
    }
    window.api.tickets
      .latestSignals({ projectId: project.id })
      .then((result) => {
        if (!signalsFetch.isCurrent(token)) return;
        if (!result.ok) {
          toastError(`Couldn't load session attention: ${result.error}`);
          return;
        }
        setSignalsByTicket(indexSignalsByTicket(result.signals));
      })
      .catch((error: unknown) => {
        if (signalsFetch.isCurrent(token))
          toastError(`Couldn't load session attention: ${errorMessage(error)}`);
      });
  }, [needsReviewIds, project.id, signalsFetch]);

  // Two triggers, deduped to at most one fetch per render:
  //   • the needs-review SET changed (a ticket entered/left the column) → always
  //     reload, since the set of tickets whose signals we show is different now;
  //   • a planning refresh whose scope is untargeted OR names a ticket we're
  //     already showing → reload; a refresh for any OTHER ticket can't touch our
  //     attention rows, so skip it.
  // Tracking both previous values (rather than two effects) stops a refresh that
  // ALSO moved the set from firing the reload twice. The ids ref starts `null` so
  // the first run always loads (mount), whatever the initial version.
  const seenNeedsReviewIds = React.useRef<readonly string[] | null>(null);
  const seenPlanningVersion = React.useRef(planningChange.version);
  React.useEffect(() => {
    const idsChanged = seenNeedsReviewIds.current !== needsReviewIds;
    const versionChanged = seenPlanningVersion.current !== planningChange.version;
    seenNeedsReviewIds.current = needsReviewIds;
    seenPlanningVersion.current = planningChange.version;
    if (idsChanged) {
      loadAttentionSignals();
      return;
    }
    if (!versionChanged) return;
    if (planningChange.ticketId !== null && !needsReviewIds.includes(planningChange.ticketId)) {
      return;
    }
    loadAttentionSignals();
  }, [needsReviewIds, planningChange, loadAttentionSignals]);

  React.useEffect(() => {
    if (liveSignature === "") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveSignature]);

  const listing = React.useMemo(
    () =>
      buildActiveSessionListing({
        tickets,
        containers,
        signalsByTicket,
        records,
        chatSessions,
        lastOutputAt,
        parkState,
        harness,
        now,
      }),
    [
      tickets,
      containers,
      signalsByTicket,
      records,
      chatSessions,
      lastOutputAt,
      parkState,
      harness,
      now,
    ],
  );
  const rowCount = listing.needsYou.length + listing.active.length;
  const activeTabId =
    openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? TICKET_BODY_TAB_ID);

  const activate = (row: ActiveSessionRow) => {
    if (row.target !== null) {
      openTicketSession(project.id, row.ticket.id, row.target.tabId, row.target.paneId);
      return;
    }
    openTicketWorkspace(project.id, row.ticket.id);
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="whitespace-nowrap text-label font-semibold text-muted-foreground uppercase">
        Active Sessions
      </SidebarGroupLabel>
      {rowCount === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No active sessions</div>
      ) : (
        <SidebarMenu>
          <SessionTier
            label="Needs you"
            tier="needs-you"
            rows={listing.needsYou}
            project={project}
            now={now}
            openTicketId={openTicketId}
            activeTabId={activeTabId}
            onActivate={activate}
          />
          <SessionTier
            label="Active"
            tier="active"
            rows={listing.active}
            project={project}
            now={now}
            openTicketId={openTicketId}
            activeTabId={activeTabId}
            onActivate={activate}
          />
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
