import { describe, expect, it } from "vite-plus/test";
import {
  SESSION_CREDENTIAL_STOP_TYPES,
  SESSION_STOP_CATEGORIES,
  sessionStopCause,
  sessionStopNextStep,
  sessionStopSummary,
  type SessionStopDetail,
} from "./session-stop";
import {
  decodeSessionEventPayload,
  decodeSessionStopDetail,
  scrubSessionEventPayload,
} from "./session-event-codec";
import { providerSignInStop } from "./session-need";
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
const select = (providerId: string) =>
  ({
    kind: "model.selected",
    selection: { providerId, modelId: `${providerId}-model`, reasoningLevel: "off" },
  }) as const;

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
  it.each([
    // [category, providerType, httpStatus, cause]
    ["auth-failed", SESSION_CREDENTIAL_STOP_TYPES.refreshFailed, null, "sign-in"],
    ["auth-failed", SESSION_CREDENTIAL_STOP_TYPES.missing, null, "sign-in"],
    ["auth-failed", "authentication_error", 401, "sign-in"],
    ["auth-failed", null, 401, "sign-in"],
    ["auth-failed", "permission_error", 403, "permission"],
    ["auth-failed", null, 403, "permission"],
    ["bad-request", "not_found_error", 404, "model-unavailable"],
    ["bad-request", "invalid_request_error", 400, "request"],
    ["rate-limited", "usage_limit_reached", 429, "quota"],
    ["rate-limited", "billing_error", 402, "quota"],
    ["rate-limited", "rate_limit_error", 429, "transient"],
    ["network", "ECONNRESET", null, "transient"],
    ["unknown", null, null, "unknown"],
  ] as const)(
    "reads %s/%s/%s as %s from structured facts alone",
    (category, providerType, httpStatus, cause) => {
      // Withheld prose must not change the answer: it is never read.
      const stop: SessionStopDetail = {
        ...detail,
        category,
        providerType,
        httpStatus,
        message: "[Provider text withheld: possible request content.]",
      };
      expect(sessionStopCause(stop)).toBe(cause);
      expect(sessionStopSummary(stop)).toMatch(/^Stopped:/);
      expect(sessionStopNextStep(stop)).toMatch(/^Next:/);
    },
  );
  it("tells sign-in apart from retry, and quota with and without a stated reset", () => {
    const signIn = {
      ...detail,
      category: "auth-failed" as const,
      providerType: SESSION_CREDENTIAL_STOP_TYPES.refreshFailed,
      httpStatus: null,
    };
    // The runtime's own codes ride the existing bounded `providerType` field,
    // so the frozen codec (and every older reader of it) takes them unchanged.
    for (const providerType of Object.values(SESSION_CREDENTIAL_STOP_TYPES)) {
      expect(decodeSessionStopDetail({ ...signIn, providerType }, "stop")).toEqual({
        ...signIn,
        providerType,
      });
    }
    expect(sessionStopSummary(signIn)).toBe("Stopped: the provider sign-in expired or was refused");
    expect(sessionStopNextStep(signIn)).toContain("a person must sign in");
    expect(
      sessionStopSummary({ ...signIn, providerType: SESSION_CREDENTIAL_STOP_TYPES.missing }),
    ).toBe("Stopped: not signed in to the provider");
    expect(sessionStopNextStep({ ...detail, category: "network" })).toBe(
      "Next: a retry may succeed.",
    );
    expect(sessionStopNextStep(detail)).toContain("until the reset above");
    expect(sessionStopNextStep({ ...detail, resetsAt: null })).toContain(
      "wait for the provider's allowance to reset",
    );
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
  it("binds a sign-in stop to the provider that failed, not the model switched to after (VC-1236)", () => {
    const signInStop = {
      category: "auth-failed",
      providerType: SESSION_CREDENTIAL_STOP_TYPES.refreshFailed,
      message: null,
      httpStatus: null,
      retry: "not-retried",
      resetsAt: null,
    } as const;
    const raised = {
      kind: "attention.raised",
      attention: {
        id: "pi:attention:a:auth",
        attachmentId: "a",
        kind: "auth_required",
        detail: null,
        diagnostic: null,
        stopDetail: signInStop,
      },
    } as const;
    const stoppedOnA = [event(1, select("anthropic")), event(2, raised)];
    const switched = [...stoppedOnA, event(3, select("openai-codex"))];
    const projection = projectSession(session, switched);
    expect(projection.attentionProviders).toEqual({ "pi:attention:a:auth": "anthropic" });
    expect(providerSignInStop(projection)).toEqual({
      providerId: "anthropic",
      attentionId: "pi:attention:a:auth",
    });
    // The same through a checkpoint taken before the switch.
    const advanced = advanceSessionProjection(
      createSessionProjectionCheckpoint(session, stoppedOnA),
      [event(3, select("openai-codex"))],
    ).projection;
    expect(providerSignInStop(advanced)?.providerId).toBe("anthropic");
    // A successful turn on the new model clears the stop, as it always has.
    const cleared = projectSession(session, [
      ...switched,
      event(4, { kind: "attention.cleared", attentionId: "pi:attention:a:auth" }),
    ]);
    expect(providerSignInStop(cleared)).toBeNull();
    expect(cleared.attentionProviders).toBeUndefined();
    // An older checkpoint without the map falls back to the Session's model.
    const { attentionProviders: _dropped, ...legacy } = projection;
    expect(providerSignInStop(legacy)?.providerId).toBe("openai-codex");
    // An archived Session, and an Attention raised before any model, name nobody.
    expect(providerSignInStop({ ...projection, status: "archived" })).toBeNull();
    expect(providerSignInStop(projectSession(session, [event(1, raised)]))).toBeNull();
  });
  it("reads only a model-not-found type as an unavailable model; a bare 404 is the provider's own detail", () => {
    const notFound = { ...detail, category: "bad-request" as const, httpStatus: 404 };
    expect(sessionStopCause({ ...notFound, providerType: null })).toBe("request");
    expect(sessionStopCause({ ...notFound, providerType: "not_found_error" })).toBe(
      "model-unavailable",
    );
  });
  it("names an unreadable credential and an unreachable token endpoint for what they are", () => {
    const unreadable = {
      ...detail,
      category: "auth-failed" as const,
      providerType: SESSION_CREDENTIAL_STOP_TYPES.unavailable,
      httpStatus: null,
    };
    expect(sessionStopCause(unreadable)).toBe("credential-unreadable");
    expect(sessionStopSummary(unreadable)).toBe(
      "Stopped: the stored provider credential could not be read",
    );
    expect(sessionStopNextStep(unreadable)).toContain("Settings");
    const unreachable = {
      ...detail,
      category: "network" as const,
      providerType: SESSION_CREDENTIAL_STOP_TYPES.refreshUnreachable,
      httpStatus: null,
    };
    expect(sessionStopCause(unreachable)).toBe("transient");
    expect(sessionStopSummary(unreachable)).toBe(
      "Stopped: the provider's sign-in service could not be reached",
    );
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
