/**
 * The runner inbox: one claim/lease/complete queue per runner (`runnerJobs`).
 *
 * The backend writes jobs (closed on write: it only enqueues kinds it knows),
 * and a runner reads them OPEN: a kind the runner does not know completes as
 * failed with {@link UNSUPPORTED_JOB_KIND}, so an older runner shows "update
 * this runner" instead of crashing.
 *
 * A job outcome is a durable fact the runner owes the backend. It waits in the
 * runner's local job journal until `runnerJobs.complete` answers, and
 * executing a re-leased job after a crash is idempotent by the job id: before
 * a boot's first claim the runner reports every journaled outcome under the
 * lease that ran it, and a re-leased job whose id is already journaled is
 * completed with the stored outcome under the new lease, not run again.
 */

import type { Actor } from "./actor";
import type { JobPayload } from "./job-payloads";
import type {
  CommandId,
  JobId,
  ProjectId,
  RunnerId,
  SessionId,
  TicketId,
  WorkingCopyId,
} from "./ids";

export const JOB_KINDS = [
  "session.start",
  "session.command",
  "session.followUp",
  "session.notice",
  "session.delegate",
  "session.release",
  "workingCopy.materialize",
  "workingCopy.trim",
  "workingCopy.reclaim",
  "workingCopy.refresh",
  "environment.run",
  "automation.run",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Whether a stored kind is one this build can execute. A runner fails the rest as unsupported. */
export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

export const JOB_PRIORITIES = ["normal", "urgent"] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

/** The sort rank stored beside the priority: the ready index sorts on it, so urgent jobs claim first. */
export function jobRank(priority: JobPriority): 0 | 1 {
  return priority === "urgent" ? 0 : 1;
}

export const JOB_STATUSES = ["queued", "leased", "done", "failed", "cancelled", "expired"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Statuses that end a job. Terminal jobs are kept {@link TERMINAL_JOB_TTL_MS}.
 * One exception: a job dead-lettered as `expired` because its last lease ran
 * out still takes that lease's late outcome (it moves to `done` or `failed`),
 * so work that finished is never reported as lost. Nothing else leaves a
 * terminal status, and nothing is handed out again.
 */
export const TERMINAL_JOB_STATUSES = [
  "done",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly JobStatus[];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/** How long a claim leases a job before it returns to the queue. Long jobs renew. */
export const JOB_LEASE_MS = 60_000;

/** The longest one renew extends a lease by (environment setup runs up to 20 minutes). */
export const JOB_LEASE_MAX_MS = 30 * 60_000;

/** The most jobs one claim hands out. */
export const JOB_CLAIM_MAX = 32;

/** How long a terminal job is kept before it expires. */
export const TERMINAL_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a `session.notice` waits for a runner that never claims it before
 * it expires. A notice is a delivery, not a fact: what it reported stays in the
 * history it came from.
 */
export const NOTICE_MAX_WAIT_MS = TERMINAL_JOB_TTL_MS;

export interface JobLease {
  bootId: string;
  expiresAt: number;
  attempt: number;
}

export interface RunnerJob<K extends JobKind = JobKind> {
  /**
   * Equals the `commandId` when the job carries a command, so a retried command finds its job.
   * A `session.notice` job's id is its frozen derived command id (`watch:{watcherSessionId}:{uuid}`
   * or `{operationId}:answer`), not a UUID: the backend admits a derived id for that kind alone.
   */
  id: JobId;
  runnerId: RunnerId;
  /** Closed on write (backend), open on read (runner). */
  kind: K;
  projectId: ProjectId;
  sessionId: SessionId | null;
  ticketId: TicketId | null;
  workingCopyId: WorkingCopyId | null;
  commandId: CommandId | null;
  payload: JobPayload<K>;
  priority: JobPriority;
  createdBy: Actor;
  createdAt: number;
  availableAt: number;
}

/** What `runnerJobs.claim` returns: the job plus its lease, which `renew` and `complete` echo. */
export interface ClaimedJob<K extends JobKind = JobKind> {
  job: RunnerJob<K>;
  lease: JobLease;
}

export type JobOutcome =
  /**
   * `result` is plain JSON of at most {@link JOB_RESULT_MAX_CHARS}; its shape
   * is kind-specific and checked by the ticket that reads it. A result that is
   * not plain JSON, or too large, is recorded as failed with
   * {@link INVALID_JOB_RESULT}.
   */
  | { status: "done"; result: unknown }
  | { status: "failed"; code: string; detail: string | null; retryable: boolean };

/**
 * Why a runner no longer holds a job: the backend cancelled it (stop working
 * on it), a newer lease or another completion replaced this one (fenced), or
 * the job is not this runner's or no longer exists (gone). Either way the
 * runner stops working on it under this lease.
 */
export type JobLostReason = "cancelled" | "fenced" | "gone";

/** What `runnerJobs.renew` answers: the extended lease, or why the runner lost the job. */
export type JobRenewReply = { ok: true; lease: JobLease } | { ok: false; reason: JobLostReason };

/**
 * What `runnerJobs.complete` answers. Every reply is final for that outcome,
 * so the runner removes it from its job journal: `recorded` (the job's status
 * after it; `queued` means a retry is scheduled), `duplicate` (this lease
 * already reported it), or `superseded`. Only a thrown error (transport,
 * auth) means try again later: `complete` refuses nothing else.
 */
export type JobCompleteReply =
  | { ack: "recorded"; status: JobStatus }
  | { ack: "duplicate"; status: JobStatus }
  | { ack: "superseded"; reason: JobLostReason };

/** The largest `result` a completion may carry, as JSON text. */
export const JOB_RESULT_MAX_CHARS = 64 * 1024;

/** The failure code recorded for a `done` outcome whose result is not plain JSON or too large. */
export const INVALID_JOB_RESULT = "invalid_job_result";

/** Why `result` cannot be stored as a job result, or `null` when it can. */
export function jobResultProblem(result: unknown): string | null {
  if (!isPlainJson(result)) return "The result is not plain JSON.";
  if (JSON.stringify(result).length > JOB_RESULT_MAX_CHARS) {
    return `The result is larger than ${JOB_RESULT_MAX_CHARS} characters of JSON.`;
  }
  return null;
}

/**
 * Whether `value` is plain JSON the backend can store: null, booleans, finite
 * numbers, strings, arrays and plain objects of them. Backend values can also
 * be 64-bit integers and bytes, which do not survive `JSON.stringify`
 * honestly, and the backend refuses an object key that is empty, longer than
 * 1024 characters, starts with `$` (a JSON Schema's `$ref`) or holds anything
 * but printable ASCII. A runner checks a result with `jobResultProblem`
 * before it sends one: the backend client cannot even encode such keys.
 */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value).every(
    ([key, item]) => STORABLE_KEY.test(key) && isPlainJson(item, depth + 1),
  );
}

/** An object key the backend stores: 1 to 1024 printable ASCII characters, not starting with `$`. */
const STORABLE_KEY = /^[\x20-\x23\x25-\x7e][\x20-\x7e]{0,1023}$/;

/** The failure code for a job kind the runner does not know. */
export const UNSUPPORTED_JOB_KIND = "unsupported_job_kind";

/** The outcome a runner reports for a kind it cannot execute: permanent until the runner updates. */
export function unsupportedJobOutcome(kind: string): JobOutcome {
  return {
    status: "failed",
    code: UNSUPPORTED_JOB_KIND,
    detail: `This runner does not know the job kind ${JSON.stringify(kind)}; update it.`,
    retryable: false,
  };
}
