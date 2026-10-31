/**
 * Preview grants: a deployment admin's (`previewAccess:set`), or one a
 * Workspace invite carries, sponsored by its sender (`./sponsoredPreview`).
 * Both are rows of the same table, read here on every product call.
 */
import {
  PREVIEW_WAITLIST_MESSAGE,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  PREVIEW_AGREEMENT_REQUIRED_MESSAGE,
  type PreviewAccess,
  type UserId,
} from "@volli/shared/cloud";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";
import type { DataModel, Doc } from "../_generated/dataModel.js";
import type { Viewer } from "./auth";

type Reader = { db: GenericDatabaseReader<DataModel> };

function previewError(message = PREVIEW_WAITLIST_MESSAGE) {
  return new ConvexError({ code: "preview_waitlisted", message });
}

export async function codeHash(code: string): Promise<string> {
  if (code.length < 16 || code.length > 128)
    throw previewError("This preview invite code is invalid.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function liveGrant(grant: Doc<"previewAccess"> | null): grant is Doc<"previewAccess"> {
  return (
    grant !== null &&
    grant.revokedAt === null &&
    (grant.expiresAt === null || grant.expiresAt > Date.now())
  );
}

export async function previewAccess(ctx: Reader, viewer: Viewer): Promise<PreviewAccess> {
  if (viewer.user.status !== "active") return "waitlisted";
  const byKey = (kind: "user" | "email", key: string) =>
    ctx.db
      .query("previewAccess")
      .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
      .unique();
  const own = await byKey("user", viewer.userId);
  // An operator's revoked user-id grant withdraws the person: it overrides
  // every other grant they hold or used (an address, a code, an invite's).
  if (own !== null && own.revokedAt !== null) return "waitlisted";
  const grants = [own];
  if (viewer.user.emailVerified && viewer.user.primaryEmail !== null) {
    const email = await byKey("email", viewer.user.primaryEmail);
    // A sponsored grant, once bound to the person who used it, serves only them.
    if (email !== null && (email.redeemedByUserId ?? viewer.userId) === viewer.userId) {
      grants.push(email);
    }
  }
  grants.push(
    ...(await ctx.db
      .query("previewAccess")
      .withIndex("by_redeemed_user", (q) => q.eq("redeemedByUserId", viewer.userId))
      .collect()),
  );
  return grants.some(liveGrant) ? "granted" : "waitlisted";
}

/** A recorded explicit current-version acceptance, never inferred from an auth refresh. */
export function hasPreviewAgreement(user: Doc<"users">): boolean {
  return (
    user.previewAgreementVersion === PREVIEW_ENROLLMENT_AGREEMENT_VERSION &&
    typeof user.previewAgreementAcceptedAt === "number"
  );
}

/** A runner/Agent owner's current product authorization, independent of its credential. */
export async function hasLivePreviewAccess(ctx: Reader, user: Doc<"users">): Promise<boolean> {
  return (
    hasPreviewAgreement(user) &&
    (await previewAccess(ctx, { userId: user.id as UserId, user })) === "granted"
  );
}

function agreementRequired(message = PREVIEW_AGREEMENT_REQUIRED_MESSAGE) {
  return new ConvexError({
    code: "preview_agreement_required",
    message,
  });
}

/** Only the person's explicit current-version enrollment action can write this receipt. */
export async function recordPreviewAgreement(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  viewer: Viewer,
  version: string | undefined,
): Promise<Viewer> {
  if (version === undefined) return viewer;
  if ((await previewAccess(ctx, viewer)) !== "granted") return viewer;
  if (version !== PREVIEW_ENROLLMENT_AGREEMENT_VERSION) {
    throw agreementRequired("Update Volli to accept the current Preview Agreement.");
  }
  if (hasPreviewAgreement(viewer.user)) return viewer;
  const fields = { previewAgreementVersion: version, previewAgreementAcceptedAt: Date.now() };
  await ctx.db.patch(viewer.user._id, fields);
  return { ...viewer, user: { ...viewer.user, ...fields } };
}

export async function requirePreviewAccess(ctx: Reader, viewer: Viewer): Promise<void> {
  if ((await previewAccess(ctx, viewer)) !== "granted") throw previewError();
  if (!hasPreviewAgreement(viewer.user)) throw agreementRequired();
}

/** Single-use, account-bound redemption; retaining the row makes revocation effective. */
export async function redeemPreviewCode(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  viewer: Viewer,
  code: string,
): Promise<void> {
  const key = await codeHash(code);
  const grant = await ctx.db
    .query("previewAccess")
    .withIndex("by_kind_key", (q) => q.eq("kind", "code").eq("key", key))
    .unique();
  // A Workspace invite's code is redeemed only by joining (`./sponsoredPreview`).
  if (!liveGrant(grant) || grant.redeemedByUserId !== null || grant.inviteId !== undefined) {
    throw previewError("This preview invite code is invalid or has already been used.");
  }
  await ctx.db.patch(grant._id, { redeemedByUserId: viewer.userId });
}
