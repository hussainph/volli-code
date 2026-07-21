import type Database from "better-sqlite3";
import {
  createTicket,
  isValidBranchName,
  leavesActiveColumns,
  moveTicket,
  type Ticket,
  type TicketEventActor,
  type HarnessId,
  type TicketPriority,
  type TicketStatus,
  type WorktreeIdentity,
} from "@volli/shared";

import { createComment } from "./db/comments-repo";
import { recordTicketEvent } from "./db/events-repo";
import {
  addTicketLabel,
  findLabelByName,
  getOrCreateLabel,
  removeTicketLabel,
} from "./db/labels-repo";
import {
  archiveTicket,
  bumpTicketVersion,
  deleteTicket,
  getTicket,
  getTicketLabelNames,
  getTicketRow,
  insertTicket,
  listTicketsByProject,
  nextPositionInStatus,
  nextTicketNumberForProject,
  unarchiveTicket,
  updateTicketFields,
  updateTicketPositionStatus,
  updateTicketPriority,
  type TicketFieldUpdate,
  type TicketRow,
} from "./db/tickets-repo";

export interface TicketCommandContext {
  now: number;
  actor: TicketEventActor;
}

function requireLiveTicket(db: Database.Database, ticketId: string, action: string): TicketRow {
  const row = getTicketRow(db, ticketId);
  if (!row) throw new Error("Unknown ticket");
  if (row.archived_at !== null) throw new Error(`Cannot ${action} an archived ticket`);
  return row;
}

/** Existence-only variant for the narrow archived-allowed callers (see below). */
function requireTicket(db: Database.Database, ticketId: string): TicketRow {
  const row = getTicketRow(db, ticketId);
  if (!row) throw new Error("Unknown ticket");
  return row;
}

function rowWorktreeIdentity(row: TicketRow): WorktreeIdentity {
  return {
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
  };
}

export interface CreateTicketCommandInput {
  id: string;
  projectId: string;
  title: string;
  status: TicketStatus;
  body?: string;
  priority?: TicketPriority;
  labels?: string[];
  usesWorktree?: boolean;
  preferredHarnessId?: HarnessId;
  baseBranch?: string | null;
}

export function createTicketCommand(
  db: Database.Database,
  input: CreateTicketCommandInput,
  context: TicketCommandContext,
): Ticket {
  // An explicit base branch override is validated at the command layer so both
  // doors (socket and IPC) share identical semantics — the socket door
  // additionally pre-validates to surface INVALID_REQUEST instead of this.
  if (typeof input.baseBranch === "string" && !isValidBranchName(input.baseBranch)) {
    throw new Error("Invalid base branch name");
  }
  return db.transaction((): Ticket => {
    const ticket = createTicket({
      id: input.id,
      projectId: input.projectId,
      ticketNumber: nextTicketNumberForProject(db, input.projectId),
      title: input.title,
      body: input.body,
      status: input.status,
      priority: input.priority,
      labels: input.labels,
      usesWorktree: input.usesWorktree,
      preferredHarnessId: input.preferredHarnessId,
      order: nextPositionInStatus(db, input.projectId, input.status),
      baseBranch: input.baseBranch,
      now: context.now,
    });
    insertTicket(db, ticket);
    recordTicketEvent(
      db,
      ticket.id,
      { kind: "created", status: ticket.status, title: ticket.title },
      context.now,
      context.actor,
    );
    for (const name of ticket.labels) {
      const label = getOrCreateLabel(db, ticket.projectId, name, context.now);
      addTicketLabel(db, ticket.id, label.id);
    }
    if (ticket.labels.length > 0) {
      recordTicketEvent(
        db,
        ticket.id,
        { kind: "labels_changed", added: ticket.labels, removed: [] },
        context.now,
        context.actor,
      );
    }
    const created = getTicket(db, ticket.id);
    if (!created) throw new Error("Unknown ticket");
    return created;
  })();
}

export function moveTicketCommand(
  db: Database.Database,
  input: { projectId: string; ticketId: string; toStatus: TicketStatus; toIndex: number },
  context: TicketCommandContext,
): Ticket[] {
  return db.transaction((): Ticket[] => {
    requireLiveTicket(db, input.ticketId, "move");
    const before = listTicketsByProject(db, input.projectId);
    const beforeById = new Map(before.map((ticket) => [ticket.id, ticket]));
    const after = moveTicket(before, input.ticketId, input.toStatus, input.toIndex, context.now);
    if (after !== before) {
      for (const ticket of after) {
        const prior = beforeById.get(ticket.id);
        if (prior && (prior.status !== ticket.status || prior.order !== ticket.order)) {
          updateTicketPositionStatus(db, ticket.id, ticket.status, ticket.order, ticket.updatedAt);
        }
      }
      const movedBefore = beforeById.get(input.ticketId);
      const movedAfter = after.find((ticket) => ticket.id === input.ticketId);
      if (movedBefore && movedAfter && movedBefore.status !== movedAfter.status) {
        recordTicketEvent(
          db,
          input.ticketId,
          { kind: "status_changed", from: movedBefore.status, to: movedAfter.status },
          context.now,
          context.actor,
        );
      }
    }
    return after;
  })();
}

/**
 * The backward-move side effect (issue #78, CONCEPT #20): a board move that
 * leaves the active columns ({@link leavesActiveColumns}) interrupts every live
 * agent session of the ticket and records ONE `sessions_interrupted` event
 * naming them, attributed to the same actor as the move. Called AFTER the move
 * commits at each choke point — the move is the truth, the interrupt its
 * consequence — so a failed move never interrupts. A missing seam
 * (`interruptTicketSessions` undefined: tests, degraded boot) is a clean no-op,
 * and an empty interrupt (no live agent sessions) records nothing. Returns the
 * interrupted session ids so the caller can surface them if it wants.
 */
export function interruptOnBackwardMove(
  db: Database.Database,
  input: { ticketId: string; fromStatus: TicketStatus; toStatus: TicketStatus },
  context: TicketCommandContext,
  interruptTicketSessions: ((ticketId: string) => string[]) | undefined,
): string[] {
  if (interruptTicketSessions === undefined) return [];
  if (!leavesActiveColumns(input.fromStatus, input.toStatus)) return [];
  const sessionIds = interruptTicketSessions(input.ticketId);
  if (sessionIds.length === 0) return [];
  recordTicketEvent(
    db,
    input.ticketId,
    { kind: "sessions_interrupted", sessionIds },
    context.now,
    context.actor,
  );
  return sessionIds;
}

export function setTicketPriorityCommand(
  db: Database.Database,
  input: { ticketId: string; priority: TicketPriority },
  context: TicketCommandContext,
): Ticket {
  return db.transaction((): Ticket => {
    const row = requireLiveTicket(db, input.ticketId, "change the priority of");
    if (row.priority !== input.priority) {
      updateTicketPriority(db, input.ticketId, input.priority, context.now);
      recordTicketEvent(
        db,
        input.ticketId,
        { kind: "priority_changed", from: row.priority as TicketPriority, to: input.priority },
        context.now,
        context.actor,
      );
    }
    const ticket = getTicket(db, input.ticketId);
    if (!ticket) throw new Error("Unknown ticket");
    return ticket;
  })();
}

export function updateTicketFieldsCommand(
  db: Database.Database,
  input: { ticketId: string } & TicketFieldUpdate,
  context: TicketCommandContext,
  // `allowArchived` is the narrow opt-in for the worktree module's system-level
  // identity clear: removing a worktree must null `worktree_path` even after the
  // ticket is archived (the dir is already gone). Every other caller stays
  // strict — an archived ticket's fields are otherwise frozen.
  options: { allowArchived?: boolean } = {},
): Ticket {
  if (typeof input.branch === "string" && !isValidBranchName(input.branch)) {
    throw new Error("Invalid branch name");
  }
  if (typeof input.baseBranch === "string" && !isValidBranchName(input.baseBranch)) {
    throw new Error("Invalid base branch name");
  }
  return db.transaction((): Ticket => {
    const row = options.allowArchived
      ? requireTicket(db, input.ticketId)
      : requireLiveTicket(db, input.ticketId, "update");
    const fields: TicketFieldUpdate = {};
    if (input.title !== undefined && input.title !== row.title) fields.title = input.title;
    if (input.body !== undefined && input.body !== row.body) fields.body = input.body;
    if (input.worktreePath !== undefined && input.worktreePath !== row.worktree_path) {
      fields.worktreePath = input.worktreePath;
    }
    if (input.branch !== undefined && input.branch !== row.branch) fields.branch = input.branch;
    if (input.baseBranch !== undefined && input.baseBranch !== row.base_branch) {
      fields.baseBranch = input.baseBranch;
    }
    if (
      input.preferredHarnessId !== undefined &&
      input.preferredHarnessId !== row.preferred_harness_id
    ) {
      fields.preferredHarnessId = input.preferredHarnessId;
    }
    const worktreeTouched =
      fields.worktreePath !== undefined ||
      fields.branch !== undefined ||
      fields.baseBranch !== undefined;
    updateTicketFields(db, input.ticketId, fields, context.now);
    if (fields.title !== undefined) {
      recordTicketEvent(
        db,
        input.ticketId,
        { kind: "retitled", from: row.title, to: fields.title },
        context.now,
        context.actor,
      );
    }
    if (fields.body !== undefined) {
      recordTicketEvent(db, input.ticketId, { kind: "body_edited" }, context.now, context.actor);
    }
    if (fields.preferredHarnessId !== undefined) {
      recordTicketEvent(
        db,
        input.ticketId,
        {
          kind: "harness_changed",
          from: row.preferred_harness_id as HarnessId,
          to: fields.preferredHarnessId,
        },
        context.now,
        context.actor,
      );
    }
    if (worktreeTouched) {
      const from = rowWorktreeIdentity(row);
      recordTicketEvent(
        db,
        input.ticketId,
        {
          kind: "worktree_changed",
          from,
          to: {
            worktreePath:
              fields.worktreePath !== undefined ? fields.worktreePath : from.worktreePath,
            branch: fields.branch !== undefined ? fields.branch : from.branch,
            baseBranch: fields.baseBranch !== undefined ? fields.baseBranch : from.baseBranch,
          },
        },
        context.now,
        context.actor,
      );
    }
    const ticket = getTicket(db, input.ticketId);
    if (!ticket) throw new Error("Unknown ticket");
    return ticket;
  })();
}

export function setTicketLabelsCommand(
  db: Database.Database,
  input: { ticketId: string; labels: string[] },
  context: TicketCommandContext,
): Ticket {
  return db.transaction((): Ticket => {
    const row = requireLiveTicket(db, input.ticketId, "change the labels of");
    const current = getTicketLabelNames(db, input.ticketId);
    const added = input.labels.filter((name) => !current.includes(name));
    const removed = current.filter((name) => !input.labels.includes(name));
    if (added.length > 0 || removed.length > 0) {
      for (const name of added) {
        const label = getOrCreateLabel(db, row.project_id, name, context.now);
        addTicketLabel(db, input.ticketId, label.id);
      }
      for (const name of removed) {
        const label = findLabelByName(db, row.project_id, name);
        if (label) removeTicketLabel(db, input.ticketId, label.id);
      }
      bumpTicketVersion(db, input.ticketId, context.now);
      recordTicketEvent(
        db,
        input.ticketId,
        { kind: "labels_changed", added, removed },
        context.now,
        context.actor,
      );
    }
    const ticket = getTicket(db, input.ticketId);
    if (!ticket) throw new Error("Unknown ticket");
    return ticket;
  })();
}

export function createTicketCommentCommand(
  db: Database.Database,
  input: { ticketId: string; body: string; sessionId?: string | null; commentActor: string },
  context: TicketCommandContext,
) {
  requireLiveTicket(db, input.ticketId, "comment on");
  return createComment(
    db,
    {
      ticketId: input.ticketId,
      body: input.body,
      actor: input.commentActor,
      sessionId: input.sessionId,
      eventActor: context.actor,
    },
    context.now,
  );
}

export function archiveTicketCommand(
  db: Database.Database,
  ticketId: string,
  context: TicketCommandContext,
): void {
  db.transaction(() => {
    const row = getTicketRow(db, ticketId);
    if (!row) throw new Error("Unknown ticket");
    if (row.archived_at !== null) return;
    archiveTicket(db, ticketId, context.now);
    recordTicketEvent(db, ticketId, { kind: "archived" }, context.now, context.actor);
  })();
}

export function unarchiveTicketCommand(
  db: Database.Database,
  ticketId: string,
  context: TicketCommandContext,
): Ticket {
  return db.transaction((): Ticket => {
    const row = getTicketRow(db, ticketId);
    if (!row) throw new Error("Unknown ticket");
    if (row.archived_at !== null) {
      // Append at the live end of its retained column — MAX+1 runs while this
      // ticket is still archived, so its own row can't contribute.
      const position = nextPositionInStatus(db, row.project_id, row.status as TicketStatus);
      unarchiveTicket(db, ticketId, position, context.now);
      recordTicketEvent(db, ticketId, { kind: "unarchived" }, context.now, context.actor);
    }
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new Error("Unknown ticket");
    return ticket;
  })();
}

/**
 * Hard-deletes an archived ticket — the one destructive act, Archive-only and
 * never exposed over the agent socket.
 * Guarding here (not just in the UI) keeps a stray call from nuking a live
 * ticket's history. Records no event: the row and its events vanish together
 * in the FK cascade, so there is no actor to attribute.
 */
export function deleteTicketCommand(db: Database.Database, ticketId: string): void {
  db.transaction((): void => {
    const row = getTicketRow(db, ticketId);
    if (!row) throw new Error("Unknown ticket");
    if (row.archived_at === null) {
      throw new Error("Only archived tickets can be deleted");
    }
    deleteTicket(db, ticketId);
  })();
}
