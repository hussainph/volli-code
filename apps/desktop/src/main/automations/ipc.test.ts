import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";
import type {
  AutomationResult,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
  Result,
} from "../../ipc/contract";

// Hoisted above module evaluation so the electron mock factory can capture
// into it — the same shape theme-ipc.test.ts uses.
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
import type { AutomationIpcDeps } from "./ipc";
import type { AutomationRunner } from "./run";
import { AUTOMATION_CHANNELS } from "../ipc-descriptors";
import { createAutomation, recordAutomationRun } from "../db/automations-repo";
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

/** A fake event object standing in for Electron's — handlers only read `.sender`. */
const EVENT = { sender: {} } as never;

async function call<T>(channel: string, input: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return (await (handler as (...args: unknown[]) => unknown)(EVENT, input)) as T;
}

function setup(overrides: Partial<AutomationIpcDeps> = {}) {
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  const mutations: Array<{ projectId?: string; ticketId?: string }> = [];
  registerAutomationIpcHandlers(
    { ok: true, db: ctx.db },
    {
      runner: null,
      inspectModelAccess: async () => ACCESS,
      onMutation: (change) => mutations.push(change),
      now: () => 5_000,
      ...overrides,
    },
  );
  return { project, ticket, mutations };
}

describe("automation IPC", () => {
  it("degrades every channel to the db-open failure instead of hanging", async () => {
    registerAutomationIpcHandlers(
      { ok: false, error: "The local database failed to open." },
      { runner: null, now: Date.now },
    );
    for (const channel of AUTOMATION_CHANNELS) {
      expect(await call<Result>(channel, {})).toEqual({
        ok: false,
        error: "The local database failed to open.",
      });
    }
  });

  it("creates, lists, updates and deletes through the guarded envelope", async () => {
    const { project, mutations } = setup();

    const created = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "  Review  ",
      instructions: "/review go",
      runtime: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("refused");
    // The name lands trimmed; the id is main's, never the caller's.
    expect(created.automation.name).toBe("Review");

    const listed = await call<AutomationsResult>("volli:automation-list", {
      projectId: project.id,
    });
    expect(listed).toMatchObject({ ok: true, automations: [{ id: created.automation.id }] });

    const updated = await call<AutomationResult>("volli:automation-update", {
      automationId: created.automation.id,
      name: "Renamed",
      instructions: "/tdd",
      runtime: PIN,
    });
    expect(updated).toMatchObject({ ok: true, automation: { name: "Renamed", runtime: PIN } });

    const deleted = await call<Result>("volli:automation-delete", {
      automationId: created.automation.id,
    });
    expect(deleted).toEqual({ ok: true });
    expect(mutations).toEqual([
      { projectId: project.id },
      { projectId: project.id },
      { projectId: project.id },
    ]);
  });

  it("scopes mutations honestly: a global Automation broadcasts untargeted", async () => {
    const { mutations } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      projectId: null,
      name: "Global",
      instructions: "x",
      runtime: null,
    });
    expect(created.ok).toBe(true);
    expect(mutations).toEqual([{}]);
  });

  it("refuses an empty draft with the shared rule — one policy for editor and store", async () => {
    const { project } = setup();
    const refused = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "   ",
      instructions: "x",
      runtime: null,
    });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Name/) });
  });

  it("validates a Runtime pin when it is SET, against the model's own reasoning levels", async () => {
    const { project } = setup();
    const unspellable = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "Pinned",
      instructions: "x",
      runtime: { ...PIN, reasoningLevel: "max" },
    });
    expect(unspellable).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reasoning level "max"/),
    });

    const fine = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "Pinned",
      instructions: "x",
      runtime: PIN,
    });
    expect(fine.ok).toBe(true);
  });

  it("refuses a pin it cannot validate when Model Access is down, but still saves inherit", async () => {
    const { project } = setup({ inspectModelAccess: undefined });
    const pinned = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "Pinned",
      instructions: "x",
      runtime: PIN,
    });
    expect(pinned).toMatchObject({ ok: false, error: expect.stringMatching(/Model Access/) });

    const inherit = await call<AutomationResult>("volli:automation-create", {
      projectId: project.id,
      name: "Inheriting",
      instructions: "x",
      runtime: null,
    });
    expect(inherit.ok).toBe(true);
  });

  it("refuses an unknown project on list and create, and an unknown automation on update/delete", async () => {
    setup();
    expect(await call<AutomationsResult>("volli:automation-list", { projectId: "nope" })).toEqual({
      ok: false,
      error: "Unknown project",
    });
    expect(
      await call<AutomationResult>("volli:automation-create", {
        projectId: "nope",
        name: "n",
        instructions: "i",
        runtime: null,
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
    expect(
      await call<AutomationResult>("volli:automation-update", {
        automationId: "missing",
        name: "n",
        instructions: "i",
        runtime: null,
      }),
    ).toEqual({ ok: false, error: "Unknown automation" });
    expect(await call<Result>("volli:automation-delete", { automationId: "missing" })).toEqual({
      ok: false,
      error: "Unknown automation",
    });
  });

  it("answers a run with the runner's outcome, and names the runtime's absence when it never came up", async () => {
    const outcomes: AutomationRunStartResult[] = [];
    const runner: AutomationRunner = {
      run: async (input) => ({
        ok: true,
        run: {
          id: "run-1",
          automationId: input.automationId,
          ticketId: input.ticketId,
          sessionId: "session-1",
          model: PIN,
          createdAt: 5_000,
        },
        projectId: "project-1",
      }),
      settled: async () => undefined,
    };
    const { ticket, mutations } = setup({ runner });

    outcomes.push(
      await call<AutomationRunStartResult>("volli:automation-run", {
        automationId: "automation-1",
        ticketId: ticket.id,
      }),
    );
    expect(outcomes[0]).toMatchObject({ ok: true, run: { sessionId: "session-1" } });
    expect(mutations).toEqual([{ projectId: "project-1", ticketId: ticket.id }]);

    handlers.clear();
    setup({ runner: null });
    const down = await call<AutomationRunStartResult>("volli:automation-run", {
      automationId: "automation-1",
      ticketId: ticket.id,
    });
    expect(down).toMatchObject({ ok: false, code: "RUN_FAILED" });
  });

  it("passes a runner refusal through with its code — never a bare string to parse", async () => {
    const runner: AutomationRunner = {
      run: async () => ({ ok: false, code: "RUN_IN_FLIGHT", error: "A Run is already working." }),
      settled: async () => undefined,
    };
    const { ticket, mutations } = setup({ runner });
    const refused = await call<AutomationRunStartResult>("volli:automation-run", {
      automationId: "automation-1",
      ticketId: ticket.id,
    });
    expect(refused).toEqual({
      ok: false,
      code: "RUN_IN_FLIGHT",
      error: "A Run is already working.",
    });
    expect(mutations).toEqual([]);
  });

  it("lists a Ticket's Runs newest first", async () => {
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
      { automationId: null, ticketId: ticket.id, sessionId: session.id, model: PIN },
      2_000,
    );

    const runs = await call<AutomationRunsResult>("volli:automation-runs-for-ticket", {
      ticketId: ticket.id,
    });
    expect(runs.ok).toBe(true);
    if (!runs.ok) throw new Error("refused");
    expect(runs.runs.map((run) => run.createdAt)).toEqual([2_000, 1_000]);
  });

  it("rejects a malformed request at the guard with the descriptor's own error", async () => {
    setup();
    expect(await call<Result>("volli:automation-create", { projectId: 7 })).toEqual({
      ok: false,
      error: "Invalid automation",
    });
    expect(
      await call<Result>("volli:automation-run", { automationId: "a" /* no ticketId */ }),
    ).toEqual({ ok: false, error: "Invalid automation run request" });
  });
});
