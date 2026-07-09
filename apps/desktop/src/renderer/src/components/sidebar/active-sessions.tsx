import type { Project } from "@volli/shared";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { DEMO_SESSIONS, type DemoSession } from "@renderer/lib/demo-sessions";
import { cn } from "@renderer/lib/utils";

const STATUS_DOT_CLASS: Record<DemoSession["status"], string> = {
  running: "bg-emerald-500",
  "needs-review": "bg-amber-500",
};

interface ActiveSessionsProps {
  project: Project;
}

/**
 * DEMO_SESSIONS rendered as read-only rows until the ticket/session layer
 * lands (see @renderer/lib/demo-sessions). Ticket ids use the selected
 * project's prefix, so this only renders once a project is selected.
 */
export function ActiveSessions({ project }: ActiveSessionsProps) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Active Sessions
      </SidebarGroupLabel>
      <SidebarMenu>
        {DEMO_SESSIONS.map((session) => (
          <SidebarMenuItem key={session.ticketNumber}>
            <SidebarMenuButton>
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[session.status])}
              />
              <span className="font-mono text-xs text-muted-foreground">
                {project.ticketPrefix}-{session.ticketNumber}
              </span>
              <span>{session.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
