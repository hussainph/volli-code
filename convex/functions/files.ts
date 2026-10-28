/**
 * Presigned object-storage URLs (A3 §5.4). A writer asks for a URL bound to
 * one key, its exact length and its SHA-256, uploads to the store directly,
 * then calls the commit mutation that records the row. Re-uploading the same
 * bytes to the same key is harmless; the commit decides what is recorded.
 *
 * Today only a Session's producer uploads its own history objects
 * (`transcripts.authorizeSessionUpload`). Project blob reads additionally
 * require a live, visible link: knowing a private Session's hash is not access.
 */

import { ConvexError, v } from "convex/values";

import {
  isUuid,
  projectBlobKey,
  presignS3Request,
  sha256ChecksumHeader,
  type SessionUploadGrant,
  type PresignedS3Request,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { action, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { authError, requireProject, requireSessionScope, requireSessionVisible } from "./lib/auth";
import { PRESIGN_EXPIRES_SECONDS, objectStoreConfig } from "./lib/objectStore";

/**
 * A URL for one PUT of exactly `bytes` bytes hashing to `sha256`, valid for
 * five minutes; or `committed` when a committed row already names the key,
 * whose object is immutable and in place.
 */
export const presignPut = action({
  args: {
    sessionId: v.string(),
    claim: v.object({ runnerId: v.string(), generation: v.number() }),
    key: v.string(),
    bytes: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args): Promise<SessionUploadGrant> => {
    const authorization = await ctx.runQuery(internal.transcripts.authorizeSessionUpload, args);
    if (authorization.status === "committed") return { status: "committed" };
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw new ConvexError({
        code: "storage_unconfigured",
        message: "Object storage is not configured on this deployment.",
      });
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

const blobArgs = { projectId: v.string(), sha256: v.string() };
const absent = () => authError("not_found", "That attachment does not exist.");

/** Resolve link ownership, never Session attribution on a shared comment. */
async function visibleLink(
  ctx: QueryCtx,
  scope: Awaited<ReturnType<typeof requireSessionScope>>,
  link: Doc<"blobLinks">,
): Promise<boolean> {
  if (link.projectId !== scope.project.id) return false;
  if (link.owner.kind === "session") {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", link.owner.id))
      .unique();
    return session !== null && scope.canSee(session);
  }
  let ticketId = link.owner.id;
  if (link.owner.kind === "comment") {
    const comment = await ctx.db
      .query("ticketComments")
      .withIndex("by_uuid", (q) => q.eq("id", link.owner.id))
      .unique();
    if (comment === null || comment.deletedAt !== null || comment.projectId !== scope.project.id)
      return false;
    ticketId = comment.ticketId;
  }
  const ticket = await ctx.db
    .query("tickets")
    .withIndex("by_uuid", (q) => q.eq("id", ticketId))
    .unique();
  return ticket !== null && ticket.deletedAt === null && ticket.projectId === scope.project.id;
}

/** Only the row's canonical project key can be signed; a stored foreign key fails closed. */
export const locateBlob = internalQuery({
  args: blobArgs,
  handler: async (ctx, args) => {
    const scope = await requireSessionScope(ctx, args.projectId);
    if (!isUuid(args.projectId) || !/^[a-f0-9]{64}$/.test(args.sha256)) throw absent();
    const blob = await ctx.db
      .query("blobs")
      .withIndex("by_project_sha", (q) =>
        q.eq("projectId", args.projectId).eq("sha256", args.sha256),
      )
      .unique();
    if (blob === null || blob.key !== projectBlobKey(args.projectId, args.sha256)) throw absent();
    for await (const link of ctx.db
      .query("blobLinks")
      .withIndex("by_blob", (q) => q.eq("projectId", args.projectId).eq("sha256", args.sha256))) {
      if (await visibleLink(ctx, scope, link)) {
        return { key: blob.key, mime: blob.mime, bytes: blob.sizeBytes };
      }
    }
    throw absent();
  },
});

/** Read-only B5 slice: one project blob, reachable through at least one visible owner. */
export const presignGet = action({
  args: blobArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{ request: PresignedS3Request; mime: string; bytes: number; sha256: string }> => {
    const blob = await ctx.runQuery(internal.files.locateBlob, args);
    const config = objectStoreConfig(process.env);
    if (config === null)
      throw new ConvexError({
        code: "storage_unconfigured",
        message: "Object storage is not configured on this deployment.",
      });
    const request = presignS3Request({
      ...config,
      method: "GET",
      key: blob.key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
    });
    return { request, mime: blob.mime, bytes: blob.bytes, sha256: args.sha256 };
  },
});

/** Ticket first, then Session: exactly the materialized-name ordering used locally. */
export const attachments = query({
  args: {
    projectId: v.string(),
    ticketId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { project, viewer } = await requireProject(ctx, args.projectId);
    const owners: Array<{ kind: "ticket" | "session"; id: string }> = [];
    let ticketId = args.ticketId;
    if (args.sessionId !== undefined) {
      const { session } = await requireSessionVisible(ctx, args.sessionId, viewer);
      if (
        session.projectId !== project.id ||
        (ticketId !== undefined && session.ticketId !== ticketId)
      )
        throw absent();
      ticketId = session.ticketId ?? undefined;
      owners.push({ kind: "session", id: session.id });
    }
    if (ticketId !== undefined) {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", ticketId!))
        .unique();
      if (ticket === null || ticket.projectId !== project.id || ticket.deletedAt !== null)
        throw absent();
      owners.unshift({ kind: "ticket", id: ticketId });
    }
    const result = [];
    for (const owner of owners) {
      const links = await ctx.db
        .query("blobLinks")
        .withIndex("by_owner", (q) => q.eq("owner.kind", owner.kind).eq("owner.id", owner.id))
        .collect();
      links.sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (a.sourceOrder ?? a._creationTime) - (b.sourceOrder ?? b._creationTime),
      );
      for (const link of links) {
        if (link.projectId !== project.id) continue;
        const blob = await ctx.db
          .query("blobs")
          .withIndex("by_project_sha", (q) =>
            q.eq("projectId", project.id).eq("sha256", link.sha256),
          )
          .unique();
        if (blob === null) continue;
        result.push({
          linkId: link.id,
          blobHash: link.sha256,
          label: link.label,
          originalName: blob.originalName,
          mime: blob.mime,
          sizeBytes: blob.sizeBytes,
        });
      }
    }
    return result;
  },
});
