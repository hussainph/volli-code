/** Deployment-admin preview grants. Workspace invites never confer preview access. */
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";
import type { DataModel } from "../_generated/dataModel.js";
import type { Viewer } from "./auth";

export type PreviewAccess = "granted" | "waitlisted";
type Reader = { db: GenericDatabaseReader<DataModel> };

export const PREVIEW_WAITLIST_MESSAGE =
  "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.";

export function previewError(message = PREVIEW_WAITLIST_MESSAGE) {
  return new ConvexError({ code: "preview_waitlisted", message });
}

export async function codeHash(code: string): Promise<string> {
  if (code.length < 16 || code.length > 128)
    throw previewError("This preview invite code is invalid.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function previewAccess(ctx: Reader, viewer: Viewer): Promise<PreviewAccess> {
  if (viewer.user.status !== "active") return "waitlisted";
  const byKey = (kind: "user" | "email", key: string) =>
    ctx.db
      .query("previewAccess")
      .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
      .unique();
  const grants = [await byKey("user", viewer.userId)];
  if (viewer.user.emailVerified && viewer.user.primaryEmail !== null) {
    grants.push(await byKey("email", viewer.user.primaryEmail));
  }
  grants.push(
    ...(await ctx.db
      .query("previewAccess")
      .withIndex("by_redeemed_user", (q) => q.eq("redeemedByUserId", viewer.userId))
      .collect()),
  );
  return grants.some(
    (grant) =>
      grant !== null &&
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > Date.now()),
  )
    ? "granted"
    : "waitlisted";
}

export async function requirePreviewAccess(ctx: Reader, viewer: Viewer): Promise<void> {
  if ((await previewAccess(ctx, viewer)) !== "granted") throw previewError();
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
  if (
    grant === null ||
    grant.revokedAt !== null ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now()) ||
    (grant.redeemedByUserId !== null && grant.redeemedByUserId !== viewer.userId)
  ) {
    throw previewError("This preview invite code is invalid or has already been used.");
  }
  if (grant.redeemedByUserId === null)
    await ctx.db.patch(grant._id, { redeemedByUserId: viewer.userId });
}
