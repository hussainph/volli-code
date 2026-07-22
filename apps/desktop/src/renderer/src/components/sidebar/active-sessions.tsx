import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
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
  type ActiveSessionTarget,
  type SessionOutcome,
  type SettledSessionRow,
} from "@renderer/components/sidebar/active-session-listing";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const EMPTY_TICKETS: readonly Ticket[] = [];
const EMPTY_TICKET_TABS: Record<string, { files: string[]; active: string }> = {};

/** How many settled rows show before the "Show N more" reveal (T3's settled-tail cap). */
const SETTLED_TAIL_INITIAL_COUNT = 8;

const ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
};

const SETTLED_OUTCOME_LABEL: Record<SessionOutcome, string> = {
  failed: "Failed",
  done: "Done",
  ended: "Ended",
};

/** What activation needs from any row, so Active tiers and the Settled tail share one handler. */
type ActivationTarget = { ticket: Ticket; target: ActiveSessionTarget | null };

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

function SettledRow({
  project,
  row,
  now,
  active,
  onActivate,
}: {
  project: Project;
  row: SettledSessionRow;
  now: number;
  active: boolean;
  onActivate(): void;
}) {
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
            row.outcome === "failed" ? "bg-red-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-xs text-muted-foreground">{row.title}</span>
            {row.resumable ? (
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
            <span className="shrink-0">{SETTLED_OUTCOME_LABEL[row.outcome]}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{relativeTime(row.endedAt, now)}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The Settled tail: recently concluded sessions, collapsed by default so the
 * board stays calm and expandable when you need to reopen or resume one. Beyond
 * {@link SETTLED_TAIL_INITIAL_COUNT} a "Show N more" reveal keeps the list short;
 * deep history lives in the ticket rail's History drawer.
 */
function SettledSection({
  project,
  rows,
  now,
  openTicketId,
  activeTabId,
  onActivate,
}: {
  project: Project;
  rows: readonly SettledSessionRow[];
  now: number;
  openTicketId: string | null;
  activeTabId: string | null;
  onActivate(row: ActivationTarget): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  if (rows.length === 0) return null;
  const shown = showAll ? rows : rows.slice(0, SETTLED_TAIL_INITIAL_COUNT);
  const hiddenCount = rows.length - shown.length;
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center justify-between px-2 pt-1 pb-0.5 text-label font-medium text-muted-foreground uppercase transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1">
          <CaretRightIcon
            weight="bold"
            aria-hidden
            className={cn("size-3 transition-transform duration-150 ease-out", open && "rotate-90")}
          />
          Settled
        </span>
        <span aria-label={`${rows.length} settled`}>{rows.length}</span>
      </button>
      {open ? (
        <SidebarMenu>
          {shown.map((row) => (
            <SettledRow
              key={row.id}
              project={project}
              row={row}
              now={now}
              active={
                openTicketId === row.ticket.id &&
                (row.target === null || activeTabId === row.target.tabId)
              }
              onActivate={() => onActivate(row)}
            />
          ))}
          {hiddenCount > 0 ? (
            <SidebarMenuItem>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full px-2 py-1 text-left text-label text-muted-foreground transition-colors hover:text-foreground"
              >
                Show {hiddenCount} more
              </button>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      ) : null}
    </li>
  );
}

/**
 * Attention-first navigator for the selected project's ticket sessions. The
 * rows come from the resident session model, not ticket-status stand-ins:
 * Needs Review promotes the exact latest signaled session when possible;
 * every other live tab remains independently reachable under In progress; and a
 * durable Settled tail keeps recently concluded sessions one click from resume.
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
  const rowCount = listing.needsYou.length + listing.inProgress.length + listing.settled.length;
  const activeTabId = openTicketId === null ? null : (ticketTabs[openTicketId]?.active ?? "doc");

  const activate = (row: ActivationTarget) => {
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
            openTicketId={openTicketId}
            activeTabId={activeTabId}
            onActivate={activate}
          />
          <SessionTier
            label="In progress"
            tier="in-progress"
            rows={listing.inProgress}
            project={project}
            openTicketId={openTicketId}
            activeTabId={activeTabId}
            onActivate={activate}
          />
          <SettledSection
            project={project}
            rows={listing.settled}
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
