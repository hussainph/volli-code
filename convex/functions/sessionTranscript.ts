/**
 * The viewer's side of a Session's transcript bodies: what a client reads to
 * show the messages `sessions.history` references (S4).
 *
 * An accepted `transcript.referenced` event names a body by digest. The body
 * is in one of two places (`transcripts.ts`):
 *
 * - **Staged** (`transcriptArtifacts`): inline up to 64 KB, or spilled to its
 *   own object. `artifacts` answers these, inline bodies in place.
 * - **Packed**: once a committed segment covers the referencing event, the
 *   body is in that segment's `volli.transcript-pack/1` object and its staging
 *   row expires an hour later. `segments` lists the committed segments, newest
 *   first from a sequence, so a reader finds the one covering an event.
 *
 * Objects are read straight from the store: `presignGet` signs one GET for a
 * committed pack, or for a body the staging table records as spilled. Bytes
 * never pass through the backend. Only objects a row of this Session names
 * are signed, never a caller's key.
 *
 * Every function requires that the viewer may see the Session
 * (`requireSessionVisible`); a Session they may not see reads as absent.
 * What crosses is an allowlist: no object keys, staging bookkeeping, uploader
 * or Convex ids. Bodies are the runner's credential-redacted canonical JSON
 * text (`transcript-spool.ts`), the same text a pack embeds.
 */

import { ConvexError, v } from "convex/values";

import {
  STAGE_ARTIFACTS_MAX_BATCH,
  isArtifactDigest,
  isUuid,
  presignS3Request,
  type PresignedS3Request,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import { action, internalQuery, query } from "./_generated/server";
import { requireSessionVisible } from "./lib/auth";
import { PRESIGN_EXPIRES_SECONDS, objectStoreConfig } from "./lib/objectStore";

/** Segments one `segments` call returns by default, and at most. */
const SEGMENTS_DEFAULT_LIMIT = 16;
const SEGMENTS_MAX_LIMIT = 64;

function invalid(message: string): ConvexError<{ code: "invalid_argument"; message: string }> {
  return new ConvexError({ code: "invalid_argument", message });
}

function sessionIdArg(sessionId: string): string {
  if (!isUuid(sessionId)) throw invalid("sessionId must be a lowercase UUID");
  return sessionId;
}

function cursorArg(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw invalid(`${name} must be a whole number`);
  }
  return value;
}

// ── segments ─────────────────────────────────────────────────────────────────

/** One committed pack, as a reader needs it. The object is named by `segmentId`. */
export interface TranscriptSegmentManifest {
  segmentId: string;
  firstSequence: number;
  lastSequence: number;
  turnIds: string[];
  /** `volli.transcript-pack/1`: zstd-compressed NDJSON. */
  format: string;
  /** The object's (compressed) size and SHA-256 hex. */
  bytes: number;
  sha256: string;
  artifactCount: number;
}

function manifest(row: Doc<"transcriptSegments">): TranscriptSegmentManifest {
  return {
    segmentId: row.id,
    firstSequence: row.firstSequence,
    lastSequence: row.lastSequence,
    turnIds: row.turnIds,
    format: row.format,
    bytes: row.bytes,
    sha256: row.sha256,
    artifactCount: row.artifactCount,
  };
}

/**
 * The Session's committed segments that start before `beforeSequence` (all of
 * them without it), the newest `limit` of those, returned oldest first.
 * Segments tile the sequence space from 1, so the segment covering event `n`
 * is the one `{ beforeSequence: n + 1, limit: 1 }` returns, when its
 * `lastSequence` reaches `n`; otherwise no pack covers `n` yet. `hasMore`:
 * older segments remain (page on with the first one's `firstSequence`).
 * `packedThrough` is the last sequence any committed segment covers, 0 before
 * any.
 */
export const segments = query({
  args: {
    sessionId: v.string(),
    beforeSequence: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    segments: TranscriptSegmentManifest[];
    hasMore: boolean;
    packedThrough: number;
  }> => {
    const { session } = await requireSessionVisible(ctx, sessionIdArg(args.sessionId));
    const before = cursorArg(args.beforeSequence, "beforeSequence");
    const limit = Math.min(
      cursorArg(args.limit, "limit") ?? SEGMENTS_DEFAULT_LIMIT,
      SEGMENTS_MAX_LIMIT,
    );
    const latest = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_session_first", (q) => q.eq("sessionId", session.id))
      .order("desc")
      .first();
    const rows = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_session_first", (q) =>
        before === undefined
          ? q.eq("sessionId", session.id)
          : q.eq("sessionId", session.id).lt("firstSequence", before),
      )
      .order("desc")
      .take(limit + 1);
    const hasMore = rows.length > limit;
    return {
      segments: rows.slice(0, limit).toReversed().map(manifest),
      hasMore,
      packedThrough: latest?.lastSequence ?? 0,
    };
  },
});

// ── staged bodies ────────────────────────────────────────────────────────────

/**
 * Where one body stands in the staging table:
 *
 * - `inline`: `body` is its canonical JSON text.
 * - `spilled`: its own object; `presignGet({ kind: "spill", digest })` signs
 *   it. The object is the body's text, zstd-compressed.
 * - `absent`: not staged (or no longer): read it from the segment covering
 *   its referencing event.
 *
 * `bytes` is the body's UTF-8 length (uncompressed). `redacted` is not known
 * for a staged body; a pack entry carries it.
 */
export type StagedTranscriptBody =
  | { digest: string; status: "inline"; mediaType: string; bytes: number; body: string }
  | { digest: string; status: "spilled"; mediaType: string; bytes: number }
  | { digest: string; status: "absent" };

async function stagedRow(
  ctx: Parameters<typeof requireSessionVisible>[0],
  sessionId: string,
  digest: string,
): Promise<Doc<"transcriptArtifacts"> | null> {
  return ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) => q.eq("sessionId", sessionId).eq("digest", digest))
    .first();
}

/** The staged bodies of up to 64 digests, in the order asked, each once. */
export const artifacts = query({
  args: { sessionId: v.string(), digests: v.array(v.string()) },
  handler: async (ctx, args): Promise<StagedTranscriptBody[]> => {
    const { session } = await requireSessionVisible(ctx, sessionIdArg(args.sessionId));
    const digests = [...new Set(args.digests)];
    if (digests.length > STAGE_ARTIFACTS_MAX_BATCH) throw invalid("Too many digests in one call");
    if (!digests.every(isArtifactDigest)) throw invalid("digest must be sha256:<hex>");
    const out: StagedTranscriptBody[] = [];
    for (const digest of digests) {
      const row = await stagedRow(ctx, session.id, digest);
      if (row === null) out.push({ digest, status: "absent" });
      else if (row.body !== null) {
        out.push({
          digest,
          status: "inline",
          mediaType: row.mediaType,
          bytes: row.bytes,
          body: row.body,
        });
      } else out.push({ digest, status: "spilled", mediaType: row.mediaType, bytes: row.bytes });
    }
    return out;
  },
});

// ── signed reads ─────────────────────────────────────────────────────────────

const sessionObject = v.union(
  v.object({ kind: v.literal("pack"), segmentId: v.string() }),
  v.object({ kind: v.literal("spill"), digest: v.string() }),
);

type ObjectLocation =
  | { status: "found"; key: string; bytes: number | null; sha256: string | null }
  | { status: "absent" };

/**
 * The key of one object a row of this Session names, for a viewer of it:
 * a committed segment's pack, or a staged body's spill. Read by `presignGet`.
 */
export const locateSessionObject = internalQuery({
  args: { sessionId: v.string(), object: sessionObject },
  handler: async (ctx, args): Promise<ObjectLocation> => {
    const { session } = await requireSessionVisible(ctx, sessionIdArg(args.sessionId));
    if (args.object.kind === "pack") {
      const segmentId = args.object.segmentId;
      if (!isUuid(segmentId)) throw invalid("segmentId must be a lowercase UUID");
      const row = await ctx.db
        .query("transcriptSegments")
        .withIndex("by_uuid", (q) => q.eq("id", segmentId))
        .unique();
      if (row === null || row.sessionId !== session.id) return { status: "absent" };
      return { status: "found", key: row.key, bytes: row.bytes, sha256: row.sha256 };
    }
    if (!isArtifactDigest(args.object.digest)) throw invalid("digest must be sha256:<hex>");
    const row = await stagedRow(ctx, session.id, args.object.digest);
    if (row === null || row.spillKey === null) return { status: "absent" };
    return { status: "found", key: row.spillKey, bytes: null, sha256: null };
  },
});

/**
 * `presignGet`'s answer: one signed GET, valid for five minutes, with the
 * object's compressed size and SHA-256 when the backend records them (a pack;
 * a spill records neither); or `absent` when no row of this Session names
 * that object (yet, or any longer: a packed spill's row is swept, and its
 * body is then read from the pack).
 */
export type SessionObjectGrant =
  | {
      status: "sign";
      request: PresignedS3Request;
      bytes: number | null;
      sha256: string | null;
    }
  | { status: "absent" };

/** A URL for one GET of a committed pack or a spilled body of a Session the viewer sees. */
export const presignGet = action({
  args: { sessionId: v.string(), object: sessionObject },
  handler: async (ctx, args): Promise<SessionObjectGrant> => {
    const location = await ctx.runQuery(internal.sessionTranscript.locateSessionObject, args);
    if (location.status === "absent") return { status: "absent" };
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw new ConvexError({
        code: "storage_unconfigured",
        message: "Object storage is not configured on this deployment.",
      });
    }
    const request = presignS3Request({
      ...config,
      method: "GET",
      key: location.key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
    });
    return { status: "sign", request, bytes: location.bytes, sha256: location.sha256 };
  },
});
