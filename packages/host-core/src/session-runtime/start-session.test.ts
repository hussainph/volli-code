/**
 * The one application act behind every door that starts a Ticket Session.
 *
 * These assertions used to ride the socket verb, in `agent-commands.test.ts`'s
 * `describe("session.start")`. VC-163 removed that door — `session.start` is
 * control tier now, a named tool in the `project` Role's bundle and absent from
 * the agent socket — so the coverage moved here rather than leaving with the
 * envelope that used to carry it.
 *
 * Testing the act directly is what the two-door design was for. The socket
 * wrapper and the tool door were always thin: argv or tool input in, a wire
 * envelope or a sentence out. Everything that decides what a start MEANS — the
 * kickoff and its derived turn ids, the heuristic title, when a model
 * refinement is worth spending, which surfaces hear about it, and what a
 * recovery-held Session withholds — lives in `startSessionOperation` and is
 * shared. What stayed with the doors is tested with the doors:
 * `agent-tool-door.test.ts` proves the tool binds its caller rather than
 * believing one.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { autoTitleFromKickoff, DEFAULT_KICKOFF_MESSAGE } from "@volli/shared";
import type {
  CommandReceipt,
  Project,
  SessionOrigin,
  Ticket,
  TicketEventActor,
} from "@volli/shared";

import type { SessionStartedNotice } from "@volli/shared";
import { getTicket, insertTicket } from "../db/tickets-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { StructuredSessionsError, type SessionStartInput } from "./sessions";
import {
  KickoffRefusedError,
  kickoffSubmitter,
  startSessionModelOverride,
  startSessionOperation,
} from "./start-session";

let ctx: TestDb | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const STARTED_SESSION = "abcdef12-3456-7890-abcd-ef1234567890";

const COMPOSE = {
  defaultKickoff: DEFAULT_KICKOFF_MESSAGE,
  autoTitle: autoTitleFromKickoff,
};

function harness(
  overrides: {
    state?: "ready" | "needs-recovery";
    receipt?: CommandReceipt | null;
    startError?: unknown;
  } = {},
): {
  project: Project;
  ticket: Ticket;
  ports: Parameters<typeof startSessionOperation>[0];
  startInputs: SessionStartInput[];
  kickoffs: Parameters<
    NonNullable<Parameters<typeof startSessionOperation>[0]["submitSessionMessage"]>
  >[0][];
  refinements: { sessionId: string; firstMessage: string; heuristicTitle: string }[];
  mutations: unknown[];
  notices: SessionStartedNotice[];
} {
  ctx = openTestDb();
  const project = testProject({
    id: "project-one",
    name: "Volli Code",
    path: "/repo/volli",
    ticketPrefix: "VC",
  });
  insertProject(ctx.db, project);
  const ticket = testTicket("project-one", {
    id: "ticket-one",
    ticketNumber: 1,
    title: "Ship CLI",
  });
  insertTicket(ctx.db, ticket);

  const startInputs: SessionStartInput[] = [];
  const kickoffs: ReturnType<typeof harness>["kickoffs"] = [];
  const refinements: { sessionId: string; firstMessage: string; heuristicTitle: string }[] = [];
  const mutations: unknown[] = [];
  const notices: SessionStartedNotice[] = [];

  return {
    project,
    ticket,
    startInputs,
    kickoffs,
    refinements,
    mutations,
    notices,
    ports: {
      db: ctx.db,
      projects: [project],
      sessions: {
        start: async (input: SessionStartInput) => {
          startInputs.push(input);
          if (overrides.startError !== undefined) throw overrides.startError;
          return {
            sessionId: STARTED_SESSION,
            state: overrides.state ?? ("ready" as const),
            receipt: overrides.receipt ?? null,
            throughSequence: 2,
            model: {
              providerId: "openai-codex",
              modelId: "gpt-5.6-sol",
              reasoningLevel: "high" as const,
            },
          };
        },
      },
      submitSessionMessage: async (input) => {
        kickoffs.push(input);
      },
      refineAutoTitle: (input) => refinements.push(input),
      onMutation: (change) => mutations.push(change),
      onSessionStarted: (notice) => notices.push(notice),
      actorTicketDisplay: () => null,
      now: () => 1_000,
    },
  };
}

/** One start with the fixture's project and ticket, and an explicit actor. */
async function start(
  fixture: ReturnType<typeof harness>,
  input: {
    operationId?: string;
    message?: string;
    title?: string;
    modelOverride?: ReturnType<typeof startSessionModelOverride>;
    actor?: TicketEventActor;
    origin?: SessionOrigin;
  } = {},
) {
  return startSessionOperation(
    fixture.ports,
    {
      operationId: input.operationId ?? "generated-1",
      project: fixture.project,
      ticket: fixture.ticket,
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
      actor: input.actor ?? { kind: "session", sessionId: "caller", ticketId: null },
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    },
    COMPOSE,
  );
}

describe("startSessionOperation", () => {
  it.each([
    { actor: { kind: "user" } as TicketEventActor, expected: { kind: "user" } },
    { actor: { kind: "automation" } as TicketEventActor, expected: undefined },
    { actor: { kind: "unauthenticated" } as TicketEventActor, expected: undefined },
  ])(
    "uses Actor attribution consistently for birth and kickoff: $actor.kind",
    async ({ actor, expected }) => {
      const fixture = harness();
      await start(fixture, { actor });
      expect(fixture.startInputs[0]?.origin).toEqual(expected);
      expect(fixture.kickoffs[0]).toHaveProperty("origin", expected);
    },
  );

  it("keeps explicit Run origin for both birth and kickoff over legacy automation attribution", async () => {
    const fixture = harness();
    const origin: SessionOrigin = {
      kind: "automation",
      automationRunId: "run",
      automationName: "Review",
    };
    await start(fixture, { actor: { kind: "automation" }, origin });
    expect(fixture.startInputs[0]?.origin).toEqual(origin);
    expect(fixture.kickoffs[0]).toHaveProperty("origin", origin);
  });
  it("starts through the product facade and answers with the Session it opened", async () => {
    const fixture = harness();

    const result = await start(fixture);

    expect(result).toEqual({
      sessionId: STARTED_SESSION,
      ticketDisplayId: "VC-1",
      state: "ready",
      kickoff: "submitted",
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
      title: "Work on VC-1",
    });
    expect(fixture.startInputs).toEqual([
      {
        operationId: "generated-1",
        projectId: "project-one",
        ticketId: "ticket-one",
        role: "ticket",
        title: "Work on VC-1",
        actor: { kind: "session", sessionId: "caller", ticketId: null },
        origin: { kind: "session", sessionId: "caller" },
      },
    ]);
  });

  it("offers the caller's own message to an automatic model choice, and the stock kickoff nothing (VC-432)", async () => {
    const fixture = harness();

    await start(fixture, { message: "Fix the flaky login test" });
    await start(fixture, { operationId: "generated-2" });

    expect(fixture.startInputs[0]?.autoSelect).toEqual({ request: "Fix the flaky login test" });
    expect(fixture.startInputs[1]).not.toHaveProperty("autoSelect");
  });

  it("submits the default kickoff turn once the attach is ready", async () => {
    const fixture = harness();

    await start(fixture);

    // The turn's ids are DERIVED from the start's operation id, never minted at
    // the delivery seam (VC-162). The Session Engine deduplicates a
    // `message.submit` on its command id, so this is the whole mechanism that
    // makes a replayed start submit one kickoff instead of two.
    expect(fixture.kickoffs).toEqual([
      {
        sessionId: STARTED_SESSION,
        text: DEFAULT_KICKOFF_MESSAGE,
        commandId: "generated-1:kickoff",
        messageId: "generated-1:kickoff-message",
        origin: { kind: "session", sessionId: "caller" },
      },
    ]);
  });

  it("names the Session from a supplied kickoff and threads the model override", async () => {
    const fixture = harness();

    await start(fixture, {
      message: "Validate VC-52 before release",
      modelOverride: startSessionModelOverride(
        { model: { providerId: "anthropic", modelId: "claude-opus" } },
        "low",
      ),
    });

    expect(fixture.kickoffs).toEqual([
      {
        sessionId: STARTED_SESSION,
        text: "Validate VC-52 before release",
        commandId: "generated-1:kickoff",
        messageId: "generated-1:kickoff-message",
        origin: { kind: "session", sessionId: "caller" },
      },
    ]);
    expect(fixture.startInputs[0]).toMatchObject({
      title: "Validate VC-52",
      modelOverride: {
        model: { providerId: "anthropic", modelId: "claude-opus" },
        reasoningLevel: "low",
      },
    });
  });

  it("uses an explicit title unchanged instead of replacing a chosen name", async () => {
    const fixture = harness();

    await start(fixture, { message: "Validate VC-52 before release", title: "My review" });

    expect(fixture.startInputs[0]).toMatchObject({ title: "My review" });
  });

  it("requests one model refinement behind a heuristic kickoff title", async () => {
    const fixture = harness();

    await start(fixture, { message: "Validate VC-52 before release" });

    expect(fixture.refinements).toEqual([
      {
        sessionId: STARTED_SESSION,
        firstMessage: "Validate VC-52 before release",
        heuristicTitle: "Validate VC-52",
      },
    ]);
  });

  it("refines the stock kickoff too, from the message it actually sent", async () => {
    const fixture = harness();

    await start(fixture);

    expect(fixture.refinements).toEqual([
      {
        sessionId: STARTED_SESSION,
        firstMessage: DEFAULT_KICKOFF_MESSAGE,
        heuristicTitle: "Work on VC-1",
      },
    ]);
  });

  it("makes zero refinement requests for an explicit title", async () => {
    const fixture = harness();

    await start(fixture, { title: "My review" });

    expect(fixture.refinements).toEqual([]);
  });

  it("makes zero refinement requests while the kickoff is only held", async () => {
    const fixture = harness({ state: "needs-recovery" });

    await start(fixture, { message: "Validate VC-52 before release" });

    // A Session held for recovery has not run this message and may never run
    // it — titling from text no turn has read would spend a model call on a
    // conversation that has not happened. Same gate as the kickoff itself.
    expect(fixture.kickoffs.map(({ delivery }) => delivery)).toEqual(["queue"]);
    expect(fixture.refinements).toEqual([]);
  });

  it("announces the start to every surface without moving the board", async () => {
    const fixture = harness();

    await start(fixture, { actor: { kind: "user" } });

    expect(fixture.mutations).toEqual([
      { ticketId: "ticket-one", projectId: "project-one", kind: "session" },
    ]);
    expect(fixture.notices).toEqual([
      {
        sessionId: STARTED_SESSION,
        projectId: "project-one",
        ticketId: "ticket-one",
        ticketDisplayId: "VC-1",
        actor: "user",
        actorTicket: null,
        at: 1_000,
      },
    ]);
    expect(getTicket(ctx!.db, "ticket-one")?.status).toBe("backlog");
  });

  it("carries the actor its door derived, and cites that actor's own ticket", async () => {
    const fixture = harness();
    fixture.ports.actorTicketDisplay = (ticketId) => (ticketId === "ticket-two" ? "VC-2" : null);

    await start(fixture, {
      actor: { kind: "session", sessionId: "driver", ticketId: "ticket-two" },
    });

    expect(fixture.startInputs[0]).toMatchObject({
      actor: { kind: "session", sessionId: "driver", ticketId: "ticket-two" },
    });
    expect(fixture.notices[0]).toMatchObject({ actor: "session", actorTicket: "VC-2" });
  });

  it("holds the kickoff of a Session that needs recovery under the ids a ready start spends (VC-799)", async () => {
    const fixture = harness({ state: "needs-recovery" });

    const result = await start(fixture, { operationId: "op-1", message: "Fix the flaky test" });

    expect(result).toMatchObject({
      sessionId: STARTED_SESSION,
      state: "needs-recovery",
      attachFailure: "the attach reported no receipt",
      kickoff: "held",
    });
    // Queued in the Session's own durable follow-up queue, which releases it at
    // the next ready attach (the app's Retry), so the Retry runs it.
    expect(fixture.kickoffs).toEqual([
      {
        sessionId: STARTED_SESSION,
        text: "Fix the flaky test",
        commandId: "op-1:kickoff",
        messageId: "op-1:kickoff-message",
        origin: { kind: "session", sessionId: "caller" },
        delivery: "queue",
      },
    ]);
    // The Session exists durably either way, so the surfaces still learn of it.
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.notices).toHaveLength(1);
  });

  describe("says why the attach was not ready (VC-659)", () => {
    const receipt = { id: "receipt-1", commandId: "start-1", recordedAt: 10, sequence: 10 };
    it.each([
      [
        "the rejection's own diagnosis",
        {
          ...receipt,
          status: "rejected" as const,
          code: "location_unavailable",
          detail:
            "Couldn't prepare the worktree at /w/VC-1 — on branch other; this ticket's branch is volli/VC-1-ship-cli.",
        },
        "Couldn't prepare the worktree at /w/VC-1 — on branch other; this ticket's branch is volli/VC-1-ship-cli.",
      ],
      [
        "the rejection code when it has no detail",
        { ...receipt, status: "rejected" as const, code: "attach_failed", detail: null },
        "attach_failed",
      ],
      [
        "a receipt that never reconciled",
        { ...receipt, status: "unreconciled" as const, detail: null },
        "the attach is unreconciled",
      ],
    ])("with %s", async (_label, refused, failure) => {
      const fixture = harness({ state: "needs-recovery", receipt: refused });

      const result = await start(fixture);

      expect(result).toMatchObject({ state: "needs-recovery", attachFailure: failure });
      // Whatever refused the attach, the kickoff is held for the Retry (VC-799).
      expect(fixture.kickoffs.map(({ delivery }) => delivery)).toEqual(["queue"]);
    });
  });

  it("says a needs-recovery kickoff was not held when the queue refused it, and logs why", async () => {
    const fixture = harness({ state: "needs-recovery" });
    fixture.ports.submitSessionMessage = async () => {
      throw new Error("The kickoff was refused (session_archived)");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await start(fixture);

      expect(result).toMatchObject({ state: "needs-recovery", kickoff: "unsent" });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("has nothing to hold a kickoff with when no runtime delivers one", async () => {
    const fixture = harness({ state: "needs-recovery" });
    delete fixture.ports.submitSessionMessage;

    expect(await start(fixture)).toMatchObject({ state: "needs-recovery", kickoff: "unsent" });
  });

  // Refusals are deliberately NOT translated here: the socket had a fixed
  // error-code vocabulary and the tool door has only text a model reads, so
  // collapsing them into one wording in this module would have made one of the
  // two worse. What this proves is that the error arrives intact for each door
  // to render, and that nothing was announced on the way out.
  it("lets a facade refusal travel out intact, announcing nothing", async () => {
    const thrown = new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", "Choose a default model.");
    const fixture = harness({ startError: thrown });

    await expect(start(fixture)).rejects.toBe(thrown);
    expect(fixture.kickoffs).toEqual([]);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.notices).toEqual([]);
  });

  it("threads a tier through as the override's tier half, with its level beside it", async () => {
    // VC-259: the door hands the facade a KIND of work, and the facade is the
    // one that resolves it — this module only carries the choice across.
    const fixture = harness();

    await start(fixture, { modelOverride: startSessionModelOverride({ tier: "deep" }, "high") });

    expect(fixture.startInputs[0]).toMatchObject({
      modelOverride: { tier: "deep", reasoningLevel: "high" },
    });
  });

  it("survives a kickoff the runtime refuses after the Session is open", async () => {
    const fixture = harness();
    fixture.ports.submitSessionMessage = async () => {
      throw new Error("attachment closed");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await start(fixture);

      expect(result).toMatchObject({ sessionId: STARTED_SESSION });
      // Drain the detached kickoff so its failure lands in the log, not the run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

/** A runtime that answers every command with `receipt`, recording what it was sent. */
function kickoffRuntime(receipt: Record<string, unknown> | null) {
  const commands: unknown[] = [];
  return {
    commands,
    submit: kickoffSubmitter({
      command: async (request) => {
        commands.push(request);
        return { receipt } as never;
      },
    }),
  };
}

/**
 * The kickoff port every start door is handed. It reads the receipt the
 * runtime answers with, so a kickoff refused on a READY attach is reported
 * rather than silent (VC-799).
 */
describe("kickoffSubmitter", () => {
  const runtime = kickoffRuntime;
  const input = {
    sessionId: STARTED_SESSION,
    text: "work",
    commandId: "op:kickoff",
    messageId: "op:kickoff-message",
  };

  it("submits one user message under the caller's ids, and settles on an accepted receipt", async () => {
    const r = runtime({ status: "accepted" });

    await expect(r.submit(input)).resolves.toBeUndefined();

    expect(r.commands).toEqual([
      {
        origin: undefined,
        commandId: "op:kickoff",
        sessionId: STARTED_SESSION,
        command: {
          kind: "message.submit",
          message: {
            id: "op:kickoff-message",
            role: "user",
            parts: [{ type: "text", text: "work" }],
          },
        },
      },
    ]);
  });

  it("asks the runtime to queue it when told to hold it", async () => {
    const r = runtime({ status: "accepted" });

    await r.submit({ ...input, delivery: "queue" });

    expect(r.commands[0]).toMatchObject({ command: { kind: "message.submit", delivery: "queue" } });
  });

  it("rejects with the refusal's own words when the runtime refused the kickoff", async () => {
    await expect(
      runtime({ status: "rejected", code: "no_live_executor", detail: "No live executor" }).submit(
        input,
      ),
    ).rejects.toThrow("The kickoff was refused (no_live_executor): No live executor");
    await expect(
      runtime({ status: "rejected", code: "session_archived", detail: null }).submit(input),
    ).rejects.toThrow("The kickoff was refused (session_archived)");
    // A distinct error, so a caller can tell a durable refusal from a lost send.
    await expect(
      runtime({ status: "rejected", code: "session_archived", detail: null }).submit(input),
    ).rejects.toBeInstanceOf(KickoffRefusedError);
  });
});

/**
 * The override a door hands the facade, built from what it validated. One
 * builder for both doors, so the shape `SessionModelOverride` types — a model
 * OR a tier, a level beside either — is spelled once.
 */
describe("startSessionModelOverride", () => {
  it("builds nothing from nothing", () => {
    expect(startSessionModelOverride(undefined, undefined)).toBeUndefined();
  });

  it("carries a bare level onto whichever base the facade reads", () => {
    expect(startSessionModelOverride(undefined, "low")).toEqual({ reasoningLevel: "low" });
  });

  it("builds a model pin, with or without a level", () => {
    const model = { providerId: "anthropic", modelId: "claude-opus" };
    expect(startSessionModelOverride({ model }, undefined)).toEqual({ model });
    expect(startSessionModelOverride({ model }, "high")).toEqual({ model, reasoningLevel: "high" });
  });

  it("builds a tier choice, with or without a level (VC-259)", () => {
    expect(startSessionModelOverride({ tier: "fast" }, undefined)).toEqual({ tier: "fast" });
    expect(startSessionModelOverride({ tier: "visual" }, "medium")).toEqual({
      tier: "visual",
      reasoningLevel: "medium",
    });
  });
});
