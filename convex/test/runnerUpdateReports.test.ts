import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import {
  RUNNER_HTTP_PATHS,
  RUNNER_TOKEN_ISSUER,
  RUNNER_UPDATE_REASON_MAX,
  parseRunnerLinkGrant,
  runnerSubject,
  type RunnerHostFacts,
  type RunnerId,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { REPORT_CLOCK_SKEW_MS, REPORT_DEDUP_WINDOW } from "../functions/runnerUpdateReports";
import schema from "../functions/schema";
import { enrollPreview } from "./preview-fixtures";

const modules = import.meta.glob("../functions/**/*.ts");
const ALICE = { subject: "user:alice", issuer: "https://issuer.test" };
const HOST: RunnerHostFacts = {
  hostname: "hetzner-1.example.com",
  platform: { os: "linux", distro: "debian 12", kernel: "6.1.0", arch: "x64", glibc: "2.36" },
  installMode: "system",
};

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

async function linkedRunner(t: T) {
  const userId = (await t.withIdentity(ALICE).mutation(api.accounts.ensureViewer, {})).userId;
  await enrollPreview(t, userId);
  const { installToken } = await t
    .withIdentity(ALICE)
    .action(api.runners.createInstallToken, { nameHint: null, defaultWorkspaceId: null });
  const response = await t.fetch(RUNNER_HTTP_PATHS.link, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ installToken, host: HOST, name: null }),
  });
  expect(response.status).toBe(200);
  const { runnerId } = parseRunnerLinkGrant(await response.json());
  const runner = t.withIdentity({
    issuer: RUNNER_TOKEN_ISSUER,
    subject: runnerSubject(runnerId as RunnerId),
    gen: 1,
  });
  return { runnerId, runner };
}

async function stored(t: T, runnerId: string) {
  return t.run(async (ctx) => ({
    runner: await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique(),
    events: (
      await ctx.db
        .query("runnerEvents")
        .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
        .collect()
    ).filter((event) => event.kind !== "linked"),
  }));
}

const REPORT = {
  outcomeId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  kind: "update_failed" as const,
  version: "0.4.0",
  fromVersion: "0.3.0",
  reason: "health_timeout",
  at: Date.now(),
};

describe("runner update reports", () => {
  test("records an outcome as a runner event and the runner's update", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await expect(runner.mutation(api.runnerUpdateReports.report, REPORT)).resolves.toEqual({
      recorded: true,
    });
    const { runner: row, events } = await stored(t, runnerId);
    const { outcomeId, ...update } = REPORT;
    expect(row?.update).toEqual(update);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "update_failed", detail: { outcomeId, ...update } });
  });

  test("is idempotent by outcome id", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await runner.mutation(api.runnerUpdateReports.report, REPORT);
    await expect(runner.mutation(api.runnerUpdateReports.report, REPORT)).resolves.toEqual({
      recorded: false,
    });
    expect((await stored(t, runnerId)).events).toHaveLength(1);
    expect(REPORT_DEDUP_WINDOW).toBeGreaterThan(10);
  });

  test("keeps the newest outcome as the projection when reports arrive out of order", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await runner.mutation(api.runnerUpdateReports.report, {
      ...REPORT,
      outcomeId: "b",
      kind: "rolled_back",
      version: "0.3.0",
      fromVersion: "0.4.0",
      reason: null,
      at: REPORT.at + 1_000,
    });
    await runner.mutation(api.runnerUpdateReports.report, REPORT);
    const { runner: row, events } = await stored(t, runnerId);
    expect(row?.update).toMatchObject({ kind: "rolled_back", at: REPORT.at + 1_000 });
    expect(events.map((event) => event.kind).toSorted()).toEqual(["rolled_back", "update_failed"]);
  });

  test("replaces a projection that is not one of its own", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", runnerId))
        .unique();
      await ctx.db.patch(row!._id, { update: { legacy: true } });
    });
    await runner.mutation(api.runnerUpdateReports.report, REPORT);
    expect((await stored(t, runnerId)).runner?.update).toMatchObject({ kind: "update_failed" });
  });

  test("cuts a long reason and refuses fields out of bounds", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await runner.mutation(api.runnerUpdateReports.report, {
      ...REPORT,
      reason: "x".repeat(RUNNER_UPDATE_REASON_MAX + 50),
    });
    const { runner: row } = await stored(t, runnerId);
    expect((row!.update as { reason: string }).reason).toHaveLength(RUNNER_UPDATE_REASON_MAX);
    for (const bad of [
      { outcomeId: "" },
      { outcomeId: "x".repeat(101) },
      { version: "1".repeat(101) },
      { fromVersion: "1".repeat(101) },
      { version: "0.4.0 <script>" },
      { at: Number.POSITIVE_INFINITY },
    ]) {
      await expect(
        runner.mutation(api.runnerUpdateReports.report, { ...REPORT, outcomeId: "c", ...bad }),
      ).rejects.toMatchObject({ data: expect.objectContaining({ code: "invalid_request" }) });
    }
  });

  test("does not let a runner's far-off clock pin the projection", async () => {
    const t = setup();
    const { runnerId, runner } = await linkedRunner(t);
    await runner.mutation(api.runnerUpdateReports.report, {
      ...REPORT,
      at: REPORT.at + 10 * REPORT_CLOCK_SKEW_MS,
    });
    const at = ((await stored(t, runnerId)).runner!.update as { at: number }).at;
    expect(at).toBeLessThan(REPORT.at + REPORT_CLOCK_SKEW_MS);
  });

  test("is a runner's call, never a person's", async () => {
    const t = setup();
    await linkedRunner(t);
    await expect(
      t.withIdentity(ALICE).mutation(api.runnerUpdateReports.report, REPORT),
    ).rejects.toMatchObject({ data: expect.objectContaining({ code: "not_a_runner" }) });
  });
});
