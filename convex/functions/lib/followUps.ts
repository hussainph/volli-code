/** Intent routing only. The runner owns queue release, steering and delivery races. */
import { ConvexError } from "convex/values";
import { encodeSessionJson, decodeCloudSessionIntent } from "@volli/shared";
import {
  FOLLOW_UP_QUEUE_MAX,
  followUpQueueView,
  SESSION_COMMAND_FORMAT,
  SESSION_FOLLOW_UP_FORMAT,
  type FollowUpIntent,
} from "@volli/shared/cloud";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cancelJob, enqueueJob, patchQueuedJob, recordSettledCommand, type JobDraft } from "./jobs";

const revisionOf = (row: Doc<"sessionFollowUpRevisions"> | null, generation: number) =>
  row === null
    ? Math.max(0, generation - 1)
    : row.revision + Math.max(0, generation - row.generation);
/** Generation changes invalidate a precondition even before a new mirror arrives. */
export async function followUpRevision(
  ctx: Pick<QueryCtx, "db">,
  sessionId: string,
  generation: number,
) {
  return revisionOf(
    await ctx.db
      .query("sessionFollowUpRevisions")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique(),
    generation,
  );
}
export async function advanceFollowUpRevision(
  ctx: Pick<MutationCtx, "db">,
  sessionId: string,
  generation: number,
) {
  const row = await ctx.db
    .query("sessionFollowUpRevisions")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  const revision = revisionOf(row, generation) + 1;
  if (row === null)
    await ctx.db.insert("sessionFollowUpRevisions", { sessionId, generation, revision });
  else await ctx.db.patch(row._id, { generation, revision });
  return revision;
}

export async function followUpJobs(ctx: Pick<QueryCtx, "db">, sessionId: string) {
  const jobs: Doc<"runnerJobs">[] = [];
  for (const kind of ["session.followUp", "session.command"] as const)
    for (const status of ["queued", "leased"] as const) {
      jobs.push(
        ...(await ctx.db
          .query("runnerJobs")
          .withIndex("by_session_kind_status", (q) =>
            q.eq("sessionId", sessionId).eq("kind", kind).eq("status", status),
          )
          .take(256)),
      );
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
  if (intake === null) throw new ConvexError({ code: "not_found", message: "No such Session." });
  const generation = intake.claim.generation;
  const mirror =
    stored !== null && stored.generation === generation && stored.runnerId === intake.claim.runnerId
      ? stored
      : null;
  const jobs = await followUpJobs(ctx, session.id);
  let payload = { format: SESSION_COMMAND_FORMAT, intent: encodeSessionJson(intent) } as const;
  const settle = (status: "accepted" | "rejected", code: string | null) =>
    recordSettledCommand(ctx, { ...draft, payload }, { status, code, detail: null });
  const bump = () => advanceFollowUpRevision(ctx, session.id, generation);
  if (intent.kind === "message.submit") {
    if (intent.delivery === "steer") {
      const result = await enqueueJob(ctx, { ...draft, payload });
      if (result.created) await bump();
      return result;
    }
    if (session.status !== "open") return settle("rejected", "session_archived");
    const view = followUpQueueView(mirror?.items ?? [], queueJobs(jobs), "online");
    if (view.some((item) => item.messageId === intent.messageId))
      return settle("rejected", "message_exists");
    if (view.length >= FOLLOW_UP_QUEUE_MAX)
      throw new ConvexError({
        code: "queue_full",
        message: "This Session already has 32 queued messages.",
      });
    const result = await enqueueJob(ctx, {
      ...draft,
      kind: "session.followUp",
      payload: { format: SESSION_FOLLOW_UP_FORMAT, intent: payload.intent },
    });
    if (result.created) await bump();
    return result;
  }
  const revision = await followUpRevision(ctx, session.id, generation);
  if (intent.expectedRevision !== undefined && intent.expectedRevision !== revision)
    throw new ConvexError({
      code: "queue_revision_conflict",
      message: "The follow-up queue changed. Refresh and try again.",
    });
  const target = jobs.find(
    (job) =>
      job.kind === "session.followUp" && queueJobs([job])[0]?.intent.messageId === intent.messageId,
  );
  if (target !== undefined && target.status === "queued" && target.lease === null) {
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
    const result = await settle("accepted", null);
    if (result.created) await bump();
    return result;
  }
  // A public precondition is on the combined view. Translate it to the
  // runner's revision, never send the backend clock to the execution ledger.
  if (intent.expectedRevision !== undefined) {
    if (mirror === null)
      throw new ConvexError({
        code: "queue_revision_conflict",
        message: "Wait for the runner's current queue, then try again.",
      });
    payload = {
      format: SESSION_COMMAND_FORMAT,
      intent: encodeSessionJson({ ...intent, expectedRevision: mirror.revision }),
    };
  }
  const result = await enqueueJob(ctx, { ...draft, payload });
  if (result.created) await bump();
  return result;
}
