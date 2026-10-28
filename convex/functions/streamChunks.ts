/**
 * Streamed text: a message still being written, as short-lived chunk rows
 * (`@volli/shared/cloud` stream-chunks has the shape and the rules).
 *
 * - `append` (runner): the next chunk of one stream, from the runner that
 *   runs the Session. Idempotent by `(sessionId, messageId, seq)`. The runner
 *   sends chunks only while someone views the Session (`sessionViewers`).
 * - `settle` (runner): the message settled as a Session fact at `sequence`;
 *   its chunks go once the backend has accepted that fact.
 * - `since` (client): the cursor read a viewer folds with the transcript
 *   overlay fold, and the streams of its cursors that have ended.
 * - `cleanupMessage`, `cleanupTurn`, `sweep` (internal): bounded deletes.
 *   The accept fold schedules the first two (`lib/streamChunks.ts`); a cron
 *   runs the sweep, which removes any row older than 15 minutes.
 */

import { ConvexError, v } from "convex/values";

import {
  STREAM_CHUNK_TTL_MS,
  STREAM_MESSAGE_ID_MAX_LENGTH,
  parseStreamChunkOps,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { requireSessionVisible } from "./lib/auth";
import { projectImporting } from "./lib/jobs";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import {
  STREAM_CLEANUP_BATCH,
  acceptedThrough,
  deleteBatch,
  deleteStreamRows,
  deleteTurnRows,
} from "./lib/streamChunks";

export type StreamChunkErrorCode = "not_claimed" | "invalid_chunk";

function streamError(code: StreamChunkErrorCode, message: string) {
  return new ConvexError({ code, message });
}

/** A settle that arrives before its fact is re-checked this many times (1 s, 2 s, … 32 s). */
export const SETTLE_ATTEMPTS = 6;

/** The live Session the calling runner runs, or `not_claimed`. */
async function requireSessionRunner(ctx: MutationCtx, sessionId: string): Promise<Doc<"sessions">> {
  const caller = await requireRunnerForWrite(ctx);
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
  if (
    session === null ||
    session.deletedAt !== null ||
    session.placeRunnerId !== caller.runnerId ||
    // A Session of a project still being imported takes no writes until its commit.
    (await projectImporting(ctx, session.projectId))
  ) {
    throw streamError("not_claimed", "This runner does not run that session.");
  }
  return session;
}

function isSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function checkMessageId(messageId: string): void {
  if (messageId.length === 0 || messageId.length > STREAM_MESSAGE_ID_MAX_LENGTH) {
    throw streamError("invalid_chunk", "A message id is 1 to 512 characters.");
  }
}

/**
 * Appends the next chunk of one stream. A chunk whose seq is already stored
 * is skipped (`written: false`), so a resend never duplicates a row.
 */
export const append = mutation({
  args: {
    sessionId: v.string(),
    messageId: v.string(),
    turnId: v.union(v.string(), v.null()),
    seq: v.number(),
    baseline: v.boolean(),
    throughSequence: v.number(),
    ops: v.string(),
  },
  handler: async (ctx, args): Promise<{ written: boolean }> => {
    await requireSessionRunner(ctx, args.sessionId);
    checkMessageId(args.messageId);
    if (args.turnId !== null && args.turnId.length > STREAM_MESSAGE_ID_MAX_LENGTH) {
      throw streamError("invalid_chunk", "A turn id is at most 512 characters.");
    }
    if (!isSequence(args.seq) || !isSequence(args.throughSequence)) {
      throw streamError(
        "invalid_chunk",
        "A chunk's seq and throughSequence are non-negative integers.",
      );
    }
    const parsed = parseStreamChunkOps(args.ops, args.baseline);
    if (!parsed.ok) throw streamError("invalid_chunk", `Chunk ${args.seq}: ${parsed.reason}.`);
    const existing = await ctx.db
      .query("streamChunks")
      .withIndex("by_session_message_seq", (q) =>
        q.eq("sessionId", args.sessionId).eq("messageId", args.messageId).eq("seq", args.seq),
      )
      .first();
    if (existing !== null) return { written: false };
    await ctx.db.insert("streamChunks", {
      sessionId: args.sessionId,
      messageId: args.messageId,
      seq: args.seq,
      turnId: args.turnId,
      baseline: args.baseline,
      throughSequence: args.throughSequence,
      delta: args.ops,
      createdAt: Date.now(),
    });
    return { written: true };
  },
});

type CleanupArgs = {
  sessionId: string;
  messageId: string;
  sequence: number | null;
  attempt: number;
};
type CleanupState = "deleted" | "deleting" | "waiting" | "abandoned";

/**
 * One step of a message's cleanup: wait (bounded, by rescheduling) until the
 * settling fact at `sequence` is accepted, then delete in batches. A settle
 * whose fact never arrives leaves its rows to the turn's end or the sweep.
 */
async function cleanupMessageStep(ctx: MutationCtx, args: CleanupArgs): Promise<CleanupState> {
  if (args.sequence !== null && (await acceptedThrough(ctx.db, args.sessionId)) < args.sequence) {
    if (args.attempt >= SETTLE_ATTEMPTS) return "abandoned";
    await ctx.scheduler.runAfter(1000 * 2 ** args.attempt, internal.streamChunks.cleanupMessage, {
      ...args,
      attempt: args.attempt + 1,
    });
    return "waiting";
  }
  if (!(await deleteStreamRows(ctx.db, args.sessionId, args.messageId))) return "deleted";
  await ctx.scheduler.runAfter(0, internal.streamChunks.cleanupMessage, {
    sessionId: args.sessionId,
    messageId: args.messageId,
    sequence: null,
    attempt: 0,
  });
  return "deleting";
}

/** The message settled as the Session fact at `sequence`: its chunks go once that fact is accepted. */
export const settle = mutation({
  args: { sessionId: v.string(), messageId: v.string(), sequence: v.number() },
  handler: async (ctx, args): Promise<{ state: CleanupState }> => {
    await requireSessionRunner(ctx, args.sessionId);
    checkMessageId(args.messageId);
    if (!isSequence(args.sequence) || args.sequence === 0) {
      throw streamError("invalid_chunk", "A settle names the positive sequence of its fact.");
    }
    return { state: await cleanupMessageStep(ctx, { ...args, attempt: 0 }) };
  },
});

export const cleanupMessage = internalMutation({
  args: {
    sessionId: v.string(),
    messageId: v.string(),
    sequence: v.union(v.number(), v.null()),
    attempt: v.number(),
  },
  handler: async (ctx, args): Promise<CleanupState> => cleanupMessageStep(ctx, args),
});

export const cleanupTurn = internalMutation({
  args: { sessionId: v.string(), turnId: v.string(), cutoff: v.number() },
  handler: async (ctx, args): Promise<void> => {
    if (await deleteTurnRows(ctx.db, args.sessionId, args.turnId, args.cutoff)) {
      await ctx.scheduler.runAfter(0, internal.streamChunks.cleanupTurn, args);
    }
  },
});

/** Removes every row older than the chunk TTL, in batches. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.db
      .query("streamChunks")
      .withIndex("by_created", (q) => q.lt("createdAt", Date.now() - STREAM_CHUNK_TTL_MS))
      .take(STREAM_CLEANUP_BATCH + 1);
    if (await deleteBatch(ctx.db, rows)) {
      await ctx.scheduler.runAfter(0, internal.streamChunks.sweep, {});
    }
    return Math.min(rows.length, STREAM_CLEANUP_BATCH);
  },
});

// ── the cursor read (client) ────────────────────────────────────────────────

/** The most streams one read follows, and the most rows it returns for one. */
export const SINCE_MAX_STREAMS = 16;
export const SINCE_MAX_ROWS = 100;
/** How many of a Session's newest rows one read looks at to find its open streams. */
export const SINCE_DISCOVERY_ROWS = 32;

export interface StreamChunkRow {
  seq: number;
  baseline: boolean;
  throughSequence: number;
  /** The operations' JSON text: a `TranscriptDelta[]` for the overlay fold. */
  ops: string;
}

export interface StreamChunkStream {
  messageId: string;
  turnId: string | null;
  chunks: StreamChunkRow[];
}

/**
 * A stream the reader holds a cursor for that has no rows left: it ended
 * (settled, its turn ended, or swept), so whatever the reader drew of it is
 * stale. `throughSequence` is the Session's accepted cursor when this was
 * read: a settled message's rows are deleted only once its fact is accepted,
 * so the fact that replaces the stream is at or below it, and a reader that
 * removes the stream once its history reaches it never shows a gap.
 */
export interface StreamChunkRetired {
  messageId: string;
  throughSequence: number;
}

/**
 * The chunks a viewer has not folded yet, per open stream of a Session.
 *
 * The open streams are the ones among the Session's newest rows, plus the
 * ones the reader names in `cursors` (the last seq it folded per message). A
 * stream the reader has no cursor for (a late joiner, or one healing after a
 * gap) starts at its latest baseline, and so does a cursor a newer baseline
 * has overtaken: a `reset` supersedes everything before it. A stream with no
 * rows past its cursor is left out, and so is one with no baseline the reader
 * has no cursor for. Rows come in seq order; a reader that finds a gap
 * ignores the stream until its next baseline.
 *
 * A cursor whose stream has no rows at all is answered in `retired`
 * instead (`StreamChunkRetired`): the stream ended, and the reader removes
 * what it drew of it. Streams it may never have seen end (its `reset` and
 * `message.remove` chunks deleted before it read them) are why this exists.
 *
 * Every read is bounded: a few newest rows, then for each stream one
 * existence check (for a cursor), one baseline lookup and at most
 * {@link SINCE_MAX_ROWS} rows, and the accepted cursor only when a stream
 * retired.
 */
export const since = query({
  args: {
    sessionId: v.string(),
    cursors: v.array(v.object({ messageId: v.string(), seq: v.number() })),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ streams: StreamChunkStream[]; retired: StreamChunkRetired[] }> => {
    await requireSessionVisible(ctx, args.sessionId);
    if (args.cursors.length > SINCE_MAX_STREAMS) {
      throw streamError("invalid_chunk", `A read follows at most ${SINCE_MAX_STREAMS} streams.`);
    }
    const cursors = new Map(args.cursors.map(({ messageId, seq }) => [messageId, seq]));
    const newest = await ctx.db
      .query("streamChunks")
      .withIndex("by_session_created", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(SINCE_DISCOVERY_ROWS);
    // Streams with recent rows first, so a reader's old cursors cannot crowd out a new stream.
    const messageIds = [
      ...new Set([...newest.map((row) => row.messageId), ...cursors.keys()]),
    ].slice(0, SINCE_MAX_STREAMS);
    const streams: StreamChunkStream[] = [];
    const ended: string[] = [];
    for (const messageId of messageIds) {
      const cursor = cursors.get(messageId);
      if (cursor !== undefined) {
        const any = await ctx.db
          .query("streamChunks")
          .withIndex("by_session_message_seq", (q) =>
            q.eq("sessionId", args.sessionId).eq("messageId", messageId),
          )
          .first();
        if (any === null) {
          ended.push(messageId);
          continue;
        }
      }
      const latestBaseline = await ctx.db
        .query("streamChunks")
        .withIndex("by_session_message_baseline", (q) =>
          q.eq("sessionId", args.sessionId).eq("messageId", messageId).eq("baseline", true),
        )
        .order("desc")
        .first();
      const baseline = latestBaseline?.seq;
      const atBaseline = baseline !== undefined && (cursor === undefined || baseline > cursor);
      // First seq to return: the baseline itself, or the one after the cursor.
      const from = atBaseline ? baseline : cursor === undefined ? undefined : cursor + 1;
      if (from === undefined) continue;
      const rows = await ctx.db
        .query("streamChunks")
        .withIndex("by_session_message_seq", (q) =>
          q.eq("sessionId", args.sessionId).eq("messageId", messageId).gte("seq", from),
        )
        .take(SINCE_MAX_ROWS);
      if (rows.length === 0) continue;
      streams.push({
        messageId,
        turnId: rows[0].turnId,
        chunks: rows.map((row) => ({
          seq: row.seq,
          baseline: row.baseline,
          throughSequence: row.throughSequence,
          ops: row.delta,
        })),
      });
    }
    // Read only when a stream ended, so a reader's live query does not re-run on every accept.
    const through = ended.length === 0 ? 0 : await acceptedThrough(ctx.db, args.sessionId);
    return {
      streams,
      retired: ended.map((messageId) => ({ messageId, throughSequence: through })),
    };
  },
});
