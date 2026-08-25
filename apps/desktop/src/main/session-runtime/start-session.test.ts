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
import type { Project, Ticket, TicketEventActor } from "@volli/shared";

import type { SessionStartedNotice } from "../../ipc/contract";
import { getTicket, insertTicket } from "../db/tickets-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { StructuredSessionsError, type SessionStartInput } from "./sessions";
import { startSessionModelOverride, startSessionOperation } from "./start-session";

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

function harness(overrides: { state?: "ready" | "needs-recovery"; startError?: unknown } = {}): {
  project: Project;
  ticket: Ticket;
  ports: Parameters<typeof startSessionOperation>[0];
  startInputs: SessionStartInput[];
  kickoffs: { sessionId: string; text: string; commandId: string; messageId: string }[];
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
  const kickoffs: { sessionId: string; text: string; commandId: string; messageId: string }[] = [];
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
            receipt: null,
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
    },
    COMPOSE,
  );
}

describe("startSessionOperation", () => {
  it("starts through the product facade and answers with the Session it opened", async () => {
    const fixture = harness();

    const result = await start(fixture);

    expect(result).toEqual({
      sessionId: STARTED_SESSION,
      ticketDisplayId: "VC-1",
      state: "ready",
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
      title: "Work on VC-1",
    });
    expect(fixture.startInputs).toEqual([
      {
        operationId: "generated-1",
        projectId: "project-one",
        ticketId: "ticket-one",
        title: "Work on VC-1",
        actor: { kind: "session", sessionId: "caller", ticketId: null },
      },
    ]);
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
      },
    ]);
  });

  it("names the Session from a supplied kickoff and threads the model override", async () => {
    const fixture = harness();

    await start(fixture, {
      message: "Validate VC-52 before release",
      modelOverride: startSessionModelOverride(
        { providerId: "anthropic", modelId: "claude-opus" },
        "low",
      ),
    });

    expect(fixture.kickoffs).toEqual([
      {
        sessionId: STARTED_SESSION,
        text: "Validate VC-52 before release",
        commandId: "generated-1:kickoff",
        messageId: "generated-1:kickoff-message",
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

  it("makes zero refinement requests when the kickoff never went out", async () => {
    const fixture = harness({ state: "needs-recovery" });

    await start(fixture, { message: "Validate VC-52 before release" });

    // A Session held for recovery has not sent this message and may never
    // send it — titling from text nobody submitted would spend a model call
    // on a conversation that did not happen. Same gate as the kickoff itself.
    expect(fixture.kickoffs).toEqual([]);
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

  it("holds the kickoff back from a Session that needs recovery, but still reports it", async () => {
    const fixture = harness({ state: "needs-recovery" });

    const result = await start(fixture);

    expect(result).toMatchObject({ sessionId: STARTED_SESSION, state: "needs-recovery" });
    expect(fixture.kickoffs).toEqual([]);
    // The Session exists durably either way, so the surfaces still learn of it.
    expect(fixture.mutations).toHaveLength(1);
    expect(fixture.notices).toHaveLength(1);
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
