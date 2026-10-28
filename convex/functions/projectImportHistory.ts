/**
 * A moved project's Session history, past its rows: what makes a moved
 * Session readable in Volli Cloud, not only stored.
 *
 * - **Transcript packs and Pi logs.** A moved Session's message bodies and Pi
 *   session log reach Volli Cloud the way a runner's do: packed into
 *   `tx/` objects (`volli.transcript-pack/1`) and Pi log ranges (`pi/`),
 *   each PUT through `projectImports.presignPut`, then recorded here. The
 *   runner's own doors (`transcripts.*`) refuse a Session of a hidden project,
 *   so these are the import's: {@link uploadHead}, {@link commitSegment} and
 *   {@link commitPiLogSegment}, for the importer of an open move, onto their
 *   own runner, for a Session of the moved project, presenting the claim the
 *   import gave it. What a commit checks is the runner's own rule
 *   (`commitTranscriptSegment` / `commitPiLogRange` in `transcripts.ts`): the
 *   key the range derives, contiguity, and a pack covering only what the
 *   Session's intake holds. The client is the runner's spool
 *   (`TranscriptSpool`, host-core) over these doors.
 * - **The fold.** `projectImports.commit` schedules {@link foldMoved}, a
 *   chain over the project's Sessions that starts each one's first fold
 *   (`startMovedFold`): the state and listing row are rebuilt from the
 *   imported events, and nothing they once derived fires again.
 *   {@link foldProgress} is how the client waits for every moved Session to
 *   be folded to its head before it checks them through the window's reads.
 *
 * Receiving wiring (MOVE-5, the move engine): `createMoveHistoryUploader`
 * (host-core) is the client of the history doors; the engine polls
 * {@link foldProgress} after `projectImports.commit` and before its
 * real-path verification.
 */

import { ConvexError, v } from "convex/values";

import {
  isUuid,
  presignS3Request,
  sha256ChecksumHeader,
  type SegmentCommitResult,
  type SessionUploadGrant,
  type SessionUploadHead,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { PRESIGN_EXPIRES_SECONDS, objectStoreConfig } from "./lib/objectStore";
import { startMovedFold } from "./lib/sessionIntake";
import { nullable } from "./lib/validators";
import { OPEN, driverOf, importError, requireImporter, requireOwnRunner } from "./projectImports";
import {
  commitPiLogRange,
  commitTranscriptSegment,
  sessionUploadOf,
  uploadHeadOf,
  type SessionUploadAuthorization,
} from "./transcripts";

const claim = v.object({ runnerId: v.string(), generation: v.number() });

/** Moved Sessions one {@link foldMoved} step starts. */
const FOLD_BATCH = 64;
/**
 * Moved Sessions one {@link foldProgress} page reports on, by default and at
 * most: each reads its row, intake and fold (up to 64 KiB of state).
 */
const PROGRESS_DEFAULT_ITEMS = 32;
const PROGRESS_MAX_ITEMS = 64;

// ── the moved Session's door ─────────────────────────────────────────────────

/**
 * One Session of an open move, for its current driver: the Session is the
 * moved project's and was imported (its owner and claim are the identities
 * the move began with, which every imported row carries), and `fence` is
 * the claim the import gave it (the move's runner, at the imported
 * generation).
 * Anyone else's move reads `not_found` (`requireImporter`), as does a
 * Session that is not this move's.
 */
async function requireMovedSession(
  ctx: QueryCtx,
  moveId: string,
  sessionId: string,
  fence: { runnerId: string; generation: number },
): Promise<{ session: Doc<"sessions">; intake: Doc<"sessionIntake"> }> {
  const { row } = await requireImporter(ctx, moveId);
  // Like `readRows`: once shown, the project's Sessions are their runner's.
  if (!OPEN.has(row.status) || row.uncommittedAt !== null) {
    throw importError("import_closed", "This move no longer takes history.", {
      status: row.status,
    });
  }
  // Whoever drives the move now (an operator may have handed it on), on their own runner.
  const driver = driverOf(row);
  await requireOwnRunner(ctx, driver.userId, driver.runnerId);
  const session = isUuid(sessionId)
    ? await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique()
    : null;
  const intake =
    session === null ||
    session.projectId !== row.projectId ||
    session.ownerUserId !== row.userId ||
    session.deletedAt !== null
      ? null
      : await ctx.db
          .query("sessionIntake")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .unique();
  if (session === null || intake === null) {
    throw new ConvexError({ code: "not_found", message: "That Session is not in this move." });
  }
  if (
    intake.state === "released" ||
    intake.claim.runnerId !== row.runnerId ||
    fence.runnerId !== intake.claim.runnerId ||
    fence.generation !== intake.claim.generation
  ) {
    throw importError("stale_claim", "That is not the claim this move gave the Session.");
  }
  return { session, intake };
}

/** Where a moved Session's uploads stand: the spool resumes from here. */
export const uploadHead = query({
  args: { moveId: v.string(), sessionId: v.string(), claim, piFileIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<SessionUploadHead> => {
    await requireMovedSession(ctx, args.moveId, args.sessionId, args.claim);
    return uploadHeadOf(ctx, args.sessionId, args.piFileIds);
  },
});

/** Whether a moved Session may upload `key` (`presignPut` below asks). */
export const authorizeUpload = internalQuery({
  args: {
    moveId: v.string(),
    sessionId: v.string(),
    claim,
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args): Promise<SessionUploadAuthorization> => {
    const { session } = await requireMovedSession(ctx, args.moveId, args.sessionId, args.claim);
    return sessionUploadOf(ctx, session, args);
  },
});

/**
 * A URL for one PUT of a moved Session's history object (a pack, a spilled
 * body, a Pi log range) of exactly `bytes` bytes hashing to `sha256`, valid
 * for five minutes; or `committed` when a committed row already names the
 * key. The runner's own rule (`files.presignPut`): an object no row names yet
 * may be replaced, so an upload resumed after a crash before its commit
 * (a Pi log that grew since, a pack whose missing bodies came back) writes
 * its new bytes, and the commit records exactly those; a committed one is
 * never signed again. The move's other objects (blobs, archives) are
 * write-once through `projectImports.presignPut`.
 */
export const presignPut = action({
  args: {
    moveId: v.string(),
    sessionId: v.string(),
    claim,
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args): Promise<SessionUploadGrant> => {
    const authorization = await ctx.runQuery(internal.projectImportHistory.authorizeUpload, args);
    if (authorization.status === "committed") return { status: "committed" };
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw importError(
        "storage_unconfigured",
        "Object storage is not configured on this deployment.",
      );
    }
    const request = presignS3Request({
      ...config,
      method: "PUT",
      key: authorization.key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
      headers: {
        "content-length": String(args.bytes),
        "x-amz-checksum-sha256": sha256ChecksumHeader(args.sha256),
      },
    });
    return { status: "sign", request };
  },
});

/** Records a moved Session's transcript pack, after its PUT (the runner's rule). */
export const commitSegment = mutation({
  args: {
    moveId: v.string(),
    sessionId: v.string(),
    claim,
    segmentId: v.string(),
    firstSequence: v.number(),
    lastSequence: v.number(),
    turnIds: v.array(v.string()),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
    artifactCount: v.number(),
    digests: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<SegmentCommitResult> => {
    const moved = await requireMovedSession(ctx, args.moveId, args.sessionId, args.claim);
    return commitTranscriptSegment(ctx, moved, args);
  },
});

/** Records one byte range of a moved Session's Pi log, after its PUT (the runner's rule). */
export const commitPiLogSegment = mutation({
  args: {
    moveId: v.string(),
    sessionId: v.string(),
    claim,
    attachmentId: v.string(),
    piFileId: v.string(),
    startOffset: v.number(),
    endOffset: v.number(),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args): Promise<SegmentCommitResult> => {
    const { session } = await requireMovedSession(ctx, args.moveId, args.sessionId, args.claim);
    return commitPiLogRange(ctx, session, args);
  },
});

// ── the fold ─────────────────────────────────────────────────────────────────

/**
 * One step of the chain a commit starts: the first fold of each of the next
 * {@link FOLD_BATCH} moved Sessions (the importer's own Sessions of the
 * project), then the next step. Stops when the move is no longer committed
 * (rolled back). A Session already folded, or folding on schedule, is left
 * alone, so a step run twice, or a commit after a roll back, starts nothing
 * twice; one whose fold stopped short of its head is scheduled again (a
 * commit sent again runs the chain again for exactly that).
 */
export const foldMoved = internalMutation({
  args: { moveId: v.string(), cursor: nullable(v.string()) },
  handler: async (ctx, { moveId, cursor }) => {
    const row = await ctx.db
      .query("projectImports")
      .withIndex("by_uuid", (q) => q.eq("id", moveId))
      .unique();
    if (row === null || row.status !== "committed") return { started: 0, done: true };
    const page = await ctx.db
      .query("sessions")
      .withIndex("by_project_activity", (q) => q.eq("projectId", row.projectId))
      .paginate({ cursor, numItems: FOLD_BATCH });
    const now = Date.now();
    let started = 0;
    for (const session of page.page) {
      if (session.deletedAt !== null || session.ownerUserId !== row.userId) continue;
      if (await startMovedFold(ctx, session.id, now)) started += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.projectImportHistory.foldMoved, {
        moveId,
        cursor: page.continueCursor,
      });
    }
    return { started, done: page.isDone };
  },
});

/**
 * How far the moved Sessions are folded, a page at a time (the importer's
 * own Sessions of the project, least recently active first): how many the
 * page held, how many are folded to their head, and the ones that are not
 * yet, with when their fold was last scheduled (a schedule long past is a
 * fold that stopped; `commit` sent again restarts it). Counts and ids only.
 * Folding reorders the index under the pages, so the pages answer "is
 * anything behind", not an exact count: the client polls until a full pass
 * finds nothing behind, then reads the Sessions through the window's own
 * queries.
 */
export const foldProgress = query({
  args: {
    moveId: v.string(),
    cursor: nullable(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, { moveId, cursor, numItems }) => {
    const { row } = await requireImporter(ctx, moveId);
    const asked =
      numItems !== undefined && Number.isFinite(numItems) ? numItems : PROGRESS_DEFAULT_ITEMS;
    const items = Math.min(Math.max(Math.floor(asked), 1), PROGRESS_MAX_ITEMS);
    const page = await ctx.db
      .query("sessions")
      .withIndex("by_project_activity", (q) => q.eq("projectId", row.projectId))
      .paginate({ cursor, numItems: items });
    let sessions = 0;
    let folded = 0;
    const behind: {
      sessionId: string;
      foldedThrough: number;
      acceptedThrough: number;
      scheduledAt: number | null;
    }[] = [];
    for (const session of page.page) {
      if (session.deletedAt !== null || session.ownerUserId !== row.userId) continue;
      sessions += 1;
      const intake = await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", session.id))
        .unique();
      const state = await ctx.db
        .query("sessionStates")
        .withIndex("by_session", (q) => q.eq("sessionId", session.id))
        .unique();
      const acceptedThrough = intake?.acceptedThrough ?? 0;
      const foldedThrough = state?.throughSequence ?? 0;
      if (foldedThrough >= acceptedThrough && (state?.catchUpAt ?? null) === null) folded += 1;
      else {
        behind.push({
          sessionId: session.id,
          foldedThrough,
          acceptedThrough,
          scheduledAt: state?.catchUpAt ?? null,
        });
      }
    }
    return {
      status: row.status,
      sessions,
      folded,
      behind,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
