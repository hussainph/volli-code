/**
 * The runner inbox: one claim/lease/complete queue per runner (`runnerJobs`).
 *
 * The backend writes jobs (closed on write: it only enqueues kinds it knows),
 * and a runner reads them OPEN: a kind the runner does not know completes as
 * failed with {@link UNSUPPORTED_JOB_KIND}, so an older runner shows "update
 * this runner" instead of crashing.
 *
 * A job outcome is a durable fact the runner owes the backend. It waits in the
 * runner's local job journal until `jobs.complete` acknowledges it, and
 * executing a re-leased job after a crash is idempotent by the job id.
 */

import type { Actor } from "./actor";
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

/**
 * Kind-specific payloads. Each is defined by the ticket that owns the kind
 * (the Session ledger and delegation work for the Session kinds, the runner work
 * for the Working copy kinds, project environments, Automations). Until then a
 * payload is an opaque JSON object.
 */
export interface JobPayloads {
  "session.start": JobPayloadObject;
  "session.command": JobPayloadObject;
  "session.followUp": JobPayloadObject;
  "session.notice": JobPayloadObject;
  "session.delegate": JobPayloadObject;
  "session.release": JobPayloadObject;
  "workingCopy.materialize": JobPayloadObject;
  "workingCopy.trim": JobPayloadObject;
  "workingCopy.reclaim": JobPayloadObject;
  "workingCopy.refresh": JobPayloadObject;
  "environment.run": JobPayloadObject;
  "automation.run": JobPayloadObject;
}

/** A payload no owning ticket has typed yet. */
export type JobPayloadObject = { readonly [field: string]: unknown };

export type JobPayload<K extends JobKind> = JobPayloads[K];

export const JOB_PRIORITIES = ["normal", "urgent"] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

/** The sort rank stored beside the priority: the ready index sorts on it, so urgent jobs claim first. */
export function jobRank(priority: JobPriority): 0 | 1 {
  return priority === "urgent" ? 0 : 1;
}

export const JOB_STATUSES = ["queued", "leased", "done", "failed", "cancelled", "expired"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses a job never leaves. Terminal jobs are kept {@link TERMINAL_JOB_TTL_MS}. */
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

/** How long a terminal job is kept before it expires. */
export const TERMINAL_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface JobLease {
  bootId: string;
  expiresAt: number;
  attempt: number;
}

export interface RunnerJob<K extends JobKind = JobKind> {
  /** Equals the `commandId` when the job carries a command, so a retried command finds its job. */
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

/** What `jobs.claim` returns: the job plus its lease, which `jobs.complete` must echo. */
export interface ClaimedJob<K extends JobKind = JobKind> {
  job: RunnerJob<K>;
  lease: JobLease;
}

export type JobOutcome =
  /** `result` is kind-specific and codec-checked by the owning ticket. */
  | { status: "done"; result: unknown }
  | { status: "failed"; code: string; detail: string | null; retryable: boolean };

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
