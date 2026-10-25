import { describe, expect, test } from "vite-plus/test";

import type { SessionAttention, SessionAttentionKind, SessionInteraction } from "./session-ledger";
import {
  sessionListingActivity,
  sessionListingWaitingOn,
  type SessionListingActivityFacts,
} from "./session-listing-activity";

function attention(kind: SessionAttentionKind): SessionAttention {
  return {
    id: `att-${kind}`,
    kind,
    attachmentId: null,
    detail: null,
    diagnostic: null,
    ...(kind === "rate_limited" ? { retryAt: null } : {}),
    ...(kind === "quota_exhausted" ? { resetAt: null } : {}),
    ...(kind === "adapter_unrecoverable" ? { resetsAt: null } : {}),
  } as SessionAttention;
}

const question: SessionInteraction = {
  id: "q1",
  attachmentId: "a1",
  kind: "question",
  title: "Which?",
  detail: null,
  options: [],
  multiple: false,
  native: { id: null, detail: null },
};

function facts(overrides: Partial<SessionListingActivityFacts> = {}): SessionListingActivityFacts {
  return {
    stopped: null,
    turnActive: false,
    lastTurnOutcome: null,
    attention: { active: [], primary: null },
    interactions: { active: [] },
    ...overrides,
  };
}

const stopped = { at: 1, reason: null, by: { kind: "user" } } as const;
const active = (...kinds: SessionAttentionKind[]) => ({
  active: kinds.map(attention),
  primary: null,
});

describe("sessionListingActivity", () => {
  test("stopped > waiting > working > interrupted > idle", () => {
    expect(sessionListingActivity(facts(), true)).toBe("idle");
    expect(sessionListingActivity(facts({ turnActive: true }), true)).toBe("working");
    // A durable turn with nothing bound to run it is not working.
    expect(sessionListingActivity(facts({ turnActive: true }), false)).toBe("idle");
    expect(
      sessionListingActivity(
        facts({ turnActive: true, interactions: { active: [question] } }),
        true,
      ),
    ).toBe("waiting");
    expect(sessionListingActivity(facts({ attention: active("permission_required") }), false)).toBe(
      "waiting",
    );
    expect(
      sessionListingActivity(
        facts({ stopped, turnActive: true, interactions: { active: [question] } }),
        true,
      ),
    ).toBe("stopped");
  });

  test("an interrupted turn reads interrupted only with a failure fact behind it", () => {
    const interrupted = { lastTurnOutcome: "interrupted" as const };
    expect(sessionListingActivity(facts(interrupted), true)).toBe("idle");
    expect(
      sessionListingActivity(
        facts({ ...interrupted, attention: active("partial_turn_interrupted") }),
        true,
      ),
    ).toBe("interrupted");
    expect(
      sessionListingActivity(
        facts({
          ...interrupted,
          lastTurnStopDetail: {
            category: "network",
            message: null,
            providerType: null,
            httpStatus: null,
            retry: "exhausted",
            resetsAt: null,
          },
        }),
        false,
      ),
    ).toBe("interrupted");
    // A transport Attention alone asks nobody anything.
    expect(sessionListingActivity(facts({ attention: active("adapter_disconnected") }), true)).toBe(
      "idle",
    );
  });
});

describe("sessionListingWaitingOn", () => {
  test("an open interaction outranks Attention, then the first user-blocking Attention speaks", () => {
    expect(sessionListingWaitingOn(facts())).toBeNull();
    expect(
      sessionListingWaitingOn(
        facts({ interactions: { active: [question] }, attention: active("auth_required") }),
      ),
    ).toBe("question");
    expect(
      sessionListingWaitingOn(facts({ attention: active("rate_limited", "auth_required") })),
    ).toBe("auth");
    expect(sessionListingWaitingOn(facts({ attention: active("input_required") }))).toBe(
      "question",
    );
    expect(sessionListingWaitingOn(facts({ attention: active("permission_required") }))).toBe(
      "permission",
    );
    expect(sessionListingWaitingOn(facts({ attention: active("rate_limited") }))).toBeNull();
    expect(
      sessionListingWaitingOn(facts({ stopped, interactions: { active: [question] } })),
    ).toBeNull();
  });

  test("waiting and its reason move together", () => {
    const cases: SessionListingActivityFacts[] = [
      facts(),
      facts({ interactions: { active: [question] } }),
      facts({ attention: active("input_required") }),
      facts({ attention: active("adapter_disconnected", "permission_required") }),
      facts({ attention: active("quota_exhausted", "adapter_unrecoverable") }),
      facts({ stopped, attention: active("auth_required") }),
    ];
    for (const value of cases) {
      expect(sessionListingActivity(value, true) === "waiting").toBe(
        sessionListingWaitingOn(value) !== null,
      );
    }
  });
});
