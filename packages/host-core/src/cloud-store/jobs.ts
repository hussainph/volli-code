import { existsSync } from "node:fs";

import type { WorktreeTrimSettings } from "@volli/shared";
import {
  InvalidJobPayloadError,
  parseJobPayload,
  type ClaimedJob,
  type JobOutcome,
} from "@volli/shared/cloud";

import type { InboxWorker, JobContext, JobExecutor } from "../cloud-runner/inbox";
import {
  acquireDeletionLease,
  reclaimExplicit,
  trimIgnoredArtifacts,
  type AgentSiteReleaseReport,
  type BusyWorktreeSites,
  type RunGitAsync,
} from "../worktree";
import type { CloudLocationFacts, CloudSessionLocationService } from "./location";
import type { RunnerPathRegistry } from "./paths";
import { hostLogger } from "../log/root";

const log = hostLogger("runner-working-copy-jobs");

export interface WorkingCopyJobOptions {
  registry: RunnerPathRegistry;
  location: CloudSessionLocationService;
  gitAsync: RunGitAsync;
  busySites?: BusyWorktreeSites;
  /** Read at the act, so a changed opt-out/keep list takes effect immediately. */
  trimSettings(): WorktreeTrimSettings;
  releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
  /**
   * The store owns the Done dwell/PR rules. Retention never deletes without a
   * fresh affirmative verdict; explicit requested removal still checks Keep,
   * activity and every dirty/unpushed/locked/unverifiable safety predicate.
   */
  retentionReclaimAllowed?(facts: CloudLocationFacts): Promise<boolean>;
}

const failed = (code: string, detail: string, retryable = false): JobOutcome => ({
  status: "failed",
  code,
  detail: detail.slice(0, 500),
  retryable,
});
const skipped = (reason: string): JobOutcome => ({
  status: "done",
  result: { kind: "skipped", reason },
});

/**
 * Registered on S2's worker: the worker journals by job.id before execution,
 * journals outcomes before reporting, and replays an outcome without executing
 * again. Interrupted operations themselves reconcile safely: materialize is
 * ensure, trim takes only still-present ignored artifacts, reclaim never
 * forces and treats an already-missing directory as complete.
 */
export function registerWorkingCopyJobs(
  worker: Pick<InboxWorker, "register">,
  options: WorkingCopyJobOptions,
): void {
  const execute: JobExecutor = async (claimed: ClaimedJob, context: JobContext) => {
    const { job } = claimed;
    if (job.runnerId !== options.registry.runnerId)
      return failed("not_your_runner", "This machine does not execute another runner's jobs.");
    if (context.signal.aborted) return failed("lease_lost", "This job no longer holds its lease.");

    const ticketId = job.ticketId;
    const copyId = job.workingCopyId;
    let reclaimReason: "requested" | "retention" = "retention";
    try {
      switch (job.kind) {
        case "workingCopy.materialize": {
          const payload = parseJobPayload("workingCopy.materialize", job.payload);
          if (ticketId !== payload.ticketId)
            return failed("invalid_job_payload", "Ticket identity does not match the job.");
          const location = await options.location.materialize({
            sessionId: job.id,
            projectId: job.projectId,
            ticketId,
          });
          return {
            status: "done",
            result: { kind: "materialized", workingCopy: location.workingCopy },
          };
        }
        case "workingCopy.trim": {
          const payload = parseJobPayload("workingCopy.trim", job.payload);
          if (ticketId !== payload.ticketId || copyId !== payload.workingCopyId)
            return failed("invalid_job_payload", "Working copy identity does not match the job.");
          break;
        }
        case "workingCopy.reclaim": {
          const payload = parseJobPayload("workingCopy.reclaim", job.payload);
          if (ticketId !== payload.ticketId || copyId !== payload.workingCopyId)
            return failed("invalid_job_payload", "Working copy identity does not match the job.");
          reclaimReason = payload.reason;
          break;
        }
        case "workingCopy.refresh":
          // The open refresh payload carries no paths; only the envelope's
          // backend-authorized Working copy identity selects local bytes.
          parseJobPayload("workingCopy.refresh", job.payload);
          break;
        default:
          return failed("unsupported_job_kind", "This is not a Working copy job.");
      }
    } catch (error) {
      if (error instanceof InvalidJobPayloadError)
        return failed("invalid_job_payload", "This Working copy job payload is invalid.");
      log.warn("Working copy materialization failed", { jobId: job.id, error });
      return failed(
        "working_copy_failed",
        "The Working copy could not be prepared on this runner. See this runner's log.",
        true,
      );
    }
    if (!ticketId || !copyId)
      return failed(
        "invalid_job_payload",
        "A Working copy job needs its ticket and copy identities.",
      );
    const facts = await options.location.factsFor({
      sessionId: job.id,
      projectId: job.projectId,
      ticketId,
    });
    const repoId = facts.primaryRepo.id;
    // Adopt/validate the main pointer before any frozen worktree pointer. A
    // corrupt legacy stamp must never select the main checkout for trimming.
    const checkoutPath = options.registry.checkouts.pathOf(facts.project.id, repoId);
    if (!checkoutPath && job.kind !== "workingCopy.refresh")
      return skipped("main checkout is not registered");
    const path = options.registry.workingCopies.pathOf(ticketId, repoId);
    if (!path) return skipped("no registered worktree");
    const registered = options.registry.workingCopies.get(ticketId, repoId)!;
    if (registered.workingCopyId !== null && registered.workingCopyId !== copyId)
      return failed("working_copy_mismatch", "That job refers to another Working copy.");
    options.registry.workingCopies.register({
      ticketId,
      projectRepoId: repoId,
      absPath: path,
      workingCopyId: copyId,
    });
    // A path in this table is a worktree even if the ticket has since switched
    // back to its main checkout. Never select the main checkout for housekeeping.
    const worktreeFacts: CloudLocationFacts = {
      ...facts,
      ticket: facts.ticket === null ? null : { ...facts.ticket, checkoutMode: registered.kind },
    };
    if (context.signal.aborted) return failed("lease_lost", "This job no longer holds its lease.");
    if (job.kind === "workingCopy.refresh") {
      const state = existsSync(path) ? "ready" : "reclaimed";
      const report = await options.location.report(worktreeFacts, path, state);
      return { status: "done", result: { kind: "refreshed", workingCopy: report } };
    }
    if (registered.kind !== "worktree")
      return skipped("main checkout is never trimmed or reclaimed");
    if (facts.ticket?.retentionKeep !== false) return skipped("kept or Keep state unavailable");
    // Renewal is a fence immediately before destructive work, not just a timer.
    if (!(await context.renew()))
      return failed("lease_lost", "This job no longer holds its lease.");
    if (context.signal.aborted) return failed("lease_lost", "This job no longer holds its lease.");
    if (job.kind === "workingCopy.trim") {
      if (facts.ticket.status !== "done" && facts.ticket.archivedAt == null)
        return skipped("not finished");
      const settings = options.trimSettings();
      if (!settings.trimOnFinish) return skipped("automatic trim is off");
      if (!existsSync(path)) return skipped("worktree already missing");
      // The primitive protects dirty/busy/keep patterns, nested repositories,
      // symlinks and mount points. The lease also excludes concurrent starts.
      const lease = acquireDeletionLease(path);
      if (!lease) return skipped("working copy is in use");
      try {
        const result = await trimIgnoredArtifacts(options.gitAsync, {
          worktreePath: path,
          keepPatterns: settings.keepPatterns,
          ...(options.busySites === undefined ? {} : { busySites: options.busySites }),
        });
        if (!result.ok) {
          log.warn("Working copy trim refused", { jobId: job.id, reason: result.error });
          return skipped("Working copy is busy or not safe to trim.");
        }
        const report = await options.location.report(worktreeFacts, path, "trimmed");
        // Reports can contain arbitrarily many ignored paths. The journal's
        // bounded result needs counts, not the whole filesystem inventory.
        return {
          status: "done",
          result: {
            kind: "trimmed",
            workingCopy: report,
            entries: result.value.removed.length,
            bytes: result.value.totalBytes,
            kept: result.value.kept.length,
          },
        };
      } finally {
        lease.release();
      }
    }
    if (reclaimReason === "retention" && !(await options.retentionReclaimAllowed?.(facts)))
      return skipped("retention reclaim is not authorized");
    if (!checkoutPath) return skipped("main checkout is not registered");
    if (existsSync(path)) {
      const current = await options.location.readHead(path);
      options.registry.workingCopies.register({
        ticketId,
        projectRepoId: repoId,
        absPath: path,
        branch: current.branch,
        headSha: current.headSha,
        baseBranch:
          registered.baseBranch ?? facts.ticket?.baseBranch ?? facts.primaryRepo.baseBranch,
      });
    }
    const result = await reclaimExplicit(
      {
        gitAsync: options.gitAsync,
        ...(options.busySites === undefined ? {} : { busySites: options.busySites }),
        ...(options.releaseAgentSites === undefined
          ? {}
          : { releaseAgentSites: options.releaseAgentSites }),
      },
      {
        checkoutPath,
        worktreePath: path,
        baseBranch:
          registered.baseBranch ?? facts.ticket?.baseBranch ?? facts.primaryRepo.baseBranch,
        keep: facts.ticket?.retentionKeep !== false,
      },
    );
    if (!result.ok) {
      log.warn("Working copy reclaim refused", { jobId: job.id, reason: result.error });
      return skipped("Working copy is busy or not safe to reclaim.");
    }
    const report = await options.location.report(worktreeFacts, path, "reclaimed");
    return { status: "done", result: { kind: "reclaimed", workingCopy: report } };
  };
  for (const kind of [
    "workingCopy.materialize",
    "workingCopy.trim",
    "workingCopy.reclaim",
    "workingCopy.refresh",
  ] as const)
    worker.register(kind, async (claimed, context) => {
      try {
        return await execute(claimed, context);
      } catch (error) {
        log.warn("Working copy job failed", { jobId: claimed.job.id, error });
        return failed(
          "working_copy_failed",
          "This Working copy job could not run on this runner. See this runner's log.",
          !context.signal.aborted,
        );
      }
    });
}
