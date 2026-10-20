import { describe, expect, it } from "vite-plus/test";
import {
  SESSION_STOP_CATEGORIES,
  sessionStopSummary,
  type SessionStopDetail,
} from "./session-stop";
import {
  decodeSessionEventPayload,
  decodeSessionStopDetail,
  scrubSessionEventPayload,
} from "./session-event-codec";
import {
  observationPayload,
  projectSession,
  sessionInterruptionDetail,
  sessionInterruptionReason,
  advanceSessionProjection,
  createSessionProjectionCheckpoint,
  type Session,
  type SessionEvent,
  type SessionEventPayload,
} from "./session-ledger";

const detail: SessionStopDetail = {
  category: "rate-limited",
  providerType: "usage_limit_reached",
  message: "Limit used",
  httpStatus: 429,
  retry: "not-retried",
  resetsAt: 1800000000000,
};
const session: Session = {
  id: "s",
  projectId: "p",
  ticketId: null,
  role: "project",
  parentSessionId: null,
  title: null,
  createdAt: 0,
};
const event = (sequence: number, payload: SessionEventPayload): SessionEvent => ({
  id: `e${sequence}`,
  sessionId: "s",
  sequence,
  occurredAt: sequence,
  recordedAt: sequence,
  provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
  payload,
});
const interruption = { kind: "turn.interrupted", attachmentId: "a", turnId: "t" } as const;

describe("durable interruption details", () => {
  it("the observation-to-event boundary keeps details only on interrupted turns", () => {
    const payload = observationPayload(
      {
        id: "observation",
        sessionId: "s",
        occurredAt: 1,
        provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
        ...interruption,
        stopDetail: detail,
      },
      { projectId: "p", ticketId: null },
    );
    expect(payload).toEqual({ ...interruption, stopDetail: detail });
  });
  it("has product-owned copy for every category; never embeds provider text in it", () => {
    for (const category of SESSION_STOP_CATEGORIES) {
      expect(sessionStopSummary({ ...detail, category })).toMatch(/^Stopped:/);
      expect(sessionStopSummary({ ...detail, category })).not.toContain("Limit used");
    }
  });
  it("round-trips details on interruptions and Attentions through the frozen codec and renderer scrub", () => {
    for (const category of SESSION_STOP_CATEGORIES) {
      const stopDetail = { ...detail, category };
      for (const payload of [
        { ...interruption, stopDetail },
        {
          kind: "attention.raised",
          attention: {
            id: "att",
            kind: "adapter_unrecoverable",
            attachmentId: "a",
            detail: "Limit used",
            diagnostic: null,
            resetsAt: null,
            stopDetail,
          },
        },
      ]) {
        const decoded = decodeSessionEventPayload(JSON.parse(JSON.stringify(payload)), "event");
        expect(decoded).toEqual(payload);
        expect(scrubSessionEventPayload(decoded)).toEqual(payload);
      }
    }
    expect(
      decodeSessionStopDetail(
        { ...detail, message: null, providerType: null, httpStatus: null, resetsAt: null },
        "detail",
      ),
    ).toMatchObject({ message: null });
  });
  it("reads an old event without inventing fields or changing its durable identity", () => {
    expect(decodeSessionEventPayload(interruption, "old")).toEqual(interruption);
    const legacy = projectSession(session, [
      event(1, {
        kind: "attention.raised",
        attention: {
          id: "old",
          attachmentId: "a",
          kind: "adapter_unrecoverable",
          detail: null,
          diagnostic: null,
          resetsAt: null,
        },
      }),
      event(2, interruption),
    ]);
    expect(sessionInterruptionReason(legacy)).toBe("stopped-by-runtime");
    expect(sessionInterruptionDetail(legacy)).toEqual({
      category: "unknown",
      message: null,
      providerType: null,
      httpStatus: null,
      retry: "not-retried",
      resetsAt: null,
    });
  });
  it("folds the detail from the turn fact, survives checkpoints, and clears it on the next turn", () => {
    const events = [event(1, { ...interruption, stopDetail: detail })];
    const stopped = projectSession(session, events);
    expect(sessionInterruptionDetail(stopped)).toEqual(detail);
    const checkpoint = createSessionProjectionCheckpoint(session, events);
    const resumed = advanceSessionProjection(checkpoint, [
      event(2, { kind: "turn.started", attachmentId: "a", turnId: "next" }),
    ]).projection;
    expect(sessionInterruptionDetail(resumed)).toBeNull();
    expect(resumed.lastTurnStopDetail).toBeUndefined();
    const completed = projectSession(session, [
      ...events,
      event(2, { kind: "turn.completed", attachmentId: "a", turnId: "next" }),
    ]);
    expect(sessionInterruptionDetail(completed)).toBeNull();
    expect(completed.lastTurnStopDetail).toBeUndefined();
    expect(sessionInterruptionDetail(projectSession(session, [event(1, interruption)]))).toBeNull();
  });
  it("does not let an older crash Attention hide the current provider stop", () => {
    const projection = projectSession(session, [
      event(1, {
        kind: "attention.raised",
        attention: {
          id: "old-crash",
          attachmentId: "a",
          kind: "partial_turn_interrupted",
          detail: null,
          diagnostic: null,
        },
      }),
      event(2, { ...interruption, stopDetail: detail }),
    ]);
    expect(sessionInterruptionDetail(projection)).toEqual(detail);
  });
  it("rejects corrupt categories, retry state and unbounded prose", () => {
    for (const patch of [
      { category: "guessed" },
      { retry: "maybe" },
      { message: "x".repeat(402) },
      { providerType: "x".repeat(81) },
      { httpStatus: 429.5 },
      { resetsAt: "tomorrow" },
    ]) {
      expect(() =>
        decodeSessionEventPayload(
          { ...interruption, stopDetail: { ...detail, ...patch } },
          "event",
        ),
      ).toThrow();
    }
    expect(() =>
      decodeSessionEventPayload({ ...interruption, stopDetail: null }, "event"),
    ).toThrow();
  });
});
