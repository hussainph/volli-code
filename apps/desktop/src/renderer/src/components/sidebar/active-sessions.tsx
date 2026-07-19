import * as React from "react";
import {
  displayTicketId,
  errorMessage,
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
} from "@renderer/components/sidebar/active-session-listing";
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

function SessionRow({
  project,
  row,
  active,
  needsAttention,
  onActivate,
}: {
  project: Project;
  row: ActiveSessionRow;
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
    : row.activity === null
      ? row.source
      : `${row.source} · ${ACTIVITY_LABEL[row.activity]}`;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        onClick={onActivate}
        className="h-auto min-h-10 items-start gap-2 py-1.5"
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
          <span className="truncate text-xs text-sidebar-foreground">{row.title}</span>
          <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
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
  rows,
  project,
  openTicketId,
  activeTabId,
  onActivate,
}: {
  label: string;
  rows: readonly ActiveSessionRow[];
  project: Project;
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
            needsAttention={label === "Needs you"}
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
 * Needs Review promotes the exact latest signaled session when possible;
 * every other live tab remains independently reachable under In progress.
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

  const projectTicketIds = new Set(tickets.map((ticket) => ticket.id));
  const liveSignature = Object.values(containers)
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
    .join(",");
  const needsReviewIds = React.useMemo(
    () => tickets.filter((ticket) => ticket.status === "needs_review").map((ticket) => ticket.id),
    [tickets],
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
    if (needsReviewIds.length === 0) {
      setEventsByTicket({});
      return;
    }
    Promise.all(
      needsReviewIds.map(async (ticketId) => ({
        ticketId,
        result: await window.api.tickets.events({ ticketId }),
      })),
    )
      .then((results) => {
        if (cancelled) return;
        const failed = results.find(({ result }) => !result.ok);
        if (failed?.result.ok === false) {
          toastError(`Could not load session attention: ${failed.result.error}`);
        }
        setEventsByTicket(
          Object.fromEntries(
            results.flatMap(({ ticketId, result }) =>
              result.ok ? [[ticketId, result.events] as const] : [],
            ),
          ),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) toastError(`Could not load session attention: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [needsReviewIds, planningDataVersion]);

  React.useEffect(() => {
    if (liveSignature === "") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveSignature]);

  const listing = buildActiveSessionListing({
    tickets,
    containers,
    eventsByTicket,
    records,
    lastOutputAt,
    parkState,
    now,
  });
  const rowCount = listing.needsYou.length + listing.inProgress.length;

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
            rows={listing.needsYou}
            project={project}
            openTicketId={openTicketId}
            activeTabId={openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? "doc")}
            onActivate={activate}
          />
          <SessionTier
            label="In progress"
            rows={listing.inProgress}
            project={project}
            openTicketId={openTicketId}
            activeTabId={openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? "doc")}
            onActivate={activate}
          />
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
