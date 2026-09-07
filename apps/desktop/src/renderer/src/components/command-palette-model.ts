import { terminalHistoryScope, type TerminalHistoryScope } from "@volli/session-presentation";
import {
  automationOwnership,
  displayTicketId,
  sessionProvenanceOf,
  type Automation,
  type AutomationOwnership,
  type ChatSessionRecord,
  type Project,
  type SessionProvenance,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";

import type { SessionContainer, SessionScope } from "@renderer/stores/sessions";

/**
 * The contract's scope answer, carrying the project id a palette row needs to
 * navigate. The two shapes differ only in that id: the decision is not remade.
 */
function paletteSessionScope(
  scope: TerminalHistoryScope,
  projectId: string,
): SessionScope | { kind: "unavailable" } {
  if (scope.kind === "ticket") return { kind: "ticket", projectId, ticketId: scope.ticketId };
  return scope.kind === "project" ? { kind: "project", projectId } : { kind: "unavailable" };
}

export interface CommandPaletteTicketItem {
  kind: "ticket";
  projectId: string;
  projectName: string;
  ticketId: string;
  displayId: string;
  title: string;
  updatedAt: number;
}

interface CommandPaletteSessionBase {
  kind: "session";
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionKind: "terminal" | "chat";
  title: string;
  ticketDisplayId: string | null;
  ticketTitle: string | null;
  /**
   * Who started this Session (VC-131). The palette is the app's one GLOBAL
   * Session listing — every project's, in one list — so it is the surface where
   * a Run's Session is most easily mistaken for one a person opened, and
   * "everywhere a Session appears" includes it. Resolved here rather than at
   * the row so the two kinds below cannot answer differently.
   */
  provenance: SessionProvenance;
}

/**
 * What selecting a Session row opens (VC-290), paired with the scope evidence
 * that destination can honestly carry.
 *
 * A live tab always has a current project/ticket scope. A durable detail may
 * instead belong to a Ticket that is no longer available: `bornTicketless`
 * distinguishes that orphan from a Session that was project-scoped at birth,
 * and `unavailable` keeps the palette from relabelling it as a Board Session.
 */
export type CommandPaletteSessionItem = CommandPaletteSessionBase &
  (
    | { destination: "tab"; scope: SessionScope }
    | {
        destination: "detail";
        scope: SessionScope | { kind: "unavailable" };
      }
  );

export interface CommandPaletteItems {
  tickets: CommandPaletteTicketItem[];
  sessions: CommandPaletteSessionItem[];
}

/**
 * Builds the universal command surface from planning state, open terminal
 * tabs, durable chat rows, and durable CLOSED terminals.
 *
 * The last of those is VC-290. The palette already fetched every project's
 * saved Session rows (it needs them for chats and for provenance) and then
 * discarded every terminal among them, so the app's one global search could
 * not find a terminal you closed an hour ago — the note in this comment used to
 * say terminal history was "not a destination until resume exists", and the
 * answer turned out not to be resume: a closed terminal's destination is its
 * own saved record.
 */
export function buildCommandPaletteItems(
  projects: readonly Project[],
  ticketsByProject: Readonly<Record<string, readonly Ticket[] | undefined>>,
  sessionsByOwner: Readonly<Record<string, SessionContainer | undefined>>,
  selectedProjectId: string | null,
  chatSessions: readonly ChatSessionRecord[] = [],
  residentChatTitles: Readonly<Record<string, string>> = {},
  /**
   * Who started each Session, keyed by Session id and **sparse** — a miss is
   * the resting case. Defaulted so a caller that has not read it yet marks
   * nothing rather than guessing, which is the same failure direction every
   * other surface takes.
   */
  provenance: Readonly<Record<string, SessionProvenance>> = {},
  /**
   * Durable TERMINAL records, straight off the same listing fetch the chat rows
   * and the provenance map come from. Only the closed, top-level ones become
   * rows; see {@link buildCommandPaletteItems}'s body for why each of the other
   * kinds is left out.
   */
  terminalSessions: readonly SessionRecord[] = [],
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
        provenance: sessionProvenanceOf(provenance, tab.sessionId),
        destination: "tab",
      });
    }
  }
  // Closed terminals, after the open tabs above so `openTerminalIds` is
  // complete: a Session that still has a tab is reachable AS that tab, and its
  // durable row would be a second entry for the same Session pointing at a
  // description of it.
  const openTerminalIds = new Set(sessions.map((item) => item.sessionId));
  for (const record of terminalSessions) {
    // A split pane is part of a tab and never a destination of its own (the
    // sidebar's Previous band draws the same line over the same records), and a
    // record with no end is either open above or a live-looking leftover this
    // window has no surface for.
    if (record.endedAt === null || record.placement === "split") continue;
    if (openTerminalIds.has(record.id)) continue;
    const project = projectById.get(record.projectId);
    if (project === undefined) continue;
    const linked = record.ticketId === null ? undefined : ticketById.get(record.ticketId);
    sessions.push({
      kind: "session",
      projectId: project.id,
      projectName: project.name,
      sessionId: record.id,
      sessionKind: "terminal",
      title: record.title,
      // The scope decision is the Session Presentation Contract's, not this
      // row's: the same record's detail asks `terminalHistoryScope` the same
      // question, and a second copy here is how a palette row comes to call an
      // orphaned Ticket Session a Board Session while its detail calls it
      // unavailable. Only the navigation `projectId` is added on top.
      scope: paletteSessionScope(
        terminalHistoryScope(record, linked?.ticket ?? null, project.ticketPrefix),
        project.id,
      ),
      ticketDisplayId:
        linked === undefined
          ? null
          : displayTicketId(linked.project.ticketPrefix, linked.ticket.ticketNumber),
      ticketTitle: linked?.ticket.title ?? null,
      provenance: sessionProvenanceOf(provenance, record.id),
      destination: "detail",
    });
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
      provenance: sessionProvenanceOf(provenance, record.sessionId),
      destination: "tab",
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

/* ---------------------------------------------------------------- editor */

/**
 * One editor command the palette offers — today exactly one, Go to Line
 * (plan §4.1). Monaco has always had the action and a ⌃G binding; what it had
 * no way of saying is that the command exists at all. This row is that saying.
 */
export interface CommandPaletteEditorItem {
  kind: "editor-command";
  id: "go-to-line";
  title: string;
  hint: string;
}

/**
 * The editor rows, given whether an editor is actually on screen to answer
 * them. Nothing open means no rows rather than a row that would open a line
 * prompt over no document — the same stance `buildAutomationRunItems` takes
 * about a run with no Ticket to run on.
 */
export function buildEditorCommandItems(editorOpen: boolean): CommandPaletteEditorItem[] {
  if (!editorOpen) return [];
  return [
    {
      kind: "editor-command",
      id: "go-to-line",
      title: "Go to Line…",
      hint: "In the editor you were last in",
    },
  ];
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
