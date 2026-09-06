import { describe, expect, it } from "vite-plus/test";
import type { SessionEvent } from "@volli/shared";

import { foldSessionAnswerState, readSessionAnswer } from "./session-answer";
import type { SessionTranscriptArtifact } from "./transcript-artifacts";

const SESSION = "s-1";

function event(sequence: number, payload: SessionEvent["payload"]): SessionEvent {
  return {
    id: `e-${sequence}`,
    sessionId: SESSION,
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
    commandId: null,
    payload,
  };
}

function referenced(sequence: number, id: string): SessionEvent {
  return event(sequence, {
    kind: "transcript.referenced",
    attachmentId: "a",
    turnId: "t1",
    reference: { id, mediaType: "m", digest: id },
  });
}

function artifact(role: "assistant" | "user", text: string): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: "t1",
    message: { id: "m", role, parts: [{ type: "text", text }] },
  };
}

describe("foldSessionAnswerState — how the latest turn ended", () => {
  it("walks the turn lifecycle, and reads a close mid-turn as the end of that turn", () => {
    const started = event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" });
    expect(foldSessionAnswerState([])).toEqual({ state: "not-started", turns: 0 });
    expect(foldSessionAnswerState([started])).toEqual({ state: "running", turns: 1 });
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
      ]).state,
    ).toBe("completed");
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "turn.interrupted", attachmentId: "a", turnId: "t1" }),
      ]).state,
    ).toBe("interrupted");
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "session.stopped", reason: null, by: { kind: "user" } }),
      ]).state,
    ).toBe("stopped");
    // The relaunch sweep closes an open attachment as interrupted; a close
    // that calls itself completed mid-turn still ended a turn that had not.
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "attachment.closed", attachmentId: "a", outcome: "completed" }),
      ]).state,
    ).toBe("interrupted");
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "attachment.closed", attachmentId: "a", outcome: "failed" }),
      ]).state,
    ).toBe("failed");
    // A close after the turn completed changes nothing: the answer stands.
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
        event(3, { kind: "attachment.closed", attachmentId: "a", outcome: "interrupted" }),
      ]).state,
    ).toBe("completed");
  });

  it("reads an attachment failure mid-turn as a failed turn, and after one as no change", () => {
    const started = event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" });
    const failure = (sequence: number): SessionEvent =>
      event(sequence, {
        kind: "attachment.failed",
        attachment: {
          id: "a",
          sessionId: SESSION,
          adapterId: "pi",
          venue: { id: "local", kind: "local" },
          continuity: "fresh",
          native: null,
          authority: null,
        },
        failure: { code: "runtime_failed", detail: "Runtime failed", diagnostic: null },
      });
    expect(foldSessionAnswerState([started, failure(2)]).state).toBe("failed");
    // The turn already had its answer; a later attachment failure is the
    // process ending, not the turn losing what it said.
    expect(
      foldSessionAnswerState([
        started,
        event(2, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
        failure(3),
      ]).state,
    ).toBe("completed");
  });
});

describe("readSessionAnswer — the last assistant message, in full", () => {
  const events = [
    event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
    referenced(2, "first"),
    referenced(3, "last"),
    referenced(4, "steer"),
    event(5, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
  ];
  const artifacts: Record<string, SessionTranscriptArtifact> = {
    first: artifact("assistant", "Looking…"),
    last: artifact(
      "assistant",
      "It is refreshed in auth/refresh.ts, line 42.\n\nSecond paragraph.",
    ),
    steer: artifact("user", "a follow-up nobody answered yet"),
  };

  it("skips a later user message and returns the assistant's last words untruncated", async () => {
    const answer = await readSessionAnswer(
      {
        listEvents: async () => events,
        readArtifact: async (reference) => artifacts[reference.id]!,
      },
      { sessionId: SESSION },
    );
    expect(answer).toEqual({
      state: "completed",
      text: "It is refreshed in auth/refresh.ts, line 42.\n\nSecond paragraph.",
      unreadable: false,
      turns: 1,
    });
  });

  it("reports an unreadable last message rather than handing back the one before it", async () => {
    const answer = await readSessionAnswer(
      {
        listEvents: async () => events,
        readArtifact: async (reference) => {
          if (reference.id === "steer") return artifacts["steer"]!;
          throw new Error("store down");
        },
      },
      { sessionId: SESSION },
    );
    expect(answer).toMatchObject({ state: "completed", text: null, unreadable: true });
  });

  it("answers the state alone when the composition holds no artifact store", async () => {
    const answer = await readSessionAnswer(
      { listEvents: async () => events },
      { sessionId: SESSION },
    );
    expect(answer).toEqual({ state: "completed", text: null, unreadable: false, turns: 1 });
  });

  it("has no answer when the Session never spoke, though the turn finished", async () => {
    // A turn that ran to completion saying nothing an artifact recorded: the
    // state is the whole answer, and `unreadable` stays false — nothing failed.
    const answer = await readSessionAnswer(
      {
        listEvents: async () => [
          event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
          referenced(2, "steer"),
          event(3, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
        ],
        readArtifact: async () => artifacts["steer"]!,
      },
      { sessionId: SESSION },
    );
    expect(answer).toEqual({ state: "completed", text: null, unreadable: false, turns: 1 });
  });

  it("joins the text parts alone, leaving reasoning and step markers out of the answer", async () => {
    const mixed: SessionTranscriptArtifact = {
      version: 1,
      threadId: "thread",
      branchId: "branch",
      attemptId: "attempt",
      turnId: "t1",
      message: {
        id: "m",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "thinking out loud" },
          { type: "text", text: "The answer" },
          { type: "text", text: "and its second line." },
        ],
      },
    };
    const answer = await readSessionAnswer(
      {
        listEvents: async () => [
          event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
          referenced(2, "mixed"),
          event(3, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
        ],
        readArtifact: async () => mixed,
      },
      { sessionId: SESSION },
    );
    expect(answer.text).toBe("The answer\nand its second line.");
  });

  it("reads an assistant message of pure whitespace as no answer, not as empty text", async () => {
    const answer = await readSessionAnswer(
      {
        listEvents: async () => [
          event(1, { kind: "turn.started", attachmentId: "a", turnId: "t1" }),
          referenced(2, "blank"),
          event(3, { kind: "turn.completed", attachmentId: "a", turnId: "t1" }),
        ],
        readArtifact: async () => artifact("assistant", "   \n  "),
      },
      { sessionId: SESSION },
    );
    expect(answer).toEqual({ state: "completed", text: null, unreadable: false, turns: 1 });
  });
});
