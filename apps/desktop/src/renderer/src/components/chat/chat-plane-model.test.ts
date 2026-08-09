/**
 * The chat plane's decisions, without a plane.
 *
 * Five rules that were each a bug: what a blocker row still says while a card is
 * up, when a redirection is allowed to leave, which card a decision in flight
 * disables, where words go when there is nowhere to send them, and what a
 * streamed token is allowed to re-render.
 */
import type { SessionAttention, SessionInteractionResolution } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  answerInteraction,
  composerModelSelection,
  holdList,
  messageRoute,
  resolvingWith,
  sameInteractionId,
  sameMessages,
  sessionBlocker,
  terminalCompanionTabId,
  withdrawInteraction,
  type SessionBlockerActs,
  type SessionBlockerInput,
} from "./chat-plane-model";

describe("composer model selection", () => {
  it("accepts only product reasoning levels at the durable command boundary", () => {
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "",
      }),
    ).toBeNull();
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "provider-ultra",
      }),
    ).toBeNull();
  });
});

const NO_OP = () => undefined;
const ACTS: SessionBlockerActs = {
  recover: NO_OP,
  retryRuntime: NO_OP,
  openTerminal: NO_OP,
  openSettings: NO_OP,
};

function blockerInput(overrides: Partial<SessionBlockerInput> = {}): SessionBlockerInput {
  return {
    sessionError: null,
    attention: { active: [], primary: null },
    catalogState: "ready",
    catalogError: null,
    terminalAvailable: false,
    runtimeRetryAvailable: false,
    ...overrides,
  };
}

/** The kinds that carry nothing but the base fields — no `retryAt`, no `resetAt`. */
type PlainAttentionKind = Exclude<SessionAttention["kind"], "quota_exhausted" | "rate_limited">;

function attention(kind: PlainAttentionKind, detail: string | null = null): SessionAttention {
  return { id: `attention-${kind}`, attachmentId: null, detail, diagnostic: null, kind };
}

function raised(primary: SessionAttention): SessionBlockerInput {
  return blockerInput({ attention: { active: [primary], primary } });
}

const rateLimited = (retryAt: number | null): SessionAttention => ({
  id: "attention-rate",
  attachmentId: null,
  detail: null,
  diagnostic: null,
  kind: "rate_limited",
  retryAt,
});

const quotaSpent = (resetAt: number | null): SessionAttention => ({
  id: "attention-quota",
  attachmentId: null,
  detail: null,
  diagnostic: null,
  kind: "quota_exhausted",
  resetAt,
});

const REFUSAL: SessionInteractionResolution = { optionIds: [], response: null };

/** One card's round trip, with what it told the surface along the way. */
function recorder(resolved: boolean) {
  const delivered: string[] = [];
  const flags: [string, boolean][] = [];
  return {
    delivered,
    flags,
    acts: {
      resolve: () => Promise.resolve(resolved),
      deliver: (message: string) => delivered.push(message),
      resolving: (id: string, active: boolean) => flags.push([id, active]),
    },
  };
}

describe("sessionBlocker", () => {
  it("reports a failed decision while its card is still on screen", () => {
    const blocker = sessionBlocker(
      blockerInput({ sessionError: "Decision not delivered: socket hang up" }),
      ACTS,
      true,
    );

    expect(blocker?.message).toBe("Decision not delivered: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("keeps a harness attention the card cannot answer", () => {
    expect(sessionBlocker(raised(attention("auth_required")), ACTS, true)?.message).toBe(
      "Sign-in required",
    );
  });

  it("offers an existing manual terminal companion plus an honest runtime retry", () => {
    expect(
      sessionBlocker(
        {
          ...raised(attention("auth_required")),
          terminalAvailable: true,
          runtimeRetryAvailable: true,
        },
        ACTS,
        false,
      ),
    ).toMatchObject({
      action: { label: "Open Terminal" },
      secondaryAction: { label: "Retry" },
    });
  });

  it("offers Pi runtime retry without inventing a terminal companion", () => {
    expect(
      sessionBlocker(
        { ...raised(attention("configuration_invalid")), runtimeRetryAvailable: true },
        ACTS,
        false,
      ),
    ).toMatchObject({ action: { label: "Retry" } });
    expect(
      sessionBlocker(
        { ...raised(attention("auth_required")), runtimeRetryAvailable: true },
        ACTS,
        false,
      ),
    ).toMatchObject({ action: { label: "Retry" } });
  });

  it("offers the existing terminal and retry for invalid Pi configuration", () => {
    expect(
      sessionBlocker(
        {
          ...raised(attention("configuration_invalid")),
          runtimeRetryAvailable: true,
          terminalAvailable: true,
        },
        ACTS,
        false,
      ),
    ).toMatchObject({
      action: { label: "Open Terminal" },
      secondaryAction: { label: "Retry" },
    });
  });

  it("stands down for the attention the card is itself the answer to", () => {
    const asked = raised(attention("permission_required"));

    expect(sessionBlocker(asked, ACTS, true)).toBeNull();
    expect(sessionBlocker(asked, ACTS, false)?.message).toBe("Waiting for approval");
  });

  it("does not ask for models while a card is waiting for an answer", () => {
    const empty = blockerInput({ catalogState: "empty" });

    expect(sessionBlocker(empty, ACTS, true)).toBeNull();
    expect(sessionBlocker(empty, ACTS, false)?.message).toBe("No models configured");
  });

  it("never lets a catalog failure stand in for the Session's own", () => {
    const blocker = sessionBlocker(
      blockerInput({
        sessionError: "Lost the Session stream: socket hang up",
        catalogError: "ECONNRESET",
      }),
      ACTS,
      false,
    );

    expect(blocker?.message).toBe("Lost the Session stream: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("says a catalog refresh failed, and offers the place that re-asks it", () => {
    const blocker = sessionBlocker(
      blockerInput({ catalogError: "ECONNRESET", catalogState: "error" }),
      ACTS,
      false,
    );

    expect(blocker).toEqual({
      message: "Models unavailable",
      detail: "ECONNRESET",
      tone: "error",
      action: { label: "Settings", act: NO_OP },
    });
    // A card on screen is not a reason to hide it, but it IS a reason not to
    // add a second row about models to one.
    expect(sessionBlocker(blockerInput({ catalogError: "ECONNRESET" }), ACTS, true)).toBeNull();
  });

  it("stays quiet when a loading catalog has simply not answered yet", () => {
    expect(sessionBlocker(blockerInput({ catalogState: "loading" }), ACTS, false)).toBeNull();
    expect(sessionBlocker(blockerInput(), ACTS, false)).toBeNull();
  });

  it("carries the harness's own wording under every attention it draws", () => {
    expect(sessionBlocker(raised(attention("adapter_disconnected", "EPIPE")), ACTS, false)).toEqual(
      {
        message: "Disconnected",
        detail: "EPIPE",
        tone: "error",
        action: { label: "Retry", act: NO_OP },
      },
    );
  });

  it("answers every attention kind, and offers a button only where one can help", () => {
    const plain: PlainAttentionKind[] = [
      "auth_required",
      "configuration_invalid",
      "transport_retrying",
      "adapter_disconnected",
      "context_limit_reached",
      "partial_turn_interrupted",
      "adapter_unrecoverable",
      "input_required",
      "permission_required",
    ];
    const drawn = plain.map((kind) => {
      const blocker = sessionBlocker(raised(attention(kind)), ACTS, false);
      return [blocker?.message, blocker?.action?.label ?? null];
    });

    expect(drawn).toEqual([
      ["Sign-in required", "Settings"],
      ["Configuration invalid", "Settings"],
      ["Reconnecting", "Retry"],
      ["Disconnected", "Retry"],
      ["Context limit reached", null],
      ["Turn interrupted", null],
      ["Session stopped", null],
      ["Waiting for an answer", null],
      ["Waiting for approval", null],
    ]);
  });

  it("names the provider's own time where it sent one, and invents none where it did not", () => {
    const at = Date.UTC(2026, 0, 2, 15, 4);
    const clause = ` until ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

    expect(sessionBlocker(raised(rateLimited(at)), ACTS, false)?.message).toBe(
      `Rate limited${clause}`,
    );
    expect(sessionBlocker(raised(rateLimited(null)), ACTS, false)).toEqual({
      message: "Rate limited",
      detail: null,
      tone: "waiting",
      action: { label: "Retry", act: NO_OP },
    });
    expect(sessionBlocker(raised(quotaSpent(at)), ACTS, false)?.message).toBe(
      `Quota exhausted${clause}`,
    );
    expect(sessionBlocker(raised(quotaSpent(Number.NaN)), ACTS, false)?.message).toBe(
      "Quota exhausted",
    );
  });
});

describe("terminalCompanionTabId", () => {
  it("opens the user's active existing tab, with the newest tab as a defensive fallback", () => {
    expect(
      terminalCompanionTabId({
        activeSessionId: "terminal-1",
        tabs: [{ sessionId: "terminal-1" }, { sessionId: "terminal-2" }],
      }),
    ).toBe("terminal-1");
    expect(
      terminalCompanionTabId({
        activeSessionId: null,
        tabs: [{ sessionId: "terminal-1" }, { sessionId: "terminal-2" }],
      }),
    ).toBe("terminal-2");
    expect(terminalCompanionTabId(undefined)).toBeNull();
  });
});

describe("answerInteraction", () => {
  it("sends the redirection once the refusal has landed", async () => {
    const acts = recorder(true);

    await answerInteraction(
      "permission:1",
      { resolution: REFUSAL, message: "run the tests" },
      acts.acts,
    );

    expect(acts.delivered).toEqual(["run the tests"]);
  });

  it("keeps the redirection to itself when the decision never reached the harness", async () => {
    const acts = recorder(false);

    await answerInteraction(
      "permission:1",
      { resolution: REFUSAL, message: "run the tests" },
      acts.acts,
    );

    expect(acts.delivered).toEqual([]);
  });

  it("marks only its own card, and clears it however the round trip ends", async () => {
    const landed = recorder(true);
    const failed = recorder(false);

    await answerInteraction("permission:1", { resolution: REFUSAL, message: null }, landed.acts);
    await answerInteraction("permission:2", { resolution: REFUSAL, message: null }, failed.acts);

    expect(landed.flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
    expect(failed.flags).toEqual([
      ["permission:2", true],
      ["permission:2", false],
    ]);
  });

  it("resolves the interaction it was given, with the submission's own resolution", async () => {
    const seen: [string, SessionInteractionResolution][] = [];

    await answerInteraction(
      "question:7",
      { resolution: REFUSAL, message: null },
      {
        resolve: (interactionId, resolution) => {
          seen.push([interactionId, resolution]);
          return Promise.resolve(true);
        },
        deliver: NO_OP,
        resolving: NO_OP,
      },
    );

    expect(seen).toEqual([["question:7", REFUSAL]]);
  });
});

describe("withdrawInteraction", () => {
  /** The card's controls are disabled by this latch, and Stop was outside it. */
  it("holds the card's own in-flight latch for the whole round trip", async () => {
    const flags: [string, boolean][] = [];
    const acts: string[] = [];

    await withdrawInteraction("permission:1", {
      interrupt: () => {
        acts.push("interrupt");
        return Promise.resolve(true);
      },
      cancel: (interactionId) => {
        expect(flags).toEqual([["permission:1", true]]);
        acts.push(`cancel:${interactionId}`);
        return Promise.resolve(true);
      },
      resolving: (id, active) => flags.push([id, active]),
    });

    expect(acts).toEqual(["interrupt", "cancel:permission:1"]);
    expect(flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
  });

  it("gives the card back however the round trip ends", async () => {
    const flags: [string, boolean][] = [];

    await expect(
      withdrawInteraction("permission:1", {
        interrupt: () => Promise.reject(new Error("socket hang up")),
        cancel: () => Promise.resolve(true),
        resolving: (id, active) => flags.push([id, active]),
      }),
    ).rejects.toThrow("socket hang up");

    expect(flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
  });
});

describe("resolvingWith", () => {
  it("answers one card without disabling the others", () => {
    const resolving = resolvingWith(new Set(["permission:1"]), "permission:2", true);

    expect([...resolving]).toEqual(["permission:1", "permission:2"]);
    expect([...resolvingWith(resolving, "permission:1", false)]).toEqual(["permission:2"]);
  });

  it("leaves the set it was given alone", () => {
    const current: ReadonlySet<string> = new Set(["permission:1"]);

    resolvingWith(current, "permission:2", true);

    expect([...current]).toEqual(["permission:1"]);
  });
});

describe("messageRoute", () => {
  it("holds anything typed before there is somewhere to send it", () => {
    expect(messageRoute("send", false)).toBe("hold");
    expect(messageRoute("steer", false)).toBe("hold");
  });

  it("holds what the composer queued on purpose", () => {
    expect(messageRoute("queue", true)).toBe("hold");
  });

  it("sends when the Session can take it", () => {
    expect(messageRoute("send", true)).toBe("send");
    expect(messageRoute("steer", true)).toBe("send");
  });
});

/* -------------------------------------------------------------- identity */

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("holdList", () => {
  /**
   * The whole of the transcript's frame budget, stated as a count. Every turn
   * arrives in a new array on every frame batch, so without this each of them is
   * a new prop and each of them re-segments and repaints.
   */
  it("hands back every turn but the one the token landed in", () => {
    const settled = [assistantMessage("m1", "one"), assistantMessage("m2", "two")];
    const live = assistantMessage("m3", "thin");
    const previous = [[settled[0]!], [settled[1]!], [live]];
    const next = [[settled[0]!], [settled[1]!], [assistantMessage("m3", "thinking")]];

    const held = holdList(previous, next, sameMessages);

    expect(held[0]).toBe(previous[0]);
    expect(held[1]).toBe(previous[1]);
    expect(held[2]).toBe(next[2]);
    expect(held.filter((turn, index) => turn !== previous[index])).toHaveLength(1);
  });

  it("keeps the list itself when nothing in it moved", () => {
    const previous = [[assistantMessage("m1", "one")]];

    expect(holdList(previous, [[...previous[0]!]], sameMessages)).toBe(previous);
  });

  it("gives up the list the moment a turn is added", () => {
    const previous = [[assistantMessage("m1", "one")]];
    const next = [[...previous[0]!], [assistantMessage("m2", "two")]];

    const held = holdList(previous, next, sameMessages);

    expect(held).not.toBe(previous);
    expect(held[0]).toBe(previous[0]);
    expect(held[1]).toBe(next[1]);
  });

  it("takes the shorter list rather than holding a row that is gone", () => {
    const previous = [[assistantMessage("m1", "one")], [assistantMessage("m2", "two")]];

    expect(holdList(previous, [previous[0]!], sameMessages)).toEqual([previous[0]]);
  });
});

describe("sameMessages", () => {
  it("reads a re-emitted message as a change and a settled one as none", () => {
    const settled = assistantMessage("m1", "one");
    const streaming = assistantMessage("m2", "thin");

    expect(sameMessages([settled, streaming], [settled, streaming])).toBe(true);
    expect(sameMessages([settled, streaming], [settled, assistantMessage("m2", "thinking")])).toBe(
      false,
    );
    expect(sameMessages([settled], [settled, streaming])).toBe(false);
  });
});

describe("sameInteractionId", () => {
  it("reads an interaction re-projected under the same id as the one it already had", () => {
    const opened = {
      id: "permission:1",
      title: "Run tests?",
      detail: null,
    } as unknown as Parameters<typeof sameInteractionId>[0];
    const again = { ...opened };
    const other = { ...opened, id: "permission:2" };

    expect(sameInteractionId(opened, again)).toBe(true);
    expect(sameInteractionId(opened, other)).toBe(false);
  });
});
