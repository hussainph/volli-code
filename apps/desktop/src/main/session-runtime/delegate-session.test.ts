/**
 * Delegation to a Subagent Session (VC-9): the application half behind the
 * `session_delegate` tool.
 *
 * What is proved here is the shape of the act, not that a Session starts —
 * the start route is the facade's and is tested beside it. Four properties:
 *
 * 1. The call returns at once with a real child Session, and the child's final
 *    message is delivered INTO the parent as a marked message when the child's
 *    first turn completes. The parent is never parked.
 * 2. A child that ends without answering — interrupted, stopped, failed —
 *    still reports back, in words that say so.
 * 3. Live children per parent are capped, and a refusal names the ones
 *    running. Replaying one tool call is one child.
 * 4. Stopping the parent stops its live children.
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
  DelegateSessionError,
  MAX_LIVE_SUBAGENTS_PER_PARENT,
  subagentAnswerMarker,
} from "./delegate-session";
import type { DelegateSessionPorts } from "./delegate-session";
import type { SessionStartInput } from "./sessions";

const PARENT = "aaaaaaaa-0000-0000-0000-000000000000";
const CHILD = "bbbbbbbb-0000-0000-0000-000000000000";

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

function projection(id: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    session: {
      id,
      projectId: "project-1",
      ticketId: null,
      role: "subagent",
      title: "Helper",
      createdAt: 1,
    },
    status: "open",
    commands: [],
    receipts: [],
    pendingExecutorStart: null,
    attachments: [
      {
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
  transcript: {
    message: { role: "assistant" | "user"; parts: { type: "text"; text: string }[] };
  } | null = null,
): SessionStreamEmission {
  return {
    sessionId,
    sequence,
    event: event(sessionId, sequence, payload),
    transcript:
      transcript === null
        ? null
        : {
            version: 1,
            threadId: "thread",
            branchId: "branch",
            attemptId: "attempt",
            turnId: "turn-1",
            message: { id: `m-${sequence}`, ...transcript.message },
          },
  } as SessionStreamEmission;
}

function harness(overrides: Partial<{ nextChild: () => string }> = {}) {
  let children = 0;
  const nextChild = overrides.nextChild ?? (() => (children++ === 0 ? CHILD : `child-${children}`));
  const starts: SessionStartInput[] = [];
  const kickoffs: { sessionId: string; text: string; commandId: string; messageId: string }[] = [];
  const commands: SessionRuntimeCommandRequest[] = [];
  const stops: { sessionId: string; intent: unknown }[] = [];
  const listeners = new Map<string, (emission: SessionStreamEmission) => void | Promise<void>>();
  const subscriptions: string[] = [];
  const projections = new Map<string, SessionProjection>();
  const unsubscribed: string[] = [];
  const startedIds = new Map<string, string>();
  const ports: DelegateSessionPorts = {
    sessions: {
      start: async (input) => {
        starts.push(input);
        // Replay-safe like the real facade: one operation, one child.
        let sessionId = startedIds.get(input.operationId);
        if (sessionId === undefined) {
          sessionId = nextChild();
          startedIds.set(input.operationId, sessionId);
          projections.set(
            sessionId,
            projection(sessionId, {
              session: { ...projection(sessionId).session, title: input.title },
            }),
          );
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
    submitSessionMessage: async (input) => {
      kickoffs.push(input);
    },
    runtime: {
      command: async (request): Promise<SessionRuntimeCommandResult> => {
        commands.push(request);
        return {
          sessionId: "sessionId" in request ? request.sessionId : CHILD,
          command: {
            id: request.commandId,
            sessionId: PARENT,
            createdAt: 0,
            intent: { kind: "session.archive" },
            route: null,
          },
          receipt: {
            id: "r",
            commandId: request.commandId,
            status: "accepted",
            acceptedAt: 0,
            recordedAt: 0,
            sequence: 0,
            result: { kind: "session.signaled", sessionId: PARENT },
          },
          throughSequence: 0,
        };
      },
      subscribe: async (input, listener) => {
        subscriptions.push(input.sessionId);
        listeners.set(input.sessionId, listener);
        return () => {
          unsubscribed.push(input.sessionId);
          listeners.delete(input.sessionId);
        };
      },
    },
    sessionEngine: {
      listSessions: async () => [...projections.values()],
      submit: async (request) => {
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
  };
  const delegations = createDelegations(ports);
  const delegate = (toolCallId = "tc-1", task = "Find where the auth token is refreshed") =>
    delegations.delegate({
      operationId: `${PARENT}:${toolCallId}`,
      parent: PARENT_IDENTITY,
      task,
      actor: { kind: "session", sessionId: PARENT, ticketId: null },
    });
  const emit = async (sessionId: string, emission: SessionStreamEmission) => {
    const listener = listeners.get(sessionId);
    if (listener === undefined) throw new Error(`nothing subscribed to ${sessionId}`);
    await listener(emission);
  };
  return {
    delegations,
    delegate,
    emit,
    starts,
    kickoffs,
    commands,
    stops,
    listeners,
    subscriptions,
    unsubscribed,
  };
}

describe("delegateSessionOperation — the child is a real Session, and the parent keeps working", () => {
  it("starts a Subagent Session with the parent's scope, kicks off the task, and returns at once", async () => {
    const h = harness();

    const result = await h.delegate();

    expect(result).toMatchObject({ childSessionId: CHILD, state: "running" });
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
    // The task is the kickoff, marked as the parent's delegation so the child
    // reads it as its instruction and not as a person's message.
    expect(h.kickoffs).toHaveLength(1);
    expect(h.kickoffs[0]).toMatchObject({
      sessionId: CHILD,
      commandId: `${PARENT}:tc-1:kickoff`,
    });
    expect(h.kickoffs[0]?.text).toContain("Find where the auth token is refreshed");
    expect(h.kickoffs[0]?.text).toContain("Delegated task");
    // The parent was not parked: nothing was submitted into it yet.
    expect(h.commands.filter((c) => "sessionId" in c && c.sessionId === PARENT)).toEqual([]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([CHILD]);
  });

  it("delivers the child's final message into the parent, marked, when the child's first turn completes", async () => {
    const h = harness();
    await h.delegate();

    // The child works: an assistant message, then another — the LAST is the answer.
    await h.emit(CHILD, frame(CHILD, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" }));
    await h.emit(
      CHILD,
      frame(
        CHILD,
        5,
        {
          kind: "transcript.referenced",
          attachmentId: "a",
          turnId: "t1",
          reference: { id: "x", mediaType: "m", digest: "d" },
        },
        {
          message: { role: "assistant", parts: [{ type: "text", text: "Looking…" }] },
        },
      ),
    );
    await h.emit(
      CHILD,
      frame(
        CHILD,
        6,
        {
          kind: "transcript.referenced",
          attachmentId: "a",
          turnId: "t1",
          reference: { id: "y", mediaType: "m", digest: "e" },
        },
        {
          message: {
            role: "assistant",
            parts: [{ type: "text", text: "It is refreshed in auth/refresh.ts, line 42." }],
          },
        },
      ),
    );
    expect(h.commands.filter((c) => "sessionId" in c && c.sessionId === PARENT)).toEqual([]);
    await h.emit(
      CHILD,
      frame(CHILD, 7, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
    );

    const delivered = h.commands.filter((c) => "sessionId" in c && c.sessionId === PARENT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      // Keyed on the operation, so a replayed watcher lands one answer.
      commandId: `${PARENT}:tc-1:answer`,
      sessionId: PARENT,
      command: { kind: "message.submit", delivery: "steer" },
    });
    const command = delivered[0]!.command;
    const text =
      command.kind === "message.submit" && command.message.parts[0]?.type === "text"
        ? command.message.parts[0].text
        : "";
    expect(text).toContain(subagentAnswerMarker(CHILD, "completed"));
    expect(text).toContain("It is refreshed in auth/refresh.ts, line 42.");
    expect(text).not.toContain("Looking…");
    // Watching ended with the answer — the child's stream and, with no child
    // left, the parent's — and the slot is free again.
    expect(h.unsubscribed).toEqual([CHILD, PARENT]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
  });

  it("reports a child that ended without answering, in words that say how", async () => {
    const h = harness();
    await h.delegate();

    await h.emit(CHILD, frame(CHILD, 4, { kind: "turn.started", attachmentId: "a", turnId: "t1" }));
    await h.emit(
      CHILD,
      frame(CHILD, 5, { kind: "turn.interrupted", attachmentId: "a", turnId: "t1" }),
    );

    const delivered = h.commands.filter((c) => "sessionId" in c && c.sessionId === PARENT);
    expect(delivered).toHaveLength(1);
    const command = delivered[0]!.command;
    const text =
      command.kind === "message.submit" && command.message.parts[0]?.type === "text"
        ? command.message.parts[0].text
        : "";
    expect(text).toContain(subagentAnswerMarker(CHILD, "interrupted"));
    expect(text).toMatch(/interrupted/);
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
  });

  it("caps live children per parent and names the ones still running", async () => {
    const h = harness();
    for (let index = 0; index < MAX_LIVE_SUBAGENTS_PER_PARENT; index += 1) {
      await h.delegate(`tc-${index}`, `Task ${index}`);
    }

    await expect(h.delegate("tc-overflow", "One more")).rejects.toBeInstanceOf(
      DelegateSessionError,
    );
    await expect(h.delegate("tc-overflow", "One more")).rejects.toThrow(/still running/);
    // Nothing durable happened for the refused call.
    expect(h.starts).toHaveLength(MAX_LIVE_SUBAGENTS_PER_PARENT);
  });

  it("replays one tool call as one child, one kickoff, one watcher", async () => {
    const h = harness();

    const first = await h.delegate("tc-1");
    const second = await h.delegate("tc-1");

    expect(second.childSessionId).toBe(first.childSessionId);
    expect(h.kickoffs.map((k) => k.commandId)).toEqual([
      `${PARENT}:tc-1:kickoff`,
      `${PARENT}:tc-1:kickoff`,
    ]);
    expect(h.delegations.liveChildren(PARENT)).toEqual([CHILD]);
    expect(h.subscriptions.filter((id) => id === CHILD)).toHaveLength(1);
  });

  it("stops live children when the parent is stopped", async () => {
    const h = harness();
    await h.delegate("tc-1");
    await h.delegate("tc-2");

    await h.emit(
      PARENT,
      frame(PARENT, 9, { kind: "session.stopped", reason: null, by: { kind: "user" } }),
    );

    // Each child received the durable stop naming the parent as the actor.
    expect(h.stops.map((s) => s.sessionId).toSorted()).toEqual([CHILD, "child-2"].toSorted());
    expect(h.stops[0]?.intent).toMatchObject({
      kind: "session.stop",
      by: { kind: "session", sessionId: PARENT },
    });
    expect(h.delegations.liveChildren(PARENT)).toEqual([]);
  });
});
