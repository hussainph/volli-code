/**
 * The Agent Tool Surface's door into main (VC-162).
 *
 * What is proved here is what makes this door different from the socket, not
 * that a Session starts — the product start route is VC-13's and is tested
 * beside the facade. Three properties:
 *
 * 1. The caller is bound, not claimed. Nothing in the tool's input names a
 *    Session, a project or an actor, and the door reads none.
 * 2. The caller's project is a bound. A Ticket in another project is not a
 *    candidate, so it cannot be named.
 * 3. Replaying one tool call is one act. Every durable write is keyed on an
 *    operation id derived from the caller plus the runtime's own call id.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_AUTHORITY_POLICY } from "@volli/shared";
import type { RuntimeSessionIdentity } from "@volli/shared";

import type { SessionStartedNotice } from "../ipc/contract";

import { createAgentToolDoor } from "./agent-tool-door";
import type { AgentToolDoorOptions } from "./agent-tool-door";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertProject, listProjects } from "./db/projects-repo";
import { insertTicket } from "./db/tickets-repo";
import type { SessionStartInput } from "./session-runtime/sessions";
import { StructuredSessionsError } from "./session-runtime/sessions";

let ctx: TestDb | undefined;

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const STARTED_SESSION = "abcdef12-3456-7890-abcd-ef1234567890";

/** The Project Session doing the calling — identity the adapter closed over. */
const CALLER: RuntimeSessionIdentity = {
  role: "project",
  sessionId: "caller-session",
  rootThreadId: "thread-1",
  attachmentId: "attachment-1",
  projectId: "project-one",
  ticketId: null,
};

function harness(overrides: { startError?: unknown } = {}) {
  ctx = openTestDb();
  insertProject(
    ctx.db,
    testProject({ id: "project-one", name: "Volli Code", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertProject(
    ctx.db,
    testProject({ id: "project-two", name: "Other", path: "/repo/other", ticketPrefix: "OT" }),
  );
  insertTicket(
    ctx.db,
    testTicket("project-one", { id: "ticket-one", ticketNumber: 1, title: "Ship CLI" }),
  );
  insertTicket(
    ctx.db,
    testTicket("project-two", { id: "ticket-two", ticketNumber: 7, title: "Elsewhere" }),
  );
  const startInputs: SessionStartInput[] = [];
  const kickoffs: { sessionId: string; text: string; commandId: string; messageId: string }[] = [];
  const notices: SessionStartedNotice[] = [];
  const db = ctx.db;
  const door = createAgentToolDoor({
    db,
    projects: () => listProjects(db),
    sessions: () => ({
      start: async (input: SessionStartInput) => {
        startInputs.push(input);
        if (overrides.startError !== undefined) throw overrides.startError;
        return {
          sessionId: STARTED_SESSION,
          state: "ready" as const,
          receipt: null,
          throughSequence: 2,
          model: {
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            reasoningLevel: "high" as const,
          },
        };
      },
    }),
    submitSessionMessage: async (input) => {
      kickoffs.push(input);
    },
    onSessionStarted: (notice) => notices.push(notice),
    actorTicketDisplay: () => null,
    now: () => 1_000,
    // `ticket.await`'s ports, inert for the start-tool suite: its own suite
    // (`agent-await.test.ts`) drives them with real fakes.
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    subscribeTicketWake: () => () => undefined,
    // Supervision's ports likewise: `supervise-session.test.ts` drives the
    // operations; this suite proves only the door — identity binding, wording,
    // and the no-runtime refusal (which is what `null` exercises).
    supervise: () => null,
  });
  const call = (input: Record<string, unknown>, toolCallId = "tc-0") =>
    door(CALLER, { verb: "session.start", input, toolCallId }, new AbortController().signal);
  return { call, door, startInputs, kickoffs, notices };
}

describe("session_start through the Agent Tool Surface", () => {
  it("starts a Ticket Session on the caller's project without touching the socket", async () => {
    const h = harness();

    const result = await h.call({ ticket: "VC-1", message: "Fix the flaky auth test" });

    expect(result.text).toContain("Started Session abcdef12 on VC-1");
    expect(result.text).toContain("openai-codex/gpt-5.6-sol");
    // The public short handle, never a full UUID: no other Volli surface takes
    // one back, so handing a model one would be handing it an unusable id.
    expect(result.text).not.toContain(STARTED_SESSION);
    expect(h.startInputs).toHaveLength(1);
    expect(h.startInputs[0]).toMatchObject({
      projectId: "project-one",
      ticketId: "ticket-one",
      title: "Fix the flaky auth test",
    });
  });

  it("binds the caller instead of believing one", async () => {
    const h = harness();

    // Every field an attacker would want to set is either absent from the
    // schema or ignored. The project and the actor come from the attachment.
    await h.call({
      ticket: "VC-1",
      projectId: "project-two",
      actor: { kind: "user" },
      sessionId: "somebody-else",
    });

    expect(h.startInputs[0]?.projectId).toBe("project-one");
    expect(h.startInputs[0]?.actor).toEqual({
      kind: "session",
      sessionId: "caller-session",
      ticketId: null,
    });
  });

  it("cannot name a Ticket outside the calling Session's project", async () => {
    const h = harness();

    // OT-7 exists and is real. It is not a candidate, because the caller's
    // project is the only project resolution ever sees.
    const result = await h.call({ ticket: "OT-7" });

    expect(result.text).toContain("No Ticket OT-7 in this project");
    expect(h.startInputs).toEqual([]);
  });

  it("derives the operation id from the caller and the runtime's own call id", async () => {
    const h = harness();

    await h.call({ ticket: "VC-1" }, "tc-9");

    // Trusted caller identity plus `toolCallId`, never a fresh random id.
    // `SessionEngine.createSession` deduplicates durably on the command id
    // derived from this, which is the whole of the replay guarantee.
    expect(h.startInputs[0]?.operationId).toBe("caller-session:tc-9");
    expect(h.kickoffs).toHaveLength(1);
    expect(h.kickoffs[0]).toMatchObject({
      sessionId: STARTED_SESSION,
      commandId: "caller-session:tc-9:kickoff",
      messageId: "caller-session:tc-9:kickoff-message",
    });
  });

  it("replays one tool call as one operation, not two", async () => {
    const h = harness();

    await h.call({ ticket: "VC-1" }, "tc-3");
    await h.call({ ticket: "VC-1" }, "tc-3");

    // The door itself does not remember; it does not have to. Both attempts
    // carry the same operation id, so the ledger collapses them — one Session,
    // one kickoff turn, one `session_started`.
    expect(h.startInputs.map((input) => input.operationId)).toEqual([
      "caller-session:tc-3",
      "caller-session:tc-3",
    ]);
    expect(new Set(h.kickoffs.map((kickoff) => kickoff.commandId))).toEqual(
      new Set(["caller-session:tc-3:kickoff"]),
    );
  });

  it("refuses in words the model can act on, never by throwing", async () => {
    for (const input of [
      {},
      { ticket: "" },
      { ticket: "VC-1", message: "   " },
      { ticket: "VC-1", model: { providerId: "anthropic" } },
      { ticket: "VC-1", reasoning: "telepathic" },
    ]) {
      const h = harness();
      const result = await h.call(input);
      expect(result.text.length).toBeGreaterThan(0);
      expect(h.startInputs).toEqual([]);
    }
  });

  it("passes a facade refusal through as the model's answer", async () => {
    const h = harness({
      startError: new StructuredSessionsError(
        "DEFAULT_MODEL_REQUIRED",
        "Choose a default model in Settings first.",
      ),
    });

    const result = await h.call({ ticket: "VC-1" });

    expect(result.text).toContain("Choose a default model in Settings first.");
  });

  it("fails the call when the host could not answer at all", async () => {
    // The line `web_fetch` draws: a refusal is the policy working and the model
    // can act on it; anything else is a host that broke, and that is a failed
    // tool call rather than a verdict about the request.
    const h = harness({ startError: new Error("the database is gone") });

    await expect(h.call({ ticket: "VC-1" })).rejects.toThrow("the database is gone");
  });
});

// The supervision pair (VC-86). The operations' own semantics — resolution,
// precedence, runtime acts — are `supervise-session.test.ts`'s; what is proved
// here is the DOOR: the caller and its project are bound not believed, the
// operation id is derived, refusals are words, and a host without a runtime
// refuses rather than breaks.
describe("session_stop and session_send through the Agent Tool Surface", () => {
  const TARGET_SESSION = "bbbbbbbb-0000-0000-0000-000000000000";

  function superviseHarness() {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", name: "Volli", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const stops: unknown[] = [];
    const sends: unknown[] = [];
    const db = ctx.db;
    const door = createAgentToolDoor({
      db,
      projects: () => listProjects(db),
      sessions: () => null,
      actorTicketDisplay: () => null,
      now: () => 1_000,
      authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
      subscribeTicketWake: () => () => undefined,
      supervise: () =>
        ({
          sessionEngine: {
            listSessions: async () => [
              {
                session: {
                  id: TARGET_SESSION,
                  projectId: "project-one",
                  ticketId: null,
                  title: "Implementer",
                  createdAt: 1,
                },
                status: "open",
                commands: [],
                receipts: [],
                pendingExecutorStart: null,
                attachments: [
                  {
                    id: "attachment-1",
                    sessionId: TARGET_SESSION,
                    adapterId: "pi",
                    venue: { id: "local", kind: "local" },
                    continuity: "fresh",
                    native: null,
                    authority: null,
                    status: "open",
                    openedAt: 1,
                    closedAt: null,
                    outcome: null,
                    failure: null,
                  },
                ],
                liveExecutor: null,
                attention: { active: [], primary: null },
                interactions: { active: [], resolved: [] },
                signal: null,
                stopped: null,
                modelSelection: null,
                turnActive: true,
                authorityDenials: 0,
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  meteredOperations: 0,
                  unreportedOperations: 0,
                  knownCostUsd: null,
                  costBasis: "unavailable",
                  costCoverage: "unavailable",
                },
                lastActivityAt: 1,
                bornTicketless: true,
              },
            ],
            submit: async (request: unknown) => {
              stops.push(request);
              return {};
            },
          },
          runtime: {
            command: async (request: unknown) => {
              sends.push(request);
              return {};
            },
          },
        }) as unknown as ReturnType<AgentToolDoorOptions["supervise"]>,
    });
    const call = (verb: "session.stop" | "session.send", input: Record<string, unknown>) =>
      door(CALLER, { verb, input, toolCallId: "tc-9" }, new AbortController().signal);
    return { call, stops, sends };
  }

  it("binds the caller as the stop's actor and derives the operation id", async () => {
    const h = superviseHarness();

    const result = await h.call("session.stop", {
      session: TARGET_SESSION.slice(0, 8),
      reason: "Wedged",
      // Ignored: the schema has no field for identity, and the door reads none.
      callerSessionId: "somebody-else",
      projectId: "project-two",
    });

    expect(result.text).toContain("Stopped Session bbbbbbbb");
    expect(result.text).toContain('"Implementer"');
    expect(h.stops[0]).toMatchObject({
      commandId: "caller-session:tc-9",
      sessionId: TARGET_SESSION,
      intent: {
        kind: "session.stop",
        reason: "Wedged",
        by: { kind: "session", sessionId: "caller-session" },
      },
    });
  });

  it("marks a sent message as steering from the calling Session", async () => {
    const h = superviseHarness();

    const result = await h.call("session.send", {
      session: TARGET_SESSION.slice(0, 8),
      message: "Use the thinking-orbs library",
    });

    expect(result.text).toContain("Steering delivered into Session bbbbbbbb");
    expect(result.text).toContain("mid-stream");
    const submitted = h.sends.find(
      (request) => (request as { command?: { kind?: string } }).command?.kind === "message.submit",
    ) as { commandId: string; command: { delivery: string; message: { parts: unknown[] } } };
    expect(submitted.commandId).toBe("caller-session:tc-9");
    expect(submitted.command.delivery).toBe("steer");
    expect(submitted.command.message.parts[0]).toMatchObject({
      text: expect.stringContaining("Steering from supervising Session caller-s"),
    });
  });

  it("refuses field mistakes and a host without a runtime in words, never throws", async () => {
    const h = superviseHarness();
    for (const [verb, input] of [
      ["session.stop", {}],
      ["session.stop", { session: "   " }],
      ["session.send", { session: "bbbbbbbb" }],
      ["session.send", { session: "bbbbbbbb", message: " " }],
    ] as const) {
      const result = await h.call(verb, { ...input });
      expect(result.text.length).toBeGreaterThan(0);
    }
    expect(h.stops).toEqual([]);

    // No runtime this launch: the start-suite harness wires `supervise: () =>
    // null`, and both tools answer in words.
    const degraded = harness();
    const stop = await degraded.door(
      CALLER,
      { verb: "session.stop", input: { session: "bbbbbbbb" }, toolCallId: "tc-1" },
      new AbortController().signal,
    );
    expect(stop.text).toContain("not available this launch");
  });
});
