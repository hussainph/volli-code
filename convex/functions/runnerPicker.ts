/**
 * The composer's runner picker (C2): which of the person's runners a new
 * Session in a project can start on, and which one it goes to unless they
 * pick another.
 *
 * Runners are personal: the answer is the caller's own runners, never a
 * teammate's. A runner cut off from its account (removed, replaced, its
 * credential reused) is left out: nothing can start there. Settings' list
 * (`runners.list`) still shows one cut off by credential reuse, to explain it.
 * `providers` are the credentials the runner last reported, expired or not:
 * a query does not read the clock, and the runner reports again on change. Each row carries
 * its status (a sleeping runner still takes work; the Session waits for it),
 * its power (C1, read tolerantly), the providers signed in on it (so the
 * composer offers only models it can serve) and whether it needs an update.
 *
 * The default rule's server half is {@link preferredRunnerId}; the client
 * finishes it with `composerDefaultRunnerId`, since only the client knows
 * whether the machine it runs on is one of these runners.
 */

import { v } from "convex/values";

import {
  preferredRunnerId,
  runnerPowerOf,
  type RunnerId,
  type RunnerPickerAnswer,
  type RunnerPickerRow,
} from "@volli/shared/cloud";

import { query } from "./_generated/server";
import { requireProject } from "./lib/auth";

export const forComposer = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }): Promise<RunnerPickerAnswer> => {
    const { viewer } = await requireProject(ctx, projectId);
    const owned = await ctx.db
      .query("runners")
      .withIndex("by_owner_name", (q) => q.eq("ownerUserId", viewer.userId))
      .collect();
    const runners: RunnerPickerRow[] = [];
    for (const runner of owned) {
      if (runner.status === "revoked" || runner.revokedAt !== null) continue;
      const credentials = await ctx.db
        .query("runnerLocalCredentials")
        .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
        .collect();
      runners.push({
        id: runner.id as RunnerId,
        name: runner.name,
        kind: runner.kind,
        status: runner.status,
        statusChangedAt: runner.statusChangedAt,
        power: runnerPowerOf(runner.capabilities),
        providers: [...new Set(credentials.map((credential) => credential.providerId))].toSorted(),
        version: runner.version,
        upgradeRequired: runner.status === "upgrade_required",
      });
    }
    return { runners, defaultRunnerId: preferredRunnerId(runners) };
  },
});
