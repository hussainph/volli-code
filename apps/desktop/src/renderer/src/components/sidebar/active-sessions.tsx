import { useLayoutEffect } from "react";
import type { Project, Ticket, TicketStatus } from "@volli/shared";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Statuses that read as an active session, in display order: doing (a live
 * agent workspace) before needs_review (a parked one awaiting the human).
 */
const SESSION_STATUSES = ["doing", "needs_review"] as const satisfies readonly TicketStatus[];
type SessionStatus = (typeof SESSION_STATUSES)[number];

const STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  doing: "bg-emerald-500",
  needs_review: "bg-amber-500",
};

/**
 * Doing first, then needs_review; freshest activity first within each group.
 * Pairs each ticket with its (narrowed) session status so rendering needs no
 * cast to look up the dot class.
 */
function sessionRows(tickets: readonly Ticket[]): Array<{ ticket: Ticket; status: SessionStatus }> {
  return SESSION_STATUSES.flatMap((status) =>
    tickets
      .filter((ticket) => ticket.status === status)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .map((ticket) => ({ ticket, status })),
  );
}

interface ActiveSessionsProps {
  project: Project;
}

/**
 * The selected project's active sessions, derived from the board store —
 * session rows = tickets whose status implies a live/parked agent workspace
 * (doing / needs_review) until the real session layer lands. Because this is
 * the same store the board renders, the two can never disagree. Clicking a
 * row jumps to the board with that card selected (the selection also lives in
 * the board store, so the card lights up wherever it's rendered).
 */
export function ActiveSessions({ project }: ActiveSessionsProps) {
  const tickets = useBoardStore((state) => state.ticketsByProject[project.id]) ?? [];
  const selectedTicketId = useBoardStore((state) => state.selectedByProject[project.id] ?? null);
  const selectTicket = useBoardStore((state) => state.selectTicket);
  const setNav = useWorkspaceStore((state) => state.setNav);

  // Layout effect so the first paint already has rows — the sidebar can mount
  // before the board page runs this same (idempotent) seed for the project.
  useLayoutEffect(() => {
    useBoardStore.getState().ensureSeeded(project.id, project.ticketPrefix);
  }, [project.id, project.ticketPrefix]);

  const sessions = sessionRows(tickets);

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="whitespace-nowrap text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Active Sessions
      </SidebarGroupLabel>
      <SidebarMenu>
        {sessions.length === 0 ? (
          // Keep the group visible so the section doesn't blink in and out as
          // tickets move through Doing — an empty list is itself information.
          <SidebarMenuItem>
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No active sessions</div>
          </SidebarMenuItem>
        ) : (
          sessions.map(({ ticket, status }) => (
            <SidebarMenuItem key={ticket.id}>
              <SidebarMenuButton
                isActive={ticket.id === selectedTicketId}
                onClick={() => {
                  setNav(project.id, "board");
                  selectTicket(project.id, ticket.id);
                }}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status])}
                />
                <span className="font-mono text-xs text-muted-foreground">{ticket.id}</span>
                <span className="truncate">{ticket.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
