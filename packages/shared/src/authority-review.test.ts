import { describe, expect, it } from "vite-plus/test";
import {
  decodeSessionEventPayload,
  encodeSessionJson,
  scrubSessionEventPayload,
} from "./session-event-codec";
import { observationPayload, projectSession } from "./session-ledger";
import type { Session, SessionEventPayload } from "./session-ledger";

const review: Extract<SessionEventPayload, { kind: "authority.reviewed" }> = {
  kind: "authority.reviewed",
  attachmentId: "attachment-1",
  turnId: "turn-1",
  toolCallId: "call-1",
  tool: "execute",
  mode: "shadow",
  authoriser: "classifier",
  wouldFlag: true,
  reason: "Outside the request.",
  category: "external",
  answers: {
    authorised: { type: "bool", value: false, probability: 0.1, confidence: 0.8 },
    risk: {
      type: "choice",
      choice: "external",
      probabilities: { safe: 0.1, external: 0.9 },
      confidence: 0.8,
    },
    severity: { type: "score", score: 1.5, level: 2, label: "high", confidence: 0.8 },
  },
  missReason: null,
  thresholds: { allow: 0.95, flag: 0.05 },
};
const decode = (value: unknown) => decodeSessionEventPayload(value, "payload");

describe("authority.reviewed durable verdict", () => {
  it("round-trips every answer shape and projects only verdict fields", () => {
    expect(decode(JSON.parse(encodeSessionJson(review)))).toEqual(review);
    expect(
      scrubSessionEventPayload({
        ...review,
        args: { secret: "never ship" },
        state: "never ship",
      } as typeof review),
    ).toEqual(review);
    const extraAnswer = {
      ...review,
      answers: { authorised: { ...review.answers!.authorised, state: "never ship" } },
    };
    expect(JSON.stringify(scrubSessionEventPayload(extraAnswer))).not.toContain("never ship");
  });

  it("preserves allowances, misses, both modes and nullable fields", () => {
    expect(decode({ ...review, mode: "auto", wouldFlag: false })).toEqual({
      ...review,
      mode: "auto",
      wouldFlag: false,
    });
    for (const missReason of [
      "unset",
      "not-opted-in",
      "needs-setup",
      "unaudited",
      "invalid-request",
      "timeout",
      "aborted",
      "provider-error",
      "malformed-answer",
    ]) {
      const missed = {
        ...review,
        turnId: null,
        wouldFlag: null,
        category: null,
        answers: null,
        missReason,
      };
      expect(decode(missed)).toEqual(missed);
    }
    expect(decode({ ...review, answers: {} })).toMatchObject({ answers: {} });
  });

  it("rejects malformed known fields instead of treating corruption as a future kind", () => {
    const fields = {
      attachmentId: 1,
      turnId: 1,
      toolCallId: null,
      tool: false,
      mode: "ask",
      authoriser: "model",
      wouldFlag: "true",
      reason: null,
      category: 1,
      answers: [],
      missReason: "unknown",
      thresholds: null,
    };
    for (const [key, value] of Object.entries(fields))
      expect(() => decode({ ...review, [key]: value })).toThrow();
    for (const value of [-0.1, 1.1, NaN, Infinity, "0.5", null, undefined]) {
      expect(() => decode({ ...review, thresholds: { allow: value, flag: 0.1 } })).toThrow();
      expect(() => decode({ ...review, thresholds: { allow: 0.9, flag: value } })).toThrow();
    }
    for (const answer of [
      null,
      { type: "future", confidence: 0.9 },
      { type: "bool", value: "false", probability: 0.1, confidence: 0.9 },
      { type: "bool", value: false, probability: -1, confidence: 0.9 },
      { type: "bool", value: false, probability: 0.1, confidence: 2 },
      { type: "choice", choice: 1, probabilities: {}, confidence: 0.9 },
      { type: "choice", choice: "safe", probabilities: [], confidence: 0.9 },
      { type: "choice", choice: "safe", probabilities: { safe: 2 }, confidence: 0.9 },
      { type: "score", score: null, level: 0, label: "low", confidence: 0.9 },
      { type: "score", score: -1, level: 0, label: "low", confidence: 0.9 },
      { type: "score", score: 0, level: -1, label: "low", confidence: 0.9 },
      { type: "score", score: 0, level: 0.1, label: "low", confidence: 0.9 },
      { type: "score", score: "0", level: 0, label: "low", confidence: 0.9 },
      { type: "score", score: 0, level: 0, label: null, confidence: 0.9 },
    ])
      expect(() => decode({ ...review, answers: { question: answer } })).toThrow();
  });

  it("translates observations without counting reviews as denials", () => {
    const provenance = {
      source: { kind: "system" as const, id: "authority-classifier", detail: null },
      venue: null,
    };
    const observation = {
      ...review,
      id: "review-1",
      sessionId: "session-1",
      occurredAt: 10,
      provenance,
    };
    expect(observationPayload(observation, { projectId: "project-1", ticketId: null })).toEqual(
      review,
    );
    const session: Session = {
      id: "session-1",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "One",
      createdAt: 0,
    };
    expect(
      projectSession(session, [{ ...observation, sequence: 1, recordedAt: 11, payload: review }])
        .authorityDenials,
    ).toBe(0);
  });
});
