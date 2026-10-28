/**
 * The runner inbox, as a runner calls it: claim, renew, complete. One
 * claim/lease/complete queue replaces the per-feature claim protocols the
 * host kept locally.
 *
 * - `wake` (a query) tells a subscribed runner how many jobs are ready and when
 *   the next one comes due.
 * - `claim` leases this runner's ready jobs, urgent first, then oldest
 *   `availableAt`. It also takes back the jobs an earlier boot of this runner
 *   held (a restart; one process runs per runner identity): each comes back
 *   under a new lease with the next attempt number. A job whose owner may no
 *   longer work in its project is cancelled instead of handed out.
 * - `renew` extends a lease (long jobs, like environment setup), re-checks
 *   the owner's membership, and tells the runner when the job was cancelled
 *   or its lease replaced.
 * - `complete` records the outcome, idempotently. It is fenced by the runner
 *   and the lease (`bootId`, `attempt`): only the job's most recent lease may
 *   complete it, including late, after that lease ran out, as long as no newer
 *   lease exists. Work that was done is recorded as done. A retryable failure
 *   goes back to the queue with a backoff; after {@link JOB_MAX_ATTEMPTS} it
 *   dead-letters as `failed`, and a last lease that runs out dead-letters as
 *   `expired`.
 *
 * Lease expiry is a scheduled check per lease, so nothing polls. Terminal jobs
 * are kept for `TERMINAL_JOB_TTL_MS`, then the hourly sweep deletes them; the
 * same sweep cancels notices that waited `NOTICE_MAX_WAIT_MS` unclaimed.
 *
 * The runner keeps each outcome in its local job journal until `complete`
 * answers; every answer is final for that outcome (see `JobCompleteReply` in
 * `@volli/shared/cloud` for the journal rules).
 */

import { ConvexError, v } from "convex/values";
import { decodeCloudSessionIntent } from "@volli/shared";

import {
  INVALID_JOB_RESULT,
  isFollowUpIntent,
  JOB_CLAIM_MAX,
  JOB_LEASE_MAX_MS,
  JOB_LEASE_MS,
  JOB_PRIORITIES,
  NOTICE_MAX_WAIT_MS,
  isDerivedId,
  isTerminalJobStatus,
  isUuid,
  jobRank,
  jobResultProblem,
  type ClaimedJob,
  type JobCompleteReply,
  type JobRenewReply,
  type JobStatus,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import {
  JOB_MAX_ATTEMPTS,
  alreadyReported,
  cancelJob,
  claimedJob,
  leaseMayContinue,
  leaseMayReport,
  ownerMayWorkOn,
  retryDelayMs,
  terminal,
  type LeaseRef,
} from "./lib/jobs";
import { projectImporting } from "./lib/auth";
import { requireRunner, requireRunnerForWrite } from "./lib/runnerAuth";
import { noticeForClaim } from "./lib/watches";

/** How many of its own leased jobs a claim looks at to take back. A runner holds far fewer. */
const LEASED_SCAN = 256;
/** How many queued jobs of projects still being imported one claim passes over. */
const IMPORTING_SKIP_MAX = 512;
/** How many terminal jobs one sweep pass deletes before it schedules the next. */
const SWEEP_BATCH = 256;
/** Bounds on what a runner reports. */
const MAX_CODE = 200;
const MAX_DETAIL = 2_000;

const NOT_A_MEMBER = {
  code: "not_a_member",
  detail: "The runner's owner can no longer work in this project.",
};

/** Whether `ref` can name a lease at all: a lease's boot id is a UUID, its attempt a positive integer. */
function wellFormed(ref: LeaseRef): boolean {
  return isUuid(ref.bootId) && Number.isSafeInteger(ref.attempt) && ref.attempt >= 1;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(Math.floor(chosen), min), max);
}

/** A job by id: a UUID, or a `session.command`'s frozen derived command id (`lib/jobs.ts`). */
async function jobOf(ctx: MutationCtx, jobId: string): Promise<Doc<"runnerJobs"> | null> {
  if (!isDerivedId(jobId)) return null;
  const job = await ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", jobId))
    .unique();
  // A job of a project still being imported is nobody's yet.
  return job === null || (await projectImporting(ctx, job.projectId)) ? null : job;
}

/** Leases `job` to `ref` until `expiresAt`, with the scheduled check that expires it. */
async function lease(
  ctx: MutationCtx,
  job: Doc<"runnerJobs">,
  ref: LeaseRef,
  expiresAt: number,
): Promise<Doc<"runnerJobs">> {
  const patch = { status: "leased" as const, lease: { ...ref, expiresAt } };
  await ctx.db.patch(job._id, patch);
  await ctx.scheduler.runAt(expiresAt, internal.runnerJobs.expireLease, {
    jobId: job.id,
    attempt: ref.attempt,
  });
  return { ...job, ...patch };
}

/** Leases up to `max` (default and cap {@link JOB_CLAIM_MAX}) of the calling runner's ready jobs. */
export const claim = mutation({
  args: { bootId: v.string(), max: v.optional(v.number()) },
  handler: async (ctx, { bootId, max }): Promise<ClaimedJob[]> => {
    const { runnerId, ownerUserId } = await requireRunnerForWrite(ctx);
    if (!isUuid(bootId)) {
      throw new ConvexError({ code: "invalid_request", message: "bootId is this boot's UUID." });
    }
    const limit = bounded(max, JOB_CLAIM_MAX, 1, JOB_CLAIM_MAX);
    const now = Date.now();
    const candidates: Doc<"runnerJobs">[] = [];

    // An earlier boot's leases: that process is gone. (This boot's own leases
    // that run out go back to the queue through their scheduled check.)
    const leased = await ctx.db
      .query("runnerJobs")
      .withIndex("by_runner_ready", (q) => q.eq("runnerId", runnerId).eq("status", "leased"))
      .take(LEASED_SCAN);
    // A project still being imported holds its jobs back, untouched, until its
    // commit; they are passed over (a bounded number) rather than block the queue.
    const importing = new Map<string, boolean>();
    const waitsForImport = async (job: Doc<"runnerJobs">): Promise<boolean> => {
      if (!importing.has(job.projectId)) {
        importing.set(job.projectId, await projectImporting(ctx, job.projectId));
      }
      return importing.get(job.projectId)!;
    };
    for (const job of leased) {
      const held = job.lease!;
      if (held.bootId === bootId || (await waitsForImport(job))) continue;
      if (held.attempt >= JOB_MAX_ATTEMPTS) await deadLetterExpired(ctx, job, now);
      else candidates.push(job);
    }
    let passedOver = 0;
    for (const priority of JOB_PRIORITIES.toSorted((a, b) => jobRank(a) - jobRank(b))) {
      if (candidates.length >= limit || passedOver >= IMPORTING_SKIP_MAX) break;
      for await (const job of ctx.db
        .query("runnerJobs")
        .withIndex("by_runner_ready", (q) =>
          q
            .eq("runnerId", runnerId)
            .eq("status", "queued")
            .eq("rank", jobRank(priority))
            .lte("availableAt", now),
        )) {
        if (candidates.length >= limit) break;
        if (await waitsForImport(job)) {
          passedOver += 1;
          if (passedOver >= IMPORTING_SKIP_MAX) break;
          continue;
        }
        candidates.push(job);
      }
    }

    const allowed = new Map<string, boolean>();
    const claimed: ClaimedJob[] = [];
    for (const job of candidates.slice(0, limit)) {
      if (await waitsForImport(job)) continue;
      // The owner may have left the Workspace (or the project gone) while the job waited.
      let mayWork = allowed.get(job.projectId);
      if (mayWork === undefined) {
        mayWork = await ownerMayWorkOn(ctx, ownerUserId, job.projectId);
        allowed.set(job.projectId, mayWork);
      }
      if (!mayWork) {
        await cancelJob(ctx, job, now, NOT_A_MEMBER);
        continue;
      }
      const deliverable = await noticeForClaim(ctx, job);
      if (deliverable === null) continue;
      const ref = { bootId, attempt: (deliverable.lease?.attempt ?? 0) + 1 };
      claimed.push(claimedJob(await lease(ctx, deliverable, ref, now + JOB_LEASE_MS)));
    }
    return claimed;
  },
});

/** Extends the calling runner's lease on a job by `extendMs` (default the claim lease, at most 30 min). */
export const renew = mutation({
  args: {
    jobId: v.string(),
    bootId: v.string(),
    attempt: v.number(),
    extendMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<JobRenewReply> => {
    const { runnerId, ownerUserId } = await requireRunnerForWrite(ctx);
    const ref = { bootId: args.bootId, attempt: args.attempt };
    const job = await jobOf(ctx, args.jobId);
    if (job === null || job.runnerId !== runnerId) return { ok: false, reason: "gone" };
    if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
    if (!wellFormed(ref) || !leaseMayContinue(job, ref)) return { ok: false, reason: "fenced" };
    const now = Date.now();
    if (!(await ownerMayWorkOn(ctx, ownerUserId, job.projectId))) {
      await cancelJob(ctx, job, now, NOT_A_MEMBER);
      return { ok: false, reason: "cancelled" };
    }
    const extended = now + bounded(args.extendMs, JOB_LEASE_MS, 1_000, JOB_LEASE_MAX_MS);
    if (job.status === "leased") {
      // A renew never shortens a lease; the scheduled check moves itself to the new expiry.
      const expiresAt = Math.max(job.lease!.expiresAt, extended);
      await ctx.db.patch(job._id, { lease: { ...ref, expiresAt } });
      return { ok: true, lease: { ...ref, expiresAt } };
    }
    // The lease ran out but nothing replaced it: the runner is still at it.
    await lease(ctx, job, ref, extended);
    return { ok: true, lease: { ...ref, expiresAt: extended } };
  },
});

const outcome = v.union(
  // Optional: a client drops an `undefined` result, which is recorded as an
  // unusable result rather than refused at the door (a refusal would be retried).
  v.object({ status: v.literal("done"), result: v.optional(v.any()) }),
  v.object({
    status: v.literal("failed"),
    code: v.string(),
    detail: v.union(v.string(), v.null()),
    retryable: v.boolean(),
  }),
);

type Failure = NonNullable<Doc<"runnerJobs">["failure"]>;

/**
 * Records the outcome of the calling runner's lease on a job. Idempotent, and
 * refuses nothing a runner could retry forever: a result that cannot be
 * stored is recorded as a permanent failure, and a malformed lease reference
 * is fenced. The work is recorded even if the owner left the Workspace since:
 * it happened.
 */
export const complete = mutation({
  args: { jobId: v.string(), bootId: v.string(), attempt: v.number(), outcome },
  handler: async (ctx, args): Promise<JobCompleteReply> => {
    const { runnerId } = await requireRunnerForWrite(ctx);
    const ref = { bootId: args.bootId, attempt: args.attempt };
    const job = await jobOf(ctx, args.jobId);
    if (job === null || job.runnerId !== runnerId) return { ack: "superseded", reason: "gone" };
    if (!wellFormed(ref)) return { ack: "superseded", reason: "fenced" };
    if (alreadyReported(job, ref)) {
      return { ack: "duplicate", status: job.status };
    }
    if (job.status === "cancelled") return { ack: "superseded", reason: "cancelled" };
    if (!leaseMayReport(job, ref)) return { ack: "superseded", reason: "fenced" };

    const now = Date.now();
    const reported = args.outcome;
    if (reported.status === "done") {
      const problem = jobResultProblem(reported.result);
      if (problem === null) {
        // Queue controls do not append event-ledger commands. Their runner
        // receipt travels with completion instead of waiting for the fact fold.
        const result = reported.result as { receipt?: unknown } | null | undefined;
        const receipt = result?.receipt as Record<string, unknown> | null | undefined;
        const queueControl = isQueueControl(job);
        const queueReceipt =
          queueControl &&
          receipt != null &&
          ["accepted", "rejected", "completed", "unreconciled"].includes(String(receipt.status)) &&
          (receipt.code === null || typeof receipt.code === "string") &&
          (receipt.detail === null || typeof receipt.detail === "string")
            ? {
                status: receipt.status as "accepted" | "rejected" | "completed" | "unreconciled",
                code: receipt.code as string | null,
                detail: receipt.detail as string | null,
                at: now,
              }
            : null;
        // A summarized attempt must not downgrade an outcome already folded
        // from the immutable Session ledger.
        await ctx.db.patch(job._id, {
          status: "done",
          ...(queueReceipt !== null &&
          (job.receipt === null ||
            job.receipt.status === "unreconciled" ||
            (job.receipt.status === "accepted" && queueReceipt.status === "completed"))
            ? { receipt: queueReceipt }
            : {}),
          result: reported.result as Doc<"runnerJobs">["result"],
          ...terminal(now),
        });
        return { ack: "recorded", status: "done" };
      }
      return recordFailure(ctx, job, ref, now, {
        code: INVALID_JOB_RESULT,
        detail: problem,
        retryable: false,
      });
    }
    return recordFailure(ctx, job, ref, now, {
      code: reported.code.slice(0, MAX_CODE) || "unspecified",
      detail: reported.detail === null ? null : reported.detail.slice(0, MAX_DETAIL),
      retryable: reported.retryable,
    });
  },
});

function isQueueControl(job: Doc<"runnerJobs">): boolean {
  if (job.kind === "session.followUp") return true;
  if (job.kind !== "session.command") return false;
  try {
    const intent = job.commandIntent ?? (job.payload as { intent?: string }).intent;
    return (
      typeof intent === "string" && isFollowUpIntent(decodeCloudSessionIntent(JSON.parse(intent)))
    );
  } catch {
    return false;
  }
}

async function recordFailure(
  ctx: MutationCtx,
  job: Doc<"runnerJobs">,
  ref: LeaseRef,
  now: number,
  reported: Pick<Failure, "code" | "detail" | "retryable">,
): Promise<JobCompleteReply> {
  const failure: Failure = { ...reported, attempt: ref.attempt, by: "runner", at: now };
  const status: JobStatus =
    reported.retryable && ref.attempt < JOB_MAX_ATTEMPTS && job.status !== "expired"
      ? "queued"
      : "failed";
  await ctx.db.patch(job._id, {
    status,
    failure,
    ...(status === "queued" ? { availableAt: now + retryDelayMs(ref.attempt) } : terminal(now)),
  });
  return { ack: "recorded", status };
}

function leaseExpired(attempt: number, retryable: boolean, at: number): Failure {
  return { attempt, code: "lease_expired", detail: null, retryable, by: "backend", at };
}

async function deadLetterExpired(ctx: MutationCtx, job: Doc<"runnerJobs">, now: number) {
  await ctx.db.patch(job._id, {
    status: "expired",
    ...terminal(now),
    failure: leaseExpired(job.lease!.attempt, false, now),
  });
}

/**
 * The scheduled check behind each lease: when lease `attempt` has run out,
 * return the job to the queue after a backoff, or dead-letter it after the
 * last attempt. A renewed lease moves the check to its new expiry; a lease
 * already replaced or finished leaves nothing to do.
 */
export const expireLease = internalMutation({
  args: { jobId: v.string(), attempt: v.number() },
  handler: async (ctx, { jobId, attempt }) => {
    const job = await jobOf(ctx, jobId);
    if (job === null || job.status !== "leased" || job.lease!.attempt !== attempt) return;
    const now = Date.now();
    if (job.lease!.expiresAt > now) {
      await ctx.scheduler.runAt(job.lease!.expiresAt, internal.runnerJobs.expireLease, {
        jobId,
        attempt,
      });
      return;
    }
    if (attempt >= JOB_MAX_ATTEMPTS) {
      await deadLetterExpired(ctx, job, now);
      return;
    }
    await ctx.db.patch(job._id, {
      status: "queued",
      availableAt: now + retryDelayMs(attempt),
      failure: leaseExpired(attempt, true, now),
    });
  },
});

/**
 * What the calling runner should claim, for a subscription that wakes its
 * inbox worker: how many jobs are ready now (up to a claim's worth), and when
 * the next waiting one becomes ready. A job that becomes ready by time alone
 * changes no row, so the runner sets a timer for `nextAvailableAt`.
 */
export const wake = query({
  args: {},
  handler: async (ctx): Promise<{ ready: number; nextAvailableAt: number | null }> => {
    const { runnerId } = await requireRunner(ctx);
    // A query's clock may be stale while its result is cached. That only moves
    // a job that is already due into `nextAvailableAt` (at or before now), and
    // the runner's timer for a past time claims at once, so it is safe here.
    const now = Date.now();
    let ready = 0;
    let nextAvailableAt: number | null = null;
    // Jobs of a project still being imported are not ready: `claim` passes them over.
    const importing = new Map<string, boolean>();
    let passedOver = 0;
    for (const priority of JOB_PRIORITIES) {
      const rank = jobRank(priority);
      for await (const job of ctx.db
        .query("runnerJobs")
        .withIndex("by_runner_ready", (q) =>
          q
            .eq("runnerId", runnerId)
            .eq("status", "queued")
            .eq("rank", rank)
            .lte("availableAt", now),
        )) {
        if (ready >= JOB_CLAIM_MAX || passedOver >= IMPORTING_SKIP_MAX) break;
        if (!importing.has(job.projectId)) {
          importing.set(job.projectId, await projectImporting(ctx, job.projectId));
        }
        if (importing.get(job.projectId)!) passedOver += 1;
        else ready += 1;
      }
      const next = await ctx.db
        .query("runnerJobs")
        .withIndex("by_runner_ready", (q) =>
          q.eq("runnerId", runnerId).eq("status", "queued").eq("rank", rank).gt("availableAt", now),
        )
        .first();
      if (next !== null && (nextAvailableAt === null || next.availableAt < nextAvailableAt)) {
        nextAvailableAt = next.availableAt;
      }
      if (ready >= JOB_CLAIM_MAX) break;
    }
    return { ready, nextAvailableAt };
  },
});

/**
 * Deletes terminal jobs past their keep time, and expires notices that waited
 * {@link NOTICE_MAX_WAIT_MS} for a runner that never claimed them, a batch at
 * a time.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("runnerJobs")
      .withIndex("by_kind_status", (q) =>
        q
          .eq("kind", "session.notice")
          .eq("status", "queued")
          .lte("createdAt", now - NOTICE_MAX_WAIT_MS),
      )
      .take(SWEEP_BATCH);
    for (const notice of stale) {
      await cancelJob(ctx, notice, now, {
        code: "notice_expired",
        detail: "The notice waited too long for its runner.",
      });
    }
    const due = await ctx.db
      .query("runnerJobs")
      .withIndex("by_expiry", (q) => q.gte("expiresAt", 0).lte("expiresAt", now))
      .take(SWEEP_BATCH);
    let deleted = 0;
    for (const job of due) {
      if (isTerminalJobStatus(job.status)) {
        await ctx.db.delete(job._id);
        deleted += 1;
      } else {
        // Only finished jobs expire; an expiry on open work is a writer's slip. Clear it.
        await ctx.db.patch(job._id, { expiresAt: null });
      }
    }
    if (due.length === SWEEP_BATCH || stale.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.runnerJobs.sweep, {});
    }
    return { deleted, expired: stale.length };
  },
});
