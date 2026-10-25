/**
 * Root key rotation for team secrets (`lib/sealing.ts`): re-wraps every data
 * key still wrapped under an older root key with the current one. Values are
 * never touched; they stay sealed under their data keys.
 *
 * An operator runs it after putting the new key first in
 * `VOLLI_SECRETS_ROOT_KEYS` (keeping the old one after it):
 *
 *     npx convex run secretKeys:rewrap '{}'
 *
 * It works in batches and schedules itself until no data key is left under
 * an old root key; then the old key can be dropped from the variable. The
 * production checklist is in `convex/README.md` ("Secrets root key").
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { dataKeyContext, rootKeyProvider } from "./lib/sealing";

const BATCH = 50;

/** Data keys not wrapped under `currentKid`, at most one batch. */
export const stale = internalQuery({
  args: { currentKid: v.string() },
  handler: async (ctx, args) => {
    const below = await ctx.db
      .query("secretKeys")
      .withIndex("by_root_kid", (q) => q.lt("rootKid", args.currentKid))
      .take(BATCH);
    const above = await ctx.db
      .query("secretKeys")
      .withIndex("by_root_kid", (q) => q.gt("rootKid", args.currentKid))
      .take(BATCH - below.length);
    return [...below, ...above].map((key) => ({
      id: key.id,
      owner: key.owner,
      rootKid: key.rootKid,
      wrapped: key.wrapped,
    }));
  },
});

/** Stores one re-wrapped key, unless it changed since it was read. */
export const store = internalMutation({
  args: { id: v.string(), fromKid: v.string(), rootKid: v.string(), wrapped: v.bytes() },
  handler: async (ctx, args): Promise<boolean> => {
    const key = await ctx.db
      .query("secretKeys")
      .withIndex("by_uuid", (q) => q.eq("id", args.id))
      .unique();
    if (key === null || key.rootKid !== args.fromKid) return false;
    await ctx.db.patch(key._id, {
      rootKid: args.rootKid,
      wrapped: args.wrapped,
      rewrappedAt: Date.now(),
    });
    return true;
  },
});

export const rewrap = internalAction({
  args: {},
  handler: async (ctx): Promise<{ rewrapped: number; more: boolean }> => {
    const provider = rootKeyProvider();
    const keys = await ctx.runQuery(internal.secretKeys.stale, {
      currentKid: provider.currentKid,
    });
    let rewrapped = 0;
    for (const key of keys) {
      const context = dataKeyContext(key.id, key.owner);
      const raw = await provider.unwrap(key.rootKid, key.wrapped, context);
      const next = await provider.wrap(raw, context);
      const stored = await ctx.runMutation(internal.secretKeys.store, {
        id: key.id,
        fromKid: key.rootKid,
        rootKid: next.rootKid,
        wrapped: next.wrapped,
      });
      if (stored) rewrapped += 1;
    }
    const more = keys.length === BATCH;
    if (more) await ctx.scheduler.runAfter(0, internal.secretKeys.rewrap, {});
    return { rewrapped, more };
  },
});
