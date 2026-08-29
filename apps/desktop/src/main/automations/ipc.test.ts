import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";
import type {
  AutomationArmingsResult,
  AutomationDeleteResult,
  AutomationResult,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
  Result,
} from "../../ipc/contract";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { registerAutomationIpcHandlers } from "./ipc";
import { createAutomationEngine } from "./engine";
import type { AutomationRunner } from "./run";
import { createAutomationService } from "./service";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  clearColumnArming,
  createAutomation,
  getAutomation,
  listAutomationsForProject,
  listColumnArmings,
  listRunsForTicket,
  recordAutomationRun,
  setColumnArming,
} from "../db/automations-repo";
import { insertProject } from "../db/projects-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";

let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

const PIN: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

const ACCESS: ModelAccessSnapshot = {
  observedAt: 0,
  providers: [],
  models: [
    {
      providerId: PIN.providerId,
      modelId: PIN.modelId,
      label: "Claude Opus",
      state: "available",
      reasoningLevels: ["medium", "high"],
      acceptsImageInput: true,
    },
  ],
};

const EVENT = { sender: {} } as never;

async function call<T>(channel: string, input: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return (await (handler as (...args: unknown[]) => unknown)(EVENT, input)) as T;
}

function setup(
  overrides: {
    runner?: AutomationRunner | null;
    inspectModelAccess?: () => Promise<ModelAccessSnapshot>;
  } = {},
) {
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  const mutations: Array<{ projectId?: string }> = [];
  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(ctx.db),
    now: () => 5_000,
    nextId: randomUUID,
  });
  const service = createAutomationService({
    engine,
    findProject: (id) => id === project.id,
    findAutomation: (id) => getAutomation(ctx.db, id),
    // These projection reads are behind the service; IPC itself never names a
    // database or repository.
    listAutomationsForProject: (id) => listAutomationsForProject(ctx.db, id),
    runsForTicket: (id) => listRunsForTicket(ctx.db, id),
    listColumnArmings: (id) => listColumnArmings(ctx.db, id),
    setColumnArming: (input) => setColumnArming(ctx.db, input, 5_000),
    clearColumnArming: (input) => clearColumnArming(ctx.db, input),
    inspectModelAccess: overrides.inspectModelAccess ?? (async () => ACCESS),
    onMutation: (change) => mutations.push(change),
  });
  registerAutomationIpcHandlers(
    { ok: true, db: ctx.db },
    { service, runner: overrides.runner ?? null },
  );
  return { project, ticket, mutations, engine, service };
}

describe("automation IPC", () => {
  it("degrades every channel to the db-open failure instead of hanging", async () => {
    registerAutomationIpcHandlers(
      { ok: false, error: "The local database failed to open." },
      { service: null, runner: null },
    );
    for (const channel of [
      "volli:automation-list",
      "volli:automation-create",
      "volli:automation-update",
      "volli:automation-delete",
      "volli:automation-run",
      "volli:automation-runs-for-ticket",
      "volli:automation-arming-list",
      "volli:automation-arm",
    ]) {
      expect(await call<Result>(channel, {})).toEqual({
        ok: false,
        error: "The local database failed to open.",
      });
    }
  });

  it("is a transport-only adapter over command receipts, events, and projections", async () => {
    const { project, mutations } = setup();
    const createId = randomUUID();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: createId,
      projectId: project.id,
      name: "  Review  ",
      instructions: "/review go",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    expect(created).toMatchObject({
      ok: true,
      automation: { name: "Review" },
      receipt: { commandId: createId, status: "completed" },
    });
    if (!created.ok) throw new Error("refused");

    const replay = await call<AutomationResult>("volli:automation-create", {
      commandId: createId,
      projectId: project.id,
      name: "  Review  ",
      instructions: "/review go",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    expect(replay).toMatchObject({ ok: true, automation: { id: created.automation.id } });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automations").get()).toEqual({ n: 1 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 1 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_events").get()).toEqual({ n: 3 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_command_receipts").get()).toEqual({
      n: 1,
    });

    const listed = await call<AutomationsResult>("volli:automation-list", {
      projectId: project.id,
    });
    expect(listed).toMatchObject({ ok: true, automations: [{ id: created.automation.id }] });

    const updated = await call<AutomationResult>("volli:automation-update", {
      commandId: randomUUID(),
      automationId: created.automation.id,
      name: "Renamed",
      instructions: "/tdd",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: PIN,
    });
    expect(updated).toMatchObject({ ok: true, automation: { name: "Renamed", runtime: PIN } });

    const deleted = await call<AutomationDeleteResult>("volli:automation-delete", {
      commandId: randomUUID(),
      automationId: created.automation.id,
    });
    expect(deleted).toMatchObject({ ok: true, receipt: { status: "completed" } });
    expect(mutations).toEqual([
      { projectId: project.id },
      { projectId: project.id },
      { projectId: project.id },
    ]);
  });

  it("validates a Runtime pin against live Model Access before accepting a command", async () => {
    const { project } = setup();
    const unspellable = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Pinned",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: { ...PIN, reasoningLevel: "max" },
    });
    expect(unspellable).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reasoning level/),
    });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 0 });
  });

  it("replays an accepted pinned write before checking changed Model Access", async () => {
    let access: ModelAccessSnapshot = ACCESS;
    const { project } = setup({ inspectModelAccess: async () => access });
    const createId = randomUUID();
    const createInput = {
      commandId: createId,
      projectId: project.id,
      name: "Pinned",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: PIN,
    };
    const created = await call<AutomationResult>("volli:automation-create", createInput);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("refused");

    const updateId = randomUUID();
    const updateInput = {
      commandId: updateId,
      automationId: created.automation.id,
      name: "Pinned, renamed",
      instructions: "x",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: PIN,
    };
    expect(await call<AutomationResult>("volli:automation-update", updateInput)).toMatchObject({
      ok: true,
      automation: { name: "Pinned, renamed" },
    });

    // A receipt is the accepted fact. Retrying its id after the pinned model
    // later vanishes must replay it, not be blocked by save-time validation.
    access = {
      ...ACCESS,
      models: ACCESS.models.map((model) => Object.assign({}, model, { state: "unavailable" })),
    };
    expect(await call<AutomationResult>("volli:automation-create", createInput)).toMatchObject({
      ok: true,
      automation: { id: created.automation.id },
      receipt: { commandId: createId, status: "completed" },
    });
    expect(await call<AutomationResult>("volli:automation-update", updateInput)).toMatchObject({
      ok: true,
      automation: { id: created.automation.id, name: "Pinned, renamed" },
      receipt: { commandId: updateId, status: "completed" },
    });
  });

  it("passes a Run outcome through without giving IPC database authority", async () => {
    const receipt = {
      id: randomUUID(),
      commandId: randomUUID(),
      status: "completed" as const,
      recordedAt: 5_000,
    };
    const runner: AutomationRunner = {
      run: async (input) => ({
        ok: true,
        run: {
          id: "run-1",
          automationId: input.automationId,
          automationName: "Review",
          ticketId: input.ticketId,
          sessionId: "session-1",
          model: PIN,
          createdAt: 5_000,
        },
        projectId: "project-1",
        receipt,
      }),
      resumeDeliveryForSession: async () => undefined,
      recover: async () => undefined,
      settled: async () => undefined,
    };
    const { ticket } = setup({ runner });

    const result = await call<AutomationRunStartResult>("volli:automation-run", {
      commandId: randomUUID(),
      automationId: "automation-1",
      ticketId: ticket.id,
    });
    expect(result).toMatchObject({ ok: true, run: { sessionId: "session-1" }, receipt });
  });

  it("lists a Ticket's Runs newest first and rejects malformed command identities", async () => {
    const { project, ticket } = setup();
    const session = testSession(project.id, ticket.id);
    insertSession(ctx.db, session);
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "Review",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      },
      1,
    );
    recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1_000,
    );
    const runs = await call<AutomationRunsResult>("volli:automation-runs-for-ticket", {
      ticketId: ticket.id,
    });
    expect(runs).toMatchObject({ ok: true, runs: [{ automationName: "Review" }] });

    expect(
      await call<Result>("volli:automation-create", {
        commandId: "not-a-uuid",
        projectId: project.id,
        name: "x",
        instructions: "x",
        trigger: NO_AUTOMATION_TRIGGER,
        runtime: null,
      }),
    ).toEqual({ ok: false, error: "Invalid automation" });
  });
  /* -------------------------------------- column arming (VC-128) --------- */

  it("stores a column Trigger on the record and reads it back as vocabulary", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Sweep",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["done", "doing"] },
      runtime: null,
    });
    // Board order, not the order the caller happened to send.
    expect(created).toMatchObject({
      ok: true,
      automation: { trigger: { kind: "columns", columns: ["doing", "done"] } },
    });
    if (!created.ok) throw new Error("refused");

    const cleared = await call<AutomationResult>("volli:automation-update", {
      commandId: randomUUID(),
      automationId: created.automation.id,
      name: "Sweep",
      instructions: "/review",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    expect(cleared).toMatchObject({ ok: true, automation: { trigger: { kind: "none" } } });
  });

  it("arms a column with one offered Automation, replaces it, and disarms it", async () => {
    const { project, mutations } = setup();
    const first = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "First",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    const second = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Second",
      instructions: "/tdd",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    if (!first.ok || !second.ok) throw new Error("refused");
    mutations.length = 0;

    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: project.id,
        status: "doing",
        automationId: first.automation.id,
      }),
    ).toMatchObject({
      ok: true,
      armings: [{ status: "doing", automationId: first.automation.id }],
    });

    // At most one, enforced by the row's own key rather than by convention.
    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: project.id,
        status: "doing",
        automationId: second.automation.id,
      }),
    ).toMatchObject({
      ok: true,
      armings: [{ status: "doing", automationId: second.automation.id }],
    });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_column_arming").get()).toEqual({
      n: 1,
    });

    expect(
      await call<AutomationArmingsResult>("volli:automation-arming-list", {
        projectId: project.id,
      }),
    ).toMatchObject({ ok: true, armings: [{ automationId: second.automation.id }] });

    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: project.id,
        status: "doing",
        automationId: null,
      }),
    ).toEqual({ ok: true, armings: [] });
    // Each write reaches the renderer; none of them is a ledger command.
    expect(mutations).toEqual([
      { projectId: project.id },
      { projectId: project.id },
      { projectId: project.id },
    ]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 2 });
  });

  it("refuses to arm a column the Automation does not offer", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Elsewhere",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["done"] },
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");

    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: project.id,
        status: "doing",
        automationId: created.automation.id,
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/not offered in this column/) });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_column_arming").get()).toEqual({
      n: 0,
    });
  });

  it("refuses an unknown Automation and an unknown project", async () => {
    const { project } = setup();
    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: project.id,
        status: "doing",
        automationId: "ghost",
      }),
    ).toEqual({ ok: false, error: "Unknown automation" });
    expect(
      await call<AutomationArmingsResult>("volli:automation-arm", {
        projectId: "no-such-project",
        status: "doing",
        automationId: null,
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
    expect(
      await call<AutomationArmingsResult>("volli:automation-arming-list", {
        projectId: "no-such-project",
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
  });

  it("drops a column's arming when the Automation behind it is deleted", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Sweep",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    await call<AutomationArmingsResult>("volli:automation-arm", {
      projectId: project.id,
      status: "doing",
      automationId: created.automation.id,
    });

    await call<AutomationDeleteResult>("volli:automation-delete", {
      commandId: randomUUID(),
      automationId: created.automation.id,
    });

    expect(
      await call<AutomationArmingsResult>("volli:automation-arming-list", {
        projectId: project.id,
      }),
    ).toEqual({ ok: true, armings: [] });
  });
});
