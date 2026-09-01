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

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_AUTHORITY_POLICY, NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type {
  AutomationRun,
  AutomationTrigger,
  ModelSelection,
  RuntimeSessionIdentity,
} from "@volli/shared";

import type { SessionStartedNotice } from "../ipc/contract";

import { createAgentToolDoor } from "./agent-tool-door";
import type { AgentToolDoorOptions } from "./agent-tool-door";
import { createAutomationEngine } from "./automations/engine";
import { createAutomationRunner } from "./automations/run";
import { SqliteAutomationLedger } from "./automations/sqlite-ledger";
import {
  getAutomation,
  listAutomationsForProject,
  listProjectRunsForAutomation,
  listRunsForTicket,
} from "./db/automations-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertProject, listProjects } from "./db/projects-repo";
import { getTicket, insertTicket } from "./db/tickets-repo";
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
    // (`agent-await.test.ts`) drives them with real fakes. `automation.run`'s
    // host is inert here for the same reason — its suite below wires the real
    // engine and the real Run door.
    automations: () => null,
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    subscribeTicketWake: () => () => undefined,
    // Supervision's ports likewise: `supervise-session.test.ts` drives the
    // operations; this suite proves only the door — identity binding, wording,
    // and the no-runtime refusal (which is what `null` exercises).
    supervise: () => null,
  });
  const call = (
    input: Record<string, unknown>,
    toolCallId = "tc-0",
    caller: RuntimeSessionIdentity = CALLER,
  ) => door(caller, { verb: "session.start", input, toolCallId }, new AbortController().signal);
  // `door` is returned raw as well: the supervision suite drives this harness
  // as its no-runtime case, where the verb under test is not `session.start`.
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

/**
 * `automation_run` (VC-134), driven against the REAL Run door.
 *
 * The fakes stop at the Session facade, exactly as `automations/run.test.ts`
 * stops there, because the acceptance this ticket has to hold is a claim about
 * the record: a Run an agent starts must be indistinguishable from one a person
 * started by hand. A stubbed runner could not prove that — it would prove only
 * that the door called something. So the engine, its ledger and the runner are
 * the production ones, and the door is wired to them the way main wires it.
 */
const RUN_MODEL: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

function automationHarness(options: { host?: "absent" } = {}) {
  ctx = openTestDb();
  const db = ctx.db;
  insertProject(
    db,
    testProject({ id: "project-one", name: "Volli Code", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertProject(
    db,
    testProject({ id: "project-two", name: "Other", path: "/repo/other", ticketPrefix: "OT" }),
  );
  insertTicket(
    db,
    testTicket("project-one", { id: "ticket-one", ticketNumber: 1, title: "Sweep" }),
  );
  insertTicket(db, testTicket("project-one", { id: "ticket-two", ticketNumber: 2, title: "Also" }));
  insertTicket(
    db,
    testTicket("project-two", { id: "ticket-far", ticketNumber: 7, title: "Elsewhere" }),
  );
  // The fake facade below mints no Session rows; production's engine does, and
  // the migration suite proves that FK (same stance as `run.test.ts`).
  db.pragma("foreign_keys = OFF");

  const engine = createAutomationEngine({
    ledger: new SqliteAutomationLedger(db),
    now: () => 42_000,
    nextId: randomUUID,
  });
  const creates: SessionStartInput[] = [];
  const runInputs: Record<string, unknown>[] = [];
  const sessionsByOperation = new Map<string, string>();
  let nextSession = 0;
  let activity: "working" | "waiting" | "idle" = "idle";

  const runner = createAutomationRunner({
    engine,
    findAutomation: (automationId) => getAutomation(db, automationId),
    findTicket: (ticketId) => {
      const found = getTicket(db, ticketId);
      return found === undefined ? undefined : { id: found.id, projectId: found.projectId };
    },
    findProject: (projectId) => projectId === "project-one" || projectId === "project-two",
    listRunsForTicket: (ticketId) => listRunsForTicket(db, ticketId),
    listProjectRunsForAutomation: (input) => listProjectRunsForAutomation(db, input),
    sessions: {
      create: async (input) => {
        creates.push(input);
        let sessionId = sessionsByOperation.get(input.operationId);
        if (sessionId === undefined) {
          sessionId = `abcdef${++nextSession}2-3456-7890-abcd-ef1234567890`;
          sessionsByOperation.set(input.operationId, sessionId);
        }
        return { sessionId, model: RUN_MODEL };
      },
      attach: async (input) => ({
        sessionId: input.sessionId,
        state: "ready" as const,
        receipt: null,
        throughSequence: 0,
      }),
    },
    promptSupply: async () => ({ templates: [], skills: [] }),
    deliverInstructions: async () => ({ receipt: { status: "accepted" } }),
    reportInstructionDeliveryFailure: async () => undefined,
    readSessionActivity: async () => activity,
    log: () => undefined,
  });

  const door = createAgentToolDoor({
    db,
    projects: () => listProjects(db),
    sessions: () => null,
    // Inert for the automation suite: its callers never reach `session.start`,
    // and the defaults here are what an ordinary Project Session's rows say.
    delegation: grantingDelegation(),
    automations: () =>
      options.host === "absent"
        ? null
        : {
            list: (projectId) => listAutomationsForProject(db, projectId),
            run: (input) => {
              runInputs.push({ ...input });
              return runner.run(input);
            },
          },
    actorTicketDisplay: () => null,
    now: () => 1_000,
    authorityPolicy: () => DEFAULT_AUTHORITY_POLICY,
    subscribeTicketWake: () => () => undefined,
    // Supervision's ports are inert here for the same reason `sessions` is:
    // this suite drives `automation.run` alone.
    supervise: () => null,
  });

  async function save(input: {
    name: string;
    projectId: string | null;
    trigger?: AutomationTrigger;
  }) {
    const created = await engine.create({
      commandId: randomUUID(),
      projectId: input.projectId,
      name: input.name,
      instructions: "Sweep this Ticket and report.",
      trigger: input.trigger ?? NO_AUTOMATION_TRIGGER,
      runtime: null,
    });
    if (!created.ok) throw new Error(created.error);
    return created.value;
  }

  const call = async (input: Record<string, unknown>, toolCallId = "tc-0") => {
    const result = await door(
      CALLER,
      { verb: "automation.run", input, toolCallId },
      new AbortController().signal,
    );
    await runner.settled();
    return result;
  };

  return {
    call,
    save,
    creates,
    runInputs,
    runner,
    db,
    setActivity: (next: "working" | "waiting" | "idle") => {
      activity = next;
    },
  };
}

/** A Run record with everything per-invocation removed — what "same record" means. */
function runShape(run: AutomationRun) {
  const {
    id: _id,
    sessionId: _sessionId,
    ticketId: _ticketId,
    createdAt: _createdAt,
    // Attendance is compared on its own below rather than folded in here: it is
    // the ONE field on which an agent's Run and a person's Run are meant to
    // differ (VC-133), so hiding it inside a shape equality would make this
    // helper assert the opposite of the rule.
    attendance: _attendance,
    ...rest
  } = run;
  return rest;
}

describe("automation_run through the Agent Tool Surface (VC-134)", () => {
  it("runs a saved Automation on the caller's project through the one Run door", async () => {
    const h = automationHarness();
    const automation = await h.save({ name: "Nightly sweep", projectId: "project-one" });

    // Named the way a person would say it, not the way SQLite stores it: an
    // orchestrator knows the Automation by its name and has no id to quote.
    const result = await h.call({ automation: "nightly SWEEP", ticket: "VC-1" });

    expect(h.runInputs).toEqual([
      {
        commandId: "caller-session:tc-0",
        // A saved record, by name. The verb reaches neither of the deliberate
        // human surfaces' extras (VC-129): no Unbound Run, no per-invocation
        // Runtime override.
        target: { kind: "automation", automationId: automation.id },
        ticketId: "ticket-one",
        modelOverride: null,
        // UNATTENDED (VC-133): the caller is another Session, not a person.
        attendance: "unattended",
      },
    ]);
    expect(result.text).toContain("Nightly sweep");
    expect(result.text).toContain("VC-1");
    expect(result.text).toContain("anthropic/claude-opus");
    // The short public handle, never a full UUID — nothing else in Volli takes
    // one back, so a model given one is given an id it cannot use.
    expect(result.text).toContain("abcdef12");
    expect(result.text).not.toContain("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("deliberately aims a schedule-trigger Automation at one Ticket", async () => {
    const h = automationHarness();
    const automation = await h.save({
      name: "Nightly sweep",
      projectId: "project-one",
      trigger: {
        kind: "schedule",
        schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
      },
    });

    const result = await h.call({ automation: "Nightly sweep", ticket: "VC-1" });

    // VC-230's ruled agent-only exception: the record keeps the schedule that
    // targets its Project through the scheduler and person-facing doors, while
    // this invocation explicitly retargets its one Run to the named Ticket.
    expect(automation.trigger.kind).toBe("schedule");
    expect(h.runInputs[0]).toMatchObject({
      target: { kind: "automation", automationId: automation.id },
      ticketId: "ticket-one",
    });
    expect(h.creates[0]).toMatchObject({
      projectId: "project-one",
      ticketId: "ticket-one",
      title: "Nightly sweep",
    });
    expect(listRunsForTicket(h.db, "ticket-one")).toHaveLength(1);
    expect(result.text).toContain('Started "Nightly sweep" on VC-1');
  });

  it("records an agent's Run exactly as a Run a person started by hand", async () => {
    const h = automationHarness();
    const automation = await h.save({ name: "Nightly sweep", projectId: "project-one" });

    await h.call({ automation: "Nightly sweep", ticket: "VC-1" });
    // The hand path: the same door the palette, the rail and the board card
    // call, with an id a person's click would have minted.
    const byHand = await h.runner.run({
      commandId: randomUUID(),
      target: { kind: "automation", automationId: automation.id },
      ticketId: "ticket-two",
      modelOverride: null,
      attendance: "attended",
    });
    await h.runner.settled();
    if (!byHand.ok) throw new Error(byHand.error);

    // Both Sessions are born with the `automation` Actor, and neither create
    // carries a trace of who asked: no session actor, no parent Session id.
    expect(h.creates).toHaveLength(2);
    for (const create of h.creates) {
      expect(create.actor).toEqual({ kind: "automation" });
      expect(create.title).toBe("Nightly sweep");
    }
    const [agentRun] = listRunsForTicket(h.db, "ticket-one");
    expect(agentRun).toBeDefined();
    // Field for field, the two records are the same thing. Only the ids, the
    // Ticket and the clock differ — which is all that differs between two
    // Runs a person started by hand.
    expect(runShape(agentRun!)).toEqual(runShape(byHand.run));
    expect(agentRun!.model).toEqual(RUN_MODEL);
    // …except attendance, which is the one field that SHOULD differ (VC-133).
    // The agent issued this tool call and went back to its own turn, so when
    // the Run's Session stops to ask, nobody is in front of it. A person's Run
    // has somebody right there.
    expect(agentRun!.attendance).toBe("unattended");
    expect(byHand.run.attendance).toBe("attended");
  });

  it("binds the caller instead of believing one", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });

    // Every field an attacker would want is absent from the schema, and the
    // door reads none of them: the project and the Actor come from the
    // attachment, and the Instructions come from the saved record.
    await h.call({
      automation: "Nightly sweep",
      ticket: "VC-1",
      projectId: "project-two",
      actor: { kind: "user" },
      instructions: "rm -rf /",
      model: { providerId: "anthropic", modelId: "claude-opus" },
    });

    expect(h.creates[0]?.projectId).toBe("project-one");
    expect(h.creates[0]?.actor).toEqual({ kind: "automation" });
    expect(h.creates[0]?.modelOverride).toBeUndefined();
    // Four fields reach the Run door and no more, and two of them are fixed by
    // this door rather than by the caller: there is nothing an agent can vary
    // here that a person clicking Run cannot.
    expect(Object.keys(h.runInputs[0]!).toSorted()).toEqual([
      "attendance",
      "commandId",
      "modelOverride",
      "target",
      "ticketId",
    ]);
    expect(h.runInputs[0]?.modelOverride).toBeNull();
    // Fixed by this door, not varied by the caller: an agent cannot ask to be
    // treated as though a person were watching.
    expect(h.runInputs[0]?.attendance).toBe("unattended");
  });

  it("cannot name a Ticket outside the calling Session's project", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });

    const result = await h.call({ automation: "Nightly sweep", ticket: "OT-7" });

    expect(result.text).toContain("No Ticket OT-7 in this project");
    expect(h.runInputs).toEqual([]);
  });

  it("cannot reach an Automation this project does not list", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });
    await h.save({ name: "Someone else's", projectId: "project-two" });

    const result = await h.call({ automation: "Someone else's", ticket: "VC-1" });

    expect(h.runInputs).toEqual([]);
    // The refusal teaches: an unknown name comes back with the names that do
    // exist here, which is how an orchestrator discovers them without a second
    // verb to list them — and the other project's Automation is not among them,
    // because the caller's project is the only listing this door ever reads.
    const offered = result.text.slice(result.text.indexOf("This project lists:"));
    expect(offered).toContain("Nightly sweep");
    expect(offered).not.toContain("Someone else's");
  });

  it("lists a global Automation beside the project's own, and prefers the project's", async () => {
    const h = automationHarness();
    const global = await h.save({ name: "Nightly sweep", projectId: null });
    const own = await h.save({ name: "Nightly sweep", projectId: "project-one" });

    const result = await h.call({ automation: "Nightly sweep", ticket: "VC-1" });

    // The app's own listing rule (`listAutomationsForProject` orders the
    // project's own first), not a rule invented at this door.
    expect(h.runInputs[0]?.target).toEqual({ kind: "automation", automationId: own.id });
    expect(h.runInputs[0]?.target).not.toEqual({ kind: "automation", automationId: global.id });
    expect(result.text).toContain("Nightly sweep");
  });

  it("refuses an ambiguous name rather than guessing between two records", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });
    await h.save({ name: "nightly sweep", projectId: "project-one" });

    const result = await h.call({ automation: "Nightly sweep", ticket: "VC-1" });

    expect(result.text).toContain("more than one");
    expect(h.runInputs).toEqual([]);
  });

  it("passes the Run door's own refusal through as the model's answer", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });

    await h.call({ automation: "Nightly sweep", ticket: "VC-1" }, "tc-1");
    h.setActivity("working");
    const result = await h.call({ automation: "Nightly sweep", ticket: "VC-1" }, "tc-2");

    // Single-flight is the Run door's rule and stays there: the door does not
    // re-implement it, it reports it.
    expect(result.text).toContain("already working on this Ticket");
    expect(h.creates).toHaveLength(1);
  });

  it("replays one tool call as one Run, not two", async () => {
    const h = automationHarness();
    await h.save({ name: "Nightly sweep", projectId: "project-one" });

    await h.call({ automation: "Nightly sweep", ticket: "VC-1" }, "tc-3");
    await h.call({ automation: "Nightly sweep", ticket: "VC-1" }, "tc-3");

    // The door does not remember, and does not have to: both attempts carry
    // the caller's own id plus the runtime's call id, so the command ledger
    // collapses them into one Run and one Session.
    expect(h.runInputs.map((input) => input.commandId)).toEqual([
      "caller-session:tc-3",
      "caller-session:tc-3",
    ]);
    expect(listRunsForTicket(h.db, "ticket-one")).toHaveLength(1);
    expect(h.creates).toHaveLength(1);
  });

  it("refuses in words the model can act on, never by throwing", async () => {
    for (const input of [
      {},
      { automation: "Nightly sweep" },
      { ticket: "VC-1" },
      { automation: "   ", ticket: "VC-1" },
      { automation: "Nightly sweep", ticket: "  " },
    ]) {
      const h = automationHarness();
      await h.save({ name: "Nightly sweep", projectId: "project-one" });
      const result = await h.call(input);
      expect(result.text.length).toBeGreaterThan(0);
      expect(h.runInputs).toEqual([]);
    }
  });

  it("says so when the Automation host never came up this launch", async () => {
    const h = automationHarness({ host: "absent" });

    const result = await h.call({ automation: "Nightly sweep", ticket: "VC-1" });

    expect(result.text).toContain("not available this launch");
    expect(h.creates).toEqual([]);
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
      // Inert for the supervision suite: its callers reach neither
      // `session.start` nor `automation.run`.
      delegation: grantingDelegation(),
      automations: () => null,
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
              return { receipt: { status: "completed" } };
            },
          },
          runtime: {
            command: async (request: unknown) => {
              sends.push(request);
              return { receipt: { status: "accepted" } };
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
