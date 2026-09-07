/**
 * Delegation to a Subagent Session (VC-9): the application half behind the
 * `session_delegate` tool.
 *
 * What is proved here is the shape of the act, not that a Session starts —
 * the start route is the facade's and is tested beside it. The fakes keep the
 * two runtime properties the real seams have and the act depends on, because
 * a fake without them proved the headline for nothing:
 *
 * - `submitSessionMessage` resolves when the TURN it opened ends (the harness
 *   holds it open until told), so "returns at once" is measured against a
 *   kickoff that has not come back.
 * - `subscribe` honours its cursor the way the runtime does: a frame at or
 *   below `afterSequence` is never delivered, and the ledger is replayed from
 *   the cursor on subscribe.
 *
 * The properties:
 *
 * 1. The call returns before the kickoff does, with the watcher already parked.
 * 2. When the child's first turn completes, a NOTICE — Volli's facts, none of
 *    the child's words — is steered into the parent, naming the read command.
 * 3. A child that ends without answering still notifies, in words that say how.
 * 4. Replaying one tool call is one child, one watcher, one kickoff id.
 * 5. Stopping the parent stops its live children; a stop already recorded
 *    before the watch began stops them at once.
 * 6. A notice waits for a parent that can read it: parked until its next
 *    attachment, dropped (and logged) for a parent that stopped, and a refused
 *    receipt is logged rather than swallowed.
 * 7. Boot recovery folds the child's ledger and notifies the same way.
 */

import { describe, expect, it } from "vite-plus/test";
import type { SessionEvent, SessionProjection } from "@volli/shared";
import type {
  SessionRuntimeCommandRequest,
  SessionRuntimeCommandResult,
  SessionStreamEmission,
} from "@volli/session-engine";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";

import {
  createDelegations,
  DELEGATION_ID_SUFFIXES,
  SUBAGENT_WALL_CLOCK_MS,
  subagentNotice,
} from "./delegate-session";
import type { DelegateSessionPorts } from "./delegate-session";
import type { SessionStartInput } from "./sessions";

const PARENT = "aaaaaaaa-0000-0000-0000-000000000000";
const CHILD = "bbbbbbbb-0000-0000-0000-000000000000";
const CHILD_HANDLE = CHILD.slice(0, 8);

const PARENT_IDENTITY = {
  role: "project" as const,
  sessionId: PARENT,
  rootThreadId: "thread-1",
  attachmentId: "attachment-1",
  projectId: "project-1",
  ticketId: null,
};

const PROVENANCE = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: { id: "local", kind: "local" as const },
};

const OPEN_ATTACHMENT = (id: string): SessionProjection["attachments"][number] => ({
  id: `${id}:attachment`,
  sessionId: id,
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
});

function projection(id: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  const attachment = OPEN_ATTACHMENT(id);
  return {
    session: {
      id,
      projectId: "project-1",
      ticketId: null,
      role: id === PARENT ? "project" : "subagent",
      parentSessionId: id === PARENT ? null : PARENT,
      title: "Helper",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [attachment],
    liveExecutor: attachment,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    modelSelection: null,
    modelTier: null,
    turnActive: true,
    lastTurnOutcome: null,
    authorityDenials: 0,
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 1,
    bornTicketless: true,
    ...overrides,
  };
}

function event(
  sessionId: string,
  sequence: number,
  payload: SessionEvent["payload"],
): SessionEvent {
  return {
    id: `${sessionId}:${sequence}`,
    sessionId,
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    provenance: PROVENANCE,
    commandId: null,
    payload,
  };
}

/** A durable frame, as the runtime's stream hands one to a subscriber. */
function frame(
  sessionId: string,
  sequence: number,
  payload: SessionEvent["payload"],
): SessionStreamEmission {
  return {
    sessionId,
    sequence,
    event: event(sessionId, sequence, payload),
    transcript: null,
  } as SessionStreamEmission;
}

type Listener = (emission: SessionStreamEmission) => void | Promise<void>;

interface Subscription {
  sessionId: string;
  afterSequence: number;
  listener: Listener;
  active: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options: { failStops?: boolean } = {}) {
  let children = 0;
  const starts: SessionStartInput[] = [];
  const kickoffs: { sessionId: string; text: string; commandId: string; messageId: string }[] = [];
  /** Each kickoff's turn, held open until the test ends it. */
  const kickoffTurns: ReturnType<typeof deferred>[] = [];
  const commands: SessionRuntimeCommandRequest[] = [];
  const stops: { sessionId: string; intent: unknown }[] = [];
  const subscriptions: Subscription[] = [];
  const projections = new Map<string, SessionProjection>();
  /** Durable history per Session, replayed on subscribe from the cursor. */
  const ledgers = new Map<string, SessionEvent[]>();
  const reports: string[] = [];
  const startedIds = new Map<string, string>();
  const timers: { callback: () => void; ms: number }[] = [];
  /** What the parent answers a `message.submit` with. */
  let receiptStatus: "accepted" | "rejected" = "accepted";
  projections.set(PARENT, projection(PARENT));

  const throughSequence = (sessionId: string) =>
    (ledgers.get(sessionId) ?? []).reduce((max, e) => Math.max(max, e.sequence), 0);

  const ports: DelegateSessionPorts = {
    sessions: {
      start: async (input) => {
        starts.push(input);
        // Replay-safe like the real facade: one operation, one child.
        let sessionId = startedIds.get(input.operationId);
        if (sessionId === undefined) {
          sessionId = children++ === 0 ? CHILD : `child-${children}`;
          startedIds.set(input.operationId, sessionId);
          projections.set(
            sessionId,
            projection(sessionId, {
              session: { ...projection(sessionId).session, title: input.title },
            }),
          );
          ledgers.set(sessionId, [
            event(sessionId, 3, {
              kind: "attachment.opened",
              attachment: OPEN_ATTACHMENT(sessionId),
            }),
          ]);
        }
        return {
          sessionId,
          state: "ready",
          receipt: null,
          throughSequence: 3,
          model: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "low" },
        };
      },
    },
    submitSessionMessage: (input) => {
      kickoffs.push(input);
      const turn = deferred();
      kickoffTurns.push(turn);
      return turn.promise;
    },
    runtime: {
      command: async (request): Promise<SessionRuntimeCommandResult> => {
        commands.push(request);
        const sessionId = "sessionId" in request ? request.sessionId : CHILD;
        const base = {
          sessionId,
          command: {
            id: request.commandId,
            sessionId,
            createdAt: 0,
            intent: { kind: "session.archive" as const },
            route: null,
          },
          throughSequence: 0,
        };
        return receiptStatus === "rejected"
          ? {
              ...base,
              receipt: {
                id: "r",
                commandId: request.commandId,
                status: "rejected",
                code: "no_live_executor",
                detail: "No live executor can receive this message",
                recordedAt: 0,
                sequence: 0,
              },
            }
          : {
              ...base,
              receipt: {
                id: "r",
                commandId: request.commandId,
                status: "accepted",
                acceptedAt: 0,
                recordedAt: 0,
                sequence: 0,
                result: { kind: "session.signaled", sessionId },
              },
            };
      },
      projection: async ({ sessionId }) => {
        const found = projections.get(sessionId);
        if (found === undefined) throw new Error(`no projection for ${sessionId}`);
        return { projection: found, throughSequence: throughSequence(sessionId) };
      },
      subscribe: async (input, listener) => {
        const subscription: Subscription = { ...input, listener, active: true };
        subscriptions.push(subscription);
        // The runtime replays the ledger from the cursor before live frames.
        for (const e of ledgers.get(input.sessionId) ?? []) {
          if (e.sequence > input.afterSequence && subscription.active) {
            await listener(frame(input.sessionId, e.sequence, e.payload));
          }
        }
        return () => {
          subscription.active = false;
        };
      },
    },
    sessionEngine: {
      listSessions: async () => [...projections.values()],
      listEvents: async ({ sessionId }) => ledgers.get(sessionId) ?? [],
      submit: async (request) => {
        if (options.failStops === true) throw new Error("engine down");
        stops.push({ sessionId: request.sessionId, intent: request.intent });
        const current = projections.get(request.sessionId);
        if (current !== undefined) {
          projections.set(request.sessionId, {
            ...current,
            stopped: { at: 1, reason: null, by: { kind: "session", sessionId: PARENT } },
          });
        }
        return {
          command: {
            id: request.commandId,
            sessionId: request.sessionId,
            createdAt: 0,
            intent: request.intent,
            route: null,
          },
          commandEvent: event(request.sessionId, 1, { kind: "session.archived" }),
          receipt: {
            id: "r",
            commandId: request.commandId,
            status: "completed",
            acceptedAt: 0,
            completedAt: 0,
            recordedAt: 0,
            sequence: 0,
            result: { kind: "session.signaled", sessionId: request.sessionId },
          },
          receiptEvent: null,
        };
      },
    },
    now: () => 1_000,
    report: (message) => {
      reports.push(message);
    },
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
  };
  const delegations = createDelegations(ports);
  const delegate = (toolCallId = "tc-1", task = "Find where the auth token is refreshed") =>
    delegations.delegate({
      operationId: `${PARENT}:${toolCallId}`,
      parent: PARENT_IDENTITY,
      task,
      actor: { kind: "session", sessionId: PARENT, ticketId: null },
    });
  /** A live frame, delivered to every active subscriber whose cursor admits it. */
  const emit = async (sessionId: string, sequence: number, payload: SessionEvent["payload"]) => {
    ledgers.set(sessionId, [
      ...(ledgers.get(sessionId) ?? []),
      event(sessionId, sequence, payload),
    ]);
    for (const subscription of subscriptions) {
      if (
        subscription.sessionId === sessionId &&
        subscription.active &&
        sequence > subscription.afterSequence
      ) {
        await subscription.listener(frame(sessionId, sequence, payload));
      }
    }
  };
  const setParent = (overrides: Partial<SessionProjection>) => {
    projections.set(PARENT, projection(PARENT, overrides));
  };
  return {
    delegations,
    delegate,
    emit,
    setParent,
    setReceipt: (status: "accepted" | "rejected") => {
      receiptStatus = status;
    },
    starts,
    kickoffs,
    kickoffTurns,
    commands,
    stops,
    subscriptions,
    ledgers,
    reports,
    timers,
    parentCommands: () => commands.filter((c) => "sessionId" in c && c.sessionId === PARENT),
    activeSubscriptions: (sessionId: string) =>
      subscriptions.filter((s) => s.sessionId === sessionId && s.active),
  };
}

/** The text steered into the parent under one notice command id, or null. */
function noticeText(commands: SessionRuntimeCommandRequest[], operationId: string): string | null {
  const found = commands.find(
    (c) => c.commandId === `${operationId}${DELEGATION_ID_SUFFIXES.notice}`,
  );
  if (found === undefined) return null;
  const command = found.command;
  return command.kind === "message.submit" && command.message.parts[0]?.type === "text"
    ? command.message.parts[0].text
    : null;
}

async function completeChildTurn(h: ReturnType<typeof harness>, child = CHILD) {
  await h.emit(child, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" });
  await h.emit(child, 5, {
    kind: "transcript.referenced",
    attachmentId: "a",
    turnId: "t1",
    reference: { id: "x", mediaType: "m", digest: "d" },
  });
  await h.emit(child, 6, { kind: "turn.completed", attachmentId: "a", turnId: "t1" });
}

describe("delegate — the child is a real Session, and the parent keeps working", () => {
  it("returns before the kickoff turn ends, with the watcher parked first", async () => {
    const h = harness();

    const result = await h.delegate();

    expect(result).toMatchObject({ childSessionId: CHILD, handle: CHILD_HANDLE, state: "running" });
    expect(h.starts).toEqual([
      expect.objectContaining({
        operationId: `${PARENT}:tc-1`,
        projectId: "project-1",
        ticketId: null,
        role: "subagent",
        parentSessionId: PARENT,
        actor: { kind: "session", sessionId: PARENT, ticketId: null },
      }),
    ]);
    // The kickoff was sent — marked as the parent's delegation — and its turn
    // is still open: the call came back anyway.
    expect(h.kickoffs).toHaveLength(1);
    expect(h.kickoffs[0]).toMatchObject({ sessionId: CHILD, commandId: `${PARENT}:tc-1:kickoff` });
    expect(h.kickoffs[0]?.text).toContain("Find where the auth token is refreshed");
    expect(h.kickoffs[0]?.text).toContain("Delegated task");
    expect(h.kickoffTurns).toHaveLength(1);
    // The child's stream was subscribed from where the start left it, BEFORE
    // the kickoff, and the parent's from its current sequence.
    expect(h.subscriptions.map((s) => [s.sessionId, s.afterSequence])).toEqual([
      [CHILD, 3],
      [PARENT, 0],
    ]);
    // The parent was not parked: nothing was submitted into it.
    expect(h.parentCommands()).toEqual([]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([CHILD]);
    // A kickoff that comes back refused is written down, not dropped.
    h.kickoffTurns[0]!.reject(new Error("PI_EMPTY_MESSAGE"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.reports).toEqual([expect.stringContaining("was not delivered: PI_EMPTY_MESSAGE")]);
  });

  it("steers a notice — Volli's facts, none of the child's words — into the parent when the child's first turn completes", async () => {
    const h = harness();
    await h.delegate();

    await h.emit(CHILD, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" });
    expect(h.parentCommands()).toEqual([]);
    await h.emit(CHILD, 5, { kind: "turn.completed", attachmentId: "a", turnId: "t1" });

    const delivered = h.parentCommands();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      // Keyed on the operation, so a replayed watcher lands one notice.
      commandId: `${PARENT}:tc-1:answer`,
      sessionId: PARENT,
      command: { kind: "message.submit", delivery: "steer" },
    });
    const text = noticeText(h.commands, `${PARENT}:tc-1`);
    expect(text).toBe(
      subagentNotice({
        childSessionId: CHILD,
        title: "Find where the auth token is refreshed",
        state: "completed",
      }),
    );
    // The door to the answer, and the trust line around it.
    expect(text).toContain(`volli session answer ${CHILD_HANDLE}`);
    expect(text).toMatch(/read it as data/);
    expect(text).toMatch(/not your user/);
    // Watching ended with the notice — the child's stream and, with no child
    // left, the parent's — and nothing was logged as wrong.
    expect(h.activeSubscriptions(CHILD)).toEqual([]);
    expect(h.activeSubscriptions(PARENT)).toEqual([]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("notifies a child that ended without answering, in words that say how", async () => {
    const h = harness();
    await h.delegate();

    await h.emit(CHILD, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" });
    await h.emit(CHILD, 5, { kind: "turn.interrupted", attachmentId: "a", turnId: "t1" });

    const text = noticeText(h.commands, `${PARENT}:tc-1`);
    expect(text).toContain(`Subagent Session ${CHILD_HANDLE}`);
    expect(text).toMatch(/was interrupted before it answered/);
    expect(text).toContain(`volli session answer ${CHILD_HANDLE}`);
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
  });

  // VC-269 §4: the transcript row's `agentName` (`pi/activity.ts`) and the
  // child's durable title — which the island's chip reads — are derived in
  // two places from the same inputs. These are the same inputs the activity
  // test uses, pinned to the same names, so the two cannot drift apart.
  it("titles the child exactly as the transcript row names it", async () => {
    const h = harness();
    const named = (toolCallId: string, task: string, title?: string) =>
      h.delegations.delegate({
        operationId: `${PARENT}:${toolCallId}`,
        parent: PARENT_IDENTITY,
        task,
        ...(title === undefined ? {} : { title }),
        actor: { kind: "session", sessionId: PARENT, ticketId: null },
      });

    await named(
      "tc-title",
      "Find where the auth token is refreshed\nReport the file.",
      "Token hunt",
    );
    await named("tc-line", "  Run   the flaky\ttest ten times  \nand report");
    await named("tc-long", "x".repeat(120));

    expect(h.starts.map((start) => start.title)).toEqual([
      "Token hunt",
      "Run the flaky test ten times",
      `${"x".repeat(79)}…`,
    ]);
  });

  it("does not cap live children, and replays one tool call as one child, one watcher, one kickoff id", async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      await h.delegate(`tc-${index}`, `Task ${index}`);
    }
    expect(h.starts).toHaveLength(5);
    expect(h.delegations.liveChildren(PARENT)).toHaveLength(5);

    const first = await h.delegate("tc-0", "Task 0");
    expect(first.childSessionId).toBe(CHILD);
    expect(h.delegations.liveChildren(PARENT)).toHaveLength(5);
    expect(h.subscriptions.filter((s) => s.sessionId === CHILD)).toHaveLength(1);
    // Two submits under ONE command id: the Session Engine deduplicates on it,
    // which is the whole of the replay story for the kickoff.
    expect(h.kickoffs.filter((k) => k.sessionId === CHILD).map((k) => k.commandId)).toEqual([
      `${PARENT}:tc-0:kickoff`,
      `${PARENT}:tc-0:kickoff`,
    ]);
  });
});

describe("delegate — stopping the parent stops the child", () => {
  it("stops live children on a parent stop recorded after the watch began, and ignores frames the cursor already covers", async () => {
    const h = harness();
    // The parent has history: the watch must start at its END, not at zero
    // (a cursor past the end would never be reached) and not at zero either
    // (replaying the parent's whole life to find a stop is pure cost).
    h.ledgers.set(PARENT, [
      event(PARENT, 7, { kind: "turn.started", attachmentId: "p", turnId: "pt" }),
      event(PARENT, 8, { kind: "turn.completed", attachmentId: "p", turnId: "pt" }),
    ]);
    await h.delegate("tc-1");
    await h.delegate("tc-2");
    expect(h.subscriptions.find((s) => s.sessionId === PARENT)?.afterSequence).toBe(8);

    // A frame at or below the cursor is one the runtime would never hand
    // over; the fake honours that, so nothing happens here.
    await h.emit(PARENT, 8, { kind: "session.stopped", reason: null, by: { kind: "user" } });
    expect(h.stops).toEqual([]);

    await h.emit(PARENT, 9, { kind: "session.stopped", reason: null, by: { kind: "user" } });

    // Each child received the durable stop naming the parent as the actor,
    // and each notice was dropped — the parent is stopped — with a log line.
    expect(h.stops.map((s) => s.sessionId).toSorted()).toEqual([CHILD, "child-2"].toSorted());
    expect(h.stops[0]?.intent).toMatchObject({
      kind: "session.stop",
      by: { kind: "session", sessionId: PARENT },
    });
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
    expect(h.activeSubscriptions(PARENT)).toEqual([]);
  });

  it("stops a child at once when the parent was already stopped before the watch began", async () => {
    const h = harness();
    h.setParent({ stopped: { at: 1, reason: null, by: { kind: "user" } } });

    await h.delegate("tc-1");

    expect(h.stops.map((s) => s.sessionId)).toEqual([CHILD]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
    expect(h.parentCommands()).toEqual([]);
    expect(h.reports).toEqual([
      expect.stringMatching(/parent .* stopped; its notice was not delivered/),
    ]);
  });

  it("stops a child that outlives its wall clock and reports it as timed out", async () => {
    const h = harness();
    await h.delegate("tc-1");
    expect(h.timers).toEqual([expect.objectContaining({ ms: SUBAGENT_WALL_CLOCK_MS })]);

    h.timers[0]!.callback();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.stops.map((s) => s.sessionId)).toEqual([CHILD]);
    expect(noticeText(h.commands, `${PARENT}:tc-1`)).toMatch(
      /did not finish within its time bound/,
    );
  });
});

describe("deliver — a notice waits for a parent that can read it", () => {
  it("parks the notice while the parent has no live executor and steers it at the parent's next attachment", async () => {
    const h = harness();
    await h.delegate("tc-1");
    // The parent's executor went away meanwhile (a relaunch retires every one).
    h.setParent({ liveExecutor: null, attachments: [] });

    await completeChildTurn(h);

    // Nothing submitted: a submit into a parent with no executor is refused
    // under the one command id that means "the parent was told".
    expect(h.parentCommands()).toEqual([]);
    const parked = h.activeSubscriptions(PARENT);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.afterSequence).toBe(0);

    // A turn the parent ran on some other attachment is not the wake.
    await h.emit(PARENT, 1, { kind: "turn.started", attachmentId: "p", turnId: "pt" });
    expect(h.parentCommands()).toEqual([]);
    await h.emit(PARENT, 2, { kind: "attachment.opened", attachment: OPEN_ATTACHMENT(PARENT) });

    expect(h.parentCommands()).toHaveLength(1);
    expect(noticeText(h.commands, `${PARENT}:tc-1`)).toMatch(/completed its task/);
    expect(h.activeSubscriptions(PARENT)).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("drops a parked notice, and says so, when the parent stops before attaching again", async () => {
    const h = harness();
    await h.delegate("tc-1");
    h.setParent({ liveExecutor: null, attachments: [] });
    await completeChildTurn(h);

    await h.emit(PARENT, 1, { kind: "session.stopped", reason: null, by: { kind: "user" } });

    expect(h.parentCommands()).toEqual([]);
    expect(h.activeSubscriptions(PARENT)).toEqual([]);
    expect(h.reports).toEqual([
      expect.stringMatching(/stopped before subagent .* notice could be delivered/),
    ]);
  });

  it("logs a refused receipt rather than swallowing it", async () => {
    const h = harness();
    await h.delegate("tc-1");
    h.setReceipt("rejected");

    await completeChildTurn(h);
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.parentCommands()).toHaveLength(1);
    expect(h.reports).toEqual([
      expect.stringMatching(/notice for .* was refused: no_live_executor/),
    ]);
  });

  it("logs a stop the child refused rather than swallowing it", async () => {
    const h = harness({ failStops: true });
    await h.delegate("tc-1");

    await h.emit(PARENT, 1, { kind: "session.stopped", reason: null, by: { kind: "user" } });

    expect(h.reports).toEqual(
      expect.arrayContaining([expect.stringMatching(/could not stop subagent .*: engine down/)]),
    );
    // The notice still lands — dropped for a stopped parent, which is logged too.
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
  });
});

describe("recover — delegations a relaunch left unanswered (VC-9)", () => {
  const FINISHED = "dddddddd-0000-0000-0000-000000000000";
  const CUT_SHORT = "eeeeeeee-0000-0000-0000-000000000000";
  const NEVER_RAN = "ffffffff-0000-0000-0000-000000000000";

  it("notifies for a finished child and a cut-short one, leaves an unstarted one alone, and parks each notice until the parent attaches", async () => {
    const h = harness();
    // After the boot sweep no parent holds an executor.
    h.setParent({ liveExecutor: null, attachments: [] });
    h.ledgers.set(FINISHED, [
      event(FINISHED, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
      event(FINISHED, 5, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
      event(FINISHED, 6, { kind: "attachment.closed", attachmentId: "a", outcome: "interrupted" }),
    ]);
    // Mid-turn when the app relaunched: the sweep closed its attachment as
    // interrupted, so the turn never completes.
    h.ledgers.set(CUT_SHORT, [
      event(CUT_SHORT, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
      event(CUT_SHORT, 5, { kind: "attachment.closed", attachmentId: "a", outcome: "interrupted" }),
    ]);
    // Created but never attached: the parent was already told no task was
    // sent, and there is nothing to report until a person retries it.
    h.ledgers.set(NEVER_RAN, []);
    const ref = (childSessionId: string, toolCallId: string, title: string) => ({
      childSessionId,
      parentSessionId: PARENT,
      projectId: "project-1",
      operationId: `${PARENT}:${toolCallId}`,
      title,
    });

    const recovered = await h.delegations.recover([
      ref(FINISHED, "tc-1", "Token hunt"),
      ref(CUT_SHORT, "tc-2", "Flaky test"),
      ref(NEVER_RAN, "tc-3", "Never"),
    ]);

    expect(recovered).toEqual({ answered: 1, reported: 1, skipped: 1 });
    // Parked, not submitted: two subscriptions on the parent, no command yet.
    expect(h.parentCommands()).toEqual([]);
    expect(h.activeSubscriptions(PARENT)).toHaveLength(2);

    await h.emit(PARENT, 1, { kind: "attachment.opened", attachment: OPEN_ATTACHMENT(PARENT) });

    const answer = noticeText(h.commands, `${PARENT}:tc-1`);
    expect(answer).toContain(`"Token hunt"`);
    expect(answer).toMatch(/completed its task/);
    expect(answer).toContain(`volli session answer ${FINISHED.slice(0, 8)}`);
    const report = noticeText(h.commands, `${PARENT}:tc-2`);
    expect(report).toMatch(/mid-turn when Volli relaunched/);
    expect(noticeText(h.commands, `${PARENT}:tc-3`)).toBeNull();
    // Nothing is watched afterwards: recovery reports and lets go.
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
    expect(h.activeSubscriptions(PARENT)).toEqual([]);
  });
});
