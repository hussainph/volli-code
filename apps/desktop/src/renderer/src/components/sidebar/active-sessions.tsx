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
import { useLatestAsync } from "@renderer/hooks/use-latest-async";
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
        className="h-auto min-h-10 items-start gap-2 py-2 [&:hover_.session-row-meta]:text-sidebar-accent-foreground [&[data-active=true]_.session-row-meta]:text-sidebar-accent-foreground"
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
  openTicketId,
  activeTabId,
  onActivate,
}: {
  label: string;
  tier: "needs-you" | "in-progress";
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
 * Needs Review promotes the exact latest signaled session when possible;
 * every other live tab remains independently reachable under In progress.
 */
export function ActiveSessions({ project }: { project: Project }) {
  const tickets = useBoardStore((state) => state.ticketsByProject[project.id]) ?? EMPTY_TICKETS;
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const containers = useSessionsStore((state) => state.byOwner);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
  const parkState = useSessionsStore((state) => state.parkState);
  const openTicketId = useWorkspaceStore(
    (state) => state.byProject[project.id]?.openTicketId ?? null,
  );
  const ticketTabs = useWorkspaceStore(
    (state) => state.byProject[project.id]?.ticketTabs ?? EMPTY_TICKET_TABS,
  );
  const openTicketWorkspace = useWorkspaceStore((state) => state.openTicketWorkspace);
  const openTicketSession = useWorkspaceStore((state) => state.openTicketSession);
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
          toastError(`Could not load active sessions: ${result.error}`);
          return;
        }
        setRecords(result.sessions);
      })
      .catch((error: unknown) => {
        if (sessionsFetch.isCurrent(token))
          toastError(`Could not load active sessions: ${errorMessage(error)}`);
      });
    return () => sessionsFetch.invalidate();
  }, [project.id, liveSignature, sessionsFetch]);

  const eventsFetch = useLatestAsync();
  const loadNeedsReviewEvents = React.useCallback(() => {
    const token = eventsFetch.claim();
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
        if (!eventsFetch.isCurrent(token)) return;
        const failures = results.flatMap(({ result }) => (result.ok ? [] : [result.error]));
        if (failures.length > 0) {
          toastError(
            `Could not load session attention for ${failures.length} ticket(s): ${failures.join("; ")}`,
          );
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
        if (eventsFetch.isCurrent(token))
          toastError(`Could not load session attention: ${errorMessage(error)}`);
      });
  }, [needsReviewIds, eventsFetch]);

  // Two triggers, deduped to at most one fetch per render:
  //   • the needs-review SET changed (a ticket entered/left the column) → always
  //     reload, since the set of tickets whose events we show is different now;
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
      loadNeedsReviewEvents();
      return;
    }
    if (!versionChanged) return;
    if (planningChange.ticketId !== null && !needsReviewIds.includes(planningChange.ticketId)) {
      return;
    }
    loadNeedsReviewEvents();
  }, [needsReviewIds, planningChange, loadNeedsReviewEvents]);

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
  const rowCount = listing.needsYou.length + listing.inProgress.length;

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
            openTicketId={openTicketId}
            activeTabId={openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? "doc")}
            onActivate={activate}
          />
          <SessionTier
            label="In progress"
            tier="in-progress"
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
