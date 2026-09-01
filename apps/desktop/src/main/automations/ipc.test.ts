import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { nextScheduleOccurrence, NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";
import type {
  AutomationArmingsResult,
  AutomationArmResult,
  AutomationDeleteResult,
  AutomationEnablementResult,
  AutomationResult,
  AutomationRunStartResult,
  AutomationRunsResult,
  AutomationsResult,
  AutomationColumnOrdersResult,
  AutomationSetColumnOrderResult,
  AutomationSetEnabledResult,
  AutomationSkipsResult,
  PendingArmedRunCancelResult,
  PendingArmedRunRetryResult,
  PendingArmedRunsResult,
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
import type { PendingArmedRunCoordinator } from "./pending-armed-runs";
import type { AutomationRunner } from "./run";
import { createAutomationScheduler } from "./scheduler";
import {
  advanceScheduleCursor,
  readScheduleCursors,
  rebaseScheduleCursor,
} from "./schedule-cursor";
import { createAutomationService } from "./service";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationsForProject,
  listRunsForProject,
  listRunsForTicket,
  listSkippedOccurrencesForProject,
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
    now?: () => number;
    pendingArmedRuns?: Pick<PendingArmedRunCoordinator, "list" | "failures" | "cancel" | "retry">;
  } = {},
) {
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  const mutations: Array<{ projectId?: string }> = [];
  const scheduleRebases: string[] = [];
  const now = overrides.now ?? (() => 5_000);
  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(ctx.db),
    now,
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
    skipsForProject: (id) => listSkippedOccurrencesForProject(ctx.db, id),
    inspectModelAccess: overrides.inspectModelAccess ?? (async () => ACCESS),
    onMutation: (change) => mutations.push(change),
    rebaseScheduleCursor: (automationId, through) => {
      scheduleRebases.push(automationId);
      rebaseScheduleCursor(ctx.db, { automationId, through }, now());
    },
  });
  registerAutomationIpcHandlers(
    { ok: true, db: ctx.db },
    {
      service,
      runner: overrides.runner ?? null,
      ...(overrides.pendingArmedRuns === undefined
        ? {}
        : { pendingArmedRuns: overrides.pendingArmedRuns }),
    },
  );
  return { project, ticket, mutations, scheduleRebases, engine, service };
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
      "volli:automation-column-order-list",
      "volli:automation-set-column-order",
      "volli:automation-runs-for-project",
      "volli:automation-enablement",
      "volli:automation-set-enabled",
      "volli:automation-pending-armed-runs",
      "volli:automation-cancel-pending-armed-run",
      "volli:automation-retry-pending-armed-run",
      "volli:automation-skips-for-project",
      "volli:automation-run-for-project",
    ]) {
      expect(await call<Result>(channel, {})).toEqual({
        ok: false,
        error: "The local database failed to open.",
      });
    }
  });

  it("lists, Cancels and retries main's exact shared armed arrival", async () => {
    const pending = {
      id: "arrival-1",
      ticketId: "ticket-1",
      projectId: "project-1",
      ticketDisplayId: "VC-12",
      automationId: "automation-1",
      automationName: "Review sweep",
      status: "doing" as const,
      origin: "armed" as const,
      openedAt: 1_000,
      startAt: 4_500,
    };
    const failure = { pending, error: "IPC reply lost" };
    const cancel = vi.fn(() => true);
    const retry = vi.fn(() => true);
    setup({
      pendingArmedRuns: { list: () => [pending], failures: () => [failure], cancel, retry },
    });

    expect(await call<PendingArmedRunsResult>("volli:automation-pending-armed-runs")).toEqual({
      ok: true,
      pending: [pending],
      failures: [failure],
    });
    expect(
      await call<PendingArmedRunCancelResult>("volli:automation-cancel-pending-armed-run", {
        id: pending.id,
      }),
    ).toEqual({ ok: true, cancelled: true });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("arrival-1");
    expect(
      await call<PendingArmedRunRetryResult>("volli:automation-retry-pending-armed-run", {
        id: pending.id,
      }),
    ).toEqual({ ok: true, retrying: true });
    expect(retry).toHaveBeenCalledExactlyOnceWith("arrival-1");
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
          automationId: input.target.kind === "automation" ? input.target.automationId : null,
          automationName: "Review",
          ticketId: input.ticketId,
          sessionId: "session-1",
          model: PIN,
          attendance: input.attendance,
          createdAt: 5_000,
        },
        projectId: "project-1",
        receipt,
      }),
      runForProject: async (input) => ({
        ok: true,
        run: {
          id: "run-project-1",
          automationId: input.automationId,
          automationName: "Review",
          // A schedule Run names no Ticket: its Target is the Project, so the
          // Session it opens is a Project Session.
          ticketId: null,
          sessionId: "session-project-1",
          model: PIN,
          attendance: input.attendance,
          createdAt: 5_000,
        },
        projectId: input.projectId,
        receipt,
      }),
      resumeDeliveryForSession: async () => undefined,
      recover: async () => undefined,
      settled: async () => undefined,
    };
    const { ticket } = setup({ runner });

    const result = await call<AutomationRunStartResult>("volli:automation-run", {
      commandId: randomUUID(),
      target: { kind: "automation", automationId: "automation-1" },
      ticketId: ticket.id,
      modelOverride: null,
    });
    expect(result).toMatchObject({ ok: true, run: { sessionId: "session-1" }, receipt });
    // ATTENDED, decided by being this handler (VC-133). Every surface behind
    // this channel is one a person had to click.
    expect(result).toMatchObject({ ok: true, run: { attendance: "attended" } });
  });

  it("will not let the renderer declare its own attendance", async () => {
    // The fact decides whether a person is interrupted, so it must not be
    // forgeable upstream: the handler overrides whatever arrived on the wire.
    const receipt = {
      id: randomUUID(),
      commandId: randomUUID(),
      status: "completed" as const,
      recordedAt: 5_000,
    };
    const seen: string[] = [];
    const runner: AutomationRunner = {
      run: async (input) => {
        seen.push(input.attendance);
        return {
          ok: true,
          run: {
            id: "run-1",
            automationId: "automation-1",
            automationName: "Review",
            ticketId: input.ticketId,
            sessionId: "session-1",
            model: PIN,
            attendance: input.attendance,
            createdAt: 5_000,
          },
          projectId: "project-1",
          receipt,
        };
      },
      runForProject: async () => ({ ok: false, code: "RUN_FAILED", error: "not this door" }),
      resumeDeliveryForSession: async () => undefined,
      recover: async () => undefined,
      settled: async () => undefined,
    };
    const { ticket } = setup({ runner });

    await call<AutomationRunStartResult>("volli:automation-run", {
      commandId: randomUUID(),
      target: { kind: "automation", automationId: "automation-1" },
      ticketId: ticket.id,
      modelOverride: null,
      attendance: "unattended",
    } as never);

    expect(seen).toEqual(["attended"]);
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

  /* ------------------------------ upgrade-era replays (VC-128) ---------- */

  /**
   * Writes the durable rows the build BEFORE the Trigger wrote: an intent with
   * no `trigger` key, a completed receipt whose Automation has none either, and
   * the record itself with a NULL `trigger_spec`.
   *
   * Inserted rather than edited into shape, because the ledger's own triggers
   * refuse to update a command or a receipt — which is the point. History
   * cannot be migrated into today's vocabulary, so today's reader is what has
   * to understand yesterday's rows, and this is the only honest way to hand it
   * one. `automationId` is returned so a test can name the record the replay
   * must answer with.
   */
  function writeLegacyRows(input: {
    commandId: string;
    projectId: string;
    name: string;
    instructions: string;
    kind: "create" | "update";
    automationId?: string;
  }): string {
    const automationId = input.automationId ?? randomUUID();
    const automation = {
      id: automationId,
      projectId: input.projectId,
      name: input.name,
      instructions: input.instructions,
      // No `trigger` — this build did not have one.
      runtime: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const intent =
      input.kind === "create"
        ? {
            kind: "automation.create",
            projectId: input.projectId,
            name: input.name,
            instructions: input.instructions,
            runtime: null,
          }
        : {
            kind: "automation.update",
            automationId,
            name: input.name,
            instructions: input.instructions,
            runtime: null,
          };
    if (input.automationId === undefined) {
      ctx.db
        .prepare(
          `INSERT INTO automations
             (id, project_id, name, instructions, trigger_spec, runtime, row_version,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
        )
        .run(automationId, input.projectId, input.name, input.instructions, 1_000, 1_000);
    }
    ctx.db
      .prepare("INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)")
      .run(input.commandId, JSON.stringify(intent), 1_000);
    ctx.db
      .prepare(
        `INSERT INTO automation_command_receipts (id, command_id, status, result, recorded_at)
         VALUES (?, ?, 'completed', ?, ?)`,
      )
      .run(
        randomUUID(),
        input.commandId,
        JSON.stringify({
          kind: input.kind === "create" ? "automation.created" : "automation.updated",
          automation,
        }),
        1_000,
      );
    return automationId;
  }

  it("replays a create written before the Trigger instead of calling the retry a conflict", async () => {
    const { project } = setup();
    const commandId = randomUUID();
    const automationId = writeLegacyRows({
      commandId,
      projectId: project.id,
      name: "Review",
      instructions: "/review go",
      kind: "create",
    });

    // The same durable identity, re-sent by the build that now HAS a Trigger.
    // Compared literally, the stored intent and this one differ by a field, and
    // the caller would be told its own command was already accepted with a
    // different intent — for a record it never chose a Trigger for.
    const replay = await call<AutomationResult>("volli:automation-create", {
      commandId,
      projectId: project.id,
      name: "Review",
      instructions: "/review go",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(replay).toMatchObject({ ok: true, automation: { id: automationId } });
    if (!replay.ok) throw new Error("refused");
    // And the receipt's own Automation comes back whole: a stored record with
    // no Trigger reads as "Nothing else", never as a record missing the field.
    expect(replay.automation.trigger).toEqual(NO_AUTOMATION_TRIGGER);
    // The replay wrote nothing: one record, one command, one receipt.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automations").get()).toEqual({ n: 1 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 1 });
  });

  it("replays an update written before the Trigger, and answers with a readable record", async () => {
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
    const commandId = randomUUID();
    writeLegacyRows({
      commandId,
      projectId: project.id,
      name: "Sweep",
      instructions: "/tdd",
      kind: "update",
      automationId: created.automation.id,
    });

    const replay = await call<AutomationResult>("volli:automation-update", {
      commandId,
      automationId: created.automation.id,
      name: "Sweep",
      instructions: "/tdd",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });

    expect(replay).toMatchObject({ ok: true, automation: { id: created.automation.id } });
    if (!replay.ok) throw new Error("refused");
    expect(replay.automation.trigger).toEqual(NO_AUTOMATION_TRIGGER);
  });

  it("still refuses a retry that genuinely changed its Trigger", async () => {
    // Reading an absent Trigger as "Nothing else" is not the same as making the
    // comparison lenient. A caller re-using one command id for a DIFFERENT
    // intent is still the conflict it always was.
    const { project } = setup();
    const commandId = randomUUID();
    writeLegacyRows({
      commandId,
      projectId: project.id,
      name: "Review",
      instructions: "/review go",
      kind: "create",
    });

    expect(
      await call<AutomationResult>("volli:automation-create", {
        commandId,
        projectId: project.id,
        name: "Review",
        instructions: "/review go",
        trigger: { kind: "columns", columns: ["doing"] },
        runtime: null,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("different intent") });
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
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        automationId: first.automation.id,
      }),
    ).toMatchObject({
      ok: true,
      armings: [{ status: "doing", automationId: first.automation.id }],
      receipt: { status: "completed" },
    });

    // At most one, enforced by the row's own key rather than by convention.
    expect(
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
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
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        automationId: null,
      }),
    ).toMatchObject({ ok: true, armings: [], receipt: { status: "completed" } });

    // Nothing about the shared record moved, so no window is told to re-read
    // its list: arming is this host's own choice about its own board.
    expect(mutations).toEqual([]);
    // Two creates plus three armings, each with its own durable command, event
    // and receipt — the projection is machine-local, the intent is not.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 5 });
    expect(
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_events WHERE kind = 'automation.arming.changed'",
        )
        .get(),
    ).toEqual({ n: 3 });
  });

  it("replays one arming command rather than arming twice", async () => {
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
    const request = {
      commandId: "55555555-5555-4555-8555-555555555555",
      projectId: project.id,
      status: "doing",
      automationId: created.automation.id,
    };

    const once = await call<AutomationArmResult>("volli:automation-arm", request);
    const twice = await call<AutomationArmResult>("volli:automation-arm", request);

    expect(once).toMatchObject({ ok: true, receipt: { status: "completed" } });
    // The SAME receipt comes back: a retry replays acceptance instead of
    // deciding again, which is the whole point of the command id.
    expect(twice).toEqual(once);
    expect(
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_events WHERE kind = 'automation.arming.changed'",
        )
        .get(),
    ).toEqual({ n: 1 });
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
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        automationId: created.automation.id,
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/not offered in this column/) });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_column_arming").get()).toEqual({
      n: 0,
    });
    // A refused write leaves no command behind: the live-fact check runs
    // before the intent is recorded, exactly as create's does.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_commands").get()).toEqual({ n: 1 });
  });

  it("refuses an unknown Automation and an unknown project", async () => {
    const { project } = setup();
    expect(
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        automationId: "ghost",
      }),
    ).toEqual({ ok: false, error: "Unknown automation" });
    expect(
      await call<AutomationArmResult>("volli:automation-arm", {
        commandId: randomUUID(),
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

  it("rejects an arming whose Automation disappeared between the check and the write", async () => {
    const { project, engine } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Sweep",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    // The service's live-fact checks guard the door; this is the engine's own
    // guard behind it, for the record that vanished after they passed. Driven
    // straight at the command core because no IPC caller can interleave there.
    deleteAutomation(ctx.db, created.automation.id);

    const outcome = await engine.setColumnArming({
      commandId: randomUUID(),
      projectId: project.id,
      status: "doing",
      automationId: created.automation.id,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "Unknown automation",
      receipt: { status: "rejected" },
    });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_column_arming").get()).toEqual({
      n: 0,
    });
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
    await call<AutomationArmResult>("volli:automation-arm", {
      commandId: randomUUID(),
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

  it("lists a project's Runs newest first, and refuses an unknown project", async () => {
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
    const { project, mutations, scheduleRebases } = setup();
    const one = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "One",
        instructions: "x",
        trigger: NIGHTLY,
        runtime: null,
      },
      1,
    );
    const two = createAutomation(
      ctx.db,
      {
        projectId: null,
        name: "Two",
        instructions: "x",
        trigger: NIGHTLY,
        runtime: null,
      },
      1,
    );
    advanceScheduleCursor(ctx.db, { automationId: one.id, through: 1_000 }, 2);
    advanceScheduleCursor(ctx.db, { automationId: two.id, through: 2_000 }, 2);

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
    expect(readScheduleCursors(ctx.db)).toEqual({ [one.id]: 5_000, [two.id]: 2_000 });
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
    // Switching on starts a durable baseline for the new lifecycle. Switching
    // off does not create another lifecycle or disturb that last position.
    expect(scheduleRebases).toEqual([one.id, two.id]);
    expect(readScheduleCursors(ctx.db)).toEqual({ [one.id]: 5_000, [two.id]: 5_000 });
  });

  it("replays one enablement command rather than flipping the switch twice", async () => {
    const { project, scheduleRebases } = setup();
    const automation = createAutomation(
      ctx.db,
      {
        projectId: project.id,
        name: "One",
        instructions: "x",
        trigger: NIGHTLY,
        runtime: null,
      },
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
    advanceScheduleCursor(ctx.db, { automationId: automation.id, through: 10_000 }, 6_000);
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
    // Replaying the old receipt is not a fresh enable and cannot reset what the
    // schedule watched after that command originally completed.
    expect(scheduleRebases).toEqual([automation.id]);
    expect(readScheduleCursors(ctx.db)).toEqual({ [automation.id]: 10_000 });
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

  /* ------------------------------- schedules (VC-130) ------------------- */

  const NIGHTLY = {
    kind: "schedule" as const,
    schedule: { preset: "daily" as const, hour: 21, minute: 30, timeZone: "Europe/London" },
  };

  it("stores a schedule Trigger whole, zone included, and lists it back", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    });
    expect(created).toMatchObject({ ok: true, automation: { trigger: NIGHTLY } });
    const listed = await call<AutomationsResult>("volli:automation-list", {
      projectId: project.id,
    });
    if (!listed.ok) throw new Error("refused");
    // The stored zone is part of the record, not a rendering choice: it comes
    // back exactly as written, whatever this machine's own zone is.
    expect(listed.automations[0]?.trigger).toEqual(NIGHTLY);
  });

  it("rebases an edited schedule without treating metadata edits as a new lifecycle", async () => {
    const { project, scheduleRebases } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    // Creation establishes its initial baseline before waking the scheduler.
    expect(scheduleRebases).toEqual([created.automation.id]);
    expect(readScheduleCursors(ctx.db)).toEqual({ [created.automation.id]: 5_000 });

    advanceScheduleCursor(ctx.db, { automationId: created.automation.id, through: 10_000 }, 6_000);
    const retimed = {
      kind: "schedule" as const,
      schedule: { ...NIGHTLY.schedule, minute: 45 },
    };
    await call<AutomationResult>("volli:automation-update", {
      commandId: randomUUID(),
      automationId: created.automation.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: retimed,
      runtime: null,
    });
    // A rebase replaces the old lifecycle even when its cursor was later.
    expect(readScheduleCursors(ctx.db)).toEqual({ [created.automation.id]: 5_000 });

    advanceScheduleCursor(ctx.db, { automationId: created.automation.id, through: 20_000 }, 7_000);
    await call<AutomationResult>("volli:automation-update", {
      commandId: randomUUID(),
      automationId: created.automation.id,
      name: "Nightly sweep",
      instructions: "/sweep more",
      trigger: retimed,
      runtime: null,
    });

    expect(scheduleRebases).toEqual([created.automation.id, created.automation.id]);
    // The unchanged schedule still owes its watched occurrences after a metadata edit.
    expect(readScheduleCursors(ctx.db)).toEqual({ [created.automation.id]: 20_000 });
  });

  it("records a missed occurrence after enable crashes before the asynchronous sweep", async () => {
    let now = Date.parse("2026-06-10T12:00:00Z");
    const { project } = setup({ now: () => now });
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");

    // The first occurrence passes while the record is switched off. Enabling
    // after it starts a fresh lifecycle, so that disabled gap remains silent.
    const disabledDueAt = nextScheduleOccurrence({
      schedule: NIGHTLY.schedule,
      staggerKey: created.automation.id,
      after: now,
    });
    now = disabledDueAt + 60_000;
    const enabledAt = now;
    await call<AutomationSetEnabledResult>("volli:automation-set-enabled", {
      commandId: randomUUID(),
      automationId: created.automation.id,
      enabled: true,
    });
    expect(readScheduleCursors(ctx.db)).toEqual({ [created.automation.id]: enabledAt });

    // Simulate process exit before onAutomationsChanged's fire-and-forget sweep:
    // no scheduler runs until after the next due time has passed. A new engine
    // and scheduler then stand in for the relaunched main process over the same
    // durable database.
    const missedDueAt = nextScheduleOccurrence({
      schedule: NIGHTLY.schedule,
      staggerKey: created.automation.id,
      after: enabledAt,
    });
    now = missedDueAt + 60_000;
    const relaunchedEngine = createAutomationEngine({
      ledger: new SqliteAutomationLedger(ctx.db),
      now: () => now,
      nextId: randomUUID,
    });
    const runs: string[] = [];
    const scheduler = createAutomationScheduler({
      now: () => now,
      listAutomations: () => Promise.resolve(listAutomationsForProject(ctx.db, project.id)),
      enabledAutomationIds: () => relaunchedEngine.enabledAutomationIds(),
      readCursors: () => Promise.resolve(readScheduleCursors(ctx.db)),
      advanceCursor: (input) => {
        advanceScheduleCursor(ctx.db, input, now);
        return Promise.resolve();
      },
      recordSkip: async (input) => {
        const outcome = await relaunchedEngine.recordSkip(input);
        if (!outcome.ok) throw new Error(outcome.error);
      },
      startRun: (input) => {
        runs.push(input.commandId);
        return Promise.resolve({ ok: true });
      },
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
    });

    await scheduler.start();

    expect(runs).toEqual([]);
    expect(listSkippedOccurrencesForProject(ctx.db, project.id)).toMatchObject([
      {
        automationId: created.automation.id,
        dueAt: missedDueAt,
        missedCount: 1,
        reason: { kind: "app-closed" },
      },
    ]);
  });

  it("refuses a schedule this build cannot read, rather than repairing it", async () => {
    const { project } = setup();
    // A zone no ICU knows. Degrading to "Nothing else" is the only safe
    // direction — inventing a zone would start unattended work at a time
    // nobody chose.
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Broken",
      instructions: "/sweep",
      trigger: {
        kind: "schedule",
        schedule: { preset: "daily", hour: 21, minute: 30, timeZone: "Mars/Olympus" },
      },
      runtime: null,
    });
    expect(created).toMatchObject({ ok: true, automation: { trigger: NO_AUTOMATION_TRIGGER } });
  });

  it("refuses a schedule on a globally listed Automation, at the write", async () => {
    setup();
    // A schedule Run's Target is the Project, and a global record names none.
    // The editor blocks Save on the same shared rule; this is main's own door.
    expect(
      await call<AutomationResult>("volli:automation-create", {
        commandId: randomUUID(),
        projectId: null,
        name: "Everywhere",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("one project") });
  });

  it("refuses an update that would put a schedule on a globally listed record", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: null,
      name: "Everywhere",
      instructions: "/sweep",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    expect(
      await call<AutomationResult>("volli:automation-update", {
        commandId: randomUUID(),
        automationId: created.automation.id,
        name: "Everywhere",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("one project") });
    // And the project-owned one is untouched by the rule.
    const owned = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly",
      instructions: "/sweep",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    if (!owned.ok) throw new Error("refused");
    expect(
      await call<AutomationResult>("volli:automation-update", {
        commandId: randomUUID(),
        automationId: owned.automation.id,
        name: "Nightly",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      }),
    ).toMatchObject({ ok: true, automation: { trigger: NIGHTLY } });
  });

  it("gives an update for a record that is gone the not-found refusal, not the Ownership one", async () => {
    setup();
    expect(
      await call<AutomationResult>("volli:automation-update", {
        commandId: randomUUID(),
        automationId: randomUUID(),
        name: "Gone",
        instructions: "/sweep",
        trigger: NIGHTLY,
        runtime: null,
      }),
    ).toMatchObject({ ok: false, error: "Unknown automation" });
  });

  it("replays a create carrying a schedule, through the same normalizer", async () => {
    // The widening is append-only, so the upgrade rule VC-128 established has
    // to hold for the new arm too: a retry of the same command with the same
    // schedule replays rather than conflicting.
    const { project } = setup();
    const commandId = randomUUID();
    const request = {
      commandId,
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    };
    const created = await call<AutomationResult>("volli:automation-create", request);
    const replayed = await call<AutomationResult>("volli:automation-create", request);
    expect(replayed).toEqual(created);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM automations").get()).toEqual({ n: 1 });
  });

  it("lists a project's Skipped occurrences, and guards the project id", async () => {
    const { project } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");

    // A schedule that has never missed anything is an empty list, not a
    // refusal — and it is project-guarded like every other history read, so an
    // unknown id says so rather than showing a convincing blank history.
    expect(
      await call<AutomationSkipsResult>("volli:automation-skips-for-project", {
        projectId: project.id,
      }),
    ).toEqual({ ok: true, skips: [] });
    expect(await call<Result>("volli:automation-skips-for-project", { projectId: "nope" })).toEqual(
      {
        ok: false,
        error: "Unknown project",
      },
    );
    expect(await call<Result>("volli:automation-skips-for-project", {})).toEqual({
      ok: false,
      error: "Invalid automation skips request",
    });
  });

  it("records a Skipped occurrence through the ledger, and replays a retried one", async () => {
    const { project, engine } = setup();
    const created = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: project.id,
      name: "Nightly sweep",
      instructions: "/sweep",
      trigger: NIGHTLY,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    const skip = {
      automationId: created.automation.id,
      automationName: created.automation.name,
      projectId: project.id,
      dueAt: 9_000,
      missedCount: 3,
      reason: { kind: "app-closed" as const },
    };
    // The command id the scheduler derives from the occurrence, so a crash
    // between noticing the gap and committing it records ONE row.
    const commandId = `${created.automation.id}:skip:9000`;
    const recorded = await engine.recordSkip({ commandId, skip });
    expect(recorded).toMatchObject({ ok: true, receipt: { status: "completed" } });
    const replayed = await engine.recordSkip({ commandId, skip });
    expect(replayed).toMatchObject({ ok: true, replayed: true });
    if (!recorded.ok || !replayed.ok) throw new Error("refused");
    expect(replayed.value).toEqual(recorded.value);
    expect(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM automation_skipped_occurrences").get(),
    ).toEqual({ n: 1 });

    const listed = await call<AutomationSkipsResult>("volli:automation-skips-for-project", {
      projectId: project.id,
    });
    expect(listed).toMatchObject({
      ok: true,
      skips: [{ automationName: "Nightly sweep", missedCount: 3, reason: { kind: "app-closed" } }],
    });
    // And the event is in the immutable history beside every other write.
    expect(
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_events WHERE kind = 'automation.skip.recorded'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("refuses a skip naming a record that is gone", async () => {
    const { project, engine } = setup();
    expect(
      await engine.recordSkip({
        commandId: randomUUID(),
        skip: {
          automationId: randomUUID(),
          automationName: "Ghost",
          projectId: project.id,
          dueAt: 1,
          missedCount: 1,
          reason: { kind: "app-closed" },
        },
      }),
    ).toMatchObject({ ok: false, error: "Unknown automation", receipt: { status: "rejected" } });
  });

  it("runs an Automation against the Project, and guards that door's shape", async () => {
    const receipt = {
      id: randomUUID(),
      commandId: randomUUID(),
      status: "completed" as const,
      recordedAt: 5_000,
    };
    const runner: AutomationRunner = {
      run: async () => ({ ok: false, code: "RUN_FAILED", error: "not this door" }),
      runForProject: async (input) => ({
        ok: true,
        run: {
          id: "run-project-1",
          automationId: input.automationId,
          automationName: "Nightly sweep",
          // No Ticket: a schedule Run's Target is the Project, so the Session
          // it opens is a Project Session.
          ticketId: null,
          sessionId: "session-project-1",
          model: PIN,
          attendance: input.attendance,
          createdAt: 5_000,
        },
        projectId: input.projectId,
        receipt,
      }),
      resumeDeliveryForSession: async () => undefined,
      recover: async () => undefined,
      settled: async () => undefined,
    };
    const { project } = setup({ runner });

    expect(
      await call<AutomationRunStartResult>("volli:automation-run-for-project", {
        commandId: randomUUID(),
        automationId: "automation-1",
        projectId: project.id,
      }),
    ).toMatchObject({
      ok: true,
      // ATTENDED: every IPC caller is a person — Skipped-occurrence Run now,
      // scheduled-page Play, or the palette. The schedule timer uses the same
      // runner method inside main, bypasses IPC, and passes `unattended`.
      run: { ticketId: null, sessionId: "session-project-1", attendance: "attended" },
    });

    // The Target is named rather than implied, so a request that forgot it is
    // refused at the door instead of quietly becoming a Project Session.
    expect(
      await call<Result>("volli:automation-run-for-project", {
        commandId: randomUUID(),
        automationId: "automation-1",
      }),
    ).toEqual({ ok: false, error: "Invalid automation run request" });
    expect(
      await call<Result>("volli:automation-run-for-project", {
        commandId: "c1",
        automationId: "automation-1",
        projectId: project.id,
      }),
    ).toEqual({ ok: false, error: "Invalid automation run request" });
  });

  it("says so when the Session runtime is down, on the Project door too", async () => {
    const { project } = setup();
    expect(
      await call<AutomationRunStartResult>("volli:automation-run-for-project", {
        commandId: randomUUID(),
        automationId: "automation-1",
        projectId: project.id,
      }),
    ).toEqual({
      ok: false,
      code: "RUN_FAILED",
      error: "The Session runtime is not available this launch.",
    });
  });
});

describe("the column's own order (VC-132)", () => {
  /** Two Automations offered in Doing, so a rank has something to arrange. */
  async function twoOffered() {
    const seeded = setup();
    const first = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: seeded.project.id,
      name: "First",
      instructions: "/review",
      trigger: { kind: "columns", columns: ["doing", "needs_review"] },
      runtime: null,
    });
    const second = await call<AutomationResult>("volli:automation-create", {
      commandId: randomUUID(),
      projectId: seeded.project.id,
      name: "Second",
      instructions: "/tdd",
      trigger: { kind: "columns", columns: ["doing"] },
      runtime: null,
    });
    if (!first.ok || !second.ok) throw new Error("refused");
    seeded.mutations.length = 0;
    return { ...seeded, first: first.automation, second: second.automation };
  }

  it("arranges a column through command → event → receipt, and answers with the whole set", async () => {
    const { project, first, second, mutations } = await twoOffered();

    expect(
      await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: [second.id, first.id],
      }),
    ).toMatchObject({
      ok: true,
      orders: [{ status: "doing", rankedAutomationIds: [second.id, first.id] }],
      receipt: { status: "completed" },
    });

    expect(
      await call<AutomationColumnOrdersResult>("volli:automation-column-order-list", {
        projectId: project.id,
      }),
    ).toMatchObject({
      ok: true,
      orders: [{ status: "doing", rankedAutomationIds: [second.id, first.id] }],
    });

    // Nothing about the shared record moved: an arrangement is this host's own
    // choice about its own board, exactly as the arming is.
    expect(mutations).toEqual([]);
    expect(
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_events WHERE kind = 'automation.column-order.changed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("keeps each column's rank to itself — one Automation, two ranks", async () => {
    const { project, first, second } = await twoOffered();
    await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
      commandId: randomUUID(),
      projectId: project.id,
      status: "doing",
      rankedAutomationIds: [second.id, first.id],
    });
    const both = await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
      commandId: randomUUID(),
      projectId: project.id,
      status: "needs_review",
      rankedAutomationIds: [first.id],
    });

    if (!both.ok) throw new Error("refused");
    expect(both.orders).toHaveLength(2);
    expect(both.orders.find((order) => order.status === "doing")?.rankedAutomationIds).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      both.orders.find((order) => order.status === "needs_review")?.rankedAutomationIds,
    ).toEqual([first.id]);
  });

  it("replays one arrangement command rather than arranging twice", async () => {
    const { project, first, second } = await twoOffered();
    const request = {
      commandId: "66666666-6666-4666-8666-666666666666",
      projectId: project.id,
      status: "doing",
      rankedAutomationIds: [second.id, first.id],
    };

    const once = await call<AutomationSetColumnOrderResult>(
      "volli:automation-set-column-order",
      request,
    );
    const twice = await call<AutomationSetColumnOrderResult>(
      "volli:automation-set-column-order",
      request,
    );

    expect(once).toMatchObject({ ok: true, receipt: { status: "completed" } });
    expect(twice).toEqual(once);
    expect(
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM automation_events WHERE kind = 'automation.column-order.changed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("tolerates a rank naming an Automation this column no longer offers", async () => {
    // A rank is a list every reader re-filters against the Offered list, so a
    // stale id is inert. Refusing it would make a lane un-arrangeable until
    // somebody found the row that had moved.
    const { project, first } = await twoOffered();
    expect(
      await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: ["ghost", first.id],
      }),
    ).toMatchObject({
      ok: true,
      orders: [{ rankedAutomationIds: ["ghost", first.id] }],
    });
  });

  it("refuses one Automation holding two ranks, and an unknown project", async () => {
    const { project, first } = await twoOffered();
    expect(
      await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: [first.id, first.id],
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/only one rank/) });
    expect(
      await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
        commandId: randomUUID(),
        projectId: "no-such-project",
        status: "doing",
        rankedAutomationIds: [],
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
    expect(
      await call<AutomationColumnOrdersResult>("volli:automation-column-order-list", {
        projectId: "no-such-project",
      }),
    ).toEqual({ ok: false, error: "Unknown project" });
    // Neither refusal recorded a command: the live-fact checks run before the
    // intent, exactly as create's and arm's do.
    expect(
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM automation_events WHERE kind LIKE 'automation.column%'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("clears a column's rank when the arrangement empties", async () => {
    const { project, first, second } = await twoOffered();
    await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
      commandId: randomUUID(),
      projectId: project.id,
      status: "doing",
      rankedAutomationIds: [second.id, first.id],
    });

    expect(
      await call<AutomationSetColumnOrderResult>("volli:automation-set-column-order", {
        commandId: randomUUID(),
        projectId: project.id,
        status: "doing",
        rankedAutomationIds: [],
      }),
    ).toMatchObject({ ok: true, orders: [] });
  });
});
