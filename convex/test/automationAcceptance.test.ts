import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { newId } from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { boardFixture, seedRunner, setup } from "./board-helpers";

const NOW = Date.parse("2026-03-07T12:00:00Z");
const FIRST = Date.parse("2026-03-07T10:17:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("VOLLI_TEST_JWKS", "data:test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function armedSchedule() {
  const t = setup();
  const owner = await boardFixture(t);
  const runnerId = await seedRunner(t, owner.userId);
  await t.run(async (ctx) => {
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(runner!._id, { capabilities: { tools: ["automation.run"] } });
  });
  const automationId = newId("automation");
  await owner.as.mutation(api.automations.create, {
    commandId: newId("command"),
    projectId: owner.projectId,
    automationId,
    name: "Clock fixture",
    instructions: "Test",
    runtime: null,
    trigger: { kind: "schedule", schedule: { preset: "hourly", minute: 17, timeZone: "UTC" } },
  });
  await owner.as.mutation(api.automations.armSchedule, {
    commandId: newId("command"),
    automationId,
    runnerId,
  });
  await t.run(async (ctx) => {
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(runner!._id, { status: "asleep" });
  });
  return { t, automationId, runnerId };
}

test("the guarded acceptance hook fires distinct due instants through the real clock atomically", async () => {
  const w = await armedSchedule();
  const { first, second, firstDueAt, secondDueAt } = await w.t.mutation(
    internal.testAutomations.coalescePastOccurrences,
    { automationId: w.automationId, firstDueAt: FIRST },
  );
  expect(firstDueAt).toBe(FIRST);
  expect(secondDueAt).toBe(FIRST + 3_600_000);
  expect(first.runs).toHaveLength(1);
  expect(first.runs[0]).toMatchObject({ status: "queued", dueAt: firstDueAt });
  expect(first.jobs[0]!.payload).toMatchObject({ missedCount: 0, dueAt: firstDueAt });
  expect(second.runs).toHaveLength(2);
  expect(second.runs.find((row) => row.status === "queued")).toMatchObject({
    id: first.runs[0]!.id,
    dueAt: secondDueAt,
  });
  expect(second.runs.find((row) => row.status === "skipped")).toMatchObject({
    dueAt: firstDueAt,
    missedCount: 1,
  });
  expect(second.jobs).toHaveLength(1);
  expect(second.jobs[0]).toMatchObject({
    id: first.jobs[0]!.id,
    status: "queued",
    lease: null,
    availableAt: secondDueAt,
  });
  expect(second.jobs[0]!.payload).toMatchObject({ missedCount: 1, dueAt: secondDueAt });
  expect(second.schedule!.nextFireAt).toBeGreaterThan(NOW);
  expect(second.jobs[0]!.availableAt).toBeLessThanOrEqual(NOW);
});

test("the hook refuses a deployment without the test issuer", async () => {
  const w = await armedSchedule();
  vi.stubEnv("VOLLI_TEST_JWKS", "");
  await expect(
    w.t.mutation(internal.testAutomations.coalescePastOccurrences, {
      automationId: w.automationId,
      firstDueAt: FIRST,
    }),
  ).rejects.toThrow("only on a test deployment");
});

test.each([FIRST + 1, FIRST - 3_600_000, NOW + 3_600_000])(
  "the hook refuses a non-occurrence or an interval other than the last two due instants: %s",
  async (firstDueAt) => {
    const w = await armedSchedule();
    await expect(
      w.t.mutation(internal.testAutomations.coalescePastOccurrences, {
        automationId: w.automationId,
        firstDueAt,
      }),
    ).rejects.toThrow("last two distinct past occurrences");
    const state = await w.t.mutation(internal.testAutomations.inspectSchedule, {
      automationId: w.automationId,
    });
    expect(state.runs).toEqual([]);
  },
);
