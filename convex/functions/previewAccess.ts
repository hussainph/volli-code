/**
 * Internal only: deployment admins manage the preview with `convex run`:
 * `previewAccess:set` (grants), `previewAccess:setSponsorSeats` (how many
 * people a person may sponsor through invites) and
 * `previewAccess:revokeSponsoredBy` (withdraw everyone a person sponsored).
 */
import { v, ConvexError } from "convex/values";
import { MAX_PREVIEW_SPONSOR_SEATS, parseId } from "@volli/shared/cloud";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { normalizeEmail } from "./lib/auth";
import { codeHash, liveGrant } from "./lib/previewAccess";
import { literals } from "./lib/validators";

function invalid(message: string) {
  return new ConvexError({ code: "invalid_argument", message });
}

function operatorEmail(value: string): string {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid("That is not an email address.");
  }
  return email;
}

export const set = internalMutation({
  args: {
    kind: literals(["email", "user", "code"]),
    value: v.string(),
    enabled: v.boolean(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    let key: string;
    if (args.kind === "code") key = await codeHash(args.value);
    else if (args.kind === "user") key = parseId("user", args.value);
    else key = operatorEmail(args.value);
    if (
      args.expiresAt !== undefined &&
      (!Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now())
    ) {
      throw invalid("Expiry must be in the future.");
    }
    const existing = await ctx.db
      .query("previewAccess")
      .withIndex("by_kind_key", (q) => q.eq("kind", args.kind).eq("key", key))
      .unique();
    const revokedAt = args.enabled ? null : Date.now();
    if (existing !== null && args.enabled && existing.sponsorUserId !== undefined) {
      // The operator's grant replaces an invite's: it stops taking its sponsor's
      // seat and no longer lapses with the invite.
      await ctx.db.patch(existing._id, {
        revokedAt,
        expiresAt: args.expiresAt ?? null,
        sponsorUserId: undefined,
        inviteId: undefined,
      });
    } else if (existing !== null) {
      await ctx.db.patch(existing._id, {
        revokedAt,
        ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      });
    } else {
      await ctx.db.insert("previewAccess", {
        kind: args.kind,
        key,
        revokedAt,
        expiresAt: args.expiresAt ?? null,
        redeemedByUserId: null,
        createdAt: Date.now(),
      });
    }
  },
});

/** The person an operator names: a Volli user UUID, or the one account with that verified email. */
async function operatorTarget(
  ctx: { db: MutationCtx["db"] },
  person: { userId?: string; email?: string },
): Promise<Doc<"users">> {
  if ((person.userId === undefined) === (person.email === undefined)) {
    throw invalid("Name the person by userId or by email, not both.");
  }
  let users: Doc<"users">[];
  if (person.userId !== undefined) {
    let userId: string;
    try {
      userId = parseId("user", person.userId);
    } catch {
      throw invalid("A userId is a Volli user UUID.");
    }
    users = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .collect();
  } else {
    const email = operatorEmail(person.email!);
    users = (
      await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("primaryEmail", email))
        .collect()
    ).filter((user) => user.emailVerified);
  }
  if (users.length > 1) throw invalid("More than one account has that email; name the userId.");
  const [user] = users;
  if (user === undefined) {
    throw new ConvexError({ code: "not_found", message: "No account matches that person." });
  }
  return user;
}

/**
 * How many people this person may sponsor into the preview through invites,
 * replacing the default. `0` turns sponsoring off; grants already given stay.
 */
export const setSponsorSeats = internalMutation({
  args: { userId: v.optional(v.string()), email: v.optional(v.string()), seats: v.number() },
  handler: async (ctx, args): Promise<{ userId: string; seats: number }> => {
    if (!Number.isInteger(args.seats) || args.seats < 0 || args.seats > MAX_PREVIEW_SPONSOR_SEATS) {
      throw invalid(`Seats is a whole number from 0 to ${MAX_PREVIEW_SPONSOR_SEATS}.`);
    }
    const user = await operatorTarget(ctx, args);
    await ctx.db.patch(user._id, { previewSponsorSeats: args.seats });
    return { userId: user.id, seats: args.seats };
  },
});

/**
 * Withdraws every live grant this person's invites carry, used or not, and
 * turns their allowance off (`setSponsorSeats` restores it), so the seats
 * freed cannot be handed out again at once. Their own access is untouched:
 * revoke it with `set`. A withdrawn grant stays revoked: no later invite
 * revives it (`set` can).
 */
export const revokeSponsoredBy = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<{ revoked: number }> => {
    const user = await operatorTarget(ctx, { userId: args.userId });
    const now = Date.now();
    let revoked = 0;
    const grants = await ctx.db
      .query("previewAccess")
      .withIndex("by_sponsor", (q) => q.eq("sponsorUserId", user.id))
      .collect();
    for (const grant of grants) {
      if (!liveGrant(grant)) continue;
      await ctx.db.patch(grant._id, { revokedAt: now });
      revoked += 1;
    }
    await ctx.db.patch(user._id, { previewSponsorSeats: 0 });
    return { revoked };
  },
});
