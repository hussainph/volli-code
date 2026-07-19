import { displayTicketId, type Project, type Ticket } from "@volli/shared";

import type { SessionContainer, SessionScope } from "@renderer/stores/sessions";

export interface CommandPaletteTicketItem {
  kind: "ticket";
  projectId: string;
  projectName: string;
  ticketId: string;
  displayId: string;
  title: string;
  updatedAt: number;
}

export interface CommandPaletteSessionItem {
  kind: "session";
  projectId: string;
  projectName: string;
  sessionId: string;
  title: string;
  scope: SessionScope;
  ticketDisplayId: string | null;
  ticketTitle: string | null;
}

export interface CommandPaletteItems {
  tickets: CommandPaletteTicketItem[];
  sessions: CommandPaletteSessionItem[];
}

/**
 * Builds the universal command surface from the authoritative planning and
 * live-session stores. Only open terminal tabs are session destinations: a
 * closed durable record cannot be focused until resume exists, so presenting
 * it as navigable would be dishonest.
 */
export function buildCommandPaletteItems(
  projects: readonly Project[],
  ticketsByProject: Readonly<Record<string, readonly Ticket[] | undefined>>,
  sessionsByOwner: Readonly<Record<string, SessionContainer | undefined>>,
  selectedProjectId: string | null,
): CommandPaletteItems {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const ticketById = new Map<string, { ticket: Ticket; project: Project }>();
  const tickets: CommandPaletteTicketItem[] = [];

  for (const project of projects) {
    for (const ticket of ticketsByProject[project.id] ?? []) {
      ticketById.set(ticket.id, { ticket, project });
      tickets.push({
        kind: "ticket",
        projectId: project.id,
        projectName: project.name,
        ticketId: ticket.id,
        displayId: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
        title: ticket.title,
        updatedAt: ticket.updatedAt,
      });
    }
  }

  const currentProjectFirst = (projectId: string): number =>
    projectId === selectedProjectId ? 0 : 1;
  tickets.sort(
    (a, b) =>
      currentProjectFirst(a.projectId) - currentProjectFirst(b.projectId) ||
      b.updatedAt - a.updatedAt ||
      a.displayId.localeCompare(b.displayId),
  );

  const sessions: CommandPaletteSessionItem[] = [];
  for (const container of Object.values(sessionsByOwner)) {
    if (container === undefined) continue;
    for (const tab of container.tabs) {
      const project = projectById.get(tab.scope.projectId);
      if (project === undefined) continue;
      const linked = tab.scope.kind === "ticket" ? ticketById.get(tab.scope.ticketId) : undefined;
      // A removed/stale ticket owner is not a valid navigation destination.
      if (tab.scope.kind === "ticket" && linked === undefined) continue;
      sessions.push({
        kind: "session",
        projectId: project.id,
        projectName: project.name,
        sessionId: tab.sessionId,
        title: tab.title,
        scope: tab.scope,
        ticketDisplayId:
          linked === undefined
            ? null
            : displayTicketId(linked.project.ticketPrefix, linked.ticket.ticketNumber),
        ticketTitle: linked?.ticket.title ?? null,
      });
    }
  }
  sessions.sort(
    (a, b) =>
      currentProjectFirst(a.projectId) - currentProjectFirst(b.projectId) ||
      a.title.localeCompare(b.title),
  );

  return { tickets, sessions };
}
