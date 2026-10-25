/**
 * Transcript bodies and Pi logs: staging, the segment index, and the head a
 * runner resumes its uploads from.
 *
 * Message bodies wait in `transcriptArtifacts` (inline up to 64 KB, or as a
 * spilled object) until the runner packs the bodies referenced by one
 * contiguous range of accepted events into one object and commits it here
 * (`commitSegment`). The commit checks that the key is the one the range
 * derives, that the range starts right after the previous segment and ends
 * at or before what has been accepted, and then sets the covered staging
 * rows to expire an hour later; a cron drops them (`sweepPacked`). Pi's
 * session log is committed the same way as byte ranges (`commitPiLogSegment`),
 * contiguous per Pi file from offset 0, and kept forever.
 *
 * One body is staged by a client instead: a `message.submit` queued through
 * `sessions.command` with its body inline (`uploadedBy: "client"`), so the
 * Session's runner, which never wrote it, can read it back
 * (`commandArtifact`, runner-only and claim-fenced) before delivery.
 *
 * Every write is the Session's producer's, presenting the current claim, so a
 * runner that lost the claim cannot commit. The producer is either the runner
 * itself (a runner token: its id must equal `claim.runnerId`, its owner must
 * own the Session and still see its project), or the Session's owner (a
 * person token; against the owner's own clients this fence is advisory: the
 * runner id is on the listing row, the generation a small counter). A Session
 * being released (moving to another runner) still accepts its holder's
 * uploads, so the handoff can pack what the old runner holds.
 *
 * Objects are write-once: a key a committed row already names is never signed
 * for upload again (`authorizeSessionUpload` answers `committed`).
 *
 * Commits are idempotent: the same object for the same range or offset is a
 * `duplicate`; a different one is `conflict`.
 */

import { ConvexError, v } from "convex/values";
import type { GenericDatabaseReader, GenericDatabaseWriter, UserIdentity } from "convex/server";

import {
  INLINE_ARTIFACT_MAX_BYTES,
  PACKED_STAGING_TTL_MS,
  STAGE_ARTIFACTS_MAX_BATCH,
  TRANSCRIPT_PACK_MAX_ARTIFACTS,
  TRANSCRIPT_PACK_MAX_TURNS,
  SESSION_OBJECT_MAX_BYTES,
  artifactDigestHex,
  artifactSpillKey,
  isArtifactDigest,
  isDerivedId,
  isSha256Hex,
  isUuid,
  piLogSegmentKey,
  sessionPrefix,
  transcriptPackKey,
  utf8Length,
  type SegmentCommitResult,
  type SessionUploadHead,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { findVisibleProject, requireIdentity, requireSessionActor } from "./lib/auth";
import {
  isRunnerIdentity,
  requireRunner,
  requireRunnerForWrite,
  type CallingRunner,
} from "./lib/runnerAuth";
import { nullable } from "./lib/validators";

export type TranscriptErrorCode =
  | "invalid_argument"
  | "not_claimed"
  | "stale_claim"
  | "beyond_accepted"
  | "gap"
  | "conflict";

export type TranscriptErrorData = { code: TranscriptErrorCode; message: string };

function transcriptError(code: TranscriptErrorCode, message: string) {
  return new ConvexError<TranscriptErrorData>({ code, message });
}

function invalid(message: string): ConvexError<TranscriptErrorData> {
  return transcriptError("invalid_argument", message);
}

type AuthCtx = { auth: { getUserIdentity(): Promise<UserIdentity | null> } };
type ReadCtx = AuthCtx & { db: GenericDatabaseReader<DataModel> };

const claim = v.object({ runnerId: v.string(), generation: v.number() });

/** Sweeps per call; a full batch schedules the next one at once. */
// 64 rows of at most 64 KB stay well inside one transaction's read budget.
const SWEEP_BATCH = 64;
/** Pi files one `head` call reports on. */
const HEAD_MAX_PI_FILES = 64;

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} must be a whole number`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (nonNegativeInteger(value, name) === 0) throw invalid(`${name} must be at least 1`);
  return value;
}

// ── the producer fence ───────────────────────────────────────────────────────

/**
 * The Session, its project and its intake head, when the caller is its
 * producer presenting the current claim (`active`, or `releasing` during a
 * handoff):
 *
 * - a runner token: the runner and its owner's account are live
 *   (`requireRunner`), the Session is live, its owner's, in a project the
 *   owner can still see, and the claim is this very runner's at
 *   `fence.generation`. Another person's Session reads as unclaimed, as
 *   `commandArtifact` answers: its existence is not this runner's to learn.
 * - any other identity: the Session's owner (`requireSessionActor`).
 *
 * Mutations pass `requireRunnerForWrite`, as every runner mutation starts.
 */
async function requireSessionProducer<C extends ReadCtx>(
  ctx: C,
  sessionId: string,
  fence: { runnerId: string; generation: number },
  resolveRunner: (ctx: C) => Promise<CallingRunner> = requireRunner,
): Promise<{ session: Doc<"sessions">; project: Doc<"projects">; intake: Doc<"sessionIntake"> }> {
  if (!isUuid(sessionId)) throw invalid("sessionId must be a lowercase UUID");
  const identity = await requireIdentity(ctx);
  const caller = isRunnerIdentity(identity) ? await resolveRunner(ctx) : null;
  let session: Doc<"sessions">;
  let project: Doc<"projects">;
  if (caller === null) {
    ({ session, project } = await requireSessionActor(ctx, sessionId));
  } else {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    const visible =
      row === null || row.deletedAt !== null || row.ownerUserId !== caller.ownerUserId
        ? null
        : await findVisibleProject(ctx, caller.ownerUserId, row.projectId);
    if (row === null || visible === null) {
      throw transcriptError("not_claimed", "No runner holds this session.");
    }
    session = row;
    project = visible;
  }
  const intake = await ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (intake === null || intake.state === "released") {
    throw transcriptError("not_claimed", "No runner holds this session.");
  }
  if (
    intake.claim.runnerId !== fence.runnerId ||
    intake.claim.generation !== fence.generation ||
    (caller !== null && caller.runnerId !== fence.runnerId)
  ) {
    throw transcriptError("stale_claim", "This runner no longer holds this session.");
  }
  return { session, project, intake };
}

async function latestSegment(
  ctx: { db: GenericDatabaseReader<DataModel> },
  sessionId: string,
): Promise<Doc<"transcriptSegments"> | null> {
  return ctx.db
    .query("transcriptSegments")
    .withIndex("by_session_first", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();
}

async function piLogEnd(
  ctx: { db: GenericDatabaseReader<DataModel> },
  sessionId: string,
  piFileId: string,
): Promise<Doc<"piLogSegments"> | null> {
  return ctx.db
    .query("piLogSegments")
    .withIndex("by_session_file_offset", (q) =>
      q.eq("sessionId", sessionId).eq("piFileId", piFileId),
    )
    .order("desc")
    .first();
}

// ── head ─────────────────────────────────────────────────────────────────────

/** Where this Session's uploads stand; a runner resumes from here after any crash. */
export const head = query({
  args: { sessionId: v.string(), claim, piFileIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<SessionUploadHead> => {
    await requireSessionProducer(ctx, args.sessionId, args.claim);
    if (args.piFileIds.length > HEAD_MAX_PI_FILES) throw invalid("Too many Pi files in one call");
    const segment = await latestSegment(ctx, args.sessionId);
    const piLogs: Record<string, number> = {};
    for (const piFileId of new Set(args.piFileIds)) {
      if (!isDerivedId(piFileId)) throw invalid("piFileId is not a valid id");
      piLogs[piFileId] = (await piLogEnd(ctx, args.sessionId, piFileId))?.endOffset ?? 0;
    }
    return { transcriptThrough: segment?.lastSequence ?? 0, piLogs };
  },
});

// ── staging ──────────────────────────────────────────────────────────────────

const stagedArtifact = v.object({
  digest: v.string(),
  mediaType: v.string(),
  bytes: v.number(),
  body: nullable(v.string()),
  spillKey: nullable(v.string()),
  sequence: nullable(v.number()),
});

type StagedArtifactArgs = {
  digest: string;
  mediaType: string;
  bytes: number;
  body: string | null;
  spillKey: string | null;
  sequence: number | null;
};

/**
 * Stage bodies for one Session, idempotently by `(sessionId, digest)`. A body
 * whose referencing event a committed segment already covers is not staged:
 * it is in that pack. The caller has checked the producer fence, or (for a
 * command's inline body, `sessions.command`) that it may command the Session.
 */
export async function stageArtifactRows(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  scope: { sessionId: string; projectId: string },
  artifacts: readonly StagedArtifactArgs[],
  uploadedBy: "runner" | "client",
  now: number,
): Promise<{ staged: number; skipped: number }> {
  if (artifacts.length > STAGE_ARTIFACTS_MAX_BATCH) throw invalid("Too many artifacts in one call");
  const packedThrough = (await latestSegment(ctx, scope.sessionId))?.lastSequence ?? 0;
  let staged = 0;
  let skipped = 0;
  for (const artifact of artifacts) {
    const hex = artifactDigestHex(artifact.digest);
    if (hex === null) throw invalid("digest must be sha256:<hex>");
    if (!isDerivedId(artifact.mediaType)) throw invalid("mediaType is not valid");
    nonNegativeInteger(artifact.bytes, "bytes");
    if (artifact.sequence !== null) positiveInteger(artifact.sequence, "sequence");
    if ((artifact.body === null) === (artifact.spillKey === null)) {
      throw invalid("An artifact is staged inline or spilled, not both or neither");
    }
    if (artifact.body !== null) {
      const size = utf8Length(artifact.body);
      if (size > INLINE_ARTIFACT_MAX_BYTES) throw invalid("An inline body is at most 64 KB");
      if (size !== artifact.bytes) throw invalid("bytes does not match the body");
    } else if (artifact.spillKey !== artifactSpillKey({ ...scope, sha256: hex })) {
      throw invalid("spillKey is not this artifact's key");
    }
    if (artifact.sequence !== null && artifact.sequence <= packedThrough) {
      skipped += 1;
      continue;
    }
    const existing = await ctx.db
      .query("transcriptArtifacts")
      .withIndex("by_session_digest", (q) =>
        q.eq("sessionId", scope.sessionId).eq("digest", artifact.digest),
      )
      .first();
    if (existing !== null) {
      if (existing.packedSegmentId !== null && artifact.sequence !== null) {
        // Referenced again after a pack covered it: this reference is in no
        // pack yet, so the row is staging again and must not expire.
        await ctx.db.patch(existing._id, {
          firstSequence: artifact.sequence,
          packedSegmentId: null,
          expiresAt: null,
        });
      } else if (
        artifact.sequence !== null &&
        (existing.firstSequence === null || artifact.sequence < existing.firstSequence)
      ) {
        await ctx.db.patch(existing._id, { firstSequence: artifact.sequence });
      }
      skipped += 1;
      continue;
    }
    await ctx.db.insert("transcriptArtifacts", {
      sessionId: scope.sessionId,
      digest: artifact.digest,
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      body: artifact.body,
      spillKey: artifact.spillKey,
      firstSequence: artifact.sequence,
      uploadedBy,
      packedSegmentId: null,
      expiresAt: null,
      createdAt: now,
    });
    staged += 1;
  }
  return { staged, skipped };
}

/** The runner stages the bodies its events reference, before those events are accepted. */
export const stageArtifacts = mutation({
  args: { sessionId: v.string(), claim, artifacts: v.array(stagedArtifact) },
  handler: async (ctx, args) => {
    const { session } = await requireSessionProducer(
      ctx,
      args.sessionId,
      args.claim,
      requireRunnerForWrite,
    );
    return stageArtifactRows(
      ctx,
      { sessionId: session.id, projectId: session.projectId },
      args.artifacts,
      "runner",
      Date.now(),
    );
  },
});

/** A staged body the claimed runner hydrates before it delivers the command that references it. */
export type CommandArtifactBody = { digest: string; mediaType: string; body: string };

/**
 * A staged inline body, for the runner holding the Session's claim: how a
 * command queued with its body (`sessions.command`'s `artifact`) reaches a
 * runner that never wrote it. The runner writes it to its own artifact store
 * (which re-verifies the digest) before delivery. `null` when nothing inline
 * is staged under `digest` (never staged, spilled, or swept after a pack).
 *
 * Runner-only (a runner token), and fenced like an accept: the Session must
 * be the runner owner's in a project they can still see, and the claim
 * this runner's at `generation`.
 */
export const commandArtifact = query({
  args: { sessionId: v.string(), generation: v.number(), digest: v.string() },
  handler: async (ctx, args): Promise<CommandArtifactBody | null> => {
    const caller = await requireRunner(ctx);
    if (!isUuid(args.sessionId)) throw invalid("sessionId must be a lowercase UUID");
    if (!isArtifactDigest(args.digest)) throw invalid("digest must be sha256:<hex>");
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
    const intake =
      session === null ||
      session.deletedAt !== null ||
      session.ownerUserId !== caller.ownerUserId ||
      (await findVisibleProject(ctx, caller.ownerUserId, session.projectId)) === null
        ? null
        : await ctx.db
            .query("sessionIntake")
            .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
            .unique();
    // Another person's Session reads as unclaimed: its existence is not this runner's to learn.
    if (intake === null || intake.state === "released") {
      throw transcriptError("not_claimed", "No runner holds this session.");
    }
    if (intake.claim.runnerId !== caller.runnerId || intake.claim.generation !== args.generation) {
      throw transcriptError("stale_claim", "This runner no longer holds this session.");
    }
    const row = await ctx.db
      .query("transcriptArtifacts")
      .withIndex("by_session_digest", (q) =>
        q.eq("sessionId", args.sessionId).eq("digest", args.digest),
      )
      .first();
    if (row === null || row.body === null) return null;
    return { digest: row.digest, mediaType: row.mediaType, body: row.body };
  },
});

// ── transcript segments ──────────────────────────────────────────────────────

/** Record a pack after its upload. See the module comment for what is checked. */
export const commitSegment = mutation({
  args: {
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
    const { session, intake } = await requireSessionProducer(
      ctx,
      args.sessionId,
      args.claim,
      requireRunnerForWrite,
    );
    if (!isUuid(args.segmentId)) throw invalid("segmentId must be a lowercase UUID");
    positiveInteger(args.firstSequence, "firstSequence");
    positiveInteger(args.lastSequence, "lastSequence");
    if (args.lastSequence < args.firstSequence) throw invalid("The range is empty");
    positiveInteger(args.bytes, "bytes");
    if (args.bytes > SESSION_OBJECT_MAX_BYTES) throw invalid("The object is too large");
    if (!isSha256Hex(args.sha256)) throw invalid("sha256 must be 64 lowercase hex digits");
    nonNegativeInteger(args.artifactCount, "artifactCount");
    if (args.artifactCount > TRANSCRIPT_PACK_MAX_ARTIFACTS) throw invalid("Too many artifacts");
    if (
      args.digests.length !== args.artifactCount ||
      new Set(args.digests).size !== args.digests.length
    ) {
      throw invalid("digests must be the pack's artifacts, each once");
    }
    if (!args.digests.every(isArtifactDigest)) throw invalid("digest must be sha256:<hex>");
    if (args.turnIds.length > TRANSCRIPT_PACK_MAX_TURNS || !args.turnIds.every(isDerivedId)) {
      throw invalid("turnIds are not valid");
    }
    const key = transcriptPackKey({
      projectId: session.projectId,
      sessionId: session.id,
      firstSequence: args.firstSequence,
      lastSequence: args.lastSequence,
    });
    if (args.key !== key) throw invalid("key is not this range's key");
    const taken = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_uuid", (q) => q.eq("id", args.segmentId))
      .unique();
    if (
      taken !== null &&
      (taken.sessionId !== session.id || taken.firstSequence !== args.firstSequence)
    ) {
      throw transcriptError("conflict", "That segment id is taken.");
    }

    const same = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_session_first", (q) =>
        q.eq("sessionId", session.id).eq("firstSequence", args.firstSequence),
      )
      .unique();
    if (same !== null) {
      if (same.lastSequence === args.lastSequence && same.sha256 === args.sha256) {
        return { status: "duplicate" };
      }
      throw transcriptError("conflict", "A different segment already starts here.");
    }
    const previous = await latestSegment(ctx, session.id);
    const expected = (previous?.lastSequence ?? 0) + 1;
    if (args.firstSequence !== expected) {
      throw transcriptError("gap", `The next segment starts at ${expected}.`);
    }
    if (args.lastSequence > intake.acceptedThrough) {
      throw transcriptError("beyond_accepted", "A segment covers accepted events only.");
    }

    const now = Date.now();
    await ctx.db.insert("transcriptSegments", {
      id: args.segmentId,
      sessionId: session.id,
      projectId: session.projectId,
      firstSequence: args.firstSequence,
      lastSequence: args.lastSequence,
      turnIds: args.turnIds,
      key,
      bytes: args.bytes,
      sha256: args.sha256,
      artifactCount: args.artifactCount,
      format: "volli.transcript-pack/1",
      createdAt: now,
    });
    for (const digest of args.digests) {
      const row = await ctx.db
        .query("transcriptArtifacts")
        .withIndex("by_session_digest", (q) => q.eq("sessionId", session.id).eq("digest", digest))
        .first();
      // A row staged for a later reference of the same body is not this pack's.
      if (row === null || row.packedSegmentId !== null) continue;
      if (row.firstSequence !== null && row.firstSequence > args.lastSequence) continue;
      await ctx.db.patch(row._id, {
        packedSegmentId: args.segmentId,
        expiresAt: now + PACKED_STAGING_TTL_MS,
      });
    }
    for (const turnId of new Set(args.turnIds)) {
      const turn = await ctx.db
        .query("sessionTurns")
        .withIndex("by_session_turn", (q) => q.eq("sessionId", session.id).eq("turnId", turnId))
        .first();
      if (turn !== null && turn.segmentId === null) {
        await ctx.db.patch(turn._id, { segmentId: args.segmentId });
      }
    }
    return { status: "committed" };
  },
});

// ── Pi log segments ──────────────────────────────────────────────────────────

/** Record one uploaded byte range of a Pi session file (kept forever). */
export const commitPiLogSegment = mutation({
  args: {
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
    const { session } = await requireSessionProducer(
      ctx,
      args.sessionId,
      args.claim,
      requireRunnerForWrite,
    );
    nonNegativeInteger(args.startOffset, "startOffset");
    nonNegativeInteger(args.endOffset, "endOffset");
    if (args.endOffset <= args.startOffset) throw invalid("The range is empty");
    positiveInteger(args.bytes, "bytes");
    if (args.bytes > SESSION_OBJECT_MAX_BYTES) throw invalid("The object is too large");
    if (!isSha256Hex(args.sha256)) throw invalid("sha256 must be 64 lowercase hex digits");
    let key: string;
    try {
      key = piLogSegmentKey({
        projectId: session.projectId,
        sessionId: session.id,
        attachmentId: args.attachmentId,
        piFileId: args.piFileId,
        offset: args.startOffset,
      });
    } catch {
      throw invalid("attachmentId or piFileId cannot name an object");
    }
    if (args.key !== key) throw invalid("key is not this range's key");

    const same = await ctx.db
      .query("piLogSegments")
      .withIndex("by_session_file_offset", (q) =>
        q
          .eq("sessionId", session.id)
          .eq("piFileId", args.piFileId)
          .eq("startOffset", args.startOffset),
      )
      .unique();
    if (same !== null) {
      if (
        same.endOffset === args.endOffset &&
        same.sha256 === args.sha256 &&
        same.attachmentId === args.attachmentId
      ) {
        return { status: "duplicate" };
      }
      throw transcriptError("conflict", "A different segment already starts here.");
    }
    const previous = await piLogEnd(ctx, session.id, args.piFileId);
    if ((previous?.endOffset ?? 0) !== args.startOffset) {
      throw transcriptError("gap", `The next segment starts at ${previous?.endOffset ?? 0}.`);
    }
    if (previous !== null && previous.attachmentId !== args.attachmentId) {
      throw transcriptError("conflict", "This Pi file belongs to another attachment.");
    }
    await ctx.db.insert("piLogSegments", {
      sessionId: session.id,
      attachmentId: args.attachmentId,
      piFileId: args.piFileId,
      startOffset: args.startOffset,
      endOffset: args.endOffset,
      key,
      sha256: args.sha256,
      bytes: args.bytes,
      createdAt: Date.now(),
    });
    return { status: "committed" };
  },
});

// ── object writes ────────────────────────────────────────────────────────────

/**
 * The Session-history objects a runner uploads, after the Session's prefix:
 * packs, spilled bodies and Pi log ranges, each exactly as the key grammar
 * (`@volli/shared/cloud` `r2-keys.ts`) writes it.
 */
const KEY_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]{0,199}";
const PACK_KEY = /^tx\/([0-9]{12})-[0-9]{12}\.pack\.zst$/u;
const SPILL_KEY = /^a\/([0-9a-f]{64})\.json\.zst$/u;
const PI_KEY = new RegExp(`^pi/${KEY_SEGMENT}/(${KEY_SEGMENT})/([0-9]{15})\\.jsonl\\.zst$`, "u");

export type SessionUploadAuthorization = { status: "sign"; key: string } | { status: "committed" };

/** Whether a committed row already names `key`, the Session-relative rest of it parsed. */
async function committedKey(
  ctx: { db: GenericDatabaseReader<DataModel> },
  sessionId: string,
  key: string,
  rest: string,
): Promise<boolean | null> {
  const pack = PACK_KEY.exec(rest);
  if (pack !== null) {
    const row = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_session_first", (q) =>
        q.eq("sessionId", sessionId).eq("firstSequence", Number(pack[1])),
      )
      .unique();
    return row !== null && row.key === key;
  }
  const spill = SPILL_KEY.exec(rest);
  if (spill !== null) {
    const row = await ctx.db
      .query("transcriptArtifacts")
      .withIndex("by_session_digest", (q) =>
        q.eq("sessionId", sessionId).eq("digest", `sha256:${spill[1]}`),
      )
      .first();
    return row !== null && row.spillKey === key;
  }
  const pi = PI_KEY.exec(rest);
  if (pi !== null && !rest.includes("..")) {
    const row = await ctx.db
      .query("piLogSegments")
      .withIndex("by_session_file_offset", (q) =>
        q.eq("sessionId", sessionId).eq("piFileId", pi[1]!).eq("startOffset", Number(pi[2])),
      )
      .unique();
    return row !== null && row.key === key;
  }
  return null;
}

/**
 * Whether the caller may upload `key`: it is the Session's producer, the key
 * is one of the Session's own upload kinds, and no committed row names it yet
 * (`committed`: the object is in place and immutable). Read by `files.presignPut`.
 */
export const authorizeSessionUpload = internalQuery({
  args: { sessionId: v.string(), claim, key: v.string(), bytes: v.number(), sha256: v.string() },
  handler: async (ctx, args): Promise<SessionUploadAuthorization> => {
    const { session } = await requireSessionProducer(ctx, args.sessionId, args.claim);
    positiveInteger(args.bytes, "bytes");
    if (args.bytes > SESSION_OBJECT_MAX_BYTES) throw invalid("The object is too large");
    if (!isSha256Hex(args.sha256)) throw invalid("sha256 must be 64 lowercase hex digits");
    const prefix = sessionPrefix({ projectId: session.projectId, sessionId: session.id });
    const rest = args.key.startsWith(prefix) ? args.key.slice(prefix.length) : null;
    const committed = rest === null ? null : await committedKey(ctx, session.id, args.key, rest);
    if (committed === null) throw invalid("This session cannot upload that key");
    return committed ? { status: "committed" } : { status: "sign", key: args.key };
  },
});

// ── dropping packed staging rows ─────────────────────────────────────────────

/** Drop staging rows whose segment committed more than an hour ago. */
export const sweepPacked = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("transcriptArtifacts")
      .withIndex("by_expiry", (q) => q.gte("expiresAt", 0).lt("expiresAt", now))
      .take(SWEEP_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.transcripts.sweepPacked, {});
    }
    return { deleted: rows.length };
  },
});
