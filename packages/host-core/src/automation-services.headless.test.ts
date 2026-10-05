/** The live Automations module over a real ledger, with no window or attention adapter. */
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { nextScheduleOccurrence } from "@volli/shared";
import { createHostAutomations, type AutomationSessionPorts } from "./automation-services";
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
  const log = { error: vi.fn() };
  const automations = createHostAutomations({ db: ctx.db, events: { publish }, log });
  const schedule = { preset: "hourly" as const, minute: 30, timeZone: "UTC" };
  const created = await automations.service.create({
    commandId: randomUUID(),
    projectId: project.id,
    name: "Headless sweep",
    instructions: "Check the project",
    trigger: { kind: "schedule", schedule },
    runtime: { kind: "tier", tier: "fast" },
  });
  if (!created.ok) throw new Error(created.error);
  await automations.service.setEnabled({
    commandId: randomUUID(),
    automationId: created.automation.id,
    enabled: true,
  });
  expect(publish).toHaveBeenCalledWith("data-changed", { projectId: project.id });

  const ports: AutomationSessionPorts = {
    sessions: { create: vi.fn(), attach: vi.fn() },
    promptSupply: vi.fn(),
    deliverInstructions: vi.fn(),
    reportInstructionDeliveryFailure: vi.fn(),
    readSessionActivity: vi.fn(),
  };
  automations.start(() => ports);
  const execution = automations.execution;
  if (execution.kind !== "ready") throw new Error("Automations did not start.");
  const runner = execution.runner;
  const run = vi.spyOn(runner, "runForProject").mockResolvedValue({
    ok: false,
    code: "RUN_FAILED",
    error: "No executor attached",
  });
  try {
    expect(execution.pendingArmedRuns.list()).toEqual([]);
    const due = nextScheduleOccurrence({ schedule, staggerKey: created.automation.id, after: now });
    await vi.advanceTimersByTimeAsync(due - now);
    await vi.waitFor(() =>
      expect(listSkippedOccurrencesForProject(ctx!.db, project.id)).toHaveLength(1),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith({
      commandId: expect.any(String),
      automationId: created.automation.id,
      projectId: project.id,
      attendance: "unattended",
    });
    expect(log.error).not.toHaveBeenCalled();
  } finally {
    automations.stop();
    await automations.settled();
  }
});
