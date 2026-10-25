/**
 * The cleanup half of streamed text, shared by the functions that end a
 * stream: the runner's settle (`streamChunks.settle`), the accept fold (turn
 * ends, and settled messages once their bodies arrive with `accept`) and the
 * sweeps. A claim move re-points viewers itself (`sessions.transferClaim`).
 *
 * Chunk rows are disposable: the settled message is a durable fact that holds
 * the whole content. So every cleanup here is a bounded batch that schedules
 * its own continuation, and none of them is ever a reason to refuse a write.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter, Scheduler } from "convex/server";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { internal } from "../_generated/api";

/**
 * Chunk rows one cleanup step deletes before it schedules the next. A
 * baseline row may hold 64 KB, so this keeps a step's reads at a few MB.
 */
export const STREAM_CLEANUP_BATCH = 64;

type Db = GenericDatabaseWriter<DataModel>;

/**
 * Deletes the first `limit` of `rows` (read with `take(limit + 1)`) and says
 * whether more remain: the step every batched cleanup takes.
 */
export async function deleteBatch(
  db: Db,
  rows: readonly { _id: Doc<"streamChunks">["_id"] }[],
  limit = STREAM_CLEANUP_BATCH,
): Promise<boolean> {
  for (const row of rows.slice(0, limit)) await db.delete(row._id);
  return rows.length > limit;
}

/** Deletes a batch of one stream's rows (a message of a Session). Returns whether rows remain. */
export async function deleteStreamRows(
  db: Db,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .query("streamChunks")
    .withIndex("by_session_message_seq", (q) =>
      q.eq("sessionId", sessionId).eq("messageId", messageId),
    )
    .take(STREAM_CLEANUP_BATCH + 1);
  return deleteBatch(db, rows);
}

/**
 * Deletes a batch of the rows a Session wrote for a turn that has ended: rows
 * of `turnId`, and rows that named no turn, written no later than `cutoff`
 * (when the turn's end was accepted). A turn's chunks are sent live, before
 * its end is drained, so every one of them is older than the cutoff; a later
 * turn's rows are left alone. Returns whether rows remain.
 */
export async function deleteTurnRows(
  db: Db,
  sessionId: string,
  turnId: string,
  cutoff: number,
): Promise<boolean> {
  const rows = await db
    .query("streamChunks")
    .withIndex("by_session_created", (q) => q.eq("sessionId", sessionId).lte("createdAt", cutoff))
    .filter((q) => q.or(q.eq(q.field("turnId"), turnId), q.eq(q.field("turnId"), null)))
    .take(STREAM_CLEANUP_BATCH + 1);
  return deleteBatch(db, rows);
}

/** What an accepted batch of Session facts ends, for the stream cleanup. */
export interface StreamSettles {
  /** Turns whose end (`turn.completed`, `turn.interrupted`) was accepted. */
  turnIds: string[];
  /** Messages whose settled body was accepted (from the bodies `accept` carries). */
  messageIds: string[];
}

/** The turns an accepted batch ends, read off the facts' payloads. */
export function endedTurnsOf(events: readonly { payload: unknown }[]): string[] {
  const turnIds: string[] = [];
  for (const { payload } of events) {
    if (typeof payload !== "object" || payload === null) continue;
    const { kind, turnId } = payload as { kind?: unknown; turnId?: unknown };
    if ((kind === "turn.completed" || kind === "turn.interrupted") && typeof turnId === "string") {
      if (!turnIds.includes(turnId)) turnIds.push(turnId);
    }
  }
  return turnIds;
}

/**
 * The accept fold's hook: schedules the deletion of every stream an accepted
 * batch ended. Scheduled rather than inline, so the accept stays one bounded
 * write however many chunk rows a turn left.
 */
export async function scheduleStreamCleanup(
  ctx: { scheduler: Scheduler },
  sessionId: string,
  settles: StreamSettles,
  acceptedAt: number,
): Promise<void> {
  for (const messageId of settles.messageIds) {
    await ctx.scheduler.runAfter(0, internal.streamChunks.cleanupMessage, {
      sessionId,
      messageId,
      sequence: null,
      attempt: 0,
    });
  }
  for (const turnId of settles.turnIds) {
    await ctx.scheduler.runAfter(0, internal.streamChunks.cleanupTurn, {
      sessionId,
      turnId,
      cutoff: acceptedAt,
    });
  }
}

/** The Session's accepted cursor: a settled message whose fact is at or below it is durable here. */
export async function acceptedThrough(
  db: GenericDatabaseReader<DataModel>,
  sessionId: string,
): Promise<number> {
  const intake = await db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  return intake?.acceptedThrough ?? 0;
}
