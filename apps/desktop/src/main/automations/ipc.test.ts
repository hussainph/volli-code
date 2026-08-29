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
import { disabledAutomationIds, setAutomationEnabled } from "./enablement";
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
    disabledAutomationIds: () => disabledAutomationIds(ctx.db),
    setAutomationEnabled: (input) => setAutomationEnabled(ctx.db, input, 5_000),
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

  it("carries machine-local enablement without minting a command or a receipt", async () => {
    const { mutations } = setup();

    expect(await call<AutomationEnablementResult>("volli:automation-enablement")).toEqual({
      ok: true,
      disabledAutomationIds: [],
    });

    expect(
      await call<AutomationEnablementResult>("volli:automation-set-enabled", {
        automationId: "automation-2",
        enabled: false,
      }),
    ).toEqual({ ok: true, disabledAutomationIds: ["automation-2"] });
    expect(
      await call<AutomationEnablementResult>("volli:automation-set-enabled", {
        automationId: "automation-1",
        enabled: false,
      }),
    ).toEqual({ ok: true, disabledAutomationIds: ["automation-1", "automation-2"] });

    // It survives the round trip through app_state, and switching one back on
    // removes exactly that id.
    expect(await call<AutomationEnablementResult>("volli:automation-enablement")).toEqual({
      ok: true,
      disabledAutomationIds: ["automation-1", "automation-2"],
    });
    expect(
      await call<AutomationEnablementResult>("volli:automation-set-enabled", {
        automationId: "automation-1",
        enabled: true,
      }),
    ).toEqual({ ok: true, disabledAutomationIds: ["automation-2"] });

    // No `volli:data-changed` fan-out: no projection of the RECORD moved.
    expect(mutations).toEqual([]);
    expect(
      await call<Result>("volli:automation-set-enabled", { automationId: "a", enabled: "yes" }),
    ).toEqual({ ok: false, error: "Invalid automation enablement request" });
  });
});
