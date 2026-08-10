import { describe, expect, it } from "vite-plus/test";
import { observationCursor } from "./native-adapter";

describe("observationCursor", () => {
  it("answers undefined for a kind that carries no cursor, and the value for one that does", () => {
    expect(
      observationCursor({
        id: "turn-1",
        kind: "turn.started",
        occurredAt: 10,
        turnId: "turn-1",
        cursor: { eventId: "provider-7" },
      }),
    ).toEqual({ eventId: "provider-7" });
    expect(
      observationCursor({ id: "turn-2", kind: "turn.completed", occurredAt: 11, turnId: "turn-1" }),
    ).toBeUndefined();
    expect(
      observationCursor({
        id: "delta-1",
        kind: "transcript.delta",
        occurredAt: 12,
        threadId: "thread:session:root",
        branchId: "branch:session:main",
        attemptId: "attempt:1",
        turnId: "turn-1",
        messageId: "assistant-1",
        delta: { op: "message.remove" },
      }),
    ).toBeUndefined();
  });
});
