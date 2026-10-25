/**
 * The runner inbox's rules: how a job gets in (`enqueueJob`), who it may go
 * to, and how its lease and retries run. `runnerJobs.ts` exposes them to
 * runners; producers (the board's side effects, Session commands, Automation
 * arrivals) call {@link enqueueJob} inside their own transaction, so a job
 * exists exactly when the write that needed it committed.
 *
 * Routing: a runner only runs its owner's work. Every job names the person
 * whose work it is (`onBehalfOf`), who must own the target runner and be an
 * active Member of the project's Workspace. The exception is housekeeping of a
 * Working copy the runner already holds (trim, reclaim, refresh): that is the
 * runner owner's own disk, so the job names the Working copy instead. Any job
 * that names a Working copy must name one on its runner, and the ticket,
 * Session and Working copy a job names must belong to the job's project. A
 * Session's jobs go to the runner holding its claim.
 *
 * Refusals are `ConvexError`s with a typed `code` ({@link JobErrorCode}). A
 * producer that must not fail its own write over a routing refusal calls
 * {@link tryEnqueueJob}, which returns the refusal instead.
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError } from "convex/values";

import {
  InvalidIdError,
  InvalidJobPayloadError,
  TERMINAL_JOB_TTL_MS,
  isActiveMember,
  isJobKind,
  isTerminalJobStatus,
  jobRank,
  newId,
  parseId,
  parseJobPayload,
  type Actor,
  type ClaimedJob,
  type JobId,
  type JobKind,
  type JobPayload,
  type JobPriority,
  type RunnerJob,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { findMembership } from "./auth";

/** A malformed job (a producer bug), or another job under a used id. Always thrown. */
type JobDefectCode = "invalid_job" | "id_taken";
/** The job is well formed but may not go to that runner. {@link tryEnqueueJob} returns these. */
export type JobRefusalCode =
  | "runner_unavailable"
  | "not_your_runner"
  | "not_a_member"
  | "wrong_runner";
export type JobErrorCode = JobDefectCode | JobRefusalCode;

class JobRefusal extends Error {
  constructor(
    readonly code: JobRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

function defect(code: JobDefectCode, message: string) {
  return new ConvexError({ code, message });
}

/** How many times a job is leased before it dead-letters. A lease that runs out counts as one. */
export const JOB_MAX_ATTEMPTS = 5;

/** How long the job waits after failed attempt `attempt` (1-based): 5 s, 20 s, 80 s, 320 s, then 10 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * 4 ** (Math.max(attempt, 1) - 1), 10 * 60_000);
}

/** The fields that end a job: when, and when the sweep may delete it. */
export function terminal(now: number) {
  return { completedAt: now, expiresAt: now + TERMINAL_JOB_TTL_MS };
}

/** Kinds that look after a Working copy the target runner already holds. */
const WORKING_COPY_KINDS: ReadonlySet<JobKind> = new Set([
  "workingCopy.trim",
  "workingCopy.reclaim",
  "workingCopy.refresh",
]);

export interface JobDraft<K extends JobKind = JobKind> {
  /** Defaults to `commandId` when the job carries a command, else a new UUID. */
  id?: string;
  runnerId: string;
  kind: K;
  projectId: string;
  sessionId?: string | null;
  ticketId?: string | null;
  workingCopyId?: string | null;
  commandId?: string | null;
  payload: JobPayload<K>;
  priority?: JobPriority;
  /** Not before this time (an armed arrival's delay). Defaults to now. */
  availableAt?: number;
  createdBy: Actor;
  /**
   * The person whose work this is; they must own the runner. `null` only for
   * Working copy housekeeping (trim, reclaim, refresh).
   */
  onBehalfOf: string | null;
}

export interface Enqueued {
  jobId: JobId;
  /** `false` when the same job was already enqueued under this id (an idempotent replay). */
  created: boolean;
}

export interface Unroutable {
  refused: JobRefusalCode;
  message: string;
}

type JobRow = Omit<Doc<"runnerJobs">, "_id" | "_creationTime">;

function optionalId(kind: Parameters<typeof parseId>[0], value: string | null | undefined) {
  return value === null || value === undefined ? null : parseId(kind, value);
}

/** Canonical JSON, keys sorted, so a replayed payload compares equal whatever its key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/**
 * Inserts a queued job for `draft.runnerId`, or returns the job already
 * enqueued under the same id with the same content. Throws on a malformed
 * draft and on a routing refusal.
 */
export async function enqueueJob<K extends JobKind>(
  ctx: Pick<MutationCtx, "db">,
  draft: JobDraft<K>,
): Promise<Enqueued> {
  const outcome = await tryEnqueueJob(ctx, draft);
  if ("refused" in outcome) {
    throw new ConvexError({ code: outcome.refused, message: outcome.message });
  }
  return outcome;
}

/** {@link enqueueJob}, but a routing refusal is returned rather than thrown. */
export async function tryEnqueueJob<K extends JobKind>(
  ctx: Pick<MutationCtx, "db">,
  draft: JobDraft<K>,
): Promise<Enqueued | Unroutable> {
  const row = draftRow(draft, Date.now());
  const existing = await ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", row.id))
    .unique();
  if (existing !== null) {
    // The runner is left out: a Session's queued jobs follow its claim when it moves.
    const same =
      existing.kind === row.kind &&
      existing.projectId === row.projectId &&
      existing.sessionId === row.sessionId &&
      existing.ticketId === row.ticketId &&
      existing.workingCopyId === row.workingCopyId &&
      existing.commandId === row.commandId &&
      canonical(existing.payload) === canonical(row.payload);
    if (!same) throw defect("id_taken", "That job id was used for another job.");
    return { jobId: row.id as JobId, created: false };
  }
  try {
    await checkRouting(ctx, draft.onBehalfOf, row);
  } catch (error) {
    if (error instanceof JobRefusal) return { refused: error.code, message: error.message };
    throw error;
  }
  await ctx.db.insert("runnerJobs", row);
  return { jobId: row.id as JobId, created: true };
}

/** The row a draft becomes, with every id and the payload checked by the shared codecs. */
function draftRow(draft: JobDraft, now: number): JobRow {
  if (!isJobKind(draft.kind))
    throw defect("invalid_job", `Unknown job kind ${String(draft.kind)}.`);
  let row: JobRow;
  try {
    const commandId = optionalId("command", draft.commandId);
    const id = parseId("job", draft.id ?? commandId ?? newId("job"));
    if (commandId !== null && id !== commandId) {
      throw defect("invalid_job", "A job that carries a command takes the command's id.");
    }
    const priority = draft.priority ?? "normal";
    row = {
      id,
      runnerId: parseId("runner", draft.runnerId),
      kind: draft.kind,
      projectId: parseId("project", draft.projectId),
      sessionId: optionalId("session", draft.sessionId),
      ticketId: optionalId("ticket", draft.ticketId),
      workingCopyId: optionalId("workingCopy", draft.workingCopyId),
      commandId,
      payload: parseJobPayload(draft.kind, draft.payload),
      priority,
      rank: jobRank(priority),
      status: "queued",
      availableAt: draft.availableAt ?? now,
      lease: null,
      receipt: null,
      result: null,
      createdBy: draft.createdBy,
      createdAt: now,
      completedAt: null,
      expiresAt: null,
      failure: null,
    };
  } catch (error) {
    if (error instanceof InvalidIdError || error instanceof InvalidJobPayloadError) {
      throw defect("invalid_job", error.message);
    }
    throw error;
  }
  const payload = row.payload as Record<string, unknown>;
  if (typeof payload.ticketId === "string" && payload.ticketId !== row.ticketId) {
    throw defect("invalid_job", "The payload names another ticket than the job.");
  }
  if (typeof payload.workingCopyId === "string" && payload.workingCopyId !== row.workingCopyId) {
    throw defect("invalid_job", "The payload names another Working copy than the job.");
  }
  if (WORKING_COPY_KINDS.has(row.kind) && row.workingCopyId === null) {
    throw defect("invalid_job", `A ${row.kind} job names its Working copy.`);
  }
  if (row.kind.startsWith("session.") && row.sessionId === null) {
    throw defect("invalid_job", `A ${row.kind} job names its session.`);
  }
  if (row.kind === "session.delegate" && payload.parentSessionId === row.sessionId) {
    throw defect(
      "invalid_job",
      "A delegation's job names the child; the parent is in the payload.",
    );
  }
  if (draft.onBehalfOf === null && !WORKING_COPY_KINDS.has(row.kind)) {
    throw defect("invalid_job", `A ${row.kind} job names whose work it is.`);
  }
  if (
    row.kind === "automation.run" &&
    payload.armedByUserId !== null &&
    payload.armedByUserId !== draft.onBehalfOf
  ) {
    throw defect("invalid_job", "A run with its armer's credentials is its armer's work.");
  }
  return row;
}

async function checkRouting(
  ctx: Pick<MutationCtx, "db">,
  onBehalfOf: string | null,
  row: JobRow,
): Promise<void> {
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", row.runnerId))
    .unique();
  if (runner === null || runner.revokedAt !== null || runner.status === "revoked") {
    throw new JobRefusal("runner_unavailable", "That runner is not connected to its account.");
  }
  if (onBehalfOf !== null && onBehalfOf !== runner.ownerUserId) {
    throw new JobRefusal("not_your_runner", "A runner only runs its owner's work.");
  }
  if (row.ticketId !== null) {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", row.ticketId!))
      .unique();
    if (ticket === null || ticket.projectId !== row.projectId) {
      throw defect("invalid_job", "That ticket is not in the job's project.");
    }
  }
  if (row.workingCopyId !== null) {
    const copy = await ctx.db
      .query("workingCopies")
      .withIndex("by_uuid", (q) => q.eq("id", row.workingCopyId!))
      .unique();
    if (copy === null || copy.runnerId !== row.runnerId) {
      throw new JobRefusal("not_your_runner", "That Working copy is not on this runner.");
    }
    if (
      copy.projectId !== row.projectId ||
      (row.ticketId !== null && copy.ticketId !== row.ticketId)
    ) {
      throw defect("invalid_job", "That Working copy is not the job's ticket's.");
    }
  }
  if (row.sessionId !== null) {
    // A `session.start` names a Session that does not exist yet.
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", row.sessionId!))
      .unique();
    if (session !== null && session.projectId !== row.projectId) {
      throw defect("invalid_job", "That session is not in the job's project.");
    }
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", row.sessionId!))
      .unique();
    if (intake !== null && intake.claim.runnerId !== row.runnerId) {
      throw new JobRefusal("wrong_runner", "A session's jobs go to the runner holding its claim.");
    }
  }
  if (row.kind === "session.delegate") {
    const parentId = (row.payload as { parentSessionId: string }).parentSessionId;
    const parent = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", parentId))
      .unique();
    if (parent === null || parent.projectId !== row.projectId) {
      throw defect("invalid_job", "A delegation's parent is a session in the job's project.");
    }
  }
  if (!(await ownerMayWorkOn(ctx, runner.ownerUserId, row.projectId))) {
    throw new JobRefusal(
      "not_a_member",
      "The runner's owner is not a member of this project's workspace.",
    );
  }
}

/**
 * Rewrites the payload of a job no runner has seen yet (queued, never
 * leased): notice coalescing, a follow-up edited in place. The payload is
 * checked again, and must still name the job's own ticket and Working copy.
 * Returns `false`, changing nothing, once any runner has held the job, so the
 * backend and a runner never both hold one payload.
 */
export async function patchQueuedJob(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"runnerJobs">,
  payload: unknown,
): Promise<boolean> {
  if (job.status !== "queued" || job.lease !== null) return false;
  let checked: Doc<"runnerJobs">["payload"];
  try {
    checked = parseJobPayload(job.kind, payload);
  } catch (error) {
    if (error instanceof InvalidJobPayloadError) throw defect("invalid_job", error.message);
    throw error;
  }
  const named = checked as Record<string, unknown>;
  if (
    (typeof named.ticketId === "string" && named.ticketId !== job.ticketId) ||
    (typeof named.workingCopyId === "string" && named.workingCopyId !== job.workingCopyId) ||
    (job.kind === "session.delegate" && named.parentSessionId === job.sessionId)
  ) {
    throw defect("invalid_job", "A patched payload names what its job names.");
  }
  await ctx.db.patch(job._id, { payload: checked });
  return true;
}

/** A command the backend answered itself, as the engine's receipt would read. */
export interface SettledReceipt {
  status: "accepted" | "rejected" | "completed";
  code: string | null;
  detail: string | null;
}

/**
 * Records a Session command the backend settled without a runner (an
 * in-place follow-up edit or cancel) as a finished job, so the command id
 * finds one row with one receipt like every other Session command. The row is
 * never handed out; the sweep deletes it with the other finished jobs.
 * Idempotent by the command id.
 */
export async function recordSettledCommand<K extends JobKind>(
  ctx: Pick<MutationCtx, "db">,
  draft: JobDraft<K> & { commandId: string },
  receipt: SettledReceipt,
): Promise<Enqueued> {
  const now = Date.now();
  const row = draftRow(draft, now);
  const existing = await ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", row.id))
    .unique();
  if (existing !== null) {
    if (
      existing.kind !== row.kind ||
      existing.sessionId !== row.sessionId ||
      existing.status !== "done"
    ) {
      throw defect("id_taken", "That command id was used for another job.");
    }
    return { jobId: row.id as JobId, created: false };
  }
  await ctx.db.insert("runnerJobs", {
    ...row,
    status: "done",
    receipt: { ...receipt, at: now },
    ...terminal(now),
  });
  return { jobId: row.id as JobId, created: true };
}

/** Whether a runner's owner may still be handed work in a project: it is live and they are an active Member. */
export async function ownerMayWorkOn(
  ctx: { db: GenericDatabaseReader<DataModel> },
  ownerUserId: string,
  projectId: string,
): Promise<boolean> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", projectId))
    .unique();
  if (project === null || project.deletedAt !== null) return false;
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", project.workspaceId))
    .unique();
  if (workspace === null || workspace.deletedAt !== null) return false;
  const membership = await findMembership(ctx, project.workspaceId, ownerUserId);
  return isActiveMember(
    { userId: ownerUserId as UserId },
    project.workspaceId as WorkspaceId,
    membership,
  );
}

/**
 * Withdraws a job that is not finished: it will not be handed out again, and
 * a runner holding it learns at its next renew. Returns whether the job was
 * still open. The reason is kept as the job's last failure.
 */
export async function cancelJob(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"runnerJobs">,
  now: number,
  why: { code: string; detail: string | null } = { code: "cancelled", detail: null },
): Promise<boolean> {
  if (isTerminalJobStatus(job.status)) return false;
  await ctx.db.patch(job._id, {
    status: "cancelled",
    ...terminal(now),
    failure: {
      attempt: job.lease?.attempt ?? 0,
      code: why.code,
      detail: why.detail,
      retryable: false,
      by: "backend",
      at: now,
    },
  });
  return true;
}

/** A runner's reference to one lease of a job. */
export interface LeaseRef {
  bootId: string;
  attempt: number;
}

function isLease(job: Doc<"runnerJobs">, ref: LeaseRef): boolean {
  return job.lease !== null && job.lease.bootId === ref.bootId && job.lease.attempt === ref.attempt;
}

/** Whether the runner already reported a failure for this lease (that attempt is over). */
export function reportedFailure(job: Doc<"runnerJobs">, ref: LeaseRef): boolean {
  return isLease(job, ref) && job.failure?.by === "runner" && job.failure.attempt === ref.attempt;
}

/** Whether this lease already reported the job's outcome: done under it, or a failure it reported. */
export function alreadyReported(job: Doc<"runnerJobs">, ref: LeaseRef): boolean {
  return (job.status === "done" && isLease(job, ref)) || reportedFailure(job, ref);
}

/**
 * Whether `ref` is the job's most recent lease and may keep working: the job
 * is leased under it, or the lease ran out and the job is back in the queue
 * with no newer lease (a renew picks it up again). Not once the lease
 * reported a failure, and never for a finished or dead-lettered job.
 */
export function leaseMayContinue(job: Doc<"runnerJobs">, ref: LeaseRef): boolean {
  if (!isLease(job, ref)) return false;
  if (job.status === "leased") return true;
  return job.status === "queued" && !reportedFailure(job, ref);
}

/**
 * Whether `ref` may report the job's outcome: it may continue, or it was the
 * last lease of a job dead-lettered as `expired` (a late outcome still counts).
 */
export function leaseMayReport(job: Doc<"runnerJobs">, ref: LeaseRef): boolean {
  return leaseMayContinue(job, ref) || (job.status === "expired" && isLease(job, ref));
}

/** A job row as the runner receives it, with the lease it must echo. */
export function claimedJob(job: JobRow): ClaimedJob {
  const runnerJob: RunnerJob = {
    id: job.id as RunnerJob["id"],
    runnerId: job.runnerId as RunnerJob["runnerId"],
    kind: job.kind,
    projectId: job.projectId as RunnerJob["projectId"],
    sessionId: job.sessionId as RunnerJob["sessionId"],
    ticketId: job.ticketId as RunnerJob["ticketId"],
    workingCopyId: job.workingCopyId as RunnerJob["workingCopyId"],
    commandId: job.commandId as RunnerJob["commandId"],
    payload: job.payload as RunnerJob["payload"],
    priority: job.priority,
    createdBy: job.createdBy as Actor,
    createdAt: job.createdAt,
    availableAt: job.availableAt,
  };
  return { job: runnerJob, lease: job.lease! };
}
