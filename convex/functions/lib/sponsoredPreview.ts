/**
 * Sponsored preview access: a Workspace invite also lets its invitee into the
 * invite-only preview, on the sender's behalf, within the sender's allowance.
 *
 * - **The grant.** An invite carries at most one `previewAccess` row, marked
 *   with `sponsorUserId` (its sender) and `inviteId`. An email invite's grant
 *   is keyed by that address, so only a person whose VERIFIED email it is can
 *   use it (`previewAccess` reads email grants only for a verified address).
 *   A link invite's grant is keyed by its token's sha256, the same hash
 *   `codeHash` keeps, and is redeemed only by joining with that token.
 * - **The allowance.** A sender sponsors at most `users.previewSponsorSeats`
 *   people (default {@link DEFAULT_PREVIEW_SPONSOR_SEATS}; 0 turns it off).
 *   A seat is taken while its grant is live: unredeemed until the invite
 *   expires, or bound to the person who used it. Revoked or expired grants
 *   free their seat.
 * - **Never over a decision already made.** No grant is written when the
 *   invitee already has access, and an existing grant this module did not
 *   leave to expire (an operator's, or any revoked one) is never taken over.
 *   A person any of whose grants an operator revoked is never sponsored back
 *   in, by address or by code: an invite cannot undo Volli withdrawing them.
 * - **Lifetime.** A grant expires with its invite and is withdrawn with it
 *   (revoke, or a reissue, which sponsors again under the new sender). The
 *   person who uses it binds it to themselves for good: signing in with it
 *   (email), or joining with its code (link). A bound grant serves only that
 *   person. Sponsorship is not cascaded: revoking the sponsor or removing the
 *   invitee from the Workspace leaves the invitee's access (operators use
 *   `previewAccess:revokeSponsoredBy`).
 */

import {
  DEFAULT_PREVIEW_SPONSOR_SEATS,
  PREVIEW_WAITLIST_MESSAGE,
  type InvitePreviewAccess,
  type UserId,
} from "@volli/shared/cloud";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import { audit } from "./audit";
import type { Viewer } from "./auth";
import { liveGrant, previewAccess } from "./previewAccess";

type Reader = { db: GenericDatabaseReader<DataModel> };
type Writer = { db: GenericDatabaseWriter<DataModel> };
type Invite = Doc<"workspaceInvites">;
type Grant = Doc<"previewAccess">;

/** The grant an invite would carry: keyed by its address, or by its token's hash for a link. */
async function inviteGrantRow(ctx: Reader, invite: Invite): Promise<Grant | null> {
  const [kind, key] =
    invite.email === null
      ? (["code", invite.tokenHash] as const)
      : (["email", invite.email] as const);
  return await ctx.db
    .query("previewAccess")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .unique();
}

/** The invite's own grant, while nobody has used it: the one revoke and reissue withdraw. */
function unusedGrantOf(grant: Grant | null, invite: Invite): grant is Grant {
  return (
    grant !== null &&
    grant.inviteId === invite.id &&
    grant.redeemedByUserId === null &&
    grant.revokedAt === null
  );
}

/** How many more people `sponsor` may sponsor now. */
export async function sponsorSeatsLeft(ctx: Reader, sponsor: Doc<"users">): Promise<number> {
  const allowance = sponsor.previewSponsorSeats ?? DEFAULT_PREVIEW_SPONSOR_SEATS;
  const taken = (
    await ctx.db
      .query("previewAccess")
      .withIndex("by_sponsor", (q) => q.eq("sponsorUserId", sponsor.id))
      .collect()
  ).filter(liveGrant).length;
  return allowance - taken;
}

/**
 * Whether an operator revoked any grant this person holds or used (by user
 * id, by their verified address, or a code they redeemed). Only an operator
 * revokes a grant: an invite's own withdrawal deletes its unused grant.
 */
async function withdrawn(ctx: Reader, user: Doc<"users">): Promise<boolean> {
  const byKey = (kind: "user" | "email", key: string) =>
    ctx.db
      .query("previewAccess")
      .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
      .unique();
  const grants = [await byKey("user", user.id)];
  if (user.emailVerified && user.primaryEmail !== null) {
    grants.push(await byKey("email", user.primaryEmail));
  }
  grants.push(
    ...(await ctx.db
      .query("previewAccess")
      .withIndex("by_redeemed_user", (q) => q.eq("redeemedByUserId", user.id))
      .collect()),
  );
  return grants.some((grant) => grant !== null && grant.revokedAt !== null);
}

/** Who already signed in with this verified address: whether one has access, or was withdrawn. */
async function addressStatus(
  ctx: Reader,
  email: string,
): Promise<"granted" | "withdrawn" | "none"> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("primaryEmail", email))
    .collect();
  let status: "withdrawn" | "none" = "none";
  for (const user of users) {
    if (!user.emailVerified) continue;
    if ((await previewAccess(ctx, { userId: user.id as UserId, user })) === "granted") {
      return "granted";
    }
    if (await withdrawn(ctx, user)) status = "withdrawn";
  }
  return status;
}

/**
 * What the invite does for its invitee's access now. An email invite answers
 * for the address; a link names nobody, so only its own grant counts.
 */
export async function invitePreview(ctx: Reader, invite: Invite): Promise<InvitePreviewAccess> {
  const grant = await inviteGrantRow(ctx, invite);
  if (liveGrant(grant)) return grant.inviteId === invite.id ? "sponsored" : "already_granted";
  if (invite.email !== null && (await addressStatus(ctx, invite.email)) === "granted") {
    return "already_granted";
  }
  return "needs_access";
}

/**
 * Withdraws the invite's grant while nobody has used it: the invite was
 * revoked, or is about to be sponsored again (reissue). A used grant stays
 * with its person; a revoked one stays as the operator's decision.
 */
export async function releaseInviteGrant(ctx: Writer, invite: Invite): Promise<void> {
  const grant = await inviteGrantRow(ctx, invite);
  if (unusedGrantOf(grant, invite)) await ctx.db.delete(grant._id);
}

/**
 * Gives a just-created (or just-reissued) invite its sender's sponsored grant,
 * if the invitee needs one and the sender has a seat left. `invite` is the
 * row as now stored: its sender, expiry and token hash.
 */
export async function sponsorInvite(
  ctx: Writer,
  sender: Viewer,
  invite: Invite,
): Promise<InvitePreviewAccess> {
  await releaseInviteGrant(ctx, invite);
  const status = await invitePreview(ctx, invite);
  if (status !== "needs_access") return status;
  const existing = await inviteGrantRow(ctx, invite);
  // Only a sponsored grant that lapsed unused may be taken over; never an operator's or a revoked one.
  if (
    existing !== null &&
    (existing.sponsorUserId === undefined ||
      existing.revokedAt !== null ||
      existing.redeemedByUserId !== null)
  ) {
    return "needs_access";
  }
  if (invite.email !== null && (await addressStatus(ctx, invite.email)) === "withdrawn") {
    return "needs_access";
  }
  if ((await sponsorSeatsLeft(ctx, sender.user)) <= 0) return "needs_access";
  const now = Date.now();
  const fields = {
    sponsorUserId: sender.userId,
    inviteId: invite.id,
    expiresAt: invite.expiresAt,
    revokedAt: null,
    redeemedByUserId: null,
  };
  if (existing === null) {
    await ctx.db.insert("previewAccess", {
      kind: invite.email === null ? "code" : "email",
      key: invite.email ?? invite.tokenHash,
      createdAt: now,
      ...fields,
    });
  } else {
    await ctx.db.patch(existing._id, fields);
  }
  await audit(ctx, {
    workspaceId: invite.workspaceId,
    actor: { kind: "person", userId: sender.userId },
    kind: "preview.sponsored",
    targetKind: "invite",
    targetId: invite.id,
    at: now,
    detail: { link: invite.email === null, expiresAt: invite.expiresAt },
  });
  return "sponsored";
}

/** Binds a grant to the person using it, for good: it no longer expires with its invite. */
async function bind(ctx: Writer, grant: Grant, viewer: Viewer): Promise<void> {
  await ctx.db.patch(grant._id, { redeemedByUserId: viewer.userId, expiresAt: null });
}

/**
 * Binds the sponsored grant on the viewer's verified address to them, once
 * they are enrolled (granted, agreement accepted): signing in with an email
 * invite's grant keeps the access after the invite would have expired.
 */
export async function bindSponsoredEmailGrant(ctx: Writer, viewer: Viewer): Promise<void> {
  const email = viewer.user.emailVerified ? viewer.user.primaryEmail : null;
  if (email === null) return;
  const grant = await ctx.db
    .query("previewAccess")
    .withIndex("by_kind_key", (q) => q.eq("kind", "email").eq("key", email))
    .unique();
  if (liveGrant(grant) && grant.sponsorUserId !== undefined && grant.redeemedByUserId === null) {
    await bind(ctx, grant, viewer);
  }
}

/**
 * Joining with a link invite's code at sign-in: a viewer without access binds
 * the link's sponsored grant to themselves. Runs only when that acceptance
 * will consume this invite, in the same transaction, so a code that cannot be
 * joined with grants nothing. A link whose sender had no seat left grants
 * nothing, and neither does any link to a person Volli withdrew.
 */
export async function redeemInviteGrant(
  ctx: Writer,
  viewer: Viewer,
  invite: Invite,
): Promise<void> {
  if ((await previewAccess(ctx, viewer)) === "granted") return;
  const grant = invite.email === null ? await inviteGrantRow(ctx, invite) : null;
  if (
    liveGrant(grant) &&
    grant.inviteId === invite.id &&
    (grant.redeemedByUserId ?? viewer.userId) === viewer.userId &&
    !(await withdrawn(ctx, viewer.user))
  ) {
    await bind(ctx, grant, viewer);
    return;
  }
  throw new ConvexError({
    code: "preview_waitlisted",
    message: `This invite doesn't include Volli Cloud preview access. Ask the person who invited you. ${PREVIEW_WAITLIST_MESSAGE}`,
  });
}

/**
 * After the viewer joined through `invite`: a link's grant nobody needed (the
 * viewer had access already) is withdrawn, freeing its seat, and the viewer's
 * own address's sponsored grant is bound to them.
 */
export async function settleJoinedInvite(ctx: Writer, viewer: Viewer, invite: Invite) {
  if (invite.email === null) await releaseInviteGrant(ctx, invite);
  await bindSponsoredEmailGrant(ctx, viewer);
}
