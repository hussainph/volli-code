import type { RuntimeAskChoice, RuntimeAskRequest } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AuthorityVerdict } from "../authority/gate";
import {
  AuthorityEscalation,
  type AuthorityDisposition,
  type AuthorityEscalationInput,
} from "./escalation";

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

/** A refusal a person could grant and must not be offered the chance to. */
const HARD_DENY: AuthorityVerdict = {
  outcome: "deny",
  cause: "command.persistence",
  reason: "This command installs something that outlives the Session.",
};

const SILENT_REFUSAL = {
  outcome: "deny",
  reason: OVERRIDABLE.reason,
  cause: OVERRIDABLE.cause,
  record: true,
  interrupt: false,
} as const;

function escalation(input: Partial<AuthorityEscalationInput> = {}): AuthorityEscalation {
  return new AuthorityEscalation({
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    ...input,
  });
}

/** One call, named the way `beforeToolCall` names it. */
function resolving(
  machine: AuthorityEscalation,
  verdict: AuthorityVerdict,
  tool: string,
  signal?: AbortSignal,
): Promise<AuthorityDisposition> {
  return machine.resolve({
    verdict,
    tool,
    toolCallId: `${tool}-call`,
    turnId: "turn-1",
    ...(signal ? { signal } : {}),
  });
}

/** An ask that never returns on its own, so a test can decide how it ends. */
function pendingAsk(): {
  ask: (request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>;
  asked: Promise<{ request: RuntimeAskRequest; signal: AbortSignal }>;
  answer: (choice: RuntimeAskChoice) => void;
  reject: (error: Error) => void;
} {
  const put = Promise.withResolvers<{ request: RuntimeAskRequest; signal: AbortSignal }>();
  const settled = Promise.withResolvers<RuntimeAskChoice>();
  return {
    ask: (request, signal) => {
      put.resolve({ request, signal });
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

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(await resolving(machine, ALLOW, "read")).toEqual({ outcome: "allow" });
    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);

    expect(ask).not.toHaveBeenCalled();
  });

  it("refuses in silence forever when there is no host to ask", async () => {
    const machine = escalation({ fallback: { consecutiveDenials: 1, sessionDenials: 1 } });

    for (let call = 0; call < 4; call += 1) {
      expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    }
  });

  it("asks once the run of refusals reaches the consecutive threshold", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 3, sessionDenials: 100 }, ask });

    await resolving(machine, OVERRIDABLE, "bash");
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).not.toHaveBeenCalled();

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledExactlyOnceWith(
      {
        cause: "command.git-discards-work",
        tool: "bash",
        toolCallId: "bash-call",
        turnId: "turn-1",
        reason: OVERRIDABLE.reason,
        trip: "consecutive",
        overridable: true,
      },
      expect.any(AbortSignal),
    );
  });

  it("counts the refusals it inherited toward the Session threshold", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 100, sessionDenials: 20 },
      priorDenials: 19,
      ask,
    });

    await resolving(machine, REPORTED, "read");

    expect(ask).toHaveBeenCalledExactlyOnceWith(
      {
        cause: "path.outside-workspace",
        tool: "read",
        toolCallId: "read-call",
        turnId: "turn-1",
        reason: REPORTED.reason,
        trip: "session",
        overridable: false,
      },
      expect.any(AbortSignal),
    );
  });

  it("names the consecutive half when both would trip on the same call", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 1, sessionDenials: 1 }, ask });

    await resolving(machine, OVERRIDABLE, "bash");

    expect(ask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ trip: "consecutive" }),
      expect.any(AbortSignal),
    );
  });

  it("lets the call run when the refusal is overruled, and writes nothing down", async () => {
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: async () => "allow",
    });

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual({ outcome: "allow" });
  });

  it("refuses anyway, and records it, when a host grants what nobody may grant", async () => {
    const ask = vi.fn(async () => "allow" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask,
    });

    // The rule is perfectly grantable — a login item or a cron entry would run
    // if this layer stood aside, and the sandbox would not stop it either. That
    // is exactly why the answer does not carry: enforcement lives here, not in
    // whatever surface put the question up.
    expect(await resolving(machine, HARD_DENY, "bash")).toEqual({
      outcome: "deny",
      reason: HARD_DENY.reason,
      cause: HARD_DENY.cause,
      record: true,
      interrupt: false,
    });
    expect(ask).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ overridable: false }),
      expect.any(AbortSignal),
    );
  });

  it("ends the turn on stop, and only records the refusal on the way out", async () => {
    const machine = escalation({
      fallback: { consecutiveDenials: 1, sessionDenials: 100 },
      ask: async () => "stop",
    });

    expect(await resolving(machine, REPORTED, "read")).toEqual({
      outcome: "deny",
      reason: REPORTED.reason,
      cause: REPORTED.cause,
      record: true,
      interrupt: true,
    });
  });

  it("asks again an interval later rather than on every call after the first", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({ fallback: { consecutiveDenials: 100, sessionDenials: 2 }, ask });

    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).not.toHaveBeenCalled();
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("records the refusal when the host cannot obtain an answer at all", async () => {
    const pending = pendingAsk();
    const ask = vi.fn(pending.ask);
    const machine = escalation({ fallback: { consecutiveDenials: 2, sessionDenials: 100 }, ask });

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    const escalated = resolving(machine, OVERRIDABLE, "bash");
    await pending.asked;
    pending.reject(new Error("the host stopped waiting"));

    // Nothing was cancelled. Pi applies the block, the model is told exactly
    // why, and a refusal the model received is a refusal history must hold —
    // otherwise a Session whose host can never answer accrues denials that
    // never reach the ledger and a threshold that never arrives.
    expect(await escalated).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledOnce();
  });

  it("stands the Session threshold down after a refusal it could not put to anyone", async () => {
    const ask = vi.fn(async () => {
      throw new Error("the host stopped waiting");
    });
    const machine = escalation({
      fallback: { consecutiveDenials: 100, sessionDenials: 2 },
      priorDenials: 1,
      ask,
    });

    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    // Recorded, so the count moved to two and the next question is due at four.
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("leaves the Session threshold where it was when nobody saw the question", async () => {
    const pending = pendingAsk();
    const controller = new AbortController();
    const ask = vi
      .fn<(request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>>()
      .mockImplementationOnce(pending.ask)
      .mockImplementation(async () => "refuse");
    const machine = escalation({
      fallback: { consecutiveDenials: 100, sessionDenials: 2 },
      priorDenials: 1,
      ask,
    });

    const escalated = resolving(machine, OVERRIDABLE, "bash", controller.signal);
    await pending.asked;
    controller.abort();
    expect(await escalated).toEqual({ ...SILENT_REFUSAL, record: false });

    // The count never moved and the target was never pushed out, so the very
    // next refusal reaches the same threshold and asks again. Had the abandoned
    // question stood the Session half down, this would buy an interval of
    // silence on the strength of a question nobody ever saw.
    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not wedge when the host throws instead of rejecting", async () => {
    const ask = vi.fn((): Promise<RuntimeAskChoice> => {
      throw new TypeError("ask is not a function");
    });
    const machine = escalation({ fallback: { consecutiveDenials: 1, sessionDenials: 100 }, ask });

    // A throw that escaped the guard would leave the consecutive count one short
    // of its threshold, so every later refusal would ask again and throw again.
    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it.each([
    { what: "the attachment", signalFor: "attachment" as const },
    { what: "the run this call belongs to", signalFor: "call" as const },
  ])("records nothing when $what is cancelled mid-question", async ({ signalFor }) => {
    const controller = new AbortController();
    const pending = pendingAsk();
    // Deliberately the same pending ask throughout: were the machine to put the
    // question up again, it would take the late `allow` immediately and let the
    // call run, which is precisely what must not happen.
    const ask = vi.fn(pending.ask);
    const machine = escalation({
      fallback: { consecutiveDenials: 2, sessionDenials: 100 },
      ask,
      ...(signalFor === "attachment" ? { signal: controller.signal } : {}),
    });

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    const escalated = resolving(
      machine,
      OVERRIDABLE,
      "bash",
      signalFor === "call" ? controller.signal : undefined,
    );
    const question = await pending.asked;
    controller.abort();

    expect(await escalated).toEqual({ ...SILENT_REFUSAL, record: false });
    // The host is told the question it is showing has been abandoned; without
    // that it would sit open against a turn that has already moved on.
    expect(question.signal.aborted).toBe(true);

    // An answer that arrives after the cancellation decides nothing. The next
    // refusal is silent because the consecutive run stood down when the question
    // was put — not overruled, which is what the late `allow` would have meant.
    pending.answer("allow");
    await Promise.resolve();
    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    expect(ask).toHaveBeenCalledOnce();
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

    expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual({
      ...SILENT_REFUSAL,
      record: false,
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
      await resolving(machine, OVERRIDABLE, "bash", run.signal);
    }

    for (const { added, removed } of listeners) {
      expect(added).toHaveBeenCalledTimes(3);
      expect(removed).toHaveBeenCalledTimes(3);
    }
  });

  it.each([
    { what: "zero", fallback: { consecutiveDenials: 0, sessionDenials: 0 } },
    { what: "negative", fallback: { consecutiveDenials: -1, sessionDenials: -20 } },
    {
      what: "not a number at all",
      fallback: { consecutiveDenials: Number.NaN, sessionDenials: Number.NaN },
    },
  ])("never escalates on a threshold of $what", async ({ fallback }) => {
    const ask = vi.fn(async () => "allow" as const);
    const machine = escalation({ fallback, priorDenials: 500, ask });

    for (let call = 0; call < 5; call += 1) {
      expect(await resolving(machine, OVERRIDABLE, "bash")).toEqual(SILENT_REFUSAL);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads a fractional threshold as the whole number below it", async () => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 1.9, sessionDenials: 100.5 },
      ask,
    });

    await resolving(machine, OVERRIDABLE, "bash");

    expect(ask).toHaveBeenCalledOnce();
  });

  it.each([
    { what: "not a number", priorDenials: Number.NaN },
    { what: "below zero", priorDenials: -5 },
  ])("ignores a seed that is $what rather than counting from it", async ({ priorDenials }) => {
    const ask = vi.fn(async () => "refuse" as const);
    const machine = escalation({
      fallback: { consecutiveDenials: 100, sessionDenials: 2 },
      priorDenials,
      ask,
    });

    // A seed left as-is would poison every later sum: `NaN` compares false
    // against the threshold forever, and a negative one pushes the question out
    // by however far below zero it started.
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).not.toHaveBeenCalled();
    await resolving(machine, OVERRIDABLE, "bash");
    expect(ask).toHaveBeenCalledOnce();
  });
});
