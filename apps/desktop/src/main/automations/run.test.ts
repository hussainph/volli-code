import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  expandCommandInvocation,
  NO_AUTOMATION_TRIGGER,
  SKILL_POLICY_DEFAULT,
} from "@volli/shared";
import type { ModelSelection, PromptResource, PromptTemplate, SkillReference } from "@volli/shared";

import { createAutomationEngine } from "./engine";
import { createAutomationRunner } from "./run";
import type { AutomationRunnerDeps } from "./run";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  getAutomation,
  listProjectRunsForAutomation,
  listRunsForTicket,
  recordAutomationRun,
} from "../db/automations-repo";
import { insertProject } from "../db/projects-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { StructuredSessionsError } from "../session-runtime/sessions";
import type { SessionStartInput } from "../session-runtime/sessions";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const RESOLVED: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

const TEMPLATE: PromptTemplate = {
  name: "review",
  description: "Review the change set",
  content: "Review this branch: $ARGUMENTS",
  source: "project",
};

const SKILL: SkillReference = {
  name: "tdd",
  description: "Red, green, refactor",
  body: "Write the failing test first.",
  authorPolicy: SKILL_POLICY_DEFAULT,
  effectivePolicy: SKILL_POLICY_DEFAULT,
  policyDiagnostic: null,
  root: ".agents/skills/tdd",
};

interface Harness {
  runner: ReturnType<typeof createAutomationRunner>;
  engine: ReturnType<typeof createAutomationEngine>;
  creates: SessionStartInput[];
  attaches: string[];
  delivered: Array<{
    sessionId: string;
    commandId: string;
    messageId: string;
    text: string;
    resources: readonly PromptResource[];
  }>;
  logs: string[];
  projectId: string;
  ticketId: string;
  attachState: "ready" | "needs-recovery";
}

function harness(overrides: Partial<AutomationRunnerDeps> = {}): Harness {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  // The fake Session facade below deliberately does not materialize Session
  // rows. Production's Session engine does, and the migration suite proves the
  // FK; tests of the Automation host only disable it around this fake edge.
  ctx.db.pragma("foreign_keys = OFF");

  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(ctx.db),
    now: () => 42_000,
    nextId: randomUUID,
  });
  const creates: SessionStartInput[] = [];
  const attaches: string[] = [];
  const delivered: Harness["delivered"] = [];
  const logs: string[] = [];
  const sessionsByOperation = new Map<string, string>();
  let nextSession = 0;
  let attachState: Harness["attachState"] = "ready";

  const runner = createAutomationRunner({
    engine,
    findAutomation: (automationId) => getAutomation(ctx.db, automationId),
    findTicket: (ticketId) => {
      const found = ticketId === ticket.id ? ticket : undefined;
      return found === undefined ? undefined : { id: found.id, projectId: found.projectId };
    },
    findProject: (candidate) => candidate === project.id,
    listRunsForTicket: (ticketId) => listRunsForTicket(ctx.db, ticketId),
    listProjectRunsForAutomation: (input) => listProjectRunsForAutomation(ctx.db, input),
    sessions: {
      create: async (input) => {
        creates.push(input);
        let sessionId = sessionsByOperation.get(input.operationId);
        if (sessionId === undefined) {
          sessionId = `session-${++nextSession}`;
          sessionsByOperation.set(input.operationId, sessionId);
          // The fake facade mints the Session ROW as well as the id, because a
          // Run that names no Ticket is scoped to its project through exactly
          // this row (`listProjectRunsForAutomation`) — a fake that skipped it
          // would leave the schedule's own single-flight guard untestable.
          insertSession(ctx.db, testSession(input.projectId, input.ticketId, { id: sessionId }));
        }
        return { sessionId, model: RESOLVED };
      },
      attach: async (input) => {
        attaches.push(input.sessionId);
        return {
          sessionId: input.sessionId,
          state: attachState,
          receipt: null,
          throughSequence: 0,
        };
      },
    },
    promptSupply: async () => ({ templates: [TEMPLATE], skills: [SKILL] }),
    deliverInstructions: async (input) => {
      delivered.push(input);
    },
    readSessionActivity: async () => "idle",
    log: (message) => logs.push(message),
    ...overrides,
  });

  return {
    runner,
    engine,
    creates,
    attaches,
    delivered,
    logs,
    projectId: project.id,
    ticketId: ticket.id,
    get attachState() {
      return attachState;
    },
    set attachState(value) {
      attachState = value;
    },
  };
}

async function savedAutomation(
  h: Harness,
  patch: Partial<{ name: string; instructions: string; runtime: ModelSelection | null }> = {},
) {
  const created = await h.engine.create({
    commandId: randomUUID(),
    projectId: h.projectId,
    name: "Two-opinion review",
    instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    ...patch,
  });
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

describe("createAutomationRunner", () => {
  it("accepts one durable Run plan, mints exactly one fresh Session, and delivers the composer's expansion", async () => {
    const h = harness();
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      projectId: h.projectId,
      ticketId: h.ticketId,
      title: "Two-opinion review",
      actor: { kind: "automation" },
    });
    expect(h.creates[0]?.modelOverride).toBeUndefined();
    expect(outcome.run).toMatchObject({
      automationId: automation.id,
      automationName: "Two-opinion review",
      ticketId: h.ticketId,
      sessionId: "session-1",
      model: RESOLVED,
    });
    expect(outcome.receipt.status).toBe("completed");
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([outcome.run]);

    const composer = expandCommandInvocation(automation.instructions, [TEMPLATE], [SKILL]);
    expect(h.attaches).toEqual(["session-1"]);
    expect(h.delivered).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        text: composer.text,
        resources: composer.resources,
      }),
    ]);
    expect(h.delivered[0]?.commandId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(h.delivered[0]?.messageId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("passes a pinned Runtime whole — model and reasoning together", async () => {
    const h = harness();
    const automation = await savedAutomation(h, {
      runtime: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
    });

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.creates[0]?.modelOverride).toEqual({
      model: { providerId: "openai", modelId: "gpt-5" },
      reasoningLevel: "medium",
    });
  });

  it("persists the first-message intent before success and resumes it after a ready recovery attach", async () => {
    const h = harness();
    h.attachState = "needs-recovery";
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    expect(h.delivered).toEqual([]);
    expect(
      ctx.db
        .prepare("SELECT delivered_at FROM automation_run_deliveries WHERE run_id = ?")
        .get(outcome.run.id),
    ).toEqual({ delivered_at: null });

    // Restart recovery finds the completed Run's delivery intent even though
    // there is no longer an accepted Run plan. It reattaches and uses the
    // persisted ids, rather than re-expanding/re-minting.
    h.attachState = "ready";
    await h.runner.recover();
    expect(h.delivered).toHaveLength(1);
    expect(
      ctx.db
        .prepare("SELECT delivered_at FROM automation_run_deliveries WHERE run_id = ?")
        .get(outcome.run.id),
    ).toEqual({ delivered_at: 42_000 });
  });

  it("recovers an accepted plan after a crash between Session mint and Run projection", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const accepted = await h.engine.acceptRun({
      commandId: randomUUID(),
      automation: { id: automation.id, name: automation.name, runtime: null },
      projectId: h.projectId,
      ticketId: h.ticketId,
      text: "Persisted instructions",
      resources: [],
    });
    expect(accepted.ok).toBe(true);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);

    await h.runner.recover();

    expect(h.creates).toHaveLength(1);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toHaveLength(1);
    expect(h.delivered).toEqual([
      expect.objectContaining({ text: "Persisted instructions", resources: [] }),
    ]);
  });

  it("replays one command id while its Session is working, without a second Session or first turn", async () => {
    let activity: "working" | "idle" = "idle";
    const h = harness({ readSessionActivity: async () => activity });
    const automation = await savedAutomation(h);
    const commandId = randomUUID();

    const first = await h.runner.run({
      commandId,
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();
    // The plan, not today's editable record, owns a retry. Deleting the
    // Automation after its Run started must not turn a lost IPC reply into an
    // AUTOMATION_NOT_FOUND refusal or change its Instructions.
    ctx.db.prepare("DELETE FROM automations WHERE id = ?").run(automation.id);
    activity = "working";
    const replay = await h.runner.run({
      commandId,
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();

    expect(first).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ ok: true });
    expect(h.creates).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toHaveLength(1);
  });

  it("checks every Run-owned Session and fails closed when a projection cannot be read", async () => {
    const activities = new Map<string, "working" | "waiting" | "idle" | null>([
      ["older", "working"],
      ["newer", "idle"],
    ]);
    const h = harness({ readSessionActivity: async (id) => activities.get(id) ?? null });
    const automation = await savedAutomation(h);
    recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: h.ticketId, sessionId: "older", model: RESOLVED },
      1,
    );
    recordAutomationRun(
      ctx.db,
      { automationId: automation.id, ticketId: h.ticketId, sessionId: "newer", model: RESOLVED },
      2,
    );

    await expect(
      h.runner.run({ commandId: randomUUID(), automationId: automation.id, ticketId: h.ticketId }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });

    activities.set("older", null);
    await expect(
      h.runner.run({ commandId: randomUUID(), automationId: automation.id, ticketId: h.ticketId }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });
  });

  it("does not reinterpret a corrupt stored Runtime as inheritance", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    ctx.db
      .prepare("UPDATE automations SET runtime = ? WHERE id = ?")
      .run('{"providerId":"anthropic"}', automation.id);

    await expect(
      h.runner.run({ commandId: randomUUID(), automationId: automation.id, ticketId: h.ticketId }),
    ).resolves.toMatchObject({
      ok: false,
      code: "RUN_FAILED",
      error: expect.stringMatching(/Runtime is invalid/),
    });
    expect(h.creates).toEqual([]);
  });

  it("keeps a later-unavailable pin on the existing Session failure path and records no Run projection", async () => {
    const h = harness({
      sessions: {
        create: async () => {
          throw new StructuredSessionsError(
            "MODEL_UNAVAILABLE",
            "Model openai/gpt-5 is not available.",
          );
        },
        attach: async () => ({
          sessionId: "never",
          state: "ready",
          receipt: null,
          throughSequence: 0,
        }),
      },
    });
    const automation = await savedAutomation(h, {
      runtime: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
    });

    const commandId = randomUUID();
    await expect(
      h.runner.run({ commandId, automationId: automation.id, ticketId: h.ticketId }),
    ).resolves.toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    // A lost response retries the same terminal receipt, not a generic
    // RUN_IN_FLIGHT refusal and not another Session-create attempt.
    await expect(
      h.runner.run({ commandId, automationId: automation.id, ticketId: h.ticketId }),
    ).resolves.toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);
  });

  it("keeps literal Instructions when the prompt supply cannot be read", async () => {
    const h = harness({
      promptSupply: async () => {
        throw new Error("directory unreadable");
      },
    });
    const automation = await savedAutomation(h);

    await h.runner.run({
      commandId: randomUUID(),
      automationId: automation.id,
      ticketId: h.ticketId,
    });
    await h.runner.settled();

    expect(h.delivered[0]?.text).toBe(automation.instructions);
    expect(h.delivered[0]?.resources).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/prompt supply/);
  });

  /* ------------------------- the Project as the Target (VC-130) --------- */

  it("opens a PROJECT Session for a Run that names no Ticket", async () => {
    const h = harness();
    const automation = await savedAutomation(h);

    const outcome = await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: automation.id,
      projectId: h.projectId,
    });
    await h.runner.settled();

    if (!outcome.ok) throw new Error("refused");
    // `ticketId: null` IS the Project Role in the Session layer, so a schedule
    // Run is a Project Session by construction rather than by a second flag.
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      projectId: h.projectId,
      ticketId: null,
      title: "Two-opinion review",
      actor: { kind: "automation" },
    });
    expect(outcome.run).toMatchObject({ ticketId: null, sessionId: "session-1" });
    // It is filed in the project's history through its Session, and it is not
    // on any Ticket's rail.
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);
    // The Instructions still arrive, by the same durable delivery intent.
    expect(h.delivered).toHaveLength(1);
  });

  it("replays a retried Project Run rather than opening a second Session", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    const first = await h.runner.runForProject({
      commandId,
      automationId: automation.id,
      projectId: h.projectId,
    });
    await h.runner.settled();
    const second = await h.runner.runForProject({
      commandId,
      automationId: automation.id,
      projectId: h.projectId,
    });
    await h.runner.settled();

    if (!first.ok || !second.ok) throw new Error("refused");
    expect(second.run).toEqual(first.run);
    expect(h.creates).toHaveLength(1);
  });

  it("refuses a Project Run whose command id was accepted for another Target", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    await h.runner.run({ commandId, automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    await expect(
      h.runner.runForProject({ commandId, automationId: automation.id, projectId: h.projectId }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
  });

  it("refuses a project this host does not have", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    await expect(
      h.runner.runForProject({
        commandId: randomUUID(),
        automationId: automation.id,
        projectId: "no-such-project",
      }),
    ).resolves.toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });
    expect(h.creates).toEqual([]);
  });

  it("refuses an Automation owned by another project", async () => {
    const h = harness();
    const created = await h.engine.create({
      commandId: randomUUID(),
      projectId: "elsewhere",
      name: "Far away",
      instructions: "/sweep",
      trigger: NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    if (!created.ok) throw new Error("refused");
    await expect(
      h.runner.runForProject({
        commandId: randomUUID(),
        automationId: created.value.id,
        projectId: h.projectId,
      }),
    ).resolves.toMatchObject({ ok: false, code: "AUTOMATION_NOT_IN_PROJECT" });
  });

  it("does not stack a schedule on itself while an earlier Run is still working", async () => {
    let activity: "working" | "idle" = "idle";
    const h = harness({ readSessionActivity: async () => activity });
    const automation = await savedAutomation(h);
    await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: automation.id,
      projectId: h.projectId,
    });
    await h.runner.settled();
    activity = "working";

    await expect(
      h.runner.runForProject({
        commandId: randomUUID(),
        automationId: automation.id,
        projectId: h.projectId,
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });
  });

  it("lets a DIFFERENT schedule fire in the same project and minute", async () => {
    // The single-flight subject for a Run with no Ticket is the schedule
    // itself, not the project: two Automations due at 09:00 are two Runs.
    let activity: "working" | "idle" = "idle";
    const h = harness({ readSessionActivity: async () => activity });
    const first = await savedAutomation(h, { name: "First" });
    const second = await savedAutomation(h, { name: "Second" });
    await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: first.id,
      projectId: h.projectId,
    });
    await h.runner.settled();
    activity = "working";

    const outcome = await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: second.id,
      projectId: h.projectId,
    });
    await h.runner.settled();
    expect(outcome.ok).toBe(true);
    expect(h.creates).toHaveLength(2);
  });
});
