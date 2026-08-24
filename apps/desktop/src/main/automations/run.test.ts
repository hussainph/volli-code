import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { expandCommandInvocation } from "@volli/shared";
import type { ModelSelection, PromptResource, PromptTemplate, SkillReference } from "@volli/shared";

import { createAutomationRunner } from "./run";
import type { AutomationRunnerDeps } from "./run";
import { createAutomation, listRunsForTicket } from "../db/automations-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { StructuredSessionsError } from "../session-runtime/sessions";
import type { SessionStartInput } from "../session-runtime/sessions";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  userInvokeOnly: false,
  root: ".agents/skills/tdd",
};

interface Harness {
  runner: ReturnType<typeof createAutomationRunner>;
  creates: SessionStartInput[];
  attaches: string[];
  delivered: Array<{ sessionId: string; text: string; resources: readonly PromptResource[] }>;
  events: Array<{ runId: string; projectId: string }>;
  logs: string[];
  projectId: string;
  ticketId: string;
}

function harness(overrides: Partial<AutomationRunnerDeps> = {}): Harness {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);

  const creates: SessionStartInput[] = [];
  const attaches: string[] = [];
  const delivered: Harness["delivered"] = [];
  const events: Harness["events"] = [];
  const logs: string[] = [];
  let minted = 0;

  const runner = createAutomationRunner({
    db: ctx.db,
    sessions: {
      create: async (input) => {
        creates.push(input);
        minted += 1;
        return { sessionId: `session-${minted}`, model: RESOLVED };
      },
      attach: async (input) => {
        attaches.push(input.sessionId);
        return { sessionId: input.sessionId, state: "ready", receipt: null, throughSequence: 0 };
      },
    },
    promptSupply: async () => ({ templates: [TEMPLATE], skills: [SKILL] }),
    deliverInstructions: async (input) => {
      delivered.push(input);
    },
    readSessionActivity: async () => "idle",
    now: () => 42_000,
    onRunStarted: ({ run, projectId }) => events.push({ runId: run.id, projectId }),
    log: (message) => logs.push(message),
    ...overrides,
  });
  // The session rows the fake facade "mints" never hit SQLite, so the run
  // rows reference sessions the FK cannot see — disable enforcement for these
  // tests only; the migration suite proves the constraints themselves.
  ctx.db.pragma("foreign_keys = OFF");

  return {
    runner,
    creates,
    attaches,
    delivered,
    events,
    logs,
    projectId: project.id,
    ticketId: ticket.id,
  };
}

function savedAutomation(
  projectId: string | null,
  patch: Partial<Parameters<typeof createAutomation>[1]> = {},
) {
  return createAutomation(
    ctx.db,
    {
      projectId,
      name: "Two-opinion review",
      instructions: "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      runtime: null,
      ...patch,
    },
    1_000,
  );
}

describe("createAutomationRunner", () => {
  it("opens exactly one fresh Session whose first message is the Instructions, and records the Run", async () => {
    const h = harness();
    const automation = savedAutomation(h.projectId);

    const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("refused");
    // One fresh mint — never a wake — carrying the automation actor and the
    // Automation's own name as the protected title.
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      projectId: h.projectId,
      ticketId: h.ticketId,
      title: "Two-opinion review",
      actor: { kind: "automation" },
    });
    // Inherit passes NO override: the facade resolves the chain itself.
    expect(h.creates[0].modelOverride).toBeUndefined();
    // The Run row: UUID id, references, and the RESOLVED model.
    expect(outcome.run.id).toMatch(UUID_PATTERN);
    expect(outcome.run).toMatchObject({
      automationId: automation.id,
      ticketId: h.ticketId,
      sessionId: "session-1",
      model: RESOLVED,
      createdAt: 42_000,
    });
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([outcome.run]);
    expect(h.events).toEqual([{ runId: outcome.run.id, projectId: h.projectId }]);
    // The detached half attached the same Session and delivered the composer's
    // own expansion: template spliced, /skill kept as typed with its body as a
    // resource beside, @ref passing through as plain text.
    expect(h.attaches).toEqual(["session-1"]);
    const composer = expandCommandInvocation(
      "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
      [TEMPLATE],
      [SKILL],
    );
    expect(h.delivered).toEqual([
      { sessionId: "session-1", text: composer.text, resources: composer.resources },
    ]);
    expect(h.delivered[0].text).toBe(
      "Review this branch: src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
    );
    expect(h.delivered[0].resources.map((resource) => resource.name)).toEqual(["tdd"]);
  });

  it("passes a pinned Runtime whole — model and reasoning together — as the facade's override", async () => {
    const h = harness();
    const automation = savedAutomation(h.projectId, {
      runtime: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" },
    });

    const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.creates[0].modelOverride).toEqual({
      model: { providerId: "openai", modelId: "gpt-5" },
      reasoningLevel: "medium",
    });
  });

  it("refuses an unknown Automation, an unknown Ticket, and another project's Automation", async () => {
    const h = harness();
    const foreign = savedAutomation("some-other-project");

    expect(await h.runner.run({ automationId: "missing", ticketId: h.ticketId })).toMatchObject({
      ok: false,
      code: "AUTOMATION_NOT_FOUND",
    });
    const automation = savedAutomation(h.projectId);
    expect(await h.runner.run({ automationId: automation.id, ticketId: "missing" })).toMatchObject({
      ok: false,
      code: "TICKET_NOT_FOUND",
    });
    expect(await h.runner.run({ automationId: foreign.id, ticketId: h.ticketId })).toMatchObject({
      ok: false,
      code: "AUTOMATION_NOT_IN_PROJECT",
    });
    expect(h.creates).toHaveLength(0);
  });

  it("holds one Run in flight per Ticket: the boot latch refuses a second start", async () => {
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const h = harness({
      sessions: {
        create: async () => ({ sessionId: "session-slow", model: RESOLVED }),
        attach: async (input) => {
          await attachGate;
          return { sessionId: input.sessionId, state: "ready", receipt: null, throughSequence: 0 };
        },
      },
    });
    const automation = savedAutomation(h.projectId);

    const first = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    expect(first.ok).toBe(true);
    const second = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    expect(second).toMatchObject({ ok: false, code: "RUN_IN_FLIGHT" });

    releaseAttach();
    await h.runner.settled();
    // Once the boot settles and the last Run's Session reads idle, the Ticket
    // is free again.
    const third = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    expect(third.ok).toBe(true);
    await h.runner.settled();
  });

  it("refuses while the latest Run's Session is working or waiting — plumbing facts, not declarations", async () => {
    const activities: Array<"working" | "waiting" | "idle"> = ["working", "waiting", "idle"];
    const h = harness({
      readSessionActivity: async () => activities.shift() ?? "idle",
    });
    const automation = savedAutomation(h.projectId);
    const seeded = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    expect(seeded.ok).toBe(true);
    await h.runner.settled();

    // First re-run meets "working", second meets "waiting", third meets "idle".
    expect(await h.runner.run({ automationId: automation.id, ticketId: h.ticketId })).toMatchObject(
      { ok: false, code: "RUN_IN_FLIGHT" },
    );
    expect(await h.runner.run({ automationId: automation.id, ticketId: h.ticketId })).toMatchObject(
      { ok: false, code: "RUN_IN_FLIGHT" },
    );
    const allowed = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    expect(allowed.ok).toBe(true);
    await h.runner.settled();
  });

  it("maps the facade's refusals onto the existing error path — no silent fallback, no Run row", async () => {
    const failures = [
      new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", "Choose a default model."),
      new StructuredSessionsError("MODEL_UNAVAILABLE", "Model openai/gpt-5 is not available."),
      new StructuredSessionsError("MODEL_SELECTION_REJECTED", "Could not record."),
      new Error("socket exploded"),
    ];
    const h = harness({
      sessions: {
        create: async () => {
          throw failures.shift();
        },
        attach: async () => {
          throw new Error("never reached");
        },
      },
    });
    const automation = savedAutomation(h.projectId);
    const run = () => h.runner.run({ automationId: automation.id, ticketId: h.ticketId });

    expect(await run()).toMatchObject({ ok: false, code: "MODEL_REQUIRED" });
    expect(await run()).toMatchObject({ ok: false, code: "MODEL_UNAVAILABLE" });
    expect(await run()).toMatchObject({ ok: false, code: "RUN_FAILED" });
    expect(await run()).toMatchObject({ ok: false, code: "RUN_FAILED", error: "socket exploded" });
    expect(listRunsForTicket(ctx.db, h.ticketId)).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("holds the Instructions when the attach needs recovery — the Session's own Retry surface owns it", async () => {
    const h = harness({
      sessions: {
        create: async () => ({ sessionId: "session-1", model: RESOLVED }),
        attach: async (input) => ({
          sessionId: input.sessionId,
          state: "needs-recovery",
          receipt: null,
          throughSequence: 0,
        }),
      },
    });
    const automation = savedAutomation(h.projectId);

    const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    // The Run and its Session exist durably; only the delivery waited.
    expect(outcome.ok).toBe(true);
    expect(h.delivered).toEqual([]);
    expect(listRunsForTicket(ctx.db, h.ticketId)).toHaveLength(1);
  });

  it("logs a detached delivery failure instead of losing it silently", async () => {
    const h = harness({
      deliverInstructions: async () => {
        throw new Error("runtime refused the turn");
      },
    });
    const automation = savedAutomation(h.projectId);

    const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.logs.join("\n")).toMatch(/could not deliver its Instructions/);
    expect(h.logs.join("\n")).toMatch(/runtime refused the turn/);
  });

  it("sends Instructions exactly as typed when the prompt supply cannot be read", async () => {
    const h = harness({
      promptSupply: async () => {
        throw new Error("directory unreadable");
      },
    });
    const automation = savedAutomation(h.projectId);

    const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
    await h.runner.settled();

    expect(outcome.ok).toBe(true);
    expect(h.delivered[0].text).toBe(
      "/review src/a.ts\nAlso /tdd please, and read @docs/DESIGN.md",
    );
    expect(h.delivered[0].resources).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/prompt supply/);
  });

  it("falls back to console.error when no log seam is supplied", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = harness({
        log: undefined,
        promptSupply: async () => {
          throw new Error("directory unreadable");
        },
      });
      const automation = savedAutomation(h.projectId);
      const outcome = await h.runner.run({ automationId: automation.id, ticketId: h.ticketId });
      await h.runner.settled();
      expect(outcome.ok).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
