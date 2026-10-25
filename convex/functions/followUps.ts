/** The runner's bounded, rebuildable follow-up queue mirror. */
import { ConvexError, v } from "convex/values";
import {
  FOLLOW_UP_QUEUE_MAX,
  FOLLOW_UP_MESSAGE_MAX_BYTES,
  FOLLOW_UP_MIRROR_MAX_BYTES,
  followUpQueueView,
} from "@volli/shared/cloud";
import { mutation, query } from "./_generated/server";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import { requireSessionVisible } from "./lib/auth";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { ownerMayWorkOn } from "./lib/jobs";
import {
  followUpJobs,
  queueJobs,
  followUpRevision,
  advanceFollowUpRevision,
} from "./lib/followUps";

const item = v.object({
  messageId: v.string(),
  commandId: v.string(),
  state: v.union(v.literal("queued"), v.literal("releasing")),
  afterCurrentStep: v.optional(v.boolean()),
  refused: v.optional(v.boolean()),
  refusedDetail: v.optional(v.string()),
  message: v.union(v.string(), v.null()),
  messageDigest: v.string(),
});
const bytes = (text: string) => new TextEncoder().encode(text).length;
export const mirror = mutation({
  args: {
    sessionId: v.string(),
    generation: v.number(),
    revision: v.number(),
    items: v.array(item),
  },
  handler: async (ctx, args) => {
    const caller = await requireRunnerForWrite(ctx);
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
    if (
      session === null ||
      session.deletedAt !== null ||
      session.ownerUserId !== caller.ownerUserId ||
      !(await ownerMayWorkOn(ctx, caller.ownerUserId, session.projectId))
    )
      throw new ConvexError({ code: "not_found", message: "No such Session." });
    if (
      intake === null ||
      intake.state === "released" ||
      intake.claim.runnerId !== caller.runnerId ||
      intake.claim.generation !== args.generation
    )
      throw new ConvexError({
        code: "fenced",
        message: "This runner no longer holds the Session claim.",
      });
    if (
      !Number.isSafeInteger(args.revision) ||
      args.revision < 0 ||
      args.items.length > FOLLOW_UP_QUEUE_MAX ||
      bytes(JSON.stringify(args)) > FOLLOW_UP_MIRROR_MAX_BYTES ||
      args.items.some(
        (i) =>
          !i.messageId ||
          i.messageId.length > 512 ||
          !i.commandId ||
          i.commandId.length > 512 ||
          i.messageDigest.length > 512 ||
          (i.message !== null && bytes(i.message) > FOLLOW_UP_MESSAGE_MAX_BYTES),
      ) ||
      new Set(args.items.map((i) => i.messageId)).size !== args.items.length
    )
      throw new ConvexError({
        code: "invalid_queue",
        message: "The follow-up mirror exceeds its bounds.",
      });
    const previous = await ctx.db
      .query("sessionFollowUpQueues")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (
      previous !== null &&
      previous.generation === args.generation &&
      args.revision <= previous.revision
    )
      return { written: false };
    const row = { ...args, runnerId: caller.runnerId, updatedAt: Date.now() };
    if (bytes(JSON.stringify(row)) > FOLLOW_UP_MIRROR_MAX_BYTES)
      throw new ConvexError({
        code: "invalid_queue",
        message: "The follow-up mirror exceeds its bounds.",
      });
    if (previous === null) await ctx.db.insert("sessionFollowUpQueues", row);
    else await ctx.db.replace(previous._id, row);
    await advanceFollowUpRevision(ctx, args.sessionId, args.generation);
    return { written: true };
  },
});

export const queue = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { session } = await requireSessionVisible(ctx, sessionId, viewer);
    const stored = await ctx.db
      .query("sessionFollowUpQueues")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    const current =
      stored !== null &&
      intake?.claim.generation === stored.generation &&
      intake.claim.runnerId === stored.runnerId
        ? stored
        : null;
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", session.placeRunnerId))
      .unique();
    return {
      revision: await followUpRevision(ctx, sessionId, intake?.claim.generation ?? 1),
      items: followUpQueueView(
        current?.items ?? [],
        queueJobs(await followUpJobs(ctx, sessionId)),
        runner?.status ?? null,
      ),
      runner: runner === null ? null : { id: runner.id, name: runner.name, status: runner.status },
    };
  },
});
