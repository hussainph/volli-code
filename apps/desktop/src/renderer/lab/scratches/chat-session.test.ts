/**
 * The chat plane's decisions, without a plane.
 *
 * Four rules that were each a bug: what a blocker row still says while a card
 * is up, when a redirection is allowed to leave, which card a decision in
 * flight disables, and where words go when there is nowhere to send them. Named
 * `.test.ts` rather than `.tsx` so the lab shell's `scratches/*.tsx` glob does
 * not pick it up as a scratch.
 *
 * The identity rules at the foot are the fifth, and the only one that is not
 * about correctness: what a streamed token is allowed to re-render. They are
 * pure on purpose — a memo is only ever as good as the equality under it, and
 * that equality is testable without a renderer.
 */
import type { SessionAttention, SessionInteractionResolution } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { type SessionTodo } from "@renderer/chat/activity";

import {
  answerInteraction,
  holdList,
  messageRoute,
  resolvingWith,
  sameMessages,
  sameTodos,
  sessionBlocker,
  withdrawInteraction,
} from "./chat-session";

type BlockerSession = Parameters<typeof sessionBlocker>[0];

const NO_OP = () => undefined;

function labSession(overrides: Partial<BlockerSession> = {}): BlockerSession {
  return {
    error: null,
    diagnosticsError: null,
    catalogError: null,
    attention: { active: [], primary: null },
    catalogState: "ready",
    recover: () => Promise.resolve(true),
    ...overrides,
  };
}

/** The kinds that carry nothing but the base fields — no `retryAt`, no `resetAt`. */
type PlainAttentionKind = Exclude<SessionAttention["kind"], "quota_exhausted" | "rate_limited">;

function attention(kind: PlainAttentionKind): SessionAttention {
  return { id: `attention-${kind}`, attachmentId: null, detail: null, diagnostic: null, kind };
}

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
      labSession({ error: "Decision not delivered: socket hang up" }),
      NO_OP,
      true,
    );

    expect(blocker?.message).toBe("Decision not delivered: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("keeps a harness attention the card cannot answer", () => {
    const blocker = sessionBlocker(
      labSession({ attention: { active: [], primary: attention("auth_required") } }),
      NO_OP,
      true,
    );

    expect(blocker?.message).toBe("Sign-in required");
  });

  it("stands down for the attention the card is itself the answer to", () => {
    const asked = { active: [], primary: attention("permission_required") };

    expect(sessionBlocker(labSession({ attention: asked }), NO_OP, true)).toBeNull();
    expect(sessionBlocker(labSession({ attention: asked }), NO_OP, false)?.message).toBe(
      "Waiting for approval",
    );
  });

  it("does not ask for models while a card is waiting for an answer", () => {
    expect(sessionBlocker(labSession({ catalogState: "empty" }), NO_OP, true)).toBeNull();
    expect(sessionBlocker(labSession({ catalogState: "empty" }), NO_OP, false)?.message).toBe(
      "No models configured",
    );
  });

  it("never lets a diagnostics failure mask a state to recover from", () => {
    const blocker = sessionBlocker(
      labSession({
        diagnosticsError: "stream closed",
        attention: { active: [], primary: attention("auth_required") },
      }),
      NO_OP,
      false,
    );

    expect(blocker?.message).toBe("Sign-in required");
  });

  it("never lets a catalog failure stand in for the Session's own", () => {
    const blocker = sessionBlocker(
      labSession({ error: "Lost the Session stream: socket hang up", catalogError: "ECONNRESET" }),
      NO_OP,
      false,
    );

    expect(blocker?.message).toBe("Lost the Session stream: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("says a catalog refresh failed, and offers the place that re-asks it", () => {
    const blocker = sessionBlocker(
      labSession({ catalogError: "ECONNRESET", catalogState: "error" }),
      NO_OP,
      false,
    );

    expect(blocker).toEqual({
      message: "Models unavailable",
      detail: "ECONNRESET",
      tone: "error",
      action: { label: "Settings", act: NO_OP },
    });
  });

  it("still says a diagnostics failure when nothing else is blocking", () => {
    const blocker = sessionBlocker(labSession({ diagnosticsError: "stream closed" }), NO_OP, false);

    expect(blocker).toEqual({
      message: "Diagnostics unavailable",
      detail: "stream closed",
      tone: "error",
      action: null,
    });
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
        // Marked before either act, so a second click lands on a disabled Stop
        // rather than on a second withdrawal of the same interaction.
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

function plan(step: SessionTodo["status"]): SessionTodo[] {
  return [
    { id: "t1", content: "Read the seam", status: "completed", priority: "medium" },
    { id: "t2", content: "Hold the plan by value", status: step, priority: "high" },
  ];
}

describe("holdList", () => {
  /**
   * The whole of the transcript's frame budget, stated as a count. Every turn
   * arrives in a new array on every frame batch, so without this each of them
   * is a new prop and each of them re-segments and repaints.
   */
  it("hands back every turn but the one the token landed in", () => {
    const settled = [assistantMessage("m1", "one"), assistantMessage("m2", "two")];
    const live = assistantMessage("m3", "thin");
    const previous = [[settled[0]!], [settled[1]!], [live]];
    // What the next batch projects: the same objects for everything settled, a
    // fresh snapshot for the message still being written, and new arrays around
    // all three because `groupTurns` rebuilds every one of them.
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

describe("sameTodos", () => {
  it("holds a plan that was re-projected unchanged", () => {
    expect(sameTodos(plan("in_progress"), plan("in_progress"))).toBe(true);
  });

  it("gives way when a step moves on", () => {
    expect(sameTodos(plan("in_progress"), plan("completed"))).toBe(false);
    expect(sameTodos(plan("in_progress"), plan("in_progress").slice(1))).toBe(false);
  });

  it("tells a Session with no plan from one whose plan is empty", () => {
    expect(sameTodos(null, null)).toBe(true);
    expect(sameTodos(null, [])).toBe(false);
    expect(sameTodos([], null)).toBe(false);
  });
});
