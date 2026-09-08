/**
 * The two states a person is needed in, and the many that only look like them.
 *
 * Most of this file is about what does NOT fire. That balance is the point: the
 * rule's whole risk is over-notification, and VC-112 says why in as many words —
 * a Ticket that moves because an agent paused to ask a question "is exactly how
 * a person learns to switch the feature off".
 */
import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_FAILURE_ATTENTION_KINDS,
  SESSION_PERSON_NEEDS,
  sessionNotificationItem,
  sessionPersonNeed,
} from "./session-need";
import { SESSION_ATTENTION_KINDS, SESSION_USER_BLOCKING_ATTENTION_KINDS } from "./session-ledger";
import type { SessionAttention, SessionAttentionKind, SessionProjection } from "./session-ledger";

function attention(kind: SessionAttentionKind): SessionAttention {
  return {
    id: `attention-${kind}`,
    attachmentId: null,
    detail: null,
    diagnostic: null,
    kind,
  } as SessionAttention;
}

type Reading = Pick<SessionProjection, "interactions" | "attention" | "stopped">;

function projection(overrides: Partial<Reading> = {}): Reading {
  return {
    interactions: { active: [], all: [] } as unknown as SessionProjection["interactions"],
    attention: { active: [], all: [] } as unknown as SessionProjection["attention"],
    stopped: null,
    ...overrides,
  };
}

function waitingOnQuestion(): Reading {
  return projection({
    interactions: {
      active: [{ id: "ask-1" }],
      all: [],
    } as unknown as SessionProjection["interactions"],
  });
}

function raising(kind: SessionAttentionKind): Reading {
  return projection({
    attention: { active: [attention(kind)], all: [] } as unknown as SessionProjection["attention"],
  });
}

describe("sessionPersonNeed", () => {
  it("needs nobody in the resting case", () => {
    expect(sessionPersonNeed(projection())).toBeNull();
  });

  it("reads an open interaction as waiting", () => {
    expect(sessionPersonNeed(waitingOnQuestion())).toBe("waiting");
  });

  it("reads each user-blocking Attention as waiting", () => {
    for (const kind of SESSION_USER_BLOCKING_ATTENTION_KINDS) {
      expect(sessionPersonNeed(raising(kind))).toBe("waiting");
    }
  });

  it("reads each failure Attention as error", () => {
    for (const kind of SESSION_FAILURE_ATTENTION_KINDS) {
      expect(sessionPersonNeed(raising(kind))).toBe("error");
    }
  });

  it("stays silent for every Attention that is the world pushing back", () => {
    // The complement of the two named lists. Computed rather than typed out, so
    // a NEW Attention kind lands here by default and this test fails until
    // somebody has decided which of the three groups it belongs to — the same
    // discipline `STATUS_DOT_TONE` gets, for the same reason.
    const spoken = new Set<string>([
      ...SESSION_USER_BLOCKING_ATTENTION_KINDS,
      ...SESSION_FAILURE_ATTENTION_KINDS,
    ]);
    const quiet = SESSION_ATTENTION_KINDS.filter((kind) => !spoken.has(kind));
    expect(quiet).toEqual([
      "rate_limited",
      "quota_exhausted",
      "context_limit_reached",
      "transport_retrying",
      "partial_turn_interrupted",
    ]);
    for (const kind of quiet) expect(sessionPersonNeed(raising(kind))).toBeNull();
  });

  it("lets a failure outrank a question", () => {
    // The renderer settles this for the tab dot: a question held over a dead
    // transport is a memory, and sending someone to answer it wastes the trip.
    const both: Reading = {
      ...waitingOnQuestion(),
      attention: {
        active: [attention("adapter_disconnected")],
        all: [],
      } as unknown as SessionProjection["attention"],
    };
    expect(sessionPersonNeed(both)).toBe("error");
  });

  it("needs nobody once the Session was stopped on purpose", () => {
    // VC-86: a stop ends the work. Answering its stale question changes
    // nothing, so a stopped Session must never raise a notification — however
    // loudly its last Attention was still standing.
    const stopped: SessionProjection["stopped"] = { at: 1, reason: null, by: { kind: "user" } };
    expect(sessionPersonNeed({ ...waitingOnQuestion(), stopped })).toBeNull();
    expect(sessionPersonNeed({ ...raising("adapter_unrecoverable"), stopped })).toBeNull();
  });

  it("names exactly the two states VC-112 does", () => {
    expect([...SESSION_PERSON_NEEDS]).toEqual(["waiting", "error"]);
  });
});

describe("sessionNotificationItem", () => {
  /**
   * The one derivation both sides of the suppression comparison use (VC-295
   * round 2). A producer names the item its alert is about with it, and a
   * window reports the item it is showing with it — so "is the person already
   * looking at this" is a comparison between two answers to the same question,
   * rather than between two similar-looking guesses.
   */
  it("names the open question a waiting Session is blocked on", () => {
    expect(sessionNotificationItem(waitingOnQuestion())).toEqual({
      interactionId: "ask-1",
      attentionId: null,
    });
  });

  it("names the failure of a Session whose plumbing broke", () => {
    expect(sessionNotificationItem(raising("adapter_disconnected"))).toEqual({
      interactionId: null,
      attentionId: "attention-adapter_disconnected",
    });
  });

  it("lets a failure outrank a question, exactly as the need does", () => {
    // Otherwise a click would land on a card that cannot be answered, and the
    // suppression comparison would disagree with the alert that raised it.
    const both: Reading = {
      ...waitingOnQuestion(),
      attention: {
        active: [attention("adapter_disconnected")],
        all: [],
      } as unknown as SessionProjection["attention"],
    };
    expect(sessionNotificationItem(both)).toEqual({
      interactionId: null,
      attentionId: "attention-adapter_disconnected",
    });
  });

  it("names a blocking question raised as an Attention rather than an Interaction", () => {
    // `sessionAwaitsUser` accepts either; the item has to as well, or an alert
    // about a permission prompt would carry no item at all.
    expect(sessionNotificationItem(raising("permission_required"))).toEqual({
      interactionId: null,
      attentionId: "attention-permission_required",
    });
  });

  it("names nothing for a Session that is merely working", () => {
    expect(sessionNotificationItem(projection())).toEqual({
      interactionId: null,
      attentionId: null,
    });
  });

  it("ignores an Attention nobody can act on", () => {
    // A rate limit clears itself. Reporting it as the item on screen would
    // suppress the question that arrives while it stands.
    expect(sessionNotificationItem(raising("rate_limited"))).toEqual({
      interactionId: null,
      attentionId: null,
    });
  });

  it("names nothing once the Session was stopped on purpose", () => {
    const stopped: SessionProjection["stopped"] = { at: 1, reason: null, by: { kind: "user" } };
    expect(sessionNotificationItem({ ...waitingOnQuestion(), stopped })).toEqual({
      interactionId: null,
      attentionId: null,
    });
  });
});
