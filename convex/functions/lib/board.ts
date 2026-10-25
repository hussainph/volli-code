/**
 * What every board mutation shares: who is acting, the project's counter
 * (ticket numbers and the event sequence), board events, labels, and the
 * mapping between stored rows and the facts the pure rules read.
 *
 * A board write is `load → decide → apply` (`@volli/shared/cloud`
 * `board-rules.ts`): the mutation loads the facts, the shared decision says
 * what changes, and the helpers here apply it inside the same transaction.
 * Every write reads the project's counter document, and every write that
 * records an event (or allocates a ticket number) writes it, so board writes
 * in one project serialize through the backend's optimistic concurrency
 * control: that is the intended order, and what makes `seq` a gapless total
 * order.
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError } from "convex/values";

import {
  BoardRuleError,
  boardLabelFromRow,
  boardTicketFromRow,
  InvalidIdError,
  InvalidPositionError,
  newId,
  type Actor,
  type BoardEventDraft,
  type BoardLabel,
  type BoardRuleCode,
  type BoardTicket,
  type PositionKey,
  type TicketPatch,
  type TicketStatus,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { onBoardEvents } from "./attention";
import { authError, requireProject, type Viewer } from "./auth";

export type BoardErrorCode =
  | BoardRuleCode
  | "invalid_id"
  | "id_taken"
  | "not_found"
  | "command_conflict"
  | "project_archived";

export type BoardErrorData = { code: BoardErrorCode; message: string };

export function boardError(code: BoardErrorCode, message: string): ConvexError<BoardErrorData> {
  return new ConvexError({ code, message });
}

/**
 * Runs pure rules (or a whole handler body), turning a shared refusal into a
 * typed `ConvexError` the client reads by `data.code`.
 */
export async function asBoardErrors<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BoardRuleError) throw boardError(error.code, error.message);
    if (error instanceof InvalidIdError) throw boardError("invalid_id", error.message);
    if (error instanceof InvalidPositionError) throw boardError("invalid_position", error.message);
    throw error;
  }
}

// ── the caller ─────────────────────────────────────────────────────────────

/**
 * Who a board write is attributed to. Today every caller is a person through
 * a client; agent verbs (Session-scoped tokens) resolve to an `agent` Actor
 * here once they exist, and nothing else in the board changes.
 */
export function boardActor(viewer: Viewer): Actor {
  return { kind: "person", userId: viewer.userId };
}

/** A project's board takes writes only while the project is live and not archived. */
export function requireWritableProject(project: Doc<"projects">): void {
  if (project.archivedAt !== null) {
    throw boardError(
      "project_archived",
      "This project is archived. Restore it to change its board.",
    );
  }
}

type Reader = { db: GenericDatabaseReader<DataModel> };

export async function findTicket(ctx: Reader, ticketId: string): Promise<Doc<"tickets"> | null> {
  const ticket = await ctx.db
    .query("tickets")
    .withIndex("by_uuid", (q) => q.eq("id", ticketId))
    .unique();
  return ticket === null || ticket.deletedAt !== null ? null : ticket;
}

/**
 * A live ticket the viewer can see (an active Member of its project's
 * current Workspace), with its project. A ticket the viewer cannot see reads
 * as `not_found`, as a project does.
 */
export async function requireTicket(
  ctx: QueryCtx | MutationCtx,
  ticketId: string,
): Promise<{ viewer: Viewer; project: Doc<"projects">; ticket: Doc<"tickets"> }> {
  const ticket = await findTicket(ctx, ticketId);
  if (ticket === null) throw authError("not_found", "That ticket does not exist.");
  const { viewer, project } = await requireProject(ctx, ticket.projectId);
  return { viewer, project, ticket };
}

// ── rows and facts ─────────────────────────────────────────────────────────

/** A stored row without the backend's own fields: what queries return. */
export function publicRow<T extends { _id: unknown; _creationTime: number }>(
  doc: T,
): Omit<T, "_id" | "_creationTime"> {
  const { _id: _ignoredId, _creationTime: _ignoredTime, ...row } = doc;
  return row;
}

/**
 * A stored Actor as the shared type. The schema's validator mirrors `Actor`
 * field for field; only the id brands are lost in storage.
 */
export function storedActor(actor: Doc<"ticketComments">["author"]): Actor {
  return actor as Actor;
}

/** A stored ticket as the rules' facts: the one map clients share (`@volli/shared/cloud`). */
export function ticketFacts(doc: Doc<"tickets">): BoardTicket {
  return boardTicketFromRow(doc);
}

/** A stored label as the rules' facts. */
export function labelFacts(doc: Doc<"labels">): BoardLabel {
  return boardLabelFromRow(doc);
}

/** Every label of a project, aliases included. */
export async function projectLabels(ctx: Reader, projectId: string): Promise<Doc<"labels">[]> {
  return ctx.db
    .query("labels")
    .withIndex("by_project_name_key", (q) => q.eq("projectId", projectId))
    .collect();
}

/** Writes the labels a decision minted. */
export async function insertLabels(
  ctx: MutationCtx,
  labels: readonly BoardLabel[],
  now: number,
): Promise<void> {
  for (const label of labels) {
    await ctx.db.insert("labels", {
      id: label.id,
      projectId: label.projectId,
      name: label.name,
      nameKey: label.nameKey,
      color: label.color,
      mergedIntoId: null,
      mergedAt: null,
      mergedBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Applies a decision's patch to a ticket row (and stamps it), unless it is empty. */
export async function patchTicket(
  ctx: MutationCtx,
  doc: Doc<"tickets">,
  patch: TicketPatch,
  now: number,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await ctx.db.patch(doc._id, { ...patch, updatedAt: now });
}

/** The live tickets of one column, in position order (the board index). */
export function columnQuery(ctx: Reader, projectId: string, status: TicketStatus) {
  return ctx.db
    .query("tickets")
    .withIndex("by_board", (q) =>
      q.eq("projectId", projectId).eq("archivedAt", null).eq("status", status),
    );
}

/** The last key in a column, or `null` when it has no live ticket. */
export async function columnEnd(
  ctx: Reader,
  projectId: string,
  status: TicketStatus,
): Promise<PositionKey | null> {
  const last = await columnQuery(ctx, projectId, status).order("desc").first();
  return last?.position ?? null;
}

// ── the project's counter and its events ─────────────────────────────────────

/**
 * One board write's handle on its project's counter: ticket numbers and the
 * event sequence come from it, and {@link commit} writes it back once.
 */
export class BoardWrite {
  private nextTicketNumber: number;
  private boardSeq: number;

  private constructor(
    private readonly ctx: MutationCtx,
    private readonly counter: Doc<"projectCounters">,
    private readonly projectId: string,
    private readonly actor: Actor,
    private readonly now: number,
  ) {
    this.nextTicketNumber = counter.nextTicketNumber;
    this.boardSeq = counter.boardSeq;
  }

  static async open(
    ctx: MutationCtx,
    projectId: string,
    actor: Actor,
    now: number,
  ): Promise<BoardWrite> {
    const counter = await ctx.db
      .query("projectCounters")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    // Created with the project; a project without one is corruption, and
    // inventing one could reissue a ticket number a migration already used.
    if (counter === null) throw new Error(`Project ${projectId} has no counter document`);
    return new BoardWrite(ctx, counter, projectId, actor, now);
  }

  /** The next ticket number: allocated in this transaction, never reissued. */
  allocateTicketNumber(): number {
    return this.nextTicketNumber++;
  }

  /**
   * Appends board events in order, each with the next `seq`. This is the one
   * place a board write appends events (the migration import copies history
   * and derives nothing), so what they derive is called from here: the review
   * requests in Needs you (`attention.ts`).
   */
  async append(drafts: readonly BoardEventDraft[]): Promise<void> {
    for (const draft of drafts) {
      this.boardSeq += 1;
      await this.ctx.db.insert("boardEvents", {
        id: newId("boardEvent"),
        projectId: this.projectId,
        ticketId: draft.ticketId,
        seq: this.boardSeq,
        kind: draft.payload.kind,
        actor: this.actor,
        occurredAt: this.now,
        payload: draft.payload,
      });
    }
    await onBoardEvents(this.ctx, {
      projectId: this.projectId,
      actor: this.actor,
      at: this.now,
      events: drafts,
    });
  }

  /**
   * Writes the counter back. It is read by every board write, so it also
   * serializes them; writing it unchanged would only churn it.
   */
  async commit(): Promise<void> {
    if (
      this.nextTicketNumber === this.counter.nextTicketNumber &&
      this.boardSeq === this.counter.boardSeq
    ) {
      return;
    }
    await this.ctx.db.patch(this.counter._id, {
      nextTicketNumber: this.nextTicketNumber,
      boardSeq: this.boardSeq,
    });
  }
}

/** Appends a write's board events through the project's counter (the common case: no ticket number). */
export async function recordBoardEvents(
  ctx: MutationCtx,
  projectId: string,
  actor: Actor,
  now: number,
  drafts: readonly BoardEventDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  const write = await BoardWrite.open(ctx, projectId, actor, now);
  await write.append(drafts);
  await write.commit();
}
