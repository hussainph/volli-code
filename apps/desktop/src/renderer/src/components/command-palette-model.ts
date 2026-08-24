import {
  automationOwnership,
  displayTicketId,
  type Automation,
  type AutomationOwnership,
  type ChatSessionRecord,
  type Project,
  type Ticket,
} from "@volli/shared";

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
  sessionKind: "terminal" | "chat";
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
 * Builds the universal command surface from planning state, open terminal
 * tabs, and durable chat rows. Terminal history is not a destination until
 * resume exists; a durable chat is directly reopenable and belongs here.
 */
export function buildCommandPaletteItems(
  projects: readonly Project[],
  ticketsByProject: Readonly<Record<string, readonly Ticket[] | undefined>>,
  sessionsByOwner: Readonly<Record<string, SessionContainer | undefined>>,
  selectedProjectId: string | null,
  chatSessions: readonly ChatSessionRecord[] = [],
  residentChatTitles: Readonly<Record<string, string>> = {},
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
        sessionKind: "terminal",
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
  for (const record of chatSessions) {
    const project = projectById.get(record.projectId);
    if (project === undefined) continue;
    const linked = record.ticketId === null ? undefined : ticketById.get(record.ticketId);
    // A chat whose ticket disappeared has no ticket workspace to open. The
    // ticketless case is valid because `ticketId` is deliberately null there.
    if (record.ticketId !== null && linked === undefined) continue;
    sessions.push({
      kind: "session",
      projectId: project.id,
      projectName: project.name,
      sessionId: record.sessionId,
      sessionKind: "chat",
      title: residentChatTitles[record.sessionId] ?? record.title,
      scope:
        record.ticketId === null
          ? { kind: "project", projectId: project.id }
          : { kind: "ticket", projectId: project.id, ticketId: record.ticketId },
      ticketDisplayId:
        linked === undefined
          ? null
          : displayTicketId(linked.project.ticketPrefix, linked.ticket.ticketNumber),
      ticketTitle: linked?.ticket.title ?? null,
    });
  }

  sessions.sort(
    (a, b) =>
      currentProjectFirst(a.projectId) - currentProjectFirst(b.projectId) ||
      a.title.localeCompare(b.title),
  );

  return { tickets, sessions };
}

/* ------------------------------------------------------------ automations */

/** One "Run ⟨name⟩ on ⟨ticket⟩" row — run by hand from the palette (VC-126). */
export interface CommandPaletteAutomationRunItem {
  kind: "automation-run";
  automationId: string;
  name: string;
  ownership: AutomationOwnership;
  ticketId: string;
  ticketDisplayId: string;
}

/**
 * The Ticket a palette-run would target: the workspace's open Ticket,
 * resolved against the live board so a stale remembered id offers nothing.
 */
export interface CommandPaletteRunContext {
  ticketId: string;
  displayId: string;
}

/**
 * The run rows the palette offers — every Automation the selected project
 * lists (its own plus the global shelf, in main's own order), each targeting
 * the open Ticket. No open Ticket means no rows rather than rows that would
 * have to invent a target: the palette is "run by name", and the richer
 * choose-a-ticket surfaces are later slices (VC-127, VC-129).
 */
export function buildAutomationRunItems(
  automations: readonly Automation[],
  context: CommandPaletteRunContext | null,
): CommandPaletteAutomationRunItem[] {
  if (context === null) return [];
  return automations.map((automation) => ({
    kind: "automation-run",
    automationId: automation.id,
    name: automation.name,
    ownership: automationOwnership(automation),
    ticketId: context.ticketId,
    ticketDisplayId: context.displayId,
  }));
}

/**
 * The open Ticket as a run target, or null. Resolved against the project's
 * live ticket list — `openTicketId` is remembered workspace state and may
 * name a Ticket that has since been deleted or belongs to another project.
 */
export function paletteRunContext(
  openTicketId: string | null,
  selectedProject: Project | null,
  tickets: readonly Ticket[],
): CommandPaletteRunContext | null {
  if (openTicketId === null || selectedProject === null) return null;
  const ticket = tickets.find((candidate) => candidate.id === openTicketId);
  if (ticket === undefined || ticket.projectId !== selectedProject.id) return null;
  return {
    ticketId: ticket.id,
    displayId: displayTicketId(selectedProject.ticketPrefix, ticket.ticketNumber),
  };
}
