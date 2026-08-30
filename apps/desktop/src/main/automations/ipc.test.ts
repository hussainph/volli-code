import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";
import type {
  AutomationDeleteResult,
  AutomationEnablementResult,
  AutomationResult,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
  AutomationSetEnabledResult,
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
import { enabledAutomationIds } from "./enablement";
import type { AutomationRunner } from "./run";
import { createAutomationService } from "./service";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  createAutomation,
  getAutomation,
  listAutomationsForProject,
  listRunsForProject,
  listRunsForTicket,
  recordAutomationRun,
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

/** Variadic so a zero-argument channel is called with none, as the guard requires. */
async function call<T>(channel: string, ...input: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return (await (handler as (...args: unknown[]) => unknown)(EVENT, ...input)) as T;
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
    runsForProject: (id) => listRunsForProject(ctx.db, id),
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
      "volli:automation-runs-for-project",
      "volli:automation-enablement",
      "volli:automation-set-enabled",
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
      { projectId: project.id, name: "Review", instructions: "x", runtime: null },
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
        runtime: null,
      }),
    ).toEqual({ ok: false, error: "Invalid automation" });
  });

  it("lists a project's Runs newest first, and refuses an unknown project", async () => {
    const { project, ticket } = setup();
    const session = testSession(project.id, ticket.id);
    insertSession(ctx.db, session);
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "Review", instructions: "x", runtime: null },
      1,
    );
    recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: ticket.id, sessionId: session.id, model: PIN },
      1_000,
    );
    recordAutomationRun(
      ctx.db,
      {
        automationId: automation.id,
        automationName: "Sweep",
        ticketId: ticket.id,
        sessionId: session.id,
        model: PIN,
      },
      9_000,
    );

    const runs = await call<AutomationRunsResult>("volli:automation-runs-for-project", {
      projectId: project.id,
    });
    expect(runs).toMatchObject({
      ok: true,
      runs: [{ automationName: "Sweep" }, { automationName: "Review" }],
    });

    // Guarded, unlike the Ticket read: a whole project's history answered as a
    // convincing empty list would look like "nothing ever ran here".
    expect(
      await call<AutomationRunsResult>("volli:automation-runs-for-project", {
        projectId: "no-such-project",
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
  });

  it("switches an Automation on for this machine through a durable command", async () => {
    const { project, mutations } = setup();
    const one = createAutomation(
      ctx.db,
      { projectId: project.id, name: "One", instructions: "x", runtime: null },
      1,
    );
    const two = createAutomation(
      ctx.db,
      { projectId: null, name: "Two", instructions: "x", runtime: null },
      1,
    );

    // VC-112: a machine fires nothing until someone turns something on there,
    // so a record nobody has switched on here is absent from the set.
    expect(await call<AutomationEnablementResult>("volli:automation-enablement")).toEqual({
      ok: true,
      enabledAutomationIds: [],
    });

    const first = await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
      commandId: "11111111-1111-4111-8111-111111111111",
      automationId: one.id,
      enabled: true,
    });
    expect(first).toMatchObject({
      ok: true,
      enabledAutomationIds: [one.id],
      // BOUNDARIES rule 5: the intent is a command with a receipt, even though
      // the projection it writes is machine-local.
      receipt: { status: "completed" },
    });
    await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
      commandId: "22222222-2222-4222-8222-222222222222",
      automationId: two.id,
      enabled: true,
    });

    // It survives the round trip through the machine-local projection, and
    // switching one back off removes exactly that id.
    expect(await call<AutomationEnablementResult>("volli:automation-enablement")).toEqual({
      ok: true,
      enabledAutomationIds: [one.id, two.id].toSorted(),
    });
    expect(enabledAutomationIds(ctx.db)).toEqual([one.id, two.id].toSorted());
    expect(
      await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
        commandId: "33333333-3333-4333-8333-333333333333",
        automationId: one.id,
        enabled: false,
      }),
    ).toMatchObject({ ok: true, enabledAutomationIds: [two.id] });

    // No `volli:data-changed` fan-out: no projection of the RECORD moved.
    expect(mutations).toEqual([]);
  });

  it("replays one enablement command rather than flipping the switch twice", async () => {
    const { project } = setup();
    const automation = createAutomation(
      ctx.db,
      { projectId: project.id, name: "One", instructions: "x", runtime: null },
      1,
    );
    const request = {
      commandId: "44444444-4444-4444-8444-444444444444",
      automationId: automation.id,
      enabled: true,
    };

    const accepted = await call<AutomationSetEnabledResult>(
      "volli:automation-set-enabled",
      request,
    );
    // Somebody else switched it off in between; the retry must answer with its
    // own recorded outcome rather than re-deciding the set.
    await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
      commandId: "55555555-5555-4555-8555-555555555555",
      automationId: automation.id,
      enabled: false,
    });
    const replayed = await call<AutomationSetEnabledResult>(
      "volli:automation-set-enabled",
      request,
    );

    expect(replayed).toEqual(accepted);
    expect(enabledAutomationIds(ctx.db)).toEqual([]);
  });

  it("refuses a switch for a record that is gone, and guards the wire shape", async () => {
    setup();

    expect(
      await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
        commandId: "66666666-6666-4666-8666-666666666666",
        automationId: "no-such-automation",
        enabled: true,
      }),
    ).toMatchObject({ ok: false, error: "Unknown automation", receipt: { status: "rejected" } });
    expect(enabledAutomationIds(ctx.db)).toEqual([]);

    expect(
      await call<Result>("volli:automation-set-enabled", {
        automationId: "a",
        enabled: true,
      }),
    ).toEqual({ ok: false, error: "Invalid automation enablement request" });

    // The switch is a durable command, so its identity is held to the same
    // UUID shape create/update/delete are: a machine-local counter is not a
    // retry identity two hosts can share.
    expect(
      await call<Result>("volli:automation-set-enabled", {
        commandId: "c1",
        automationId: "a",
        enabled: true,
      }),
    ).toEqual({ ok: false, error: "Invalid automation enablement request" });
  });
});
