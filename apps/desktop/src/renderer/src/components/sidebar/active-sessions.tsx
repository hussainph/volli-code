import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import {
  displayTicketId,
  errorMessage,
  type LatestSessionSignal,
  type Project,
  type SessionActivityState,
  type SessionRecord,
  type Ticket,
  type TicketEvent,
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
  type SessionOutcome,
} from "@renderer/components/sidebar/active-session-listing";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const EMPTY_TICKETS: readonly Ticket[] = [];
const EMPTY_TICKET_TABS: Record<string, { files: string[]; active: string }> = {};

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
};

const OUTCOME_LABEL: Record<SessionOutcome, string> = {
  failed: "Failed",
  done: "Done",
  ended: "Ended",
};

/**
 * Rehydrates the batched `latestSignals` read into the `eventsByTicket` shape
 * the pure listing model already consumes — one synthetic session_signal event
 * per ticket. Keeps the tested model untouched while the fetch collapses from a
 * per-needs-review-ticket fan-out to a single project query.
 */
function signalsToEventsByTicket(
  signals: readonly LatestSessionSignal[],
): Record<string, TicketEvent[]> {
  const byTicket: Record<string, TicketEvent[]> = {};
  for (const signal of signals) {
    byTicket[signal.ticketId] = [
      {
        id: `signal:${signal.ticketId}`,
        ticketId: signal.ticketId,
        actor: signal.sessionId === null ? "automation" : "session",
        actorContext:
          signal.sessionId === null
            ? null
            : { ticketId: signal.ticketId, sessionId: signal.sessionId },
        createdAt: signal.createdAt,
        payload: { kind: "session_signal", signal: signal.signal, reason: signal.reason },
      },
    ];
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
        : "Needs review";
  const stateLabel = needsAttention
    ? attentionLabel
    : row.lastRun !== null
      ? row.lastRun.endedAt === null
        ? OUTCOME_LABEL[row.lastRun.outcome]
        : `${OUTCOME_LABEL[row.lastRun.outcome]} · ${relativeTime(row.lastRun.endedAt, now)}`
      : row.activity === null
        ? row.source
        : `${row.source} · ${ACTIVITY_LABEL[row.activity]}`;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        onClick={onActivate}
        className="h-auto min-h-10 items-start gap-2 py-2 [&:hover_.session-row-meta]:text-sidebar-accent-foreground [&[data-active=true]_.session-row-meta]:text-sidebar-accent-foreground"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            needsAttention
              ? "bg-amber-500"
              : row.lastRun?.outcome === "failed"
                ? "bg-red-500"
                : row.activity === "working"
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/40",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                "truncate text-xs",
                row.lastRun !== null ? "text-muted-foreground" : "text-sidebar-foreground",
              )}
            >
              {row.title}
            </span>
            {row.lastRun?.resumable ? (
              <ArrowClockwiseIcon
                aria-label="Resumable"
                className="size-3 shrink-0 text-muted-foreground/70"
              />
            ) : null}
          </span>
          <span className="session-row-meta flex min-w-0 items-center gap-1 text-label text-muted-foreground transition-colors">
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
  const planningDataVersion = useBoardStore((state) => state.planningDataVersion);
  const containers = useSessionsStore((state) => state.byOwner);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
  const parkState = useSessionsStore((state) => state.parkState);
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  const ticketTabs = useWorkspaceStore(
    (state) => state.byProject[project.id]?.ticketTabs ?? EMPTY_TICKET_TABS,
  );
  const openTicket = useWorkspaceStore((state) => state.openTicket);
  const openTicketSession = useWorkspaceStore((state) => state.openTicketSession);
  const setNav = useWorkspaceStore((state) => state.setNav);
  const [records, setRecords] = React.useState<SessionRecord[]>([]);
  const [eventsByTicket, setEventsByTicket] = React.useState<Record<string, TicketEvent[]>>({});
  const [now, setNow] = React.useState(() => Date.now());

  const projectTicketIds = React.useMemo(
    () => new Set(tickets.map((ticket) => ticket.id)),
    [tickets],
  );
  const liveSignature = React.useMemo(
    () =>
      Object.values(containers)
        .flatMap((container) =>
          container.tabs
            .filter(
              (tab) =>
                tab.scope.kind === "ticket" &&
                tab.scope.projectId === project.id &&
                projectTicketIds.has(tab.scope.ticketId),
            )
            .flatMap((tab) => sessionPanes(tab.layout).map((pane) => pane.sessionId)),
        )
        .join(","),
    [containers, project.id, projectTicketIds],
  );
  React.useEffect(() => {
    let cancelled = false;
    window.api.sessions
      .list({ projectId: project.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          toastError(`Could not load active sessions: ${result.error}`);
          return;
        }
        setRecords(result.sessions);
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError(`Could not load active sessions: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, liveSignature]);

  React.useEffect(() => {
    let cancelled = false;
    window.api.tickets
      .latestSignals({ projectId: project.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          toastError(`Could not load session attention: ${result.error}`);
          return;
        }
        setEventsByTicket(signalsToEventsByTicket(result.signals));
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError(`Could not load session attention: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, planningDataVersion]);

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
        eventsByTicket,
        records,
        lastOutputAt,
        parkState,
        now,
      }),
    [tickets, containers, eventsByTicket, records, lastOutputAt, parkState, now],
  );
  const rowCount = listing.needsYou.length + listing.active.length;
  const activeTabId = openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? "doc");

  const activate = (row: ActiveSessionRow) => {
    if (row.target !== null) {
      openTicketSession(project.id, row.ticket.id, row.target.tabId, row.target.paneId);
      return;
    }
    setNav(project.id, "board");
    openTicket(project.id, row.ticket.id);
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
