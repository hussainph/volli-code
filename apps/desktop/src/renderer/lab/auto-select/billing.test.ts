import { describe, expect, it } from "vite-plus/test";
import {
  AUTO_SELECT_MAX_REQUEST_CHARS,
  AUTO_SELECT_MIN_CONFIDENCE,
  autoSelectRequest,
  checkDecisionRequest,
  readAutoSelect,
  type DecisionAnswered,
} from "@volli/shared";
import {
  billingAwareCriterion,
  billingAwareRequest,
  billingScenarioCriterion,
  billingWindowPace,
  DEFAULT_BILLING_INSTRUCTIONS,
  readBillingAware,
  validateBillingCandidates,
  type BillingCandidate,
} from "./billing";
import { BILLING_LADDERS, createBillingCandidates, EVAL_PROMPTS } from "./fixtures";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const candidates = () => createBillingCandidates("real-user-ladder", NOW);
const build = (values = candidates(), instructions = DEFAULT_BILLING_INSTRUCTIONS) =>
  billingAwareRequest({ request: "write tests", tierHint: "deep" }, values, instructions, NOW)!;

function answered(confidence = 0.8, choice = "option_3"): DecisionAnswered {
  return {
    answers: {
      model: {
        type: "choice",
        choice,
        confidence,
        probabilities: { option_1: 0.1, option_2: 0.03, option_3: 0.85, option_4: 0.02 },
      },
    },
    model: { where: "cloud", providerId: "typesafe", modelId: "jev-latest" },
    elapsedMs: 12,
  };
}

describe("billing-aware request", () => {
  it("preserves baseline request, tier hint, question and option keys", () => {
    const values = candidates();
    const input = {
      request: "x".repeat(AUTO_SELECT_MAX_REQUEST_CHARS + 100),
      tierHint: "deep" as const,
    };
    const baseline = autoSelectRequest(input, values)!;
    const request = billingAwareRequest(input, values, DEFAULT_BILLING_INSTRUCTIONS, NOW)!;
    expect(request.state).toMatchObject(baseline.state);
    expect(request.state["request"]).toHaveLength(AUTO_SELECT_MAX_REQUEST_CHARS);
    expect(Object.keys(request.questions)).toEqual(Object.keys(baseline.questions));
    const question = request.questions["model"]!;
    const baseQuestion = baseline.questions["model"]!;
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(Object.keys(baseQuestion.criteria));
    expect(checkDecisionRequest(request).ok).toBe(true);
  });

  it("carries billing, full model identity, time, and derived pace keyed to each option", () => {
    const request = build();
    expect(request.state["now"]).toBe(new Date(NOW).toISOString());
    expect(request.state["billing"]).toMatchObject({
      option_1: {
        selection: candidates()[0]!.selection,
        billingSource: "subscription",
        fiveHour: { leftPercent: 85, pace: "under" },
        weekly: { leftPercent: 80, pace: "under" },
      },
      option_2: { billingSource: "api-key", fiveHour: null, weekly: null },
    });
    expect(
      build(candidates(), "Prefer adequate subscription capacity.").questions["model"]
        ?.instructions,
    ).toBe("Prefer adequate subscription capacity.");
  });

  it("returns null without two candidates and does not invent a tier hint", () => {
    expect(build([])).toBeNull();
    expect(build(candidates().slice(0, 1))).toBeNull();
    const request = billingAwareRequest(
      { request: "hi", tierHint: null },
      candidates(),
      DEFAULT_BILLING_INSTRUCTIONS,
      NOW,
    )!;
    expect(request.state).not.toHaveProperty("tierHint");
  });

  it("takes an immutable snapshot without modifying the editor values", () => {
    const values = candidates();
    const before = structuredClone(values);
    const request = build(values);
    expect(values).toEqual(before);
    values[0]!.fiveHour!.leftPercent = 1;
    values[0]!.selection.modelId = "changed";
    values[0]!.tiers = [];
    expect(request.state["billing"]).toMatchObject({
      option_1: {
        selection: before[0]!.selection,
        tiers: before[0]!.tiers,
        fiveHour: { leftPercent: 85 },
      },
    });
  });

  it("refuses invalid editor values and decision bounds before a paid call", () => {
    const values = candidates();
    values[0]!.fiveHour = { leftPercent: 101, resetsAt: "not a date" };
    expect(validateBillingCandidates(values)).toEqual([
      "Candidate 1 fiveHour: remaining must be 0–100 or unknown.",
      "Candidate 1 fiveHour: reset must be a date or unknown.",
    ]);
    expect(() => build(values)).toThrow("remaining must be 0–100");
    expect(() => build(candidates(), " ")).toThrow("must be text");
    expect(() => build(candidates(), "x".repeat(2_001))).toThrow("over 2000");
    expect(() =>
      billingAwareRequest({ request: "hi" }, candidates(), DEFAULT_BILLING_INSTRUCTIONS, NaN),
    ).toThrow("clock");
    expect(() =>
      build(
        Array.from({ length: 33 }, (_, i) => ({
          ...candidates()[0]!,
          selection: { ...candidates()[0]!.selection, modelId: `model-${i}` },
        })),
      ),
    ).toThrow("2 to 32");
  });
});

describe("scenario → criteria", () => {
  it("describes the task suitability and both billing windows", () => {
    const candidate = candidates()[0]!;
    const text = billingAwareCriterion(candidate, NOW);
    expect(text).toContain("gpt-6.1-sol at high reasoning");
    expect(text).toContain("Subscription. 5h: 85% left");
    expect(text).toContain("weekly: 80% left");
    expect(text).toContain("pace under");
    expect(DEFAULT_BILLING_INSTRUCTIONS).toContain("actual marginal cost");
    expect(DEFAULT_BILLING_INSTRUCTIONS).toContain("share its windows");
  });

  it("uses shared five-hour and seven-day pace semantics, including the on-pace band", () => {
    const reset = new Date(NOW + 2.5 * 60 * 60_000).toISOString();
    expect(billingWindowPace({ leftPercent: 80, resetsAt: reset }, "fiveHour", NOW)).toBe("under");
    expect(billingWindowPace({ leftPercent: 50, resetsAt: reset }, "fiveHour", NOW)).toBe("on");
    expect(billingWindowPace({ leftPercent: 20, resetsAt: reset }, "fiveHour", NOW)).toBe("ahead");
    const weeklyReset = new Date(NOW + 3.5 * 24 * 60 * 60_000).toISOString();
    expect(billingWindowPace({ leftPercent: 20, resetsAt: weeklyReset }, "weekly", NOW)).toBe(
      "ahead",
    );
  });

  it("keeps unknown and expired windows honest instead of treating them as cheap capacity", () => {
    const candidate: BillingCandidate = {
      ...candidates()[0]!,
      fiveHour: null,
      weekly: { leftPercent: 90, resetsAt: null },
    };
    expect(billingScenarioCriterion(candidate, NOW)).toContain("5h: unknown");
    expect(billingScenarioCriterion(candidate, NOW)).toContain(
      "90% left, reset unknown, pace unknown",
    );
    expect(billingWindowPace(null, "fiveHour", NOW)).toBeNull();
    expect(
      billingWindowPace(
        { leftPercent: null, resetsAt: new Date(NOW + 1_000).toISOString() },
        "fiveHour",
        NOW,
      ),
    ).toBeNull();
    expect(billingWindowPace({ leftPercent: 90, resetsAt: "invalid" }, "fiveHour", NOW)).toBeNull();
    candidate.fiveHour = { leftPercent: 90, resetsAt: new Date(NOW).toISOString() };
    expect(billingWindowPace(candidate.fiveHour, "fiveHour", NOW)).toBeNull();
    expect(billingScenarioCriterion(candidate, NOW)).toContain("expired; headroom unknown");
    const request = build([candidate, candidates()[1]!]);
    expect(request.state["billing"]).toMatchObject({ option_1: { weekly: { pace: null } } });
  });

  it.each([
    ["api-key", "API key: metered real-dollar spend"],
    ["gateway", "Gateway: metered real-dollar spend"],
    ["local", "Local: no API token charge"],
  ] as const)(
    "describes %s without applying leftover subscription windows",
    (billingSource, expected) => {
      const values = candidates();
      values[0]!.billingSource = billingSource;
      expect(billingScenarioCriterion(values[0]!, NOW)).toContain(expected);
      expect(billingScenarioCriterion(values[0]!, NOW)).not.toContain("85%");
      expect(build(values).state["billing"]).toMatchObject({
        option_1: { fiveHour: null, weekly: null },
      });
    },
  );

  it("keeps long candidate descriptions in the decision criterion bound without losing billing", () => {
    const value = candidates()[0]!;
    value.selection.modelId = "x".repeat(600);
    expect(billingAwareCriterion(value, NOW)).toHaveLength(500);
    expect(billingAwareCriterion(value, NOW)).toContain("Subscription.");
    expect(checkDecisionRequest(build([value, candidates()[1]!])).ok).toBe(true);
  });
});

describe("reading an answer", () => {
  it("uses the baseline interpretation, including alternatives and rounding", () => {
    const values = candidates();
    const pick = readBillingAware(answered(), values);
    expect(pick).toEqual(readAutoSelect(answered(), values));
    expect(pick?.selection).toEqual(values[2]!.selection);
    expect(pick?.auto.alternatives).toEqual([
      { selection: values[0]!.selection, probability: 0.1 },
      { selection: values[1]!.selection, probability: 0.03 },
    ]);
  });

  it("accepts exactly 0.5 confidence, but falls back below the threshold before rounding", () => {
    expect(readBillingAware(answered(AUTO_SELECT_MIN_CONFIDENCE), candidates())).not.toBeNull();
    expect(readBillingAware(answered(AUTO_SELECT_MIN_CONFIDENCE - 0.001), candidates())).toBeNull();
  });

  it("returns the fallback cue for unknown options, absent answers or the wrong question type", () => {
    expect(readBillingAware(answered(1, "option_99"), candidates())).toBeNull();
    expect(readBillingAware({ ...answered(), answers: {} }, candidates())).toBeNull();
    expect(
      readBillingAware(
        {
          ...answered(),
          answers: { model: { type: "bool", value: true, probability: 1, confidence: 1 } },
        },
        candidates(),
      ),
    ).toBeNull();
  });
});

describe("eval fixtures", () => {
  it("retains both supplied ladders and the 14 provided prompts", () => {
    expect(Object.keys(BILLING_LADDERS)).toEqual(["clean-ladder", "real-user-ladder"]);
    expect(EVAL_PROMPTS).toHaveLength(14);
    expect(EVAL_PROMPTS.find((p) => p.id === "triage-subagent")?.tierHint).toBe("fast");
    expect(EVAL_PROMPTS.find((p) => p.id === "migration-plan")?.tierHint).toBe("deep");
    for (const name of Object.keys(BILLING_LADDERS) as (keyof typeof BILLING_LADDERS)[]) {
      const values = createBillingCandidates(name, NOW);
      expect(values.map(({ selection, tiers }) => ({ selection, tiers }))).toEqual(
        BILLING_LADDERS[name],
      );
      expect(validateBillingCandidates(values)).toEqual([]);
      for (const prompt of EVAL_PROMPTS) {
        expect(
          checkDecisionRequest(
            billingAwareRequest(prompt, values, DEFAULT_BILLING_INSTRUCTIONS, NOW),
          ).ok,
        ).toBe(true);
      }
    }
  });

  it("gives each editor independent objects without mutating a source fixture", () => {
    const values = candidates();
    values[0]!.selection.modelId = "edited";
    values[0]!.fiveHour!.leftPercent = 1;
    expect(candidates()[0]!.selection.modelId).toBe("gpt-6.1-sol");
    expect(candidates()[0]!.fiveHour!.leftPercent).toBe(85);
    expect(values[2]!.fiveHour!.leftPercent).toBe(85);
  });
});
