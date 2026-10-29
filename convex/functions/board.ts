/**
 * The board: tickets, their bodies, labels, moves, archive, comments and
 * signals, written once here for every client and agent.
 *
 * Every mutation is `load → decide → apply` over the pure rules in
 * `@volli/shared/cloud` (`board-rules.ts`), inside one transaction that also
 * appends the board events recording it (with the next `seq` from the
 * project's counter), writes the command's receipt (idempotent by
 * `commandId`, seven days) and turns machine side effects into runner jobs
 * (`lib/boardEffects.ts`). The local SQLite board keeps its own commands for
 * signed-out mode; its rules are the ones these were ported from.
 *
 * Every function requires a signed-in Member of the ticket's project's
 * current Workspace: an id that names nothing is `not_found`, and one in a
 * project the viewer is not a Member of is `not_a_member`, as for projects
 * (ids are not secrets).
 *
 * The reads and the writes an agent verb makes (`volli ticket create`,
 * `update`, `move`, `comment`, `signal`, `label merge`, and the reads behind
 * `board`, `ticket list|show|events|brief`, `label list`) also take an agent,
 * through its runner, under an Agent token (`lib/actorAuth.ts`): it acts with
 * its Session owner's membership and is recorded as the `agent` Actor. The
 * rest (archive, restore, comment edits, label colours) stay person-only, as
 * the agent doors have no verb for them. A move naming a ticket or neighbour of another
 * project reads it as `not_found`. An archived project's board takes no
 * writes.
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  CHECKOUT_MODES,
  decideArchiveTicket,
  decideCreateComment,
  decideCreateSignal,
  decideCreateTicket,
  decideEditComment,
  decideMergeLabels,
  decideMoveTickets,
  decideUnarchiveTicket,
  decideUpdateTicket,
  labelNamesOf,
  movingTicketIds,
  BOARD_LIMITS,
  needsRebalance,
  newId,
  normalizeLabelColor,
  parseId,
  parseTicketKey,
  rebalancedPositions,
  renderTicketKey,
  requireCommentEditable,
  TICKET_PRIORITIES,
  TICKET_SIGNAL_KINDS,
  TICKET_SIGNAL_VERDICTS,
  TICKET_STATUSES,
  type Actor,
  type ProjectId,
  type TicketId,
  type TicketStatus,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import {
  authError,
  isShownProject,
  requireProject,
  requireSessionScope,
  type Viewer,
} from "./lib/auth";
import {
  asBoardErrors,
  boardError,
  BoardWrite,
  recordBoardEvents,
  columnEnd,
  columnQuery,
  findTicket,
  insertLabels,
  labelFacts,
  patchTicket,
  projectLabels,
  publicRow,
  requireTicket,
  requireWritableProject,
  storedActor,
  ticketFacts,
} from "./lib/board";
import { enqueueSideEffects, hasLiveWorktree } from "./lib/boardEffects";
import { withBoardReceipt } from "./lib/boardReceipts";
import { visibleBoardEvents } from "./lib/visibility";
import { literals, nullable } from "./lib/validators";

const ticketStatus = literals(TICKET_STATUSES);
const ticketPriority = literals(TICKET_PRIORITIES);
const checkoutMode = literals(CHECKOUT_MODES);
const bodyMutation = v.union(
  v.object({ mode: v.literal("replace"), body: v.string() }),
  v.object({ mode: v.literal("append"), text: v.string() }),
  v.object({ mode: v.literal("edit"), oldText: v.string(), newText: v.string() }),
);
const moveChoice = v.union(
  v.object({ kind: v.literal("automation"), automationId: v.string() }),
  v.object({ kind: v.literal("move-only") }),
);

// ── reads ────────────────────────────────────────────────────────────────────

/** The board roster: every live ticket (without its body) and every label of a project. */
export const roster = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireProject(ctx, projectId, viewer);
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_board", (q) => q.eq("projectId", projectId).eq("archivedAt", null))
      .collect();
    return {
      tickets: tickets.filter((ticket) => ticket.deletedAt === null).map(publicRow),
      labels: (await projectLabels(ctx, projectId)).map(publicRow),
    };
  },
});

/**
 * One ticket and its body (read separately from the roster, so body edits do
 * not re-run it), with the label names it wears now (merges followed).
 */
export const getTicket = query({
  args: { ticketId: v.string() },
  handler: async (ctx, { ticketId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { ticket } = await requireTicket(ctx, ticketId, viewer);
    const body = await ctx.db
      .query("ticketBodies")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
      .unique();
    return {
      ticket: publicRow(ticket),
      body: body?.body ?? "",
      bodyRevision: body?.revision ?? 0,
      labels: labelNamesOf(ticket.labelIds, await projectLabels(ctx, ticket.projectId)),
    };
  },
});

/** A project's Archive, most recently archived first, a page at a time (it only grows). */
export const archivedTickets = query({
  args: { projectId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { projectId, paginationOpts }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireProject(ctx, projectId, viewer);
    const page = await ctx.db
      .query("tickets")
      .withIndex("by_project_archived", (q) => q.eq("projectId", projectId).gte("archivedAt", 0))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.filter((ticket) => ticket.deletedAt === null).map(publicRow),
    };
  },
});

/**
 * A ticket's history, in `seq` order. An event about a Session the viewer
 * cannot see (a private one that is not theirs, unless the Workspace shares
 * everything) is left out.
 */
export const ticketEvents = query({
  args: { ticketId: v.string() },
  handler: async (ctx, { ticketId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { project } = await requireTicket(ctx, ticketId, viewer);
    const events = await ctx.db
      .query("boardEvents")
      .withIndex("by_ticket_seq", (q) => q.eq("ticketId", ticketId))
      .collect();
    const scope = await requireSessionScope(ctx, project.id, viewer);
    return (await visibleBoardEvents(ctx, scope, events)).map(publicRow);
  },
});

/** A ticket's comments, oldest first; removed ones are left out. */
export const comments = query({
  args: { ticketId: v.string() },
  handler: async (ctx, { ticketId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireTicket(ctx, ticketId, viewer);
    const rows = await ctx.db
      .query("ticketComments")
      .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
      .collect();
    return rows.filter((comment) => comment.deletedAt === null).map(publicRow);
  },
});

/** A ticket's signals, by kind then time: the latest of a kind is the one that stands. */
export const signals = query({
  args: { ticketId: v.string() },
  handler: async (ctx, { ticketId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireTicket(ctx, ticketId, viewer);
    const rows = await ctx.db
      .query("ticketSignals")
      .withIndex("by_ticket_kind", (q) => q.eq("ticketId", ticketId))
      .collect();
    return rows.map(publicRow);
  },
});

// ── tickets ──────────────────────────────────────────────────────────────────

/** A ticket for a writable project the viewer can see, refused with the shared codes otherwise. */
async function writableTicket(ctx: MutationCtx, ticketId: string, viewer: Viewer) {
  const access = await requireTicket(ctx, ticketId, viewer);
  requireWritableProject(access.project);
  return access;
}

/** Inserts or rewrites a ticket's body document. */
async function writeBody(
  ctx: MutationCtx,
  ticketId: string,
  body: string,
  actor: Actor,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("ticketBodies")
    .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("ticketBodies", {
      ticketId,
      body,
      revision: 1,
      updatedBy: actor,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, {
      body,
      revision: existing.revision + 1,
      updatedBy: actor,
      updatedAt: now,
    });
  }
}

/** Creates a ticket (caller-minted id) at the end of its column, numbered from the project's counter. */
export const createTicket = mutation({
  args: {
    commandId: v.string(),
    projectId: v.string(),
    ticketId: v.string(),
    status: ticketStatus,
    title: v.string(),
    priority: v.optional(ticketPriority),
    body: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    checkoutMode: v.optional(checkoutMode),
    preferredHarnessId: v.optional(v.string()),
    baseBranch: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.createTicket", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        const ticketId = parseId("ticket", intent.ticketId);
        const taken = await ctx.db
          .query("tickets")
          .withIndex("by_uuid", (q) => q.eq("id", ticketId))
          .unique();
        if (taken !== null) throw boardError("id_taken", "That ticket id is already in use.");
        const now = Date.now();
        const write = await BoardWrite.open(ctx, project.id, actor, now);
        const decision = decideCreateTicket(
          {
            projectId: project.id as ProjectId,
            number: write.allocateTicketNumber(),
            columnEnd: await columnEnd(ctx, project.id, intent.status),
            // Read only when the command names labels: every create already
            // serializes on the project's counter, and the label range would
            // add conflicts with label writes that a plain create never needs.
            labels:
              (intent.labels?.length ?? 0) > 0
                ? (await projectLabels(ctx, project.id)).map(labelFacts)
                : [],
            mintLabelId: () => newId("label"),
          },
          { ...intent, ticketId },
        );
        await insertLabels(ctx, decision.createdLabels, now);
        const { ticket } = decision;
        await ctx.db.insert("tickets", {
          id: ticket.id,
          projectId: ticket.projectId,
          number: ticket.number,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          position: ticket.position,
          labelIds: ticket.labelIds,
          assigneeUserId: null,
          checkoutMode: ticket.checkoutMode,
          preferredHarnessId: ticket.preferredHarnessId,
          branch: null,
          baseBranch: ticket.baseBranch,
          pullRequests: [],
          retentionKeep: false,
          placeRunnerId: null,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          purgeAfter: null,
        });
        await writeBody(ctx, ticket.id, decision.body, actor, now);
        await write.append(decision.events);
        await write.commit();
        return {
          projectId: project.id,
          reply: {
            ticketId: ticket.id,
            number: ticket.number,
            key: renderTicketKey(project, ticket.number),
          },
        };
      },
    ),
});

/**
 * Updates a live ticket's title, body (whole or by mutation), priority,
 * harness, checkout mode and labels (the whole set, or names to add and
 * remove) in one write. An unchanged field records nothing. Switching to a
 * worktree asks the ticket's Place for one; the switch is refused once a
 * worktree exists.
 */
export const updateTicket = mutation({
  args: {
    commandId: v.string(),
    ticketId: v.string(),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    bodyMutation: v.optional(bodyMutation),
    priority: v.optional(ticketPriority),
    preferredHarnessId: v.optional(v.string()),
    checkoutMode: v.optional(checkoutMode),
    labels: v.optional(v.array(v.string())),
    addLabels: v.optional(v.array(v.string())),
    removeLabels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.updateTicket", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { ticketId, ...command } = intent;
        const { project, ticket } = await writableTicket(ctx, ticketId, viewer);
        const now = Date.now();
        const body = await ctx.db
          .query("ticketBodies")
          .withIndex("by_ticket", (q) => q.eq("ticketId", ticket.id))
          .unique();
        const decision = decideUpdateTicket(
          {
            ticket: ticketFacts(ticket),
            body: body?.body ?? "",
            labels: (await projectLabels(ctx, project.id)).map(labelFacts),
            hasWorktree:
              command.checkoutMode !== undefined && (await hasLiveWorktree(ctx, ticket.id)),
            mintLabelId: () => newId("label"),
          },
          command,
        );
        await insertLabels(ctx, decision.createdLabels, now);
        await patchTicket(ctx, ticket, decision.patch, now);
        if (decision.body !== null) await writeBody(ctx, ticket.id, decision.body, actor, now);
        await recordBoardEvents(ctx, project.id, actor, now, decision.events);
        const effects = await enqueueSideEffects(
          { ctx, tickets: new Map([[ticket.id, ticket]]), actor, now },
          decision.sideEffects,
        );
        return {
          projectId: project.id,
          reply: {
            ticketId: ticket.id,
            changed: decision.events.length > 0,
            // Switched to a worktree on a Place that is not the caller's runner:
            // the worktree is made when its owner next works on the ticket there.
            worktreeDeferred: effects.deferredWorktrees.length > 0,
          },
        };
      },
    ),
});

/**
 * The gap a move lands in, read inside the transaction: right after the
 * named `after` ticket, else right before the named `before`. A named neighbour
 * that has since left the column (moved, archived) is ignored rather than
 * refused, so a move made against a slightly stale board still lands next to
 * what is there. With no usable neighbour the group goes to the column's
 * end, or its start when the command named only a ticket to land before.
 */
async function moveGap(
  ctx: MutationCtx,
  projectId: string,
  toStatus: TicketStatus,
  moving: ReadonlySet<string>,
  afterTicketId: string | null,
  beforeTicketId: string | null,
): Promise<{ after: Doc<"tickets"> | null; before: Doc<"tickets"> | null }> {
  const anchor = async (id: string | null): Promise<Doc<"tickets"> | null> => {
    if (id === null) return null;
    const ticket = await findTicket(ctx, parseId("ticket", id));
    if (ticket === null || ticket.projectId !== projectId) {
      throw authError("not_found", "A move names a neighbour that does not exist.");
    }
    const usable =
      ticket.archivedAt === null && ticket.status === toStatus && !moving.has(ticket.id);
    return usable ? ticket : null;
  };
  const column = () => columnQuery(ctx, projectId, toStatus);
  // The first ticket past `from` (in `order`) that is not one of the moved ones.
  const firstStill = async (rows: AsyncIterable<Doc<"tickets">>) => {
    for await (const ticket of rows) if (!moving.has(ticket.id)) return ticket;
    return null;
  };
  const after = await anchor(afterTicketId);
  const before = await anchor(beforeTicketId);
  // The gap is always read off the column itself, never taken from the two
  // named rows alone: reading the range next to the anchor is what makes a
  // concurrent move into the same gap conflict (and retry) instead of
  // computing the same key. A ticket that arrived between the named pair since
  // the client looked is respected: the group lands right after `after`.
  if (after !== null) {
    const next = columnBeyond(ctx, projectId, toStatus, "after", after.position);
    return { after, before: await firstStill(next) };
  }
  if (before !== null) {
    const previous = columnBeyond(ctx, projectId, toStatus, "before", before.position);
    return { after: await firstStill(previous), before };
  }
  if (afterTicketId === null && beforeTicketId !== null) {
    return { after: null, before: await firstStill(column().order("asc")) };
  }
  return { after: await firstStill(column().order("desc")), before: null };
}

/** The live tickets of a column strictly after (or before) `position`, nearest first. */
function columnBeyond(
  ctx: MutationCtx,
  projectId: string,
  status: TicketStatus,
  side: "after" | "before",
  position: string,
) {
  return ctx.db
    .query("tickets")
    .withIndex("by_board", (q) => {
      const column = q.eq("projectId", projectId).eq("archivedAt", null).eq("status", status);
      return side === "after" ? column.gt("position", position) : column.lt("position", position);
    })
    .order(side === "after" ? "asc" : "desc");
}

/**
 * Moves one or more tickets into a column, between the neighbours the
 * command names (or to its end). Exactly the moved tickets are written; the
 * keys are computed here, inside the transaction, so concurrent moves cannot
 * collide. A ticket that crosses columns records `status_changed`, and its
 * consequences become runner jobs: a Done move trims its worktrees, leaving
 * the active columns interrupts its running agents, and an armed column (or
 * the picker's choice) starts an Automation run after the arming delay.
 */
export const moveTickets = mutation({
  args: {
    commandId: v.string(),
    projectId: v.string(),
    ticketIds: v.array(v.string()),
    toStatus: ticketStatus,
    afterTicketId: v.optional(nullable(v.string())),
    beforeTicketId: v.optional(nullable(v.string())),
    choice: v.optional(nullable(moveChoice)),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.moveTickets", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        const now = Date.now();
        const ids = [...new Set(intent.ticketIds.map((id) => parseId("ticket", id)))];
        // Bounded before anything is read.
        if (ids.length > BOARD_LIMITS.ticketsPerMove) {
          throw boardError(
            "invalid_argument",
            `A move takes at most ${BOARD_LIMITS.ticketsPerMove} tickets.`,
          );
        }
        const docs = new Map<string, Doc<"tickets">>();
        for (const id of ids) {
          const ticket = await findTicket(ctx, id);
          // A ticket of another project is not on this board: it reads as absent.
          if (ticket === null || ticket.projectId !== project.id) {
            throw authError("not_found", "A move names a ticket that is not on this board.");
          }
          docs.set(id, ticket);
        }
        const command = {
          ticketIds: ids as TicketId[],
          toStatus: intent.toStatus,
          afterTicketId: (intent.afterTicketId ?? null) as TicketId | null,
          beforeTicketId: (intent.beforeTicketId ?? null) as TicketId | null,
          choice: intent.choice ?? null,
        };
        const facts = [...docs.values()].map(ticketFacts);
        // The gap is read around the tickets that actually move: one a
        // column-only move leaves where it is, is a neighbour like any other.
        const gap = await moveGap(
          ctx,
          project.id,
          intent.toStatus,
          new Set(movingTicketIds(command, facts)),
          command.afterTicketId,
          command.beforeTicketId,
        );
        const decision = decideMoveTickets(
          {
            tickets: facts,
            after: gap.after === null ? null : ticketFacts(gap.after),
            before: gap.before === null ? null : ticketFacts(gap.before),
            now,
          },
          command,
        );
        for (const change of decision.changes) {
          await patchTicket(ctx, docs.get(change.ticketId)!, change.patch, now);
        }
        await recordBoardEvents(ctx, project.id, actor, now, decision.events);
        const { unstartedRuns } = await enqueueSideEffects(
          { ctx, tickets: docs, actor, now },
          decision.sideEffects,
        );
        if (decision.changes.some((change) => needsRebalance(change.patch.position!))) {
          await ctx.scheduler.runAfter(0, internal.board.rebalanceColumn, {
            projectId: project.id,
            status: intent.toStatus,
          });
        }
        return {
          projectId: project.id,
          reply: {
            moved: decision.changes.map((change) => change.ticketId),
            // Picked Automation runs that could not start, and why.
            unstartedRuns,
          },
        };
      },
    ),
});

/**
 * Rewrites a column's keys short and evenly spaced, in their current order,
 * once a key has grown past the rebalance length (rare: many inserts at one
 * spot). Order is unchanged, so it records no event.
 */
export const rebalanceColumn = internalMutation({
  args: { projectId: v.string(), status: ticketStatus },
  handler: async (ctx, { projectId, status }) => {
    const column = await columnQuery(ctx, projectId, status).collect();
    if (!column.some((ticket) => needsRebalance(ticket.position))) return { rewritten: 0 };
    const keys = rebalancedPositions(column.length);
    for (const [index, ticket] of column.entries()) {
      await ctx.db.patch(ticket._id, { position: keys[index]! });
    }
    return { rewritten: column.length };
  },
});

async function archiveWrite(
  ctx: MutationCtx,
  ticketId: string,
  { viewer, actor: viewerActor }: { viewer: Viewer; actor: Actor },
  decide: (ticket: Doc<"tickets">, now: number) => Promise<ReturnType<typeof decideArchiveTicket>>,
) {
  const { project, ticket } = await writableTicket(ctx, ticketId, viewer);
  const now = Date.now();
  const decision = await decide(ticket, now);
  await patchTicket(ctx, ticket, decision.patch, now);
  await recordBoardEvents(ctx, project.id, viewerActor, now, decision.events);
  await enqueueSideEffects(
    { ctx, tickets: new Map([[ticket.id, ticket]]), actor: viewerActor, now },
    decision.sideEffects,
  );
  return {
    projectId: project.id,
    reply: { ticketId: ticket.id, changed: decision.events.length > 0 },
  };
}

/** Archives a ticket: off the board, everything kept, its worktrees trimmed. */
export const archiveTicket = mutation({
  args: { commandId: v.string(), ticketId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(ctx, { commandId, operation: "board.archiveTicket", intent }, (caller) =>
      archiveWrite(ctx, intent.ticketId, caller, async (ticket, now) =>
        decideArchiveTicket(ticketFacts(ticket), now),
      ),
    ),
});

/** Returns an archived ticket to the end of its retained column. */
export const unarchiveTicket = mutation({
  args: { commandId: v.string(), ticketId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(ctx, { commandId, operation: "board.unarchiveTicket", intent }, (caller) =>
      archiveWrite(ctx, intent.ticketId, caller, async (ticket) =>
        decideUnarchiveTicket(
          ticketFacts(ticket),
          await columnEnd(ctx, ticket.projectId, ticket.status),
        ),
      ),
    ),
});

// ── comments and signals ─────────────────────────────────────────────────────

/** Comments on a live ticket (caller-minted id). An agent's comment cites its Session. */
export const createComment = mutation({
  args: { commandId: v.string(), ticketId: v.string(), commentId: v.string(), body: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.createComment", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { project, ticket } = await writableTicket(ctx, intent.ticketId, viewer);
        const commentId = parseId("comment", intent.commentId);
        const taken = await ctx.db
          .query("ticketComments")
          .withIndex("by_uuid", (q) => q.eq("id", commentId))
          .unique();
        if (taken !== null) throw boardError("id_taken", "That comment id is already in use.");
        const now = Date.now();
        const decision = decideCreateComment(
          ticketFacts(ticket),
          { commentId, body: intent.body },
          actor,
        );
        await ctx.db.insert("ticketComments", {
          ...decision.comment,
          author: actor,
          createdAt: now,
          editedAt: null,
          deletedAt: null,
        });
        await recordBoardEvents(ctx, project.id, actor, now, decision.events);
        return { projectId: project.id, reply: { commentId, createdAt: now } };
      },
    ),
});

async function ownComment(ctx: MutationCtx, commentId: string, viewer: Viewer) {
  const comment = await ctx.db
    .query("ticketComments")
    .withIndex("by_uuid", (q) => q.eq("id", parseId("comment", commentId)))
    .unique();
  if (comment === null) throw authError("not_found", "That comment does not exist.");
  const { project } = await requireProject(ctx, comment.projectId, viewer);
  requireWritableProject(project);
  return comment;
}

/** Edits a comment's body (its author only). Records no board event; the row carries `editedAt`. */
export const updateComment = mutation({
  args: { commandId: v.string(), commentId: v.string(), body: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.updateComment", intent },
      async ({ viewer, actor }) => {
        const comment = await ownComment(ctx, intent.commentId, viewer);
        const body = decideEditComment(
          { author: storedActor(comment.author), deletedAt: comment.deletedAt },
          intent.body,
          actor,
        );
        if (body !== comment.body) await ctx.db.patch(comment._id, { body, editedAt: Date.now() });
        return { projectId: comment.projectId, reply: { commentId: comment.id } };
      },
    ),
});

/** Removes a comment (its author only): hidden from every read, kept until the ticket is purged. */
export const removeComment = mutation({
  args: { commandId: v.string(), commentId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.removeComment", intent },
      async ({ viewer, actor }) => {
        const comment = await ownComment(ctx, intent.commentId, viewer);
        requireCommentEditable(
          { author: storedActor(comment.author), deletedAt: comment.deletedAt },
          actor,
        );
        await ctx.db.patch(comment._id, { deletedAt: Date.now() });
        return { projectId: comment.projectId, reply: { commentId: comment.id } };
      },
    ),
});

/** Records one typed verdict on a live ticket (caller-minted id). Never a board move. */
export const createSignal = mutation({
  args: {
    commandId: v.string(),
    ticketId: v.string(),
    signalId: v.string(),
    kind: literals(TICKET_SIGNAL_KINDS),
    verdict: literals(TICKET_SIGNAL_VERDICTS),
    detail: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.createSignal", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { project, ticket } = await writableTicket(ctx, intent.ticketId, viewer);
        const signalId = parseId("signal", intent.signalId);
        const taken = await ctx.db
          .query("ticketSignals")
          .withIndex("by_uuid", (q) => q.eq("id", signalId))
          .unique();
        if (taken !== null) throw boardError("id_taken", "That signal id is already in use.");
        const now = Date.now();
        const decision = decideCreateSignal(ticketFacts(ticket), { ...intent, signalId }, actor);
        await ctx.db.insert("ticketSignals", { ...decision.signal, actor, createdAt: now });
        await recordBoardEvents(ctx, project.id, actor, now, decision.events);
        return { projectId: project.id, reply: { signalId, createdAt: now } };
      },
    ),
});

// ── labels ───────────────────────────────────────────────────────────────────

/** Sets (or clears, with `null`) a label's colour. Records no board event, as on the local board. */
export const setLabelColor = mutation({
  args: { commandId: v.string(), labelId: v.string(), color: nullable(v.string()) },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.setLabelColor", intent },
      async ({ viewer }) => {
        const label = await ctx.db
          .query("labels")
          .withIndex("by_uuid", (q) => q.eq("id", parseId("label", intent.labelId)))
          .unique();
        if (label === null) throw authError("not_found", "That label does not exist.");
        const { project } = await requireProject(ctx, label.projectId, viewer);
        requireWritableProject(project);
        const color = normalizeLabelColor(intent.color);
        if (color !== label.color) await ctx.db.patch(label._id, { color, updatedAt: Date.now() });
        return { projectId: project.id, reply: { labelId: label.id } };
      },
    ),
});

/** A project's live labels (aliases left out), each with how many board tickets wear it. */
export const labels = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireProject(ctx, projectId, viewer);
    const rows = await projectLabels(ctx, projectId);
    const tickets = await ctx.db
      .query("tickets")
      .withIndex("by_board", (q) => q.eq("projectId", projectId).eq("archivedAt", null))
      .collect();
    const worn = new Map<string, number>();
    for (const ticket of tickets) {
      if (ticket.deletedAt !== null) continue;
      for (const name of labelNamesOf(ticket.labelIds, rows)) {
        worn.set(name, (worn.get(name) ?? 0) + 1);
      }
    }
    return rows
      .filter((label) => label.mergedIntoId === null)
      .map((label) => ({
        labelId: label.id,
        name: label.name,
        color: label.color,
        tickets: worn.get(label.name) ?? 0,
      }));
  },
});

/** At most this many tickets are named in a label merge preview; `ticketCount` counts them all. */
const LABEL_MERGE_LISTED_TICKETS = 200;

/** Loads and decides a label merge (the labels only: the merge writes one label row). */
async function decideLabelMerge(
  ctx: QueryCtx | MutationCtx,
  project: Doc<"projects">,
  command: { from: string; into: string },
) {
  const rows = await projectLabels(ctx, project.id);
  const decision = await asBoardErrors(() => decideMergeLabels(rows.map(labelFacts), command));
  return { decision, fromRow: rows.find((row) => row.id === decision.from.id)! };
}

/**
 * A label merge's preview: the tickets it relabels, live and archived, so the
 * whole blast radius shows. Reads every ticket of the project, so it is a
 * query, never part of the write.
 */
async function previewLabelMerge(
  ctx: QueryCtx,
  project: Doc<"projects">,
  command: { from: string; into: string },
) {
  const { decision } = await decideLabelMerge(ctx, project, command);
  const fromIds = new Set<string>(decision.fromIds);
  const tickets = [];
  for await (const ticket of ctx.db
    .query("tickets")
    .withIndex("by_project_number", (q) => q.eq("projectId", project.id))) {
    if (ticket.deletedAt !== null || !ticket.labelIds.some((id) => fromIds.has(id))) continue;
    tickets.push({
      ticketId: ticket.id,
      key: renderTicketKey(project, ticket.number),
      title: ticket.title,
      archived: ticket.archivedAt !== null,
    });
  }
  return {
    from: decision.from.name,
    into: decision.into.name,
    ticketCount: tickets.length,
    tickets: tickets.slice(0, LABEL_MERGE_LISTED_TICKETS),
  };
}

/**
 * What folding `from` into `into` would change, without changing it: `volli
 * label merge` previews by default, because the merge rewrites how tickets
 * nobody is looking at are organised.
 */
export const labelMergePreview = query({
  args: { projectId: v.string(), from: v.string(), into: v.string() },
  handler: async (ctx, { projectId, from, into }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { project } = await requireProject(ctx, projectId, viewer);
    return { ...(await previewLabelMerge(ctx, project, { from, into })), applied: false };
  },
});

/**
 * Folds one label into another (`decideMergeLabels`): `from` becomes an
 * alias of `into`, so every ticket that wore it wears `into` and the retired
 * name keeps resolving there. Records one project-level `label_merged` event.
 * Writes one label row and reads no ticket: `labelMergePreview` lists them.
 */
export const mergeLabels = mutation({
  args: { commandId: v.string(), projectId: v.string(), from: v.string(), into: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "board.mergeLabels", intent, allow: PERSON_OR_AGENT },
      async ({ viewer, actor }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        const { decision, fromRow } = await decideLabelMerge(ctx, project, intent);
        const now = Date.now();
        await ctx.db.patch(fromRow._id, {
          ...decision.patch,
          mergedAt: now,
          mergedBy: actor,
          updatedAt: now,
        });
        await recordBoardEvents(ctx, project.id, actor, now, decision.events);
        return {
          projectId: project.id,
          reply: { from: decision.from.name, into: decision.into.name, applied: true },
        };
      },
    ),
});

// ── ticket keys ──────────────────────────────────────────────────────────────

/** At most this many candidates are named in an ambiguous key's refusal. */
const KEY_CANDIDATES = 20;

function occursOnce(keys: readonly string[], key: string): boolean {
  return keys.filter((other) => other === key).length === 1;
}

/**
 * The ambiguous matches, each with a key qualified as narrowly as it takes to
 * name it alone: by project name, else by Workspace slug, else not at all
 * (`null`: only its ticket id names it, two projects of one Workspace sharing
 * a name and a prefix).
 */
function qualifiedCandidates(
  matches: readonly {
    ticket: Doc<"tickets">;
    project: Doc<"projects">;
    workspace: Doc<"workspaces">;
  }[],
) {
  const byName = matches.map(
    ({ ticket, project }) =>
      `${qualifierOf(project.name)}/${renderTicketKey(project, ticket.number)}`,
  );
  const bySlug = matches.map(
    ({ ticket, project, workspace }) =>
      `${workspace.slug}/${renderTicketKey(project, ticket.number)}`,
  );
  return matches.map(({ ticket, project, workspace }, index) => ({
    ticketId: ticket.id,
    projectId: project.id,
    projectName: project.name,
    workspaceSlug: workspace.slug,
    qualifiedKey: occursOnce(byName, byName[index]!)
      ? byName[index]!
      : occursOnce(bySlug, bySlug[index]!)
        ? bySlug[index]!
        : null,
  }));
}

/** A project name as a key qualifier matches it: lower case, runs of other characters as `-`. */
function qualifierOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The ticket a typed display key (`VC-12`, or qualified `volli-code/VC-12`)
 * names among the projects the caller can see, without guessing.
 *
 * The prefix is looked up in every Workspace the caller (an agent: its
 * Session's owner) is an active Member of. An agent's own Session is
 * preferred: its project, then its Workspace. A qualifier names a project
 * (its name, lower case and dashed) or a Workspace (its slug). When more than
 * one ticket still matches, the answer is `ambiguous_key` with the candidates
 * (their ids, projects and Workspaces) so the caller can qualify the key or
 * use the ticket's id; `not_found` when none does.
 */
export const resolveTicketKey = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const caller = await requireActor(ctx, PERSON_OR_AGENT);
    const parsed = parseTicketKey(key);
    if (parsed === null || (parsed.qualifier !== null && qualifierOf(parsed.qualifier) === "")) {
      throw boardError("invalid_argument", `${key} is not a ticket key (like VC-12).`);
    }
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", caller.viewer.userId))
      .collect();
    type Candidate = {
      ticket: Doc<"tickets">;
      project: Doc<"projects">;
      workspace: Doc<"workspaces">;
    };
    const candidates: Candidate[] = [];
    for (const membership of memberships) {
      if (membership.status !== "active") continue;
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", membership.workspaceId))
        .unique();
      if (workspace === null || workspace.deletedAt !== null) continue;
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_workspace_prefix", (q) =>
          q.eq("workspaceId", workspace.id).eq("ticketPrefix", parsed.prefix),
        )
        .collect();
      for (const project of projects) {
        if (!isShownProject(project)) continue;
        if (
          parsed.qualifier !== null &&
          parsed.qualifier.toLowerCase() !== workspace.slug.toLowerCase() &&
          qualifierOf(parsed.qualifier) !== qualifierOf(project.name)
        ) {
          continue;
        }
        const ticket = await ctx.db
          .query("tickets")
          .withIndex("by_project_number", (q) =>
            q.eq("projectId", project.id).eq("number", parsed.number),
          )
          .unique();
        if (ticket !== null && ticket.deletedAt === null) {
          candidates.push({ ticket, project, workspace });
        }
      }
    }
    let matches = candidates;
    if (matches.length > 1 && caller.agent !== null) {
      const sessionProjectId = caller.agent.session.projectId;
      const sessionProject = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", sessionProjectId))
        .unique();
      const inProject = matches.filter((c) => c.project.id === sessionProjectId);
      const inWorkspace = matches.filter((c) => c.workspace.id === sessionProject?.workspaceId);
      matches = inProject.length > 0 ? inProject : inWorkspace.length > 0 ? inWorkspace : matches;
    }
    if (matches.length === 0) throw authError("not_found", `No ticket ${key} that you can see.`);
    if (matches.length > 1) {
      throw new ConvexError({
        code: "ambiguous_key",
        message: `${key} names a ticket in more than one project. Qualify it (project/${parsed.prefix}-${parsed.number}) or use the ticket's id.`,
        candidates: qualifiedCandidates(matches.slice(0, KEY_CANDIDATES)),
      });
    }
    const [{ ticket, project }] = matches as [Candidate];
    return {
      ticketId: ticket.id,
      projectId: project.id,
      key: renderTicketKey(project, ticket.number),
    };
  },
});
