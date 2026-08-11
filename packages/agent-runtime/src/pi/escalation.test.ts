import type { RuntimeAskOutcome, RuntimeAskRequest } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AuthorityVerdict } from "../authority/gate";
import { AuthorityEscalation, type AuthorityEscalationInput } from "./escalation";

const ALLOW: AuthorityVerdict = { outcome: "allow" };

/** A refusal consent could carry out, and so one an ask can offer to override. */
const OVERRIDABLE: AuthorityVerdict = {
  outcome: "deny",
  cause: "command.git-discards-work",
  reason: "This command discards uncommitted work in a Main checkout.",
};

/** A refusal that stands whatever the answer, because the sandbox denies it too. */
const REPORTED: AuthorityVerdict = {
  outcome: "deny",
  cause: "path.outside-workspace",
  reason: "This path resolves outside the Session workspace.",
};

const SILENT_REFUSAL = {
  outcome: "refuse",
  reason: OVERRIDABLE.reason,
  cause: OVERRIDABLE.cause,
  record: true,
  endTurn: false,
} as const;

function escalation(input: Partial<AuthorityEscalationInput> = {}): AuthorityEscalation {
  return new AuthorityEscalation({
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    ...input,
  });
}

/** An ask that never returns on its own, so a test can decide how it ends. */
function pendingAsk(): {
  ask: (request: RuntimeAskRequest) => Promise<RuntimeAskOutcome>;
  asked: Promise<RuntimeAskRequest>;
  answer: (outcome: RuntimeAskOutcome) => void;
  reject: (error: Error) => void;
} {
  const put = Promise.withResolvers<RuntimeAskRequest>();
  const settled = Promise.withResolvers<RuntimeAskOutcome>();
  return {
    ask: (request) => {
      put.resolve(request);
      return settled.promise;
    },
    asked: put.promise,
    answer: settled.resolve,
    reject: settled.reject,
  };
}

describe("AuthorityEscalation", () => {
  it("stands aside for an allowed call and forgets the run of refusals before it", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 2, sessionDenials: 100 }, ask });

    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(await machine.resolve(ALLOW, "read")).toEqual({ outcome: "proceed" });
    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);

    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses in silence forever when there is no host to ask", async () => {
    const machine = escalation({ fallback: { consecutiveDenials: 1, sessionDenials: 1 } });

    for (let call = 0; call < 4; call += 1) {
      expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    }
  });

  it("asks once the run of refusals reaches the consecutive threshold", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 3, sessionDenials: 100 }, ask });

    await machine.resolve(OVERRIDABLE, "bash");
    await machine.resolve(OVERRIDABLE, "bash");
    expect(ask).not.toHaveBeenCalled();

    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledExactlyOnceWith({
      cause: "command.git-discards-work",
      tool: "bash",
      reason: OVERRIDABLE.reason,
      trip: "consecutive",
      overridable: true,
    });
  });

  it("counts the refusals it inherited toward the Session threshold", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 100, sessionDenials: 20 },
      priorDenials: 19,
      ask,
    });

    await machine.resolve(REPORTED, "read");

    expect(ask).toHaveBeenCalledExactlyOnceWith({
      cause: "path.outside-workspace",
      tool: "read",
      reason: REPORTED.reason,
      trip: "session",
      overridable: false,
    });
  });

  it("names the consecutive half when both would trip on the same call", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 1, sessionDenials: 1 }, ask });

    await machine.resolve(OVERRIDABLE, "bash");

    expect(ask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ trip: "consecutive" }));
  });

  it("lets the call run when the refusal is overruled, and writes nothing down", async () => {
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: async () => "allow",
    });

    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual({ outcome: "proceed" });
  });

  it("ends the turn on stop, and only records the refusal on the way out", async () => {
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: async () => "stop",
    });

    expect(await machine.resolve(REPORTED, "read")).toEqual({
      outcome: "refuse",
      reason: REPORTED.reason,
      cause: REPORTED.cause,
      record: true,
      endTurn: true,
    });
  });

  it("asks again an interval later rather than on every call after the first", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 100, sessionDenials: 2 }, ask });

    await machine.resolve(OVERRIDABLE, "bash");
    expect(ask).not.toHaveBeenCalled();
    await machine.resolve(OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    await machine.resolve(OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    await machine.resolve(OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not put a dismissed question back in front of the same person", async () => {
    const pending = pendingAsk();
    const ask = vi.fn(pending.ask);
    const machine = escalation({ fallback: { consecutiveDenials: 2, sessionDenials: 100 }, ask });

    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    const escalated = machine.resolve(OVERRIDABLE, "bash");
    await pending.asked;
    pending.reject(new Error("the host stopped waiting"));

    expect(await escalated).toEqual({
      outcome: "refuse",
      reason: OVERRIDABLE.reason,
      cause: OVERRIDABLE.cause,
      record: false,
      endTurn: false,
    });
    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledOnce();
  });

  it.each([
    { what: "the attachment", signalFor: "attachment" as const },
    { what: "the run this call belongs to", signalFor: "call" as const },
  ])("records nothing when $what is cancelled mid-question", async ({ signalFor }) => {
    const controller = new AbortController();
    const pending = pendingAsk();
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: pending.ask,
      ...(signalFor === "attachment" ? { signal: controller.signal } : {}),
    });

    const escalated = machine.resolve(
      OVERRIDABLE,
      "bash",
      signalFor === "call" ? controller.signal : undefined,
    );
    await pending.asked;
    controller.abort();

    expect(await escalated).toEqual({
      outcome: "refuse",
      reason: OVERRIDABLE.reason,
      cause: OVERRIDABLE.cause,
      record: false,
      endTurn: false,
    });
    // The answer that arrives after the run was cancelled changes nothing, and
    // must not resolve a second disposition behind the first one's back.
    pending.answer("allow");
    expect(await escalated).toMatchObject({ outcome: "refuse" });
  });

  it("never asks a question nobody is left to answer", async () => {
    const controller = new AbortController();
    controller.abort();
    const ask = vi.fn(async () => "allow" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask,
      signal: controller.signal,
    });

    expect(await machine.resolve(OVERRIDABLE, "bash")).toEqual({
      outcome: "refuse",
      reason: OVERRIDABLE.reason,
      cause: OVERRIDABLE.cause,
      record: false,
      endTurn: false,
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("leaves no abort listener behind on either signal it raced", async () => {
    const attachment = new AbortController();
    const run = new AbortController();
    const listeners = [attachment.signal, run.signal].map((signal) => ({
      added: vi.spyOn(signal, "addEventListener"),
      removed: vi.spyOn(signal, "removeEventListener"),
    }));
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: async () => "refuse",
      signal: attachment.signal,
    });

    for (let call = 0; call < 3; call += 1) {
      await machine.resolve(OVERRIDABLE, "bash", run.signal);
    }

    for (const { added, removed } of listeners) {
      expect(added).toHaveBeenCalledTimes(3);
      expect(removed).toHaveBeenCalledTimes(3);
    }
  });
});
