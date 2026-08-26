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
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertProject, listProjects } from "./db/projects-repo";
import { insertTicket } from "./db/tickets-repo";
import type { TicketSessionDelegationClaims } from "./session-runtime/delegation-policy";
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

const TICKET_CALLER: RuntimeSessionIdentity = {
  role: "ticket",
  sessionId: "ticket-caller-session",
  rootThreadId: "thread-2",
  attachmentId: "attachment-2",
  projectId: "project-one",
  ticketId: "ticket-one",
};

/**
 * The ledger a Ticket caller born with the Role default would meet.
 *
 * `startGrantScope` answers null by default because that is what a genuine
 * Project Session's row says: it was never born with a scoped grant. The one
 * test that needs the other answer is the orphaned-Ticket case, and it says so.
 */
function grantingDelegation(
  overrides: Partial<TicketSessionDelegationClaims> = {},
): TicketSessionDelegationClaims {
  return {
    startGrantScope: () => null,
    claimStart: ({ parentSessionId, toolCallId }) => ({
      ok: true,
      delegation: {
        parentSessionId,
        depth: 1,
        maxDepth: 1,
        maxChildren: 3,
        claimToolCallId: toolCallId,
      },
    }),
    releaseIfUnstarted: () => undefined,
    ...overrides,
  };
}

function harness(
  overrides: { startError?: unknown; delegation?: TicketSessionDelegationClaims } = {},
) {
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
    testTicket("project-one", { id: "ticket-three", ticketNumber: 2, title: "Another task" }),
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
    delegation: overrides.delegation ?? grantingDelegation(),
    // `ticket.await`'s ports, inert for the start-tool suite: its own suite
    // (`agent-await.test.ts`) drives them with real fakes.
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    subscribeTicketWake: () => () => undefined,
  });
  const call = (
    input: Record<string, unknown>,
    toolCallId = "tc-0",
    caller: RuntimeSessionIdentity = CALLER,
  ) => door(caller, { verb: "session.start", input, toolCallId }, new AbortController().signal);
  return { call, startInputs, kickoffs, notices };
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

  it("lets a Ticket Session start only on its own Ticket", async () => {
    const h = harness();

    const own = await h.call({ ticket: "VC-1" }, "ticket-own", TICKET_CALLER);
    const other = await h.call({ ticket: "VC-2" }, "ticket-other", TICKET_CALLER);

    expect(own.text).toContain("Started Session");
    expect(other.text).toContain("only start Sessions on its own Ticket");
    expect(h.startInputs).toHaveLength(1);
    expect(h.startInputs[0]).toMatchObject({
      ticketId: "ticket-one",
      delegation: {
        parentSessionId: TICKET_CALLER.sessionId,
        depth: 1,
        maxDepth: 1,
        maxChildren: 3,
        claimToolCallId: "ticket-own",
      },
    });
  });

  it("refuses a Ticket caller whose frozen birth grant is absent or exhausted", async () => {
    const h = harness({
      delegation: grantingDelegation({
        claimStart: ({ toolCallId }) =>
          toolCallId === "no-grant"
            ? { ok: false, reason: "not-granted" as const }
            : { ok: false, reason: "limit" as const, maxChildren: 3 },
      }),
    });

    const missing = await h.call({ ticket: "VC-1" }, "no-grant", TICKET_CALLER);
    const capped = await h.call({ ticket: "VC-1" }, "at-cap", TICKET_CALLER);

    expect(missing.text).toContain("was not granted in-ticket delegation when it started");
    // The number, not the word "limit": a model told only that it hit a bound
    // has no way to size what it has left.
    expect(capped.text).toContain("already started the 3 Sessions its in-ticket delegation allows");
    expect(h.startInputs).toEqual([]);
  });

  /**
   * Deleting a Ticket sets `sessions.ticket_id` to NULL, so a Session born on a
   * Ticket can attach later as a ticketless — `project` Role — one, while the
   * frozen tool surface it replays still names `session.start`. Judging that
   * caller by its live Role would silently widen an own-ticket grant into the
   * project-wide bound, so the door reads how it was BORN.
   */
  it("refuses a ticketless caller that was born with an own-ticket grant", async () => {
    const h = harness({ delegation: grantingDelegation({ startGrantScope: () => "own-ticket" }) });

    const orphaned = await h.call({ ticket: "VC-1" }, "orphaned", CALLER);

    expect(orphaned.text).toContain("scoped to its own Ticket, which is no longer attached");
    expect(h.startInputs).toEqual([]);
  });

  it("hands the ledger the create command id its start will write, and asks for the slot back on failure", async () => {
    const claimed: unknown[] = [];
    const released: unknown[] = [];
    const h = harness({
      startError: new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", "Choose a model."),
      delegation: grantingDelegation({
        claimStart: (input) => {
          claimed.push(input);
          return {
            ok: true,
            delegation: {
              parentSessionId: input.parentSessionId,
              depth: 1,
              maxDepth: 1,
              maxChildren: 3,
              claimToolCallId: input.toolCallId,
            },
          };
        },
        releaseIfUnstarted: (input) => released.push(input),
      }),
    });

    const result = await h.call({ ticket: "VC-1" }, "failed-start", TICKET_CALLER);

    expect(result.text).toContain("Choose a model.");
    // The door states the create id once, at claim time; the release names only
    // the claim, and the ledger reads the evidence it already stored.
    expect(claimed).toEqual([
      {
        parentSessionId: TICKET_CALLER.sessionId,
        toolCallId: "failed-start",
        ticketId: "ticket-one",
        createCommandId: `${TICKET_CALLER.sessionId}:failed-start:create`,
      },
    ]);
    expect(released).toEqual([
      { parentSessionId: TICKET_CALLER.sessionId, toolCallId: "failed-start" },
    ]);
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
