/** The live Automations module's wiring and its start/stop ownership (VC-627). */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { displayTicketId } from "@volli/shared";
import {
  createHostAutomations,
  type AutomationSessionPorts,
  type HostAutomationsInput,
} from "./automation-services";
import { createAutomationEngine } from "./automations/engine";
import { createAutomationService, type AutomationServicePorts } from "./automations/service";
import { createAutomationRunner, type AutomationRunnerPorts } from "./automations/run";
import { createAutomationScheduler, type AutomationSchedulerPorts } from "./automations/scheduler";
import {
  createPendingArmedRunCoordinator,
  type PendingArmedRunCoordinatorPorts,
} from "./automations/pending-armed-runs";
import { SqliteAutomationLedger } from "./automations/sqlite-ledger";
import { enabledAutomationIds } from "./automations/enablement";
import {
  advanceScheduleCursor,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "./automations/schedule-cursor";
import { getProjectById } from "./db/projects-repo";
import { getTicket, getTicketRow } from "./db/tickets-repo";
import {
  getAutomation,
  getAutomationRun,
  listAllAutomations,
  listAutomationsForProject,
  listColumnArmings,
  listProjectRunsForAutomation,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForAutomation,
  listSkippedOccurrencesForProject,
} from "./db/automations-repo";
import {
  beginPendingArmedRunAttempt,
  deletePendingArmedRun,
  deletePendingArmedRunAttempt,
  deletePendingArmedRunForTicket,
  getPendingArmedRun,
  getPendingArmedRunAttempt,
  listPendingArmedRunAttempts,
  listPendingArmedRuns,
  putPendingArmedRun,
  updatePendingArmedRunAttemptError,
} from "./db/pending-armed-runs-repo";

vi.mock("./automations/engine", () => ({ createAutomationEngine: vi.fn() }));
vi.mock("./automations/service", () => ({ createAutomationService: vi.fn() }));
vi.mock("./automations/run", () => ({ createAutomationRunner: vi.fn() }));
vi.mock("./automations/scheduler", () => ({ createAutomationScheduler: vi.fn() }));
vi.mock("./automations/pending-armed-runs", () => ({
  createPendingArmedRunCoordinator: vi.fn(),
}));
vi.mock("./automations/sqlite-ledger", () => ({
  SqliteAutomationLedger: vi.fn(function (this: { db: unknown }, db: unknown) {
    this.db = db;
  }),
}));
vi.mock("./automations/enablement");
vi.mock("./automations/schedule-cursor");
vi.mock("./db/projects-repo");
vi.mock("./db/tickets-repo");
vi.mock("./db/automations-repo");
vi.mock("./db/pending-armed-runs-repo");

const db = { name: "live" } as unknown as Database.Database;

function fixture(over: Partial<HostAutomationsInput> = {}) {
  const order: string[] = [];
  const engine = {
    enabledAutomationIds: vi.fn(async () => ["a1"]),
    recordSkip: vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true })),
  };
  const service = { kind: "service" };
  const runner = {
    run: vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true })),
    runForProject: vi.fn(async (_input: unknown): Promise<unknown> => ({ ok: true })),
    recover: vi.fn(async () => {
      order.push("runner.recover");
    }),
    settled: vi.fn(async () => {}),
  };
  const pending = {
    start: vi.fn(() => order.push("pending.start")),
    stop: vi.fn(() => order.push("pending.stop")),
    settled: vi.fn(async () => {}),
  };
  const scheduler = {
    start: vi.fn(async () => {
      order.push("scheduler.start");
    }),
    refresh: vi.fn(async () => {}),
    stop: vi.fn(() => order.push("scheduler.stop")),
    settled: vi.fn(async () => {}),
  };
  vi.mocked(createAutomationEngine).mockReturnValue(engine as never);
  vi.mocked(createAutomationService).mockReturnValue(service as never);
  vi.mocked(createAutomationRunner).mockImplementation(() => {
    order.push("createRunner");
    return runner as never;
  });
  vi.mocked(createPendingArmedRunCoordinator).mockImplementation(() => {
    order.push("createPending");
    return pending as never;
  });
  vi.mocked(createAutomationScheduler).mockImplementation(() => {
    order.push("createScheduler");
    return scheduler as never;
  });
  const publish = vi.fn();
  const log = { error: vi.fn() };
  const automations = createHostAutomations({ db, events: { publish }, log, ...over });
  const sessionPorts = {
    sessions: { create: vi.fn(), attach: vi.fn() },
    promptSupply: vi.fn(),
    deliverInstructions: vi.fn(),
    reportInstructionDeliveryFailure: vi.fn(),
    readSessionActivity: vi.fn(),
  } as unknown as AutomationSessionPorts;
  return {
    automations,
    order,
    engine,
    service,
    runner,
    pending,
    scheduler,
    publish,
    log,
    sessionPorts,
    serviceDeps: () =>
      vi.mocked(createAutomationService).mock.calls[0]![0] as AutomationServicePorts,
    runnerDeps: () => vi.mocked(createAutomationRunner).mock.calls[0]![0] as AutomationRunnerPorts,
    pendingDeps: () =>
      vi.mocked(createPendingArmedRunCoordinator).mock
        .calls[0]![0] as PendingArmedRunCoordinatorPorts,
    schedulerPorts: () =>
      vi.mocked(createAutomationScheduler).mock.calls[0]![0] as AutomationSchedulerPorts,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("construction", () => {
  it("builds one engine over the database's ledger and a live CRUD service, and nothing armed", () => {
    const f = fixture();
    expect(SqliteAutomationLedger).toHaveBeenCalledExactlyOnceWith(db);
    expect(createAutomationEngine).toHaveBeenCalledExactlyOnceWith({
      ledger: expect.objectContaining({ db }),
      now: Date.now,
      nextId: randomUUID,
    });
    expect(f.automations.service).toBe(f.service);
    expect(f.serviceDeps().engine).toBe(f.engine);
    expect(f.serviceDeps()).not.toHaveProperty("inspectModelAccess");
    expect(f.automations.execution).toEqual({ kind: "idle" });
    expect(createAutomationRunner).not.toHaveBeenCalled();
    expect(createPendingArmedRunCoordinator).not.toHaveBeenCalled();
    expect(createAutomationScheduler).not.toHaveBeenCalled();
  });

  it("hands the service the model-access inspection only when one is supplied", () => {
    const inspectModelAccess = vi.fn();
    const f = fixture({ inspectModelAccess });
    expect(f.serviceDeps().inspectModelAccess).toBe(inspectModelAccess);
  });

  it("reads the service's projections from the same database", () => {
    const deps = fixture().serviceDeps();
    vi.mocked(getProjectById).mockReturnValueOnce({ id: "p1" } as never);
    expect(deps.findProject("p1")).toBe(true);
    expect(deps.findProject("p2")).toBe(false);
    expect(getProjectById).toHaveBeenCalledWith(db, "p2");
    deps.findAutomation("a1");
    expect(getAutomation).toHaveBeenCalledWith(db, "a1");
    deps.listAutomationsForProject("p1");
    expect(listAutomationsForProject).toHaveBeenCalledWith(db, "p1");
    deps.runsForTicket("t1");
    expect(listRunsForTicket).toHaveBeenCalledWith(db, "t1");
    deps.runsForProject("p1");
    expect(listRunsForProject).toHaveBeenCalledWith(db, "p1");
    deps.skipsForProject("p1");
    expect(listSkippedOccurrencesForProject).toHaveBeenCalledWith(db, "p1");
    const query = { automationId: "a1", projectId: "p1" };
    deps.runsForAutomation(query);
    expect(listProjectRunsForAutomation).toHaveBeenCalledWith(db, query);
    deps.skipsForAutomation(query);
    expect(listSkippedOccurrencesForAutomation).toHaveBeenCalledWith(db, query);
  });

  it("publishes mutations and rebases a schedule cursor at the command's instant", () => {
    const f = fixture();
    f.serviceDeps().onMutation!({ projectId: "p1" });
    expect(f.publish).toHaveBeenCalledWith("data-changed", { projectId: "p1" });
    vi.setSystemTime(5_000);
    f.serviceDeps().rebaseScheduleCursor!("a1", 4_000);
    expect(rebaseScheduleCursor).toHaveBeenCalledWith(
      db,
      { automationId: "a1", through: 4_000 },
      5_000,
    );
  });
});

describe("start and stop", () => {
  it("arms pending, then recovery, then the scheduler, over one runner", () => {
    const f = fixture();
    f.serviceDeps().onAutomationsChanged!();
    f.automations.start(() => f.sessionPorts);
    expect(f.order).toEqual([
      "createRunner",
      "createPending",
      "pending.start",
      "runner.recover",
      "createScheduler",
      "scheduler.start",
    ]);
    expect(f.automations.execution).toEqual({
      kind: "ready",
      runner: f.runner,
      pendingArmedRuns: f.pending,
    });
    expect(f.runnerDeps()).toMatchObject({ ...f.sessionPorts, engine: f.engine });
    expect(f.scheduler.refresh).not.toHaveBeenCalled();
    f.serviceDeps().onAutomationsChanged!();
    expect(f.scheduler.refresh).toHaveBeenCalledOnce();
    f.automations.stop();
    expect(f.order.slice(-2)).toEqual(["pending.stop", "scheduler.stop"]);
  });

  it("arms only the pending Runs when no Session runtime booted", async () => {
    const f = fixture();
    f.automations.start(() => null);
    expect(f.order).toEqual(["createPending", "pending.start"]);
    expect(f.automations.execution).toEqual({ kind: "unavailable", pendingArmedRuns: f.pending });
    f.serviceDeps().onAutomationsChanged!();
    expect(f.scheduler.refresh).not.toHaveBeenCalled();
    await expect(
      f.pendingDeps().run({ commandId: "c1", automationId: "a1", ticketId: "t1" }),
    ).resolves.toEqual({
      ok: false,
      code: "RUN_FAILED",
      error: "The Session runtime is not available this launch.",
    });
    f.automations.stop();
    expect(f.pending.stop).toHaveBeenCalledOnce();
  });

  it("starts once, reads the ports only on the starting call, and refuses starts after stop", () => {
    const f = fixture();
    const refused = vi.fn((): AutomationSessionPorts | null => {
      throw new Error("no recovery proof");
    });
    expect(() => f.automations.start(refused)).toThrow("no recovery proof");
    expect(f.order).toEqual([]);
    f.automations.start(() => f.sessionPorts);
    const later = vi.fn(() => f.sessionPorts);
    f.automations.start(later);
    expect(later).not.toHaveBeenCalled();
    expect(createAutomationRunner).toHaveBeenCalledOnce();
    f.automations.stop();
    f.automations.start(later);
    expect(later).not.toHaveBeenCalled();

    const early = fixture();
    early.automations.stop();
    const read = vi.fn(() => early.sessionPorts);
    early.automations.start(read);
    expect(read).not.toHaveBeenCalled();
    expect(early.order).toEqual([]);
    expect(early.automations.execution).toEqual({ kind: "idle" });
  });

  it("logs a failed recovery or scheduler start instead of surfacing either", async () => {
    const f = fixture();
    f.runner.recover.mockRejectedValueOnce(new Error("ledger locked"));
    f.scheduler.start.mockRejectedValueOnce(new Error("cursor unreadable"));
    f.automations.start(() => f.sessionPorts);
    await vi.waitFor(() => {
      expect(f.log.error).toHaveBeenCalledWith("automation recovery failed", {
        error: expect.objectContaining({ message: "ledger locked" }),
      });
      expect(f.log.error).toHaveBeenCalledWith("automation scheduler could not start", {
        error: expect.objectContaining({ message: "cursor unreadable" }),
      });
    });
  });
});

describe("writer drain", () => {
  it("joins recovery and timer attempts before the runner's final boot snapshot", async () => {
    const f = fixture();
    const recovery = Promise.withResolvers<void>();
    const armed = Promise.withResolvers<void>();
    const scheduled = Promise.withResolvers<void>();
    const boot = Promise.withResolvers<void>();
    f.runner.recover.mockReturnValueOnce(recovery.promise);
    f.pending.settled.mockReturnValueOnce(armed.promise);
    f.scheduler.settled.mockReturnValueOnce(scheduled.promise);
    f.runner.settled.mockReturnValueOnce(boot.promise);
    f.automations.start(() => f.sessionPorts);
    f.automations.stop();
    let drained = false;
    const drain = f.automations.settled().then(() => {
      drained = true;
    });
    recovery.resolve();
    armed.resolve();
    await Promise.resolve();
    expect(f.runner.settled).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    scheduled.resolve();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(f.runner.settled).toHaveBeenCalledOnce();
    expect(drained).toBe(false);
    boot.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("settles unstarted and runtime-unavailable variants without inventing a runner", async () => {
    const idle = fixture();
    idle.automations.stop();
    await idle.automations.settled();
    expect(idle.runner.settled).not.toHaveBeenCalled();
    const unavailable = fixture();
    unavailable.automations.start(() => null);
    unavailable.automations.stop();
    await unavailable.automations.settled();
    expect(unavailable.pending.settled).toHaveBeenCalledOnce();
    expect(unavailable.runner.settled).not.toHaveBeenCalled();
  });
});

describe("runner wiring", () => {
  it("reads the ledger from the database and announces a started Run without a missing ticket", () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const deps = f.runnerDeps();
    deps.findAutomation("a1");
    expect(getAutomation).toHaveBeenCalledWith(db, "a1");
    deps.findRun("r1");
    expect(getAutomationRun).toHaveBeenCalledWith(db, "r1");
    deps.findTicket("t1");
    expect(getTicket).toHaveBeenCalledWith(db, "t1");
    vi.mocked(getProjectById).mockReturnValueOnce({ id: "p1" } as never);
    expect(deps.findProject("p1")).toBe(true);
    expect(deps.findProject("p2")).toBe(false);
    deps.listRunsForTicket("t1");
    expect(listRunsForTicket).toHaveBeenCalledWith(db, "t1");
    const query = { automationId: "a1", projectId: "p1" };
    deps.listProjectRunsForAutomation(query);
    expect(listProjectRunsForAutomation).toHaveBeenCalledWith(db, query);

    deps.onRunStarted!({ projectId: "p1", run: { ticketId: null } as never });
    expect(f.publish).toHaveBeenLastCalledWith("data-changed", { projectId: "p1" });
    expect(f.publish.mock.lastCall![1]).not.toHaveProperty("ticketId");
    deps.onRunStarted!({ projectId: "p1", run: { ticketId: "t1" } as never });
    expect(f.publish).toHaveBeenLastCalledWith("data-changed", {
      projectId: "p1",
      ticketId: "t1",
    });
  });
});

describe("pending armed Run wiring", () => {
  it("delegates its durable rows to the database", () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const deps = f.pendingDeps();
    expect(deps.now).toBe(Date.now);
    expect(deps.nextId).toBe(randomUUID);
    deps.listPending();
    expect(listPendingArmedRuns).toHaveBeenCalledWith(db);
    deps.getPending("x");
    expect(getPendingArmedRun).toHaveBeenCalledWith(db, "x");
    const armed = { id: "x" } as never;
    deps.putPending(armed);
    expect(putPendingArmedRun).toHaveBeenCalledWith(db, armed);
    deps.deletePending("x");
    expect(deletePendingArmedRun).toHaveBeenCalledWith(db, "x");
    deps.deletePendingForTicket("t1");
    expect(deletePendingArmedRunForTicket).toHaveBeenCalledWith(db, "t1");
    deps.beginAttempt("x", "c1", "fallback");
    expect(beginPendingArmedRunAttempt).toHaveBeenCalledWith(db, "x", "c1", "fallback");
    deps.listAttempts();
    expect(listPendingArmedRunAttempts).toHaveBeenCalledWith(db);
    deps.getAttempt("x");
    expect(getPendingArmedRunAttempt).toHaveBeenCalledWith(db, "x");
    deps.updateAttemptError("x", "boom");
    expect(updatePendingArmedRunAttemptError).toHaveBeenCalledWith(db, "x", "boom");
    deps.deleteAttempt("x");
    expect(deletePendingArmedRunAttempt).toHaveBeenCalledWith(db, "x");
    vi.mocked(listAutomationsForProject).mockReturnValueOnce(["auto"] as never);
    vi.mocked(listColumnArmings).mockReturnValueOnce(["arming"] as never);
    vi.mocked(enabledAutomationIds).mockReturnValueOnce(["a1"]);
    expect(deps.readPlanning("p1")).toEqual({
      automations: ["auto"],
      armings: ["arming"],
      enabledAutomationIds: ["a1"],
    });
    expect(listColumnArmings).toHaveBeenCalledWith(db, "p1");
    expect(enabledAutomationIds).toHaveBeenCalledWith(db);
  });

  it("reads a ticket only while it, its row and its project are all live", () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const { readTicket } = f.pendingDeps();
    const row = { archived_at: null, project_id: "p1" } as never;
    const ticket = { projectId: "p1", status: "doing", ticketNumber: 7 } as never;
    const project = { ticketPrefix: "VC" } as never;
    expect(readTicket("t1")).toBeUndefined();
    vi.mocked(getTicketRow).mockReturnValueOnce({ archived_at: 1, project_id: "p1" } as never);
    expect(readTicket("t1")).toBeUndefined();
    vi.mocked(getTicketRow).mockReturnValueOnce(row);
    vi.mocked(getProjectById).mockReturnValueOnce(project);
    expect(readTicket("t1")).toBeUndefined();
    vi.mocked(getTicketRow).mockReturnValueOnce(row);
    vi.mocked(getTicket).mockReturnValueOnce(ticket);
    expect(readTicket("t1")).toBeUndefined();
    expect(getProjectById).toHaveBeenLastCalledWith(db, "p1");
    vi.mocked(getTicketRow).mockReturnValueOnce(row);
    vi.mocked(getTicket).mockReturnValueOnce(ticket);
    vi.mocked(getProjectById).mockReturnValueOnce(project);
    expect(readTicket("t1")).toEqual({
      projectId: "p1",
      status: "doing",
      displayId: displayTicketId("VC", 7),
    });
    expect(getTicketRow).toHaveBeenCalledWith(db, "t1");
  });

  it("runs an expired arrival attended through the armed runner", async () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const outcome = { ok: true, run: {} };
    f.runner.run.mockResolvedValueOnce(outcome);
    await expect(
      f.pendingDeps().run({ commandId: "c1", automationId: "a1", ticketId: "t1" }),
    ).resolves.toBe(outcome);
    expect(f.runner.run).toHaveBeenCalledExactlyOnceWith({
      commandId: "c1",
      target: { kind: "automation", automationId: "a1" },
      ticketId: "t1",
      modelOverride: null,
      attendance: "attended",
    });
  });

  it("owns real timers, publishes changes and settlements, and logs to the host log", () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const deps = f.pendingDeps();
    const fire = vi.fn();
    deps.setTimer(100, fire);
    vi.advanceTimersByTime(100);
    expect(fire).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    deps.clearTimer(deps.setTimer(100, cancelled));
    vi.advanceTimersByTime(200);
    expect(cancelled).not.toHaveBeenCalled();
    deps.onPendingChanged!([]);
    expect(f.publish).toHaveBeenCalledWith("pending-armed-runs-changed", []);
    const notice = { kind: "started" } as never;
    deps.onSettled!(notice);
    expect(f.publish).toHaveBeenCalledWith("pending-armed-run-settled", notice);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.log!("pending failed", { pendingId: "p1" });
    expect(error).toHaveBeenCalledWith("[armed-runs] pending failed", { pendingId: "p1" });
  });
});

describe("scheduler wiring", () => {
  it("reads every Automation, the local switches and the cursors, and advances at now", async () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const ports = f.schedulerPorts();
    expect(ports.now).toBe(Date.now);
    vi.mocked(listAllAutomations).mockReturnValueOnce(["auto"] as never);
    await expect(ports.listAutomations()).resolves.toEqual(["auto"]);
    expect(listAllAutomations).toHaveBeenCalledWith(db);
    await expect(ports.enabledAutomationIds()).resolves.toEqual(["a1"]);
    vi.mocked(readScheduleCursors).mockReturnValueOnce({ a1: 5 } as never);
    await expect(ports.readCursors()).resolves.toEqual({ a1: 5 });
    expect(readScheduleCursors).toHaveBeenCalledWith(db);
    vi.setSystemTime(9_000);
    await ports.advanceCursor({ automationId: "a1", through: 8_000 });
    expect(advanceScheduleCursor).toHaveBeenCalledWith(
      db,
      { automationId: "a1", through: 8_000 },
      9_000,
    );
  });

  it("publishes a recorded skip and fails the step on a refused one", async () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const { recordSkip } = f.schedulerPorts();
    const input = { commandId: "c1", skip: { projectId: "p1" } } as never;
    await recordSkip(input);
    expect(f.engine.recordSkip).toHaveBeenCalledWith(input);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith("data-changed", { projectId: "p1" });
    f.engine.recordSkip.mockResolvedValueOnce({ ok: false, error: "ledger refused" });
    await expect(recordSkip(input)).rejects.toThrow("ledger refused");
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("starts a schedule's Run unattended and narrows its outcome", async () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const { startRun } = f.schedulerPorts();
    const request = { commandId: "c1", automationId: "a1", projectId: "p1" };
    f.runner.runForProject.mockResolvedValueOnce({ ok: true, run: {}, receipt: {} });
    await expect(startRun(request)).resolves.toEqual({ ok: true });
    expect(f.runner.runForProject).toHaveBeenCalledWith({ ...request, attendance: "unattended" });
    f.runner.runForProject.mockResolvedValueOnce({
      ok: false,
      code: "RUN_FAILED",
      error: "No executor",
      extra: true,
    });
    await expect(startRun(request)).resolves.toEqual({
      ok: false,
      code: "RUN_FAILED",
      error: "No executor",
    });
  });

  it("owns real timers", () => {
    const f = fixture();
    f.automations.start(() => f.sessionPorts);
    const ports = f.schedulerPorts();
    const fire = vi.fn();
    ports.setTimer(50, fire);
    vi.advanceTimersByTime(50);
    expect(fire).toHaveBeenCalledOnce();
    const cancelled = vi.fn();
    ports.clearTimer(ports.setTimer(50, cancelled));
    vi.advanceTimersByTime(100);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
