/**
 * The plan and the current reply as projection state (VC-315; the
 * verification review's B1 and B2). A Client holds only the newest window of
 * a Session's transcript, so the facts these two answers depend on are folded
 * from each settled message's digest rather than from messages it may never
 * page in.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  decodeRendererSessionEventPayload,
  decodeSessionEventPayload,
} from "./session-event-codec";
import {
  advanceSessionProjection,
  createSessionProjectionCheckpoint,
  observationPayload,
  projectSession,
} from "./session-ledger";
import type {
  Session,
  SessionCommandIntent,
  SessionEvent,
  SessionTranscriptDigest,
} from "./session-ledger";

const session: Session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: null,
  role: "project",
  parentSessionId: null,
  title: null,
  createdAt: 100,
};

const provenance = {
  source: { kind: "system" as const, id: "session-engine", detail: null },
  venue: { id: "machine-1", kind: "local" as const },
};

function event(sequence: number, payload: SessionEvent["payload"]): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: session.id,
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10 + 1,
    provenance,
    payload,
  };
}

const reference = (sequence: number) => ({
  id: `artifact-${sequence}`,
  mediaType: null,
  digest: null,
});

function message(sequence: number, digest?: SessionTranscriptDigest): SessionEvent {
  return event(sequence, {
    kind: "transcript.referenced",
    attachmentId: "attachment-1",
    turnId: "turn-1",
    reference: reference(sequence),
    ...(digest === undefined ? {} : { digest }),
  });
}

function command(sequence: number, intent: SessionCommandIntent): SessionEvent {
  return event(sequence, {
    kind: "command.recorded",
    command: {
      id: `command-${sequence}`,
      sessionId: session.id,
      createdAt: 1,
      route: null,
      intent,
    },
  });
}

const plan = [{ content: "Finish migration", status: "in_progress" as const }];

describe("the plan in the projection", () => {
  it("is the newest settled plan, and stays through any amount of later work", () => {
    const later = Array.from({ length: 300 }, (_, index) =>
      message(index + 3, { role: "assistant", reply: true }),
    );
    const projection = projectSession(session, [
      message(1, { role: "assistant", todoList: [{ content: "Old", status: "pending" }] }),
      message(2, { role: "assistant", todoList: plan }),
      ...later,
    ]);
    expect(projection.todoList).toEqual(plan);
  });

  it("keeps a cleared list apart from never having had one", () => {
    expect(projectSession(session, [message(1, { role: "assistant" })])).not.toHaveProperty(
      "todoList",
    );
    const cleared = projectSession(session, [
      message(1, { role: "assistant", todoList: plan }),
      message(2, { role: "assistant", todoList: [] }),
    ]);
    expect(cleared.todoList).toEqual([]);
  });

  it("is unchanged by messages recorded before digests existed", () => {
    const projection = projectSession(session, [
      message(1, { role: "assistant", todoList: plan }),
      message(2),
    ]);
    expect(projection.todoList).toEqual(plan);
    expect(projectSession(session, [message(1)])).not.toHaveProperty("todoList");
  });

  it("survives a checkpoint split at any point", () => {
    const events = [
      message(1, { role: "assistant", todoList: plan }),
      message(2, { role: "assistant", reply: true }),
      message(3, { role: "assistant" }),
    ];
    const whole = projectSession(session, events);
    for (let split = 0; split <= events.length; split += 1) {
      const head = createSessionProjectionCheckpoint(session, events.slice(0, split));
      const resumed = advanceSessionProjection(head, events.slice(split)).projection;
      expect(resumed.todoList).toEqual(whole.todoList);
      expect(resumed.latestReply).toEqual(whole.latestReply);
    }
  });
});

describe("the current turn's latest reply in the projection", () => {
  it("points at the newest assistant message that said something, past tool-only ones", () => {
    const tools = Array.from({ length: 256 }, (_, index) =>
      message(index + 3, { role: "assistant" }),
    );
    const projection = projectSession(session, [
      command(1, { kind: "message.submit", reference: reference(1) }),
      message(2, { role: "assistant", reply: true }),
      ...tools,
    ]);
    expect(projection.latestReply).toEqual({ sequence: 2, reference: reference(2) });
  });

  it("resets at every user message: a submit, a steer, an answer, a user transcript", () => {
    const said = message(2, { role: "assistant", reply: true });
    const resets: SessionEvent[] = [
      command(3, { kind: "message.submit", reference: reference(3) }),
      command(3, {
        kind: "interaction.resolve",
        attachmentId: "attachment-1",
        interactionId: "interaction-1",
        resolution: { optionIds: [], response: "yes" },
        reference: reference(3),
      }),
      message(3, { role: "user" }),
    ];
    for (const reset of resets) {
      expect(projectSession(session, [said, reset])).not.toHaveProperty("latestReply");
      // And the next thing said is the new turn's reply.
      expect(
        projectSession(session, [said, reset, message(4, { role: "assistant", reply: true })])
          .latestReply,
      ).toEqual({ sequence: 4, reference: reference(4) });
    }
  });

  it("is not moved by a system message or one recorded before digests existed", () => {
    const projection = projectSession(session, [
      message(1, { role: "assistant", reply: true }),
      message(2, { role: "system", reply: true }),
      message(3),
    ]);
    expect(projection.latestReply).toEqual({ sequence: 1, reference: reference(1) });
  });
});

describe("the transcript digest on the wire", () => {
  it("is carried from observation to payload, and decodes as written", () => {
    const digest: SessionTranscriptDigest = { role: "assistant", reply: true, todoList: plan };
    const payload = observationPayload(
      {
        id: "observation-1",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "transcript.referenced",
        attachmentId: "attachment-1",
        turnId: "turn-1",
        reference: reference(1),
        digest,
      },
      { projectId: session.projectId, ticketId: session.ticketId },
    );
    expect(payload).toMatchObject({ digest });
    const stored = JSON.parse(JSON.stringify(payload)) as unknown;
    expect(decodeSessionEventPayload(stored, "payload")).toEqual(payload);
    expect(decodeRendererSessionEventPayload(stored, "payload")).toEqual(payload);
  });

  it("decodes a digest that carries only its role", () => {
    const payload = message(1, { role: "user" }).payload;
    expect(decodeSessionEventPayload(JSON.parse(JSON.stringify(payload)), "payload")).toEqual(
      payload,
    );
  });

  it("decodes an event written before digests existed without inventing one", () => {
    const legacy = message(1).payload;
    expect(decodeSessionEventPayload(JSON.parse(JSON.stringify(legacy)), "payload")).toEqual(
      legacy,
    );
    expect(decodeSessionEventPayload(legacy, "payload")).not.toHaveProperty("digest");
  });

  it("refuses a digest that is not one", () => {
    const base = message(1).payload;
    for (const digest of [
      null,
      { role: "robot" },
      { role: "assistant", reply: false },
      { role: "assistant", todoList: [{ content: "x", status: "blocked" }] },
      { role: "assistant", todoList: "nope" },
    ]) {
      expect(() => decodeSessionEventPayload({ ...base, digest }, "payload")).toThrow();
    }
  });
});

/**
 * Whether the checkpoint's plan and reply baseline is whole (VC-315's legacy
 * baseline). The host recovers the baseline of a checkpoint that does not say
 * so; one that does is never scanned.
 */
describe("the checkpoint's baseline marker", () => {
  const marked = [{ content: "Plan", status: "pending" as const }];

  it("is set by a fold from the first event that meets only digests", () => {
    expect(createSessionProjectionCheckpoint(session, []).baselineComplete).toBe(true);
    expect(
      createSessionProjectionCheckpoint(session, [
        message(1, { role: "assistant", reply: true, todoList: marked }),
        message(2, { role: "assistant" }),
      ]).baselineComplete,
    ).toBe(true);
  });

  it("is absent once a digest-less transcript fact is folded, from scratch or over a checkpoint", () => {
    expect(createSessionProjectionCheckpoint(session, [message(1)])).not.toHaveProperty(
      "baselineComplete",
    );
    const whole = createSessionProjectionCheckpoint(session, [message(1, { role: "user" })]);
    expect(advanceSessionProjection(whole, [message(2)])).not.toHaveProperty("baselineComplete");
  });

  it("is carried across digest-bearing facts, and not invented over a checkpoint without it", () => {
    const whole = createSessionProjectionCheckpoint(session, [message(1, { role: "user" })]);
    expect(
      advanceSessionProjection(whole, [message(2, { role: "assistant" })]).baselineComplete,
    ).toBe(true);
    // An older build's checkpoint says nothing: a digest after it does not
    // make the baseline before it whole.
    const { baselineComplete: _marker, ...older } = whole;
    expect(advanceSessionProjection(older, [message(2, { role: "assistant" })])).not.toHaveProperty(
      "baselineComplete",
    );
  });

  it("keeps a recovered baseline under the facts that follow it", () => {
    const recovered = {
      ...createSessionProjectionCheckpoint(session, [message(1)]),
      baselineComplete: true as const,
    };
    const withPlan = {
      ...recovered,
      projection: {
        ...recovered.projection,
        todoList: marked,
        latestReply: { sequence: 1, reference: reference(1) },
      },
    };
    const next = advanceSessionProjection(withPlan, [message(2, { role: "assistant" })]);
    expect(next.baselineComplete).toBe(true);
    expect(next.projection.todoList).toEqual(marked);
    expect(next.projection.latestReply).toEqual({ sequence: 1, reference: reference(1) });
    const reset = advanceSessionProjection(withPlan, [message(2, { role: "user" })]);
    expect(reset.projection.latestReply).toBeUndefined();
    expect(reset.projection.todoList).toEqual(marked);
  });
});
