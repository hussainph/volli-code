/** Intent routing only. The runner owns queue release, steering and delivery races. */
import { ConvexError } from "convex/values";
import { encodeSessionJson } from "@volli/shared";
import {
  decodeCloudSessionIntent,
  FOLLOW_UP_QUEUE_MAX,
  followUpQueueView,
  SESSION_COMMAND_FORMAT,
  SESSION_FOLLOW_UP_FORMAT,
  type FollowUpIntent,
} from "@volli/shared/cloud";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cancelJob, enqueueJob, patchQueuedJob, recordSettledCommand, type JobDraft } from "./jobs";

export async function followUpJobs(ctx: Pick<QueryCtx, "db">, sessionId: string) {
  const jobs: Doc<"runnerJobs">[] = [];
  // Only open indexed ranges, never seven days of terminal command history.
  for (const kind of ["session.followUp", "session.command"] as const) {
    for (const status of ["queued", "leased"] as const) {
      const rows = await ctx.db
        .query("runnerJobs")
        .withIndex("by_session_kind_status", (q) =>
          q.eq("sessionId", sessionId).eq("kind", kind).eq("status", status),
        )
        .take(256);
      jobs.push(...rows);
    }
  }
  return jobs.toSorted((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
}

export function queueJobs(jobs: readonly Doc<"runnerJobs">[]) {
  return jobs.flatMap((job) => {
    const payload = job.payload as { intent?: string };
    if (typeof payload.intent !== "string") return [];
    const intent = decodeCloudSessionIntent(JSON.parse(payload.intent));
    if (
      !(
        intent.kind === "message.edit" ||
        intent.kind === "message.cancel" ||
        (intent.kind === "message.submit" && "delivery" in intent)
      )
    )
      return [];
    return [
      { commandId: job.commandId!, intent, status: job.status, neverLeased: job.lease === null },
    ];
  });
}

export async function routeFollowUp(
  ctx: MutationCtx,
  draft: JobDraft<"session.command"> & { commandId: string },
  intent: FollowUpIntent,
  session: Doc<"sessions">,
) {
  const stored = await ctx.db
    .query("sessionFollowUpQueues")
    .withIndex("by_session", (q) => q.eq("sessionId", session.id))
    .unique();
  const intake = await ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", session.id))
    .unique();
  const mirror =
    stored !== null &&
    intake?.claim.generation === stored.generation &&
    intake.claim.runnerId === stored.runnerId
      ? stored
      : null;
  const jobs = await followUpJobs(ctx, session.id);
  const payload = { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson(intent) } as const;
  const settle = (status: "accepted" | "rejected", code: string | null) =>
    recordSettledCommand(ctx, { ...draft, payload }, { status, code, detail: null });
  if (intent.kind === "message.submit") {
    if (intent.delivery === "steer") return enqueueJob(ctx, { ...draft, payload });
    if (session.status !== "open") return settle("rejected", "session_archived");
    const view = followUpQueueView(mirror?.items ?? [], queueJobs(jobs), "online");
    if (view.some((item) => item.messageId === intent.messageId))
      return settle("rejected", "message_exists");
    if (view.length >= FOLLOW_UP_QUEUE_MAX)
      throw new ConvexError({
        code: "queue_full",
        message: "This Session already has 32 queued messages.",
      });
    return enqueueJob(ctx, {
      ...draft,
      kind: "session.followUp",
      payload: { format: SESSION_FOLLOW_UP_FORMAT, intent: payload.intent },
    });
  }
  const target = jobs.find(
    (job) =>
      job.kind === "session.followUp" && queueJobs([job])[0]?.intent.messageId === intent.messageId,
  );
  if (target !== undefined && target.status === "queued" && target.lease === null) {
    if (
      intent.expectedRevision !== undefined &&
      intent.expectedRevision !== (mirror?.revision ?? 0)
    )
      throw new ConvexError({
        code: "queue_revision_conflict",
        message: "The follow-up queue changed. Refresh and try again.",
      });
    if (intent.kind === "message.cancel")
      await cancelJob(ctx, target, Date.now(), {
        code: "withdrawn",
        detail: "The queued message was cancelled.",
      });
    else {
      const original = queueJobs([target])[0]!.intent;
      if (original.kind !== "message.submit") throw new Error("Not a queued submit.");
      await patchQueuedJob(ctx, target, {
        format: SESSION_FOLLOW_UP_FORMAT,
        intent: encodeSessionJson({ ...original, reference: intent.reference }),
      });
    }
    return settle("accepted", null);
  }
  // Even after the intake job completed, the runner may still hold the item.
  // It alone knows whether release already crossed the idle boundary.
  return enqueueJob(ctx, { ...draft, payload });
}
