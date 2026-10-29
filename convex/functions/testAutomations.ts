/**
 * Test-only hooks into the Automation clock for the fixture backend
 * (`test:backend`). Internal, so only an admin key can call them, and each
 * refuses to run on a deployment that does not trust the test issuer
 * (`VOLLI_TEST_JWKS`), which no cloud deployment may set.
 *
 * - `scheduleOccurrences` runs the shared `nextScheduleOccurrence` inside the
 *   deployed runtime, so a test can compare its time-zone answers with Node's
 *   (the clock computes `nextFireAt` only here, never on a client).
 * - `fireDueAt` runs one clock pass as if it were `now`, so an acceptance can
 *   pass schedule occurrences without waiting for them.
 */

import { v } from "convex/values";
import {
  nextScheduleOccurrence,
  parseAutomationSchedule,
  type AutomationSchedule,
} from "@volli/shared";

import { internalMutation, type MutationCtx } from "./_generated/server";
import { fireDuePage, fireSchedule } from "./lib/automationClock";

function requireTestDeployment(): void {
  let trusted: string | undefined;
  try {
    trusted = process.env["VOLLI_TEST_JWKS"];
  } catch {
    trusted = undefined;
  }
  if (!trusted) throw new Error("Test hooks run only on a test deployment.");
}

export const scheduleOccurrences = internalMutation({
  args: {
    cases: v.array(v.object({ schedule: v.any(), staggerKey: v.string(), after: v.number() })),
  },
  handler: async (_ctx, { cases }) => {
    requireTestDeployment();
    return {
      // What the runtime's own ICU says, for a readable failure if it lacks zone data.
      icu: {
        resolvedZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        supportedZones:
          typeof Intl.supportedValuesOf === "function"
            ? Intl.supportedValuesOf("timeZone").length
            : null,
      },
      occurrences: cases.map(({ schedule, staggerKey, after }) => {
        try {
          return nextScheduleOccurrence({
            schedule: schedule as AutomationSchedule,
            staggerKey,
            after,
          });
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }),
    };
  },
});

/** One clock page as if it were `now` (which may be ahead of the clock): test passes only. */
export const fireDueAt = internalMutation({
  args: { now: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { now, cursor }) => {
    requireTestDeployment();
    return fireDuePage(ctx, { now, cursor: cursor ?? null });
  },
});

/** Makes a runner live and advertise the Automation executor, as a 0.3 desktop reports. */
export const advertiseExecutor = internalMutation({
  args: { runnerId: v.string() },
  handler: async (ctx, { runnerId }) => {
    requireTestDeployment();
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    if (runner === null) throw new Error("No such runner.");
    await ctx.db.patch(runner._id, {
      status: "online",
      capabilities: { tools: ["automation.run"] },
    });
  },
});

/** Moves an armed schedule's cursor into the past, as if its time had come while nobody looked. */
export const backdateSchedule = internalMutation({
  args: { automationId: v.string(), nextFireAt: v.number() },
  handler: async (ctx, { automationId, nextFireAt }) => {
    requireTestDeployment();
    const row = await ctx.db
      .query("automationSchedules")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .unique();
    if (row === null) throw new Error("No such schedule.");
    await ctx.db.patch(row._id, { nextFireAt });
  },
});

function strip<T extends { _id: unknown; _creationTime: number }>(row: T) {
  const { _id, _creationTime, ...fields } = row;
  void _id;
  void _creationTime;
  return fields;
}

async function scheduleState(ctx: Pick<MutationCtx, "db">, automationId: string) {
  const schedule = await ctx.db
    .query("automationSchedules")
    .withIndex("by_automation", (q) => q.eq("automationId", automationId))
    .unique();
  const runs = await ctx.db
    .query("automationRuns")
    .withIndex("by_automation", (q) => q.eq("automationId", automationId))
    .collect();
  const jobs = [];
  for (const run of runs) {
    if (run.jobId == null) continue;
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", run.jobId!))
      .unique();
    if (job !== null) jobs.push(strip(job));
  }
  return {
    schedule: schedule === null ? null : strip(schedule),
    runs: runs.map(strip),
    jobs,
  };
}

/** One schedule's row, its Run rows and its jobs, for assertions. */
export const inspectSchedule = internalMutation({
  args: { automationId: v.string() },
  handler: async (ctx, { automationId }) => {
    requireTestDeployment();
    return scheduleState(ctx, automationId);
  },
});

/** Two DISTINCT past occurrences through the real clock, in one transaction.
 * Atomic only to keep the live minute cron from advancing the second cursor
 * between assertions. Jobs remain honestly due on the real clock at wake. */
export const coalescePastOccurrences = internalMutation({
  args: { automationId: v.string(), firstDueAt: v.number() },
  handler: async (ctx, { automationId, firstDueAt }) => {
    requireTestDeployment();
    const row = await ctx.db
      .query("automationSchedules")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .unique();
    if (row === null || row.pausedAt != null) throw new Error("An unpaused schedule is required.");
    const spec = parseAutomationSchedule(row.spec);
    if (spec === null) throw new Error("No readable schedule.");
    const occurrence = (after: number) =>
      nextScheduleOccurrence({
        schedule: { ...spec, timeZone: row.timezone },
        staggerKey: automationId,
        after,
      });
    const secondDueAt = occurrence(firstDueAt);
    if (
      !Number.isFinite(firstDueAt) ||
      occurrence(firstDueAt - 1) !== firstDueAt ||
      secondDueAt > Date.now() ||
      occurrence(secondDueAt) <= Date.now()
    ) {
      throw new Error("Choose the last two distinct past occurrences.");
    }
    await ctx.db.patch(row._id, { nextFireAt: firstDueAt });
    // Convex permits only one paginated query per function. Use the clock's
    // SAME per-row executor twice, rereading its cursor/pointers after the
    // first write; do not invoke the paginated fireDuePage twice here.
    const firstRow = (await ctx.db.get(row._id))!;
    if (!(await fireSchedule(ctx, firstRow, firstDueAt)))
      throw new Error("The first occurrence did not fire.");
    const first = await scheduleState(ctx, automationId);
    const secondRow = (await ctx.db.get(row._id))!;
    if (secondRow.nextFireAt !== secondDueAt || !(await fireSchedule(ctx, secondRow, secondDueAt)))
      throw new Error("The second occurrence did not fire.");
    const second = await scheduleState(ctx, automationId);
    return { first, second, firstDueAt, secondDueAt };
  },
});
