/** Internal only: deployment admins manage the preview with `convex run previewAccess:set`. */
import { v, ConvexError } from "convex/values";
import { parseId } from "@volli/shared/cloud";
import { internalMutation } from "./_generated/server";
import { normalizeEmail } from "./lib/auth";
import { codeHash } from "./lib/previewAccess";
import { literals } from "./lib/validators";

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
    else {
      key = normalizeEmail(args.value);
      if (key.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
        throw new ConvexError({
          code: "invalid_argument",
          message: "That is not an email address.",
        });
      }
    }
    if (
      args.expiresAt !== undefined &&
      (!Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now())
    ) {
      throw new ConvexError({ code: "invalid_argument", message: "Expiry must be in the future." });
    }
    const existing = await ctx.db
      .query("previewAccess")
      .withIndex("by_kind_key", (q) => q.eq("kind", args.kind).eq("key", key))
      .unique();
    const revokedAt = args.enabled ? null : Date.now();
    if (existing !== null) {
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
