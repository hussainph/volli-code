import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { nextScheduleOccurrence } from "@volli/shared";
import { createHostAutomationServices } from "./automation-services";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import { insertProject } from "./db/projects-repo";
import { listSkippedOccurrencesForProject } from "./db/automations-repo";

let ctx: TestDb | undefined;
afterEach(() => {
  vi.useRealTimers();
  ctx?.cleanup();
  ctx = undefined;
});

it("keeps CRUD and the unattended schedule alive without a window or attention adapter", async () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 9, 4, 12);
  vi.setSystemTime(now);
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const publish = vi.fn();
  const services = createHostAutomationServices(ctx.db, { events: { publish } });
  const engine = services.createEngine()!;
  const changed = vi.fn();
  const service = services.createService(engine, { onAutomationsChanged: changed })!;
  const schedule = { preset: "hourly" as const, minute: 30, timeZone: "UTC" };
  const created = await service.create({
    commandId: randomUUID(),
    projectId: project.id,
    name: "Headless sweep",
    instructions: "Check the project",
    trigger: { kind: "schedule", schedule },
    runtime: { kind: "tier", tier: "fast" },
  });
  if (!created.ok) throw new Error(created.error);
  await service.setEnabled({
    commandId: randomUUID(),
    automationId: created.automation.id,
    enabled: true,
  });
  expect(changed).toHaveBeenCalled();
  expect(publish).toHaveBeenCalledWith("data-changed", { projectId: project.id });

  const runner = services.createRunner({
    engine,
    sessions: { create: vi.fn(), attach: vi.fn() },
    promptSupply: vi.fn(),
    deliverInstructions: vi.fn(),
    reportInstructionDeliveryFailure: vi.fn(),
    readSessionActivity: vi.fn(),
  })!;
  const run = vi.spyOn(runner, "runForProject").mockResolvedValue({
    ok: false,
    code: "RUN_FAILED",
    error: "No executor attached",
  });
  const scheduler = services.createScheduler(engine, runner)!;
  try {
    await scheduler.start();
    const due = nextScheduleOccurrence({ schedule, staggerKey: created.automation.id, after: now });
    await vi.advanceTimersByTimeAsync(due - now);
    await scheduler.settled();
    expect(run).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String),
      automationId: created.automation.id,
      projectId: project.id,
      attendance: "unattended",
    });
    expect(listSkippedOccurrencesForProject(ctx.db, project.id)).toHaveLength(1);
  } finally {
    scheduler.stop();
  }
  const pending = services.createPendingArmedRuns(() => null)!;
  pending.start();
  pending.stop();
  expect(pending.list()).toEqual([]);
});

it("does not construct a ledger or timer when the database is degraded", () => {
  const services = createHostAutomationServices(null, { events: { publish: vi.fn() } });
  expect(services.createEngine()).toBeNull();
  expect(services.createService(null, {})).toBeNull();
  expect(services.createPendingArmedRuns(() => null)).toBeNull();
});
