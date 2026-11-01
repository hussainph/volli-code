/**
 * A runner's own update outcomes (n3 §9.2): staged, applied, failed, rolled
 * back. The runner's update agent (`apps/runner/src/update/agent.ts`) sends
 * each outcome its updater recorded, once, and again until it hears back, so
 * `report` is idempotent by `outcomeId`.
 *
 * Each report becomes a `runnerEvents` row of its `kind` (the audit trail
 * Settings → Runners and support read) and, when it is the newest, the
 * runner's `update` projection: `{ kind, version, fromVersion, reason, at }`,
 * which `runners.list` exposes. Whether a runner may claim work is not
 * decided here: the version floor in `heartbeat` and `runnerJobs.claim` does
 * that from the version the runner reports.
 */
import { ConvexError, v } from "convex/values";

import {
  RUNNER_UPDATE_OUTCOME_KINDS,
  RUNNER_UPDATE_REASON_MAX,
  type RunnerUpdateReport,
} from "@volli/shared/cloud";

import { mutation } from "./_generated/server";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import { literals, nullable } from "./lib/validators";

/** How far back a retry is matched against reports already recorded. */
export const REPORT_DEDUP_WINDOW = 100;
/** A runner's clock is believed this far from ours; beyond it, ours is used. */
export const REPORT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD = 100;
const VERSION = /^[0-9A-Za-z.+-]{1,100}$/u;

function invalid(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "invalid_request", message });
}

export const report = mutation({
  args: {
    outcomeId: v.string(),
    kind: literals(RUNNER_UPDATE_OUTCOME_KINDS),
    version: v.string(),
    fromVersion: nullable(v.string()),
    reason: nullable(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args): Promise<{ recorded: boolean }> => {
    const { runner } = await requireRunnerForWrite(ctx);
    if (
      args.outcomeId.length === 0 ||
      args.outcomeId.length > MAX_FIELD ||
      !VERSION.test(args.version) ||
      (args.fromVersion !== null && !VERSION.test(args.fromVersion)) ||
      !Number.isFinite(args.at)
    ) {
      throw invalid("An update report's fields are out of bounds.");
    }
    const recent = await ctx.db
      .query("runnerEvents")
      .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
      .order("desc")
      .take(REPORT_DEDUP_WINDOW);
    if (
      recent.some(
        (event) => (event.detail as { outcomeId?: unknown } | null)?.outcomeId === args.outcomeId,
      )
    ) {
      return { recorded: false };
    }
    const now = Date.now();
    // A runner whose clock is far off cannot pin the projection to the future.
    const at = Math.abs(args.at - now) > REPORT_CLOCK_SKEW_MS ? now : args.at;
    const update: Omit<RunnerUpdateReport, "outcomeId"> = {
      kind: args.kind,
      version: args.version,
      fromVersion: args.fromVersion,
      reason: args.reason === null ? null : args.reason.slice(0, RUNNER_UPDATE_REASON_MAX),
      at,
    };
    await ctx.db.insert("runnerEvents", {
      runnerId: runner.id,
      kind: args.kind,
      at: now,
      detail: { outcomeId: args.outcomeId, ...update },
    });
    // Retries arrive out of order: only a newer outcome replaces the projection.
    const shown = runner.update as { at?: unknown } | null;
    if (shown === null || typeof shown.at !== "number" || shown.at <= at) {
      await ctx.db.patch(runner._id, { update });
    }
    return { recorded: true };
  },
});
