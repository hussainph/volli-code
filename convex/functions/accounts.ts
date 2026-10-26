/**
 * The signed-in person's account. The first thing a client calls after sign-in
 * is {@link ensureViewer}; every other function then resolves the caller with
 * the helpers in `lib/auth.ts`.
 *
 * Account deletion (L5) starts here: {@link requestDeletion} schedules it
 * (`deletion_pending`, a `deletionRequests` row whose `purgeAfter` is 30 days
 * out) and {@link cancelDeletion} restores the account inside that window.
 * The purge itself is the retention job's (VC-905): it reads the
 * `deletionRequests` row, nulls PII and leaves the tombstone.
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  CLIENT_KINDS,
  newId,
  type ClientKind,
  type PersonActor,
  type PreviewAccess,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api.js";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server";
import { authError, ensureViewer as ensureViewerRow, findViewer, type Viewer } from "./lib/auth";
import { audit } from "./lib/audit";
import {
  previewAccess,
  redeemPreviewCode,
  hasPreviewAgreement,
  recordPreviewAgreement,
} from "./lib/previewAccess";
import { onFirstSignIn } from "./lib/firstSignIn";
import { literals } from "./lib/validators";

/** How long a deletion waits before the purge, during which the person may restore the account. */
export const ACCOUNT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type ViewerSummary = {
  userId: string;
  displayName: string;
  primaryEmail: string | null;
  status: "active" | "deletion_pending";
  /** When a pending deletion is purged; `null` for an active account. */
  purgeAfter: number | null;
  previewAccess: PreviewAccess;
  previewAgreementAccepted: boolean;
};

export type AccountErrorCode = "sole_owner" | "purge_started";

/** The client the person asked through, recorded on the deletion's Actor; the desktop when unsaid. */
const deletionArgs = { via: v.optional(literals(CLIENT_KINDS)) };

function personActor(viewer: Viewer, via: ClientKind | undefined): PersonActor {
  return { kind: "person", userId: viewer.userId, via: via ?? "desktop" };
}

function accountError(
  code: AccountErrorCode,
  message: string,
  extra: { workspaceIds?: string[] } = {},
) {
  return new ConvexError({ code, message, ...extra });
}

/** The viewer, pending deletion or not; `no_viewer` before `ensureViewer`. */
async function signedInViewer(ctx: Parameters<typeof findViewer>[0]): Promise<Viewer> {
  const found = await findViewer(ctx);
  if (found === null) throw authError("no_viewer", "This account is not set up yet.");
  return found;
}

async function summary(
  ctx: Parameters<typeof findViewer>[0],
  viewer: Viewer,
): Promise<ViewerSummary> {
  const { user } = viewer;
  return {
    previewAccess: await previewAccess(ctx, viewer),
    previewAgreementAccepted: hasPreviewAgreement(user),
    userId: viewer.userId,
    displayName: user.displayName,
    primaryEmail: user.primaryEmail,
    // `liveViewer` already refused a deleted account.
    status: user.status === "deletion_pending" ? "deletion_pending" : "active",
    purgeAfter: user.status === "deletion_pending" ? user.purgeAfter : null,
  };
}

/**
 * Creates the caller's `users` row on first sign-in. The first granted
 * sign-in runs Workspace setup in the same transaction; waitlisted accounts
 * retain only their account until invited. Idempotent. An account whose deletion is pending is returned
 * as it is, so the client can offer to restore it.
 */
export const ensureViewer = mutation({
  args: { inviteCode: v.optional(v.string()), acceptedAgreementVersion: v.optional(v.string()) },
  handler: async (
    ctx,
    { inviteCode, acceptedAgreementVersion },
  ): Promise<ViewerSummary & { created: boolean }> => {
    const { created, ...found } = await ensureViewerRow(ctx);
    let viewer = found;
    if (inviteCode !== undefined && (await previewAccess(ctx, viewer)) !== "granted") {
      await redeemPreviewCode(ctx, viewer, inviteCode);
    }
    viewer = await recordPreviewAgreement(ctx, viewer, acceptedAgreementVersion);
    const result = await summary(ctx, viewer);
    if (
      result.previewAccess === "granted" &&
      result.previewAgreementAccepted &&
      !viewer.user.previewWorkspaceCreated
    ) {
      // Older accounts already own a Workspace. A waitlisted account has none yet.
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
        .first();
      if (memberships === null) await onFirstSignIn(ctx, viewer);
      await ctx.db.patch(viewer.user._id, { previewWorkspaceCreated: true });
    }
    return { ...result, created };
  },
});

/** The caller's account, or `null` before {@link ensureViewer} has run for this identity. */
export const viewer = query({
  args: {},
  handler: async (ctx): Promise<ViewerSummary | null> => {
    const found = await findViewer(ctx);
    return found === null ? null : summary(ctx, found);
  },
});

/**
 * The Workspaces the person is the only active owner of while other active
 * Members remain: deleting the account would leave each without an owner, so
 * ownership moves (or the Workspace is deleted) first.
 */
async function soleOwnerships(
  ctx: { db: GenericDatabaseReader<DataModel> },
  userId: string,
): Promise<string[]> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const blocked: string[] = [];
  for (const membership of memberships) {
    if (membership.role !== "owner" || membership.status !== "active") continue;
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_uuid", (q) => q.eq("id", membership.workspaceId))
      .unique();
    if (workspace === null || workspace.deletedAt !== null) continue;
    const active = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", membership.workspaceId).eq("status", "active"),
      )
      .collect();
    const others = active.filter((member) => member.userId !== userId);
    if (others.length === 0) continue;
    // A co-owner whose own deletion is pending is no owner to leave behind:
    // otherwise two owners could each schedule theirs and orphan the Workspace.
    let ownerRemains = false;
    for (const member of others) {
      if (member.role !== "owner") continue;
      const owner = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", member.userId))
        .unique();
      if (owner?.status === "active") {
        ownerRemains = true;
        break;
      }
    }
    if (!ownerRemains) blocked.push(membership.workspaceId);
  }
  return blocked;
}

async function pendingRequest(
  ctx: { db: GenericDatabaseReader<DataModel> },
  userId: string,
): Promise<Doc<"deletionRequests"> | null> {
  const requests = await ctx.db
    .query("deletionRequests")
    .withIndex("by_target", (q) => q.eq("targetKind", "user").eq("targetId", userId))
    .collect();
  return requests.find((request) => request.status === "pending") ?? null;
}

/**
 * Schedules the caller's account for deletion. Refused with `sole_owner`
 * (naming the Workspaces) while the person is the only owner of a Workspace
 * other Members still use. Otherwise the account becomes `deletion_pending`
 * at once, which signs it out of every function but this module's (see
 * `requireViewer` in `lib/auth.ts`), and its signed-in devices are revoked. Idempotent: a
 * second request answers the pending one.
 *
 * The person's GitHub authorization of the App is revoked at once (on
 * GitHub, and the sealed tokens forgotten; `github.revokeForUser`): a
 * restored account connects GitHub again. Revoking the sign-in provider's
 * sessions and runner credentials needs server-held secrets and is the
 * retention job's first step (VC-905), keyed by the `deletionRequests` row
 * written here.
 */
export const requestDeletion = mutation({
  args: deletionArgs,
  handler: async (ctx, { via }): Promise<ViewerSummary> => {
    const person = await signedInViewer(ctx);
    if (person.user.status === "deletion_pending") return summary(ctx, person);
    const blocked = await soleOwnerships(ctx, person.userId);
    if (blocked.length > 0) {
      throw accountError(
        "sole_owner",
        "Make someone else an owner of your shared workspaces, or delete them, before deleting your account.",
        { workspaceIds: blocked },
      );
    }
    const now = Date.now();
    const purgeAfter = now + ACCOUNT_DELETION_GRACE_MS;
    await ctx.db.patch(person.user._id, {
      status: "deletion_pending",
      deletionRequestedAt: now,
      purgeAfter,
    });
    await ctx.db.insert("deletionRequests", {
      id: newId("deletionRequest"),
      targetKind: "user",
      targetId: person.userId,
      requestedBy: personActor(person, via),
      requestedAt: now,
      purgeAfter,
      status: "pending",
      blockedBy: null,
      cursor: null,
    });
    const devices = await ctx.db
      .query("clientSessions")
      .withIndex("by_user", (q) => q.eq("userId", person.userId))
      .collect();
    for (const device of devices) {
      if (device.revokedAt === null) await ctx.db.patch(device._id, { revokedAt: now });
    }
    const github = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", person.userId))
      .unique();
    if (github !== null) {
      await ctx.scheduler.runAfter(0, internal.github.revokeForUser, { userId: person.userId });
    }
    await audit(ctx, {
      workspaceId: null,
      actor: personActor(person, via),
      kind: "account.deletion_requested",
      targetKind: "user",
      targetId: person.userId,
      at: now,
      detail: { purgeAfter },
    });
    const user = (await ctx.db.get(person.user._id))!;
    return summary(ctx, { userId: person.userId, user });
  },
});

/**
 * Restores an account whose deletion is pending, before its purge starts.
 * Idempotent: an active account is answered as it is. `purge_started` once
 * the window has passed or the retention job has picked the request up.
 */
export const cancelDeletion = mutation({
  args: deletionArgs,
  handler: async (ctx, { via }): Promise<ViewerSummary> => {
    const found = await signedInViewer(ctx);
    if (found.user.status !== "deletion_pending") return summary(ctx, found);
    const now = Date.now();
    const request = await pendingRequest(ctx, found.userId);
    if (request === null || (found.user.purgeAfter !== null && now >= found.user.purgeAfter)) {
      throw accountError("purge_started", "This account's deletion has already started.");
    }
    await ctx.db.patch(request._id, { status: "cancelled" });
    await ctx.db.patch(found.user._id, {
      status: "active",
      deletionRequestedAt: null,
      purgeAfter: null,
    });
    await audit(ctx, {
      workspaceId: null,
      actor: personActor(found, via),
      kind: "account.deletion_cancelled",
      targetKind: "user",
      targetId: found.userId,
      at: now,
      detail: {},
    });
    const user = (await ctx.db.get(found.user._id))!;
    return summary(ctx, { userId: found.userId, user });
  },
});
