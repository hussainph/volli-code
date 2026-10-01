import {
  DECISION_PURPOSE_POLICY,
  type DecisionAnswered,
  type DecisionMiss,
  type DecisionModelSetting,
  type DecisionPurpose,
  type DecisionPurposePolicy,
  type SessionUsage,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { piDecisionClassifier, type DecisionClassifier } from "../pi/classifier";
import {
  fakeLlamaServer,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  FIXTURE_SECRET,
  fixtureModels,
} from "./fixture.test-support";
import { createDecisionService, type DecisionServiceOptions } from "./service";

const CLOUD: DecisionModelSetting = {
  kind: "cloud",
  providerId: FIXTURE_PROVIDER,
  modelId: FIXTURE_MODEL,
  optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
};

const QUESTIONS = {
  page: {
    type: "choice",
    instructions: "Which page is this?",
    criteria: { login: "A sign-in form", inbox: "A message list", error: "An error page" },
  },
  filled: {
    type: "score",
    instructions: "How far is the form filled in?",
    criteria: ["empty", "partly", "complete"],
  },
  blocked: {
    type: "bool",
    instructions: "Is the person blocked by an error?",
    criteria: { true: "An error blocks them", false: "Nothing blocks them" },
  },
};
const STATE = { title: "Sign in", fields: ["email", "password"] };

type Outcome = { answered: DecisionAnswered } | { miss: DecisionMiss };

/** One decision, asked the way every caller must: with a use AND a fallback. */
function ask(
  decisions: ReturnType<typeof createDecisionService>,
  overrides: Partial<{
    purpose: DecisionPurpose;
    sessionId: string | null;
    state: unknown;
    questions: unknown;
    signal: AbortSignal;
  }> = {},
): Promise<Outcome> {
  return decisions.decide<Outcome>({
    purpose: "agent.classify",
    sessionId: "session-1",
    state: STATE,
    questions: QUESTIONS,
    ...overrides,
    use: (answered) => ({ answered }),
    fallback: (miss) => ({ miss }),
  });
}

function service(overrides: Partial<DecisionServiceOptions> = {}) {
  const usage: Array<{ sessionId: string; purpose: DecisionPurpose; usage: SessionUsage }> = [];
  const failures: unknown[] = [];
  const decisions = createDecisionService({
    resolveSetting: () => CLOUD,
    classifier: piDecisionClassifier(fixtureModels()),
    recordUsage: (fact) => {
      usage.push(fact);
    },
    onRecordFailure: (error) => failures.push(error),
    ...overrides,
  });
  return { decisions, usage, failures };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The shipped policy with one field changed — a deadline a test can wait out. */
function withPolicy(patch: Partial<DecisionPurposePolicy>) {
  return (purpose: DecisionPurpose): DecisionPurposePolicy => ({
    ...DECISION_PURPOSE_POLICY[purpose],
    ...patch,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a decision that is made", () => {
  it("answers every question type, held to the questions asked", async () => {
    const { decisions } = service();
    const outcome = await ask(decisions);
    expect(outcome).toEqual({
      answered: {
        answers: {
          page: {
            type: "choice",
            choice: "login",
            probabilities: { login: 0.85, inbox: 0.075, error: 0.075 },
            confidence: 0.8,
          },
          filled: { type: "score", score: 1.8, level: 2, label: "complete", confidence: 0.7 },
          blocked: {
            type: "bool",
            value: true,
            probability: 0.92,
            confidence: expect.closeTo(0.84),
          },
        },
        model: { where: "cloud", providerId: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL },
        elapsedMs: expect.any(Number),
      },
    });
  });

  it("bills the call to its Session as decision usage, attributed to its purpose", async () => {
    const { decisions, usage } = service();
    await ask(decisions);
    await flush();
    expect(usage).toEqual([
      {
        sessionId: "session-1",
        purpose: "agent.classify",
        usage: expect.objectContaining({
          cause: "decision",
          providerId: FIXTURE_PROVIDER,
          modelId: FIXTURE_MODEL,
          inputTokens: 420,
          costUsd: 0.0000176,
          costBasis: "catalog-estimate",
        }),
      },
    ]);
  });

  it("meters nothing for a call with no Session, and still answers", async () => {
    const { decisions, usage } = service();
    const outcome = await ask(decisions, { sessionId: null });
    await flush();
    expect("answered" in outcome).toBe(true);
    expect(usage).toEqual([]);
  });

  it("keeps a decision when its bill fails to land, and reports the failure", async () => {
    const { decisions, failures } = service({
      recordUsage: () => Promise.reject(new Error("ledger closed")),
    });
    expect("answered" in (await ask(decisions))).toBe(true);
    await flush();
    expect(failures).toEqual([new Error("ledger closed")]);
  });

  it("answers without metering when no ledger is wired", async () => {
    const { decisions } = service({ recordUsage: undefined, onRecordFailure: undefined });
    expect("answered" in (await ask(decisions))).toBe(true);
  });

  it("answers from a local server, billed as a free request", async () => {
    const { decisions, usage } = service({
      resolveSetting: () => ({
        kind: "local",
        server: "llama-cpp",
        baseUrl: "http://127.0.0.1:8080",
        modelId: "qwen3-4b",
      }),
      classifier: piDecisionClassifier(fixtureModels(), { fetch: fakeLlamaServer(0.8, []) }),
    });
    const outcome = await ask(decisions);
    expect("answered" in outcome && outcome.answered.model).toEqual({
      where: "local",
      providerId: "local-llama-cpp",
      modelId: "qwen3-4b",
    });
    await flush();
    expect(usage[0]?.usage).toMatchObject({ costUsd: 0, inputTokens: null });
  });

  it("measures the call from its own start", async () => {
    let now = 100;
    const { decisions } = service({ now: () => (now += 25) });
    const outcome = await ask(decisions);
    expect("answered" in outcome && outcome.answered.elapsedMs).toBe(25);
  });
});

describe("the fallback is the answer to every miss", () => {
  it("falls back, sending nothing, when no decision model is configured", async () => {
    const seen: unknown[] = [];
    const { decisions, usage } = service({
      resolveSetting: () => ({ kind: "none" }),
      classifier: piDecisionClassifier(fixtureModels({ seen: seen as never })),
    });
    expect(await ask(decisions)).toEqual({
      miss: { status: "unavailable", reason: "unset", message: expect.any(String) },
    });
    expect(seen).toEqual([]);
    expect(usage).toEqual([]);
  });

  it("falls back when a cloud model's opt-in does not cover the purpose", async () => {
    const { decisions } = service({
      resolveSetting: () => ({ ...CLOUD, optIn: { acceptedAt: 1, purposes: [] } }),
    });
    expect(await ask(decisions)).toMatchObject({ miss: { reason: "not-opted-in" } });
  });

  it("falls back as unset when the setting cannot be read", async () => {
    const { decisions } = service({
      resolveSetting: () => Promise.reject(new Error("db closed")),
    });
    expect(await ask(decisions)).toMatchObject({ miss: { reason: "unset" } });
  });

  it("passes the caller's scope to the setting read", async () => {
    const scopes: unknown[] = [];
    const { decisions } = service({
      resolveSetting: (scope) => {
        scopes.push(scope);
        return CLOUD;
      },
    });
    await decisions.decide({
      purpose: "agent.classify",
      projectId: "project-9",
      state: STATE,
      questions: QUESTIONS,
      use: () => null,
      fallback: () => null,
    });
    expect(scopes).toEqual([{ sessionId: null, projectId: "project-9" }]);
  });

  it("falls back when the provider needs setup", async () => {
    const { decisions } = service({
      classifier: piDecisionClassifier(fixtureModels({ signedIn: false })),
    });
    expect(await ask(decisions)).toMatchObject({
      miss: { status: "unavailable", reason: "needs-setup" },
    });
  });

  it("falls back on an error result, with no provider text and no credential", async () => {
    const { decisions } = service({
      classifier: piDecisionClassifier(
        fixtureModels({
          answer: () => ({ stopReason: "error", errorMessage: `500 ${FIXTURE_SECRET}` }),
        }),
      ),
    });
    const outcome = await ask(decisions);
    expect(outcome).toMatchObject({ miss: { status: "error", reason: "provider-error" } });
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_SECRET);
  });

  it("falls back when a classifier throws instead of answering", async () => {
    const { decisions } = service({
      classifier: { classify: () => Promise.reject(new Error(FIXTURE_SECRET)) },
    });
    const outcome = await ask(decisions);
    expect(outcome).toMatchObject({ miss: { reason: "provider-error" } });
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_SECRET);
  });

  it("falls back when the answer leaves a question unanswered, and still bills it", async () => {
    const { decisions, usage } = service({
      classifier: piDecisionClassifier(
        fixtureModels({
          answer: () => ({
            answers: { blocked: { type: "bool", probability: 0.5 } },
            usage: {
              input: 10,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 10,
              cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
            },
          }),
        }),
      ),
    });
    expect(await ask(decisions)).toMatchObject({ miss: { reason: "malformed-answer" } });
    await flush();
    expect(usage).toHaveLength(1);
  });

  it("falls back when the caller cannot act on the answer", async () => {
    const { decisions } = service();
    const outcome = await decisions.decide({
      purpose: "agent.classify",
      state: STATE,
      questions: QUESTIONS,
      use: () => {
        throw new Error("not a candidate");
      },
      fallback: (miss) => miss.reason,
    });
    expect(outcome).toBe("malformed-answer");
  });

  it("refuses a caller that is not a purpose", async () => {
    const { decisions } = service();
    expect(await ask(decisions, { purpose: "authority.judge" as DecisionPurpose })).toMatchObject({
      miss: { reason: "invalid-request" },
    });
  });
});

describe("bounds", () => {
  it("refuses a bound breach before reaching any model", async () => {
    const seen: unknown[] = [];
    const { decisions } = service({
      classifier: piDecisionClassifier(fixtureModels({ seen: seen as never })),
    });
    const tooBig = await ask(decisions, { state: { text: "x".repeat(40 * 1024) } });
    expect(tooBig).toMatchObject({
      miss: { status: "error", reason: "invalid-request", message: expect.stringMatching(/bytes/) },
    });
    const tooMany = await ask(decisions, {
      questions: Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`q${i}`, QUESTIONS.blocked]),
      ),
    });
    expect(tooMany).toMatchObject({ miss: { reason: "invalid-request" } });
    const tooManyChoices = await ask(decisions, {
      questions: {
        page: {
          ...QUESTIONS.page,
          criteria: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`o${i}`, "x"])),
        },
      },
    });
    expect(tooManyChoices).toMatchObject({ miss: { reason: "invalid-request" } });
    expect(seen).toEqual([]);
  });

  it("falls back on timeout, even from a model that ignores its signal", async () => {
    vi.useFakeTimers();
    const hung: DecisionClassifier = { classify: () => new Promise(() => {}) };
    const { decisions } = service({
      classifier: hung,
      policyFor: withPolicy({ timeoutMs: 2_000 }),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({
      miss: {
        status: "error",
        reason: "timeout",
        message: "The decision model did not answer within 2 s.",
      },
    });
  });

  it("falls back on timeout when reading the setting is what hangs", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const { decisions } = service({
      resolveSetting: () => new Promise(() => {}),
      classifier: piDecisionClassifier(fixtureModels({ seen: seen as never })),
      policyFor: withPolicy({ timeoutMs: 1_000 }),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ miss: { reason: "timeout" } });
    expect(seen).toEqual([]);
  });

  it("treats a classifier that throws synchronously as a provider error, never a rejection", async () => {
    const { decisions } = service({
      classifier: {
        classify: () => {
          throw new Error(FIXTURE_SECRET);
        },
      },
    });
    const outcome = await ask(decisions);
    expect(outcome).toMatchObject({ miss: { reason: "provider-error" } });
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_SECRET);
  });

  it("bills an answer that lands after the deadline, because the provider charged for it", async () => {
    vi.useFakeTimers();
    let answer: (() => void) | undefined;
    const slow: DecisionClassifier = {
      classify: (target, request, options) =>
        new Promise((resolve) => {
          answer = () =>
            void piDecisionClassifier(fixtureModels())
              .classify(target, request, { ...options, signal: new AbortController().signal })
              .then(resolve);
        }),
    };
    const { decisions, usage } = service({
      classifier: slow,
      policyFor: withPolicy({ timeoutMs: 500 }),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ miss: { reason: "timeout" } });
    vi.useRealTimers();
    answer!();
    await flush();
    await flush();
    expect(usage).toHaveLength(1);
  });

  it("admits a queued call the moment the one before it finishes", async () => {
    const releases: Array<() => void> = [];
    let classify = 0;
    const gated: DecisionClassifier = {
      classify: async (target, request, options) => {
        classify += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return piDecisionClassifier(fixtureModels()).classify(target, request, options);
      },
    };
    const { decisions } = service({ classifier: gated, maxConcurrent: 1 });
    const first = ask(decisions);
    const second = ask(decisions);
    await flush();
    expect(classify).toBe(1);
    releases.shift()!();
    expect("answered" in (await first)).toBe(true);
    await flush();
    releases.shift()!();
    expect("answered" in (await second)).toBe(true);
  });

  it("aborts the model's request when the deadline passes", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const listening: DecisionClassifier = {
      classify: (_target, _request, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({
              ok: false,
              usage: null,
              miss: { status: "error", reason: "aborted", message: "x" },
            });
          });
        }),
    };
    const { decisions } = service({
      classifier: listening,
      policyFor: withPolicy({ timeoutMs: 500 }),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ miss: { reason: "timeout" } });
    expect(aborted).toBe(true);
  });

  it("caps calls in flight, queues the rest, and times out a call that waited too long", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const gated: DecisionClassifier = {
      classify: async (target, request, options) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return piDecisionClassifier(fixtureModels()).classify(target, request, options);
      },
    };
    const { decisions } = service({
      classifier: gated,
      maxConcurrent: 2,
      policyFor: withPolicy({ timeoutMs: 1_000 }),
    });
    const calls = [ask(decisions), ask(decisions), ask(decisions), ask(decisions)];
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(2);
    // The first two finish; the third and fourth take their slots in order.
    releases.shift()!();
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    expect(peak).toBe(2);
    // Nobody frees the last two slots before their deadline: both fall back.
    await vi.advanceTimersByTimeAsync(1_000);
    const outcomes = await Promise.all(calls);
    expect(
      outcomes.map((outcome) => ("answered" in outcome ? "answered" : outcome.miss.reason)),
    ).toEqual(["answered", "answered", "timeout", "timeout"]);
  });

  it("keeps a slot held while a call the caller gave up on is still in flight, up to a hard cap", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    // Ignores its signal: only the cap can free the slot it holds.
    const stuck: DecisionClassifier = {
      classify: (_target, _request, _options) => {
        started.push("call");
        return new Promise(() => undefined);
      },
    };
    const { decisions } = service({
      classifier: stuck,
      maxConcurrent: 1,
      slotGraceMs: 500,
      policyFor: withPolicy({ timeoutMs: 1_000 }),
    });
    const first = ask(decisions);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toMatchObject({ miss: { reason: "timeout" } });
    // The first caller has its fallback, but its call is still running.
    const second = ask(decisions);
    await vi.advanceTimersByTimeAsync(400);
    expect(started).toHaveLength(1);
    // The cap (deadline + grace) frees the slot; the second call is let in.
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await second).toMatchObject({ miss: { reason: "timeout" } });
  });

  it("frees the slot when a call the caller gave up on finally settles", async () => {
    vi.useFakeTimers();
    const settle: Array<() => void> = [];
    const started: string[] = [];
    const slow: DecisionClassifier = {
      classify: (target, request, options) => {
        started.push("call");
        return new Promise((resolve) =>
          settle.push(() =>
            resolve(piDecisionClassifier(fixtureModels()).classify(target, request, options)),
          ),
        );
      },
    };
    const { decisions } = service({
      classifier: slow,
      maxConcurrent: 1,
      policyFor: withPolicy({ timeoutMs: 1_000 }),
    });
    const first = ask(decisions);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toMatchObject({ miss: { reason: "timeout" } });
    const second = ask(decisions);
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toHaveLength(1);
    settle.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
    settle.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect("answered" in (await second)).toBe(true);
  });

  it("lets a queued caller leave on its own abort", async () => {
    const releases: Array<() => void> = [];
    const gated: DecisionClassifier = {
      classify: async (target, request, options) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return piDecisionClassifier(fixtureModels()).classify(target, request, options);
      },
    };
    const { decisions } = service({ classifier: gated, maxConcurrent: 1 });
    const first = ask(decisions);
    const controller = new AbortController();
    const second = ask(decisions, { signal: controller.signal });
    const third = ask(decisions);
    await flush();
    controller.abort();
    expect(await second).toMatchObject({ miss: { reason: "aborted" } });
    releases.shift()!();
    expect("answered" in (await first)).toBe(true);
    await flush();
    // The withdrawn waiter gave its place to the next one, not a lost slot.
    releases.shift()!();
    expect("answered" in (await third)).toBe(true);
  });

  it("answers an already-withdrawn call with its fallback", async () => {
    const { decisions } = service();
    const controller = new AbortController();
    controller.abort();
    expect(await ask(decisions, { signal: controller.signal })).toMatchObject({
      miss: { reason: "aborted" },
    });
  });

  it("falls back when the caller withdraws mid-call", async () => {
    const controller = new AbortController();
    const slow: DecisionClassifier = { classify: () => new Promise(() => {}) };
    const { decisions } = service({ classifier: slow });
    const pending = ask(decisions, { signal: controller.signal });
    await flush();
    controller.abort();
    expect(await pending).toMatchObject({ miss: { reason: "aborted" } });
  });
});

describe("audit", () => {
  // No shipped purpose is audited yet (VC-28's authority.judge will be), so the
  // rule is pinned under a policy that says it is.
  const audited = withPolicy({ audit: true });

  it("refuses an audited purpose it has nowhere to record", async () => {
    const seen: unknown[] = [];
    const { decisions } = service({
      policyFor: audited,
      classifier: piDecisionClassifier(fixtureModels({ seen: seen as never })),
    });
    expect(await ask(decisions)).toEqual({
      miss: { status: "unavailable", reason: "unaudited", message: expect.any(String) },
    });
    expect(seen).toEqual([]);
  });

  it("records every audited decision, made or missed, with its purpose and target", async () => {
    const facts: unknown[] = [];
    const recordDecision = (fact: unknown): void => {
      facts.push(fact);
    };
    await ask(service({ policyFor: audited, recordDecision }).decisions);
    await ask(
      service({
        policyFor: audited,
        recordDecision,
        resolveSetting: () => ({ ...CLOUD, modelId: "retired" }),
      }).decisions,
    );
    await flush();
    expect(facts).toEqual([
      expect.objectContaining({
        purpose: "agent.classify",
        sessionId: "session-1",
        target: { where: "cloud", providerId: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL },
        outcome: expect.objectContaining({ kind: "answered" }),
      }),
      expect.objectContaining({
        outcome: { kind: "miss", miss: expect.objectContaining({ reason: "needs-setup" }) },
      }),
    ]);
  });

  it("records a decision the caller could not act on as the miss it fell back on", async () => {
    const facts: Array<{ outcome: { kind: string } }> = [];
    const { decisions } = service({
      policyFor: audited,
      recordDecision: (fact) => void facts.push(fact),
    });
    await decisions.decide({
      purpose: "agent.classify",
      state: STATE,
      questions: QUESTIONS,
      use: () => {
        throw new Error("not a candidate");
      },
      fallback: () => null,
    });
    await flush();
    expect(facts.map((fact) => fact.outcome.kind)).toEqual(["miss"]);
  });

  it("holds an audited verdict until its audit write has landed", async () => {
    let finishWrite!: () => void;
    const order: string[] = [];
    const { decisions } = service({
      policyFor: audited,
      recordDecision: async () => {
        order.push("write started");
        await new Promise<void>((resolve) => (finishWrite = resolve));
        order.push("write landed");
      },
    });
    const pending = ask(decisions).then((outcome) => {
      order.push("verdict");
      return outcome;
    });
    await flush();
    await flush();
    // The decision is made, but nobody has it yet: its record is not written.
    expect(order).toEqual(["write started"]);
    finishWrite();
    expect("answered" in (await pending)).toBe(true);
    expect(order).toEqual(["write started", "write landed", "verdict"]);
  });

  it("falls back as unaudited, and says why, when the audit write fails", async () => {
    const boom = new Error("disk full");
    const { decisions, failures } = service({
      policyFor: audited,
      recordDecision: () => Promise.reject(boom),
    });
    expect(await ask(decisions)).toEqual({
      miss: { status: "unavailable", reason: "unaudited", message: expect.any(String) },
    });
    expect(failures).toEqual([boom]);
    // A synchronous throw is the same failure.
    const sync = service({
      policyFor: audited,
      recordDecision: () => {
        throw boom;
      },
    });
    expect(await ask(sync.decisions)).toMatchObject({ miss: { reason: "unaudited" } });
  });

  it("does not let a hung audit write hold the caller", async () => {
    vi.useFakeTimers();
    const { decisions } = service({
      policyFor: audited,
      auditWaitMs: 250,
      recordDecision: () => new Promise<void>(() => undefined),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ miss: { reason: "unaudited" } });
  });

  it("still records a decision that timed out, and returns its own miss", async () => {
    vi.useFakeTimers();
    const facts: Array<{ outcome: { kind: string; miss?: { reason: string } } }> = [];
    const { decisions } = service({
      policyFor: (purpose) => ({ ...audited(purpose), timeoutMs: 100 }),
      classifier: { classify: () => new Promise(() => undefined) },
      recordDecision: (fact) => void facts.push(fact),
    });
    const pending = ask(decisions);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ miss: { reason: "timeout" } });
    expect(facts.map((fact) => fact.outcome.miss?.reason)).toEqual(["timeout"]);
  });

  it("records nothing for an unaudited purpose, even with a recorder wired", async () => {
    const facts: unknown[] = [];
    await ask(service({ recordDecision: (fact) => void facts.push(fact) }).decisions);
    await flush();
    expect(facts).toEqual([]);
  });
});
