import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  expandCommandInvocation,
  NO_AUTOMATION_TRIGGER,
  SKILL_POLICY_DEFAULT,
} from "@volli/shared";
import type {
  CommandReceipt,
  ModelSelection,
  PromptResource,
  PromptTemplate,
  SkillReference,
} from "@volli/shared";

import { createAutomationEngine } from "./engine";
import type { AutomationRunPlan } from "./engine";
import { createAutomationRunner } from "./run";
import type { AutomationRunnerDeps } from "./run";
import { SqliteAutomationLedger } from "./sqlite-ledger";
import {
  getAutomation,
  listAutomationsForProject,
  listProjectRunsForAutomation,
  listRunsForTicket,
  recordAutomationRun,
} from "../db/automations-repo";
import { listTicketEvents, recordSessionStartedOnce } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { readSessionProvenance } from "../db/session-provenance-repo";
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
  /** What a refused attach answered with, which is the Run's whole diagnosis. */
  attachReceipt: CommandReceipt | null;
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
  let attachReceipt: CommandReceipt | null = null;

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
          receipt: attachReceipt,
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
    get attachReceipt() {
      return attachReceipt;
    },
    set attachReceipt(value) {
      attachReceipt = value;
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
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
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

  // VC-131's fourth acceptance criterion, end to end across the two pieces that
  // make it true: the Run door hands `mint` the `automation` Actor, and `mint`
  // records the launch on the Ticket. Production wires those together in
  // `index.ts` (`recordSessionStarted: recordSessionStartedOnce`), so the fake
  // Session facade here does the same thing with the actor it is handed rather
  // than asserting on the argument alone — an argument nobody wrote down is not
  // a timeline entry.
  it("records each Run's launch on the Ticket timeline, with the automation Actor", async () => {
    const h = harness({
      sessions: {
        create: async (input) => {
          const sessionId = `session-${input.operationId}`;
          if (input.ticketId !== null) {
            recordSessionStartedOnce(ctx.db, {
              ticketId: input.ticketId,
              sessionId,
              now: 42_000,
              actor: input.actor ?? { kind: "user" },
            });
          }
          return { sessionId, model: RESOLVED };
        },
        attach: async (input) => ({
          sessionId: input.sessionId,
          state: "ready" as const,
          receipt: null,
          throughSequence: 0,
        }),
      },
    });
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();
    if (!outcome.ok) throw new Error(outcome.error);

    const started = listTicketEvents(ctx.db, h.ticketId).filter(
      (event) => event.payload.kind === "session_started",
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.actor).toBe("automation");
    expect(started[0]?.payload).toEqual({
      kind: "session_started",
      sessionId: outcome.run.sessionId,
    });

    // And the same launch, read back as the mark every listing draws. The bolt
    // and the timeline entry are two readings of one Run, which is the point of
    // deriving provenance from the records rather than storing it a third time.
    expect(
      readSessionProvenance(ctx.db, {
        sessionId: outcome.run.sessionId,
        ticketId: h.ticketId,
      }),
    ).toEqual({ kind: "automation", automationName: "Two-opinion review" });
  });

  it("passes a pinned Runtime whole — model and reasoning together", async () => {
    const h = harness();
    const automation = await savedAutomation(h, {
      runtime: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
    });

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.creates[0]?.modelOverride).toEqual({
      model: { providerId: "openai", modelId: "gpt-5" },
      reasoningLevel: "medium",
      // And recorded rather than validated: see the unavailable-pin case below.
      whenUnavailable: "record",
    });
  });

  it("persists the first-message intent before success and resumes it after a ready recovery attach", async () => {
    const h = harness();
    h.attachState = "needs-recovery";
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
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
      automation: { id: automation.id, name: automation.name },
      runtime: null,
      request: { instructions: null, modelOverride: null },
      projectId: h.projectId,
      ticketId: h.ticketId,
      text: "Persisted instructions",
      resources: [],
      attendance: "attended",
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
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();
    // The plan, not today's editable record, owns a retry. Deleting the
    // Automation after its Run started must not turn a lost IPC reply into an
    // AUTOMATION_NOT_FOUND refusal or change its Instructions.
    ctx.db.prepare("DELETE FROM automations WHERE id = ?").run(automation.id);
    activity = "working";
    const replay = await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
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
      h.runner.run({
        commandId: randomUUID(),
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });

    activities.set("older", null);
    await expect(
      h.runner.run({
        commandId: randomUUID(),
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });
  });

  it("does not reinterpret a corrupt stored Runtime as inheritance", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    ctx.db
      .prepare("UPDATE automations SET runtime = ? WHERE id = ?")
      .run('{"providerId":"anthropic"}', automation.id);

    await expect(
      h.runner.run({
        commandId: randomUUID(),
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "RUN_FAILED",
      error: expect.stringMatching(/Runtime is invalid/),
    });
    expect(h.creates).toEqual([]);
  });

  it("opens a Session for a pin that has become unavailable, instead of refusing at the door", async () => {
    // VC-112: "a pinned model that has since become unavailable does not
    // silently fall back — let the Session fail through the existing error
    // path rather than building a second failure surface", and VC-133: that
    // Run "lands in `error` and is covered by the same rule".
    //
    // Neither is reachable from a door-time refusal, because a refusal creates
    // nothing to land in `error` and nothing to notify about. So this door
    // asks the Session facade to RECORD the Runtime, and the attach raises the
    // `configuration_invalid` Attention that is `error`. The unattended doors
    // are why it matters: a refusal returned to the schedule timer or to
    // another Session's tool call is a sentence nobody reads.
    const h = harness();
    const automation = await savedAutomation(h, {
      runtime: { providerId: "retired-provider", modelId: "retired-model", reasoningLevel: "high" },
    });

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "unattended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.creates[0]?.modelOverride).toEqual({
      model: { providerId: "retired-provider", modelId: "retired-model" },
      reasoningLevel: "high",
      whenUnavailable: "record",
    });
    // A Run row exists, bound to a Session — which is the thing a person can
    // open, the thing the dot reads, and the thing the notification names.
    // (What that recorded selection then IS, the Session facade answers, and
    // `sessions.test.ts` pins it; this fake echoes its own resolved model.)
    const [run] = listRunsForTicket(ctx.db, h.ticketId);
    expect(run?.sessionId).toBe("session-1");
    expect(listRunsForTicket(ctx.db, h.ticketId)).toHaveLength(1);
  });

  it("still speaks plainly if the Session facade refuses an unavailable model anyway", async () => {
    // The door no longer asks for validation, but `Sessions` is a port: an
    // implementation that refuses regardless must still produce this Run
    // vocabulary rather than a `RUN_FAILED` shrug, and the refusal must be
    // terminal so a lost response replays the receipt instead of minting a
    // second Session.
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
      h.runner.run({
        commandId,
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    await expect(
      h.runner.run({
        commandId,
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);
  });

  it("runs UNBOUND Instructions that name no Automation and leave no record behind", async () => {
    const h = harness();

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "unbound", instructions: "/review src/a.ts once" },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    // Names no Automation, in the Run and in the Session it opened. The only
    // name either wears is the constant every surface prints for one.
    expect(outcome.run).toMatchObject({
      automationId: null,
      automationName: null,
      ticketId: h.ticketId,
      sessionId: "session-1",
    });
    expect(h.creates[0]).toMatchObject({ title: "Run once", actor: { kind: "automation" } });
    // Nothing to name, disable or delete afterwards: the record table is
    // untouched, and the Run is the whole of what was saved.
    expect(listAutomationsForProject(ctx.db, h.projectId)).toEqual([]);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([outcome.run]);
    // Its Instructions still go through the composer's own grammar.
    const composer = expandCommandInvocation("/review src/a.ts once", [TEMPLATE], [SKILL]);
    expect(h.delivered).toEqual([
      expect.objectContaining({ text: composer.text, resources: composer.resources }),
    ]);
  });

  it("refuses an Unbound Run with nothing to say, and mints no Session for it", async () => {
    const h = harness();

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "unbound", instructions: "   \n " },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });

    expect(outcome).toMatchObject({ ok: false, code: "INSTRUCTIONS_REQUIRED" });
    expect(h.creates).toEqual([]);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);
  });

  it("spends a per-invocation override on this Run and stores it nowhere", async () => {
    const h = harness();
    const automation = await savedAutomation(h, {
      runtime: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
    });

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      attendance: "attended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    // The Session is born on the override, not on the record's own pin...
    expect(h.creates[0]?.modelOverride).toEqual({
      model: { providerId: "anthropic", modelId: "claude-opus" },
      reasoningLevel: "high",
      whenUnavailable: "record",
    });
    // ...and the record keeps the Runtime it was saved with.
    expect(getAutomation(ctx.db, automation.id)?.runtime).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
      reasoningLevel: "medium",
    });
  });

  it("gives an Unbound Run the override it names, and inherit without one", async () => {
    const h = harness();

    await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "unbound", instructions: "sweep" },
      ticketId: h.ticketId,
      modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      attendance: "attended",
    });
    await h.runner.settled();

    expect(h.creates[0]?.modelOverride).toEqual({
      model: { providerId: "anthropic", modelId: "claude-opus" },
      reasoningLevel: "high",
      whenUnavailable: "record",
    });
  });

  it("replays one Unbound Run command instead of starting a second Session", async () => {
    const h = harness();
    const commandId = randomUUID();
    const request = {
      commandId,
      target: { kind: "unbound", instructions: "sweep" } as const,
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended" as const,
    };

    const first = await h.runner.run(request);
    await h.runner.settled();
    const replayed = await h.runner.run(request);
    await h.runner.settled();

    expect(first.ok && replayed.ok).toBe(true);
    if (!first.ok || !replayed.ok) throw new Error("refused");
    expect(replayed.run).toEqual(first.run);
    expect(h.creates).toHaveLength(1);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([first.run]);
  });

  it("refuses to reuse one command id for a different target", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();

    await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    await expect(
      h.runner.run({
        commandId,
        target: { kind: "unbound", instructions: "something else entirely" },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
    expect(h.creates).toHaveLength(1);
  });

  it("refuses to reuse one command id for DIFFERENT Unbound Instructions", async () => {
    // Both Runs name no Automation, so the record alone cannot tell them apart:
    // what distinguishes them is the only thing either of them said.
    const h = harness();
    const commandId = randomUUID();

    const first = await h.runner.run({
      commandId,
      target: { kind: "unbound", instructions: "sweep the diff" },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    await expect(
      h.runner.run({
        commandId,
        target: { kind: "unbound", instructions: "sweep the WHOLE repository" },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
    // The first Run stands, alone: a conflict starts nothing and undoes nothing.
    expect(h.creates).toHaveLength(1);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("refused");
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([first.run]);
  });

  it("refuses to reuse one command id for a different per-invocation override", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();

    await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      attendance: "attended",
    });
    await h.runner.settled();

    // Same Automation, same Ticket, another model — a second Run, and it must
    // not be answered with the first one's Session.
    await expect(
      h.runner.run({
        commandId,
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" },
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
    // And dropping the override entirely is a different request too.
    await expect(
      h.runner.run({
        commandId,
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: null,
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
    expect(h.creates).toHaveLength(1);
  });

  it("replays the receipt when the SAME override is retried under one command id", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    const request = {
      commandId,
      target: { kind: "automation", automationId: automation.id } as const,
      ticketId: h.ticketId,
      modelOverride: {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      } as const,
      attendance: "attended" as const,
    };

    const first = await h.runner.run(request);
    await h.runner.settled();
    const replayed = await h.runner.run(request);
    await h.runner.settled();

    expect(first.ok && replayed.ok).toBe(true);
    if (!first.ok || !replayed.ok) throw new Error("refused");
    expect(replayed.run).toEqual(first.run);
    expect(h.creates).toHaveLength(1);
  });

  it("reads a plan written before the request identity existed as the request it was", async () => {
    // The ledger is append-only and older than VC-129: a plan accepted then
    // carries no `request` at all, so this seeds one exactly as that release
    // would have left it — an accepted command whose Session never got minted.
    // Its caller's retry must still replay, rather than be told its own command
    // id belongs to a different Run.
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    const legacyPlan = {
      commandId,
      runId: randomUUID(),
      automationId: automation.id,
      automationName: automation.name,
      projectId: h.projectId,
      ticketId: h.ticketId,
      runtime: null,
      text: "Persisted instructions",
      resources: [],
      sessionOperationId: randomUUID(),
      messageCommandId: randomUUID(),
      messageId: randomUUID(),
    } as unknown as AutomationRunPlan;
    await new SqliteAutomationLedger(ctx.db).transaction(async (tx) => {
      await tx.insertCommand({
        id: commandId,
        intent: { kind: "automation.run", plan: legacyPlan },
        createdAt: 1,
      });
      await tx.appendReceipt({
        id: randomUUID(),
        commandId,
        status: "accepted",
        result: { kind: "automation.run.accepted", plan: legacyPlan },
        recordedAt: 1,
      });
    });

    const replayed = await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    expect(replayed).toMatchObject({ ok: true });
    if (!replayed.ok) throw new Error("refused");
    expect(replayed.run).toMatchObject({ id: legacyPlan.runId, automationId: automation.id });
    // Read as the request it was, not as a wildcard: a retry that now names an
    // override is a different Run under the same id, and still refuses.
    await expect(
      h.runner.run({
        commandId,
        target: { kind: "automation", automationId: automation.id },
        ticketId: h.ticketId,
        modelOverride: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" },
        attendance: "attended",
      }),
    ).resolves.toMatchObject({ ok: false, code: "RUN_FAILED" });
    expect(h.creates).toHaveLength(1);
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
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
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
      attendance: "attended",
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
      attendance: "attended",
    });
    await h.runner.settled();
    const second = await h.runner.runForProject({
      commandId,
      automationId: automation.id,
      projectId: h.projectId,
      attendance: "attended",
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
    await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    await expect(
      h.runner.runForProject({
        commandId,
        automationId: automation.id,
        projectId: h.projectId,
        attendance: "attended",
      }),
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
        attendance: "attended",
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
        attendance: "attended",
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
      attendance: "attended",
    });
    await h.runner.settled();
    activity = "working";

    await expect(
      h.runner.runForProject({
        commandId: randomUUID(),
        automationId: automation.id,
        projectId: h.projectId,
        attendance: "attended",
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
      attendance: "attended",
    });
    await h.runner.settled();
    activity = "working";

    const outcome = await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: second.id,
      projectId: h.projectId,
      attendance: "attended",
    });
    await h.runner.settled();
    expect(outcome.ok).toBe(true);
    expect(h.creates).toHaveLength(2);
  });
});

/**
 * VC-220: a Run opened its Session and the kickoff never fired.
 *
 * Every Run door in the product funnels into the two methods below, so the
 * doors are pinned HERE rather than through five app runs: the renderer's
 * surfaces (the Ticket page's Run button, the rail's split button and its "Run
 * once", the board card's menu, the armed column's drop window, the palette)
 * all reach `volli:automation-run` → `run()` and differ only in the Target and
 * the per-invocation Runtime they name; the schedule timer and "Run now" on a
 * Skipped occurrence reach `runForProject()`; the agent verb reaches `run()`
 * unattended. What each door owes is identical and is what was missing: the
 * composed Instructions, delivered as the Session's FIRST turn, under the
 * Run's own durable message ids.
 */
describe("every Run door delivers its Instructions as the kickoff turn (VC-220)", () => {
  const doors = [
    {
      door: "the page Run button, the rail's split button, the board card, the armed column, the palette",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      open: (h: Harness, automationId: string) =>
        h.runner.run({
          commandId: randomUUID(),
          target: { kind: "automation", automationId },
          ticketId: h.ticketId,
          modelOverride: null,
          attendance: "attended",
        }),
    },
    {
      door: "a door that spends a different Runtime on this one Run",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      open: (h: Harness, automationId: string) =>
        h.runner.run({
          commandId: randomUUID(),
          target: { kind: "automation", automationId },
          ticketId: h.ticketId,
          modelOverride: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
          attendance: "attended",
        }),
    },
    {
      door: "the rail's Run once, whose Instructions no record supplies",
      instructions: "/review src/a.ts once, and read @docs/DESIGN.md",
      open: (h: Harness) =>
        h.runner.run({
          commandId: randomUUID(),
          target: {
            kind: "unbound",
            instructions: "/review src/a.ts once, and read @docs/DESIGN.md",
          },
          ticketId: h.ticketId,
          modelOverride: null,
          attendance: "attended",
        }),
    },
    {
      door: "the agent verb, with nobody at the door",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      open: (h: Harness, automationId: string) =>
        h.runner.run({
          commandId: randomUUID(),
          target: { kind: "automation", automationId },
          ticketId: h.ticketId,
          modelOverride: null,
          attendance: "unattended",
        }),
    },
    {
      door: "the schedule timer",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      open: (h: Harness, automationId: string) =>
        h.runner.runForProject({
          commandId: randomUUID(),
          automationId,
          projectId: h.projectId,
          attendance: "unattended",
        }),
    },
    {
      door: "Run now on a Skipped occurrence",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      open: (h: Harness, automationId: string) =>
        h.runner.runForProject({
          commandId: randomUUID(),
          automationId,
          projectId: h.projectId,
          attendance: "attended",
        }),
    },
  ];

  for (const { door, instructions, open } of doors) {
    it(door, async () => {
      const h = harness();
      const automation = await savedAutomation(h);

      const outcome = await open(h, automation.id);
      await h.runner.settled();

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("refused");
      // The Session was attached before anything was sent — an unattached
      // Session is where the kickoff went missing.
      expect(h.attaches).toEqual([outcome.run.sessionId]);
      // Exactly one turn, carrying the composer's expansion of what this door
      // asked for, addressed to the Session this Run opened.
      const composer = expandCommandInvocation(instructions, [TEMPLATE], [SKILL]);
      expect(h.delivered).toEqual([
        expect.objectContaining({
          sessionId: outcome.run.sessionId,
          text: composer.text,
          resources: composer.resources,
        }),
      ]);
      // Under the Run's own durable ids, so a crash between here and the
      // adapter replays this turn rather than sending a second one — and the
      // intent is marked delivered only now that it has been.
      const stored = ctx.db
        .prepare(
          "SELECT message_command_id, message_id, delivered_at FROM automation_run_deliveries WHERE run_id = ?",
        )
        .get(outcome.run.id);
      expect(stored).toEqual({
        message_command_id: h.delivered[0]?.commandId,
        message_id: h.delivered[0]?.messageId,
        delivered_at: 42_000,
      });
    });
  }

  it("says so when the attach that would have delivered them is refused", async () => {
    // The owner's Run, at the seam. Its Session was minted, its attach was
    // rejected — an unpreparable worktree — and the boot half returned without
    // a word: the door had already answered `ok`, the Run row linked to a
    // Session with nothing in it, and there was no line anywhere saying why.
    //
    // The intent is deliberately still owed (the attach failed, not the
    // delivery), so the Session's own Retry and the next launch's recovery
    // sweep can still land it under the same ids. What is no longer allowed is
    // the silence — and beneath this seam the refused attach leaves the Session
    // carrying a failure Attention, which is the `error` VC-133's notification
    // rule fires on (`session-runtime.ts`, `session-need.ts`).
    const h = harness();
    h.attachState = "needs-recovery";
    h.attachReceipt = {
      id: "receipt-1",
      commandId: "start-1",
      status: "rejected",
      code: "location_unavailable",
      detail: "Couldn't prepare the worktree at /w/VC-1 — no such table: blob_links",
      recordedAt: 10,
      sequence: 10,
    };
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "unattended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    expect(h.delivered).toEqual([]);
    expect(h.logs).toEqual([
      `[volli] automation Run ${outcome.run.id} could not attach its Session: Couldn't prepare the worktree at /w/VC-1 — no such table: blob_links`,
    ]);
    expect(
      ctx.db
        .prepare("SELECT delivered_at FROM automation_run_deliveries WHERE run_id = ?")
        .get(outcome.run.id),
    ).toEqual({ delivered_at: null });
  });

  it("names an attach that answered nothing it could quote", async () => {
    // A port is allowed to answer `needs-recovery` without a receipt — the
    // legacy/test seams do. There is still no first turn, so there is still a
    // line; it just cannot pretend to a diagnosis it was not given.
    const h = harness();
    h.attachState = "needs-recovery";
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    if (!outcome.ok) throw new Error("refused");
    expect(h.logs).toEqual([
      `[volli] automation Run ${outcome.run.id} could not attach its Session: the attach reported no receipt`,
    ]);
  });

  it("names an attach that neither opened nor refused", async () => {
    const h = harness();
    h.attachState = "needs-recovery";
    h.attachReceipt = {
      id: "receipt-2",
      commandId: "start-2",
      status: "unreconciled",
      detail: null,
      recordedAt: 11,
      sequence: 11,
    };
    const automation = await savedAutomation(h);

    const outcome = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();

    if (!outcome.ok) throw new Error("refused");
    expect(h.logs).toEqual([
      `[volli] automation Run ${outcome.run.id} could not attach its Session: the attach is unreconciled`,
    ]);
  });
});

describe("Run attendance (VC-133)", () => {
  it("carries the door's answer onto the durable plan and the completed Run", async () => {
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();

    const outcome = await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "unattended",
    });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.run.attendance).toBe("unattended");
    // On the PLAN as well as the Run: the plan is durable first, and it is what
    // a crash recovery replays after the door that knew this is gone.
    expect((await h.engine.runPlan(commandId))?.attendance).toBe("unattended");
    expect(listRunsForTicket(ctx.db, h.ticketId)[0]?.attendance).toBe("unattended");
  });

  it("keeps the Project door's two callers apart", async () => {
    // Same Automation, same schedule, same Project Session — and a person at
    // one of the two doors. This is why attendance cannot be derived from the
    // Automation's Trigger.
    const h = harness();
    const automation = await savedAutomation(h);

    const scheduled = await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: automation.id,
      projectId: h.projectId,
      attendance: "unattended",
    });
    await h.runner.settled();
    expect(scheduled.ok && scheduled.run.attendance).toBe("unattended");

    const byHand = await h.runner.runForProject({
      commandId: randomUUID(),
      automationId: automation.id,
      projectId: h.projectId,
      attendance: "attended",
    });
    await h.runner.settled();
    expect(byHand.ok && byHand.run.attendance).toBe("attended");
  });

  it("recovers a crashed unattended Run as unattended", async () => {
    // The reason this is durable at all. `recover()` replays an accepted plan
    // in a LATER process; an in-memory set of unattended Session ids would have
    // answered "attended" here, silently and only after a crash.
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    await h.engine.acceptRun({
      commandId,
      automation: { id: automation.id, name: automation.name },
      runtime: null,
      request: { instructions: null, modelOverride: null },
      projectId: h.projectId,
      ticketId: h.ticketId,
      attendance: "unattended",
      text: "sweep",
      resources: [],
    });

    await h.runner.recover();
    await h.runner.settled();

    expect(listRunsForTicket(ctx.db, h.ticketId)[0]?.attendance).toBe("unattended");
  });

  it("replays a plan older than attendance as attended", async () => {
    // The upgrade-day case. A plan written before VC-133 has no such field;
    // reading it literally would put `undefined` on a Run. Written as a legacy
    // ROW rather than by ageing a current one, because the ledger enforces
    // command immutability with a trigger — which is the guarantee that makes
    // normalizing on READ the only available answer.
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();
    const legacyPlan = {
      commandId,
      runId: randomUUID(),
      automationId: automation.id,
      automationName: automation.name,
      projectId: h.projectId,
      ticketId: h.ticketId,
      runtime: null,
      request: { instructions: null, modelOverride: null },
      text: "sweep",
      resources: [],
      sessionOperationId: randomUUID(),
      messageCommandId: randomUUID(),
      messageId: randomUUID(),
    };
    ctx.db
      .prepare("INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)")
      .run(commandId, JSON.stringify({ kind: "automation.run", plan: legacyPlan }), 1000);

    expect(Object.hasOwn(legacyPlan, "attendance")).toBe(false);
    expect((await h.engine.runPlan(commandId))?.attendance).toBe("attended");
  });

  it("does not refuse a retry whose door disagrees with the stored plan", async () => {
    // Attendance is a fact about the DOOR, not about the work, so it is
    // deliberately outside the replay-identity comparison. Comparing it would
    // break upgrade day exactly the way VC-128's widened Trigger did: a legacy
    // schedule plan normalizes to `attended`, and the scheduler's own retry of
    // that occurrence would then be refused as a different intent, forever.
    const h = harness();
    const automation = await savedAutomation(h);
    const commandId = randomUUID();

    const first = await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();
    const replayed = await h.runner.run({
      commandId,
      target: { kind: "automation", automationId: automation.id },
      ticketId: h.ticketId,
      modelOverride: null,
      attendance: "unattended",
    });
    await h.runner.settled();

    expect(first.ok && replayed.ok).toBe(true);
    if (!first.ok || !replayed.ok) throw new Error("refused");
    // Same Run, and the stored plan's answer wins rather than the retry's.
    expect(replayed.run).toEqual(first.run);
    expect(replayed.run.attendance).toBe("attended");
  });
});
