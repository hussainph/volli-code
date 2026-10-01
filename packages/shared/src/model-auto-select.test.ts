import { describe, expect, it } from "vite-plus/test";

import type { ModelSelection } from "./agent-runtime";
import { checkDecisionRequest, type DecisionAnswered } from "./decision-model";
import {
  AUTO_SELECT_MAX_ALTERNATIVES,
  AUTO_SELECT_MAX_REQUEST_CHARS,
  AUTO_SELECT_MIN_CONFIDENCE,
  autoSelectCandidates,
  autoSelectCriterion,
  autoSelectRequest,
  readAutoSelect,
} from "./model-auto-select";

const opus: ModelSelection = { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" };
const sonnet: ModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet",
  reasoningLevel: "medium",
};
const haiku: ModelSelection = { providerId: "anthropic", modelId: "haiku", reasoningLevel: "low" };
const max: ModelSelection = { providerId: "anthropic", modelId: "opus", reasoningLevel: "max" };

describe("the approved candidates", () => {
  it("is the default first, then each tier's pair once, naming every tier that shares it", () => {
    const candidates = autoSelectCandidates(sonnet, {
      fast: haiku,
      deep: opus,
      ticket: sonnet,
      global: sonnet,
    });
    expect(candidates.map((candidate) => candidate.selection)).toEqual([sonnet, haiku, opus]);
    expect(candidates[0]?.tiers).toEqual(["ticket", "global"]);
    expect(candidates[1]?.tiers).toEqual(["fast"]);
  });

  it("skips tiers nobody configured and never offers visual", () => {
    const candidates = autoSelectCandidates(sonnet, { fast: null, visual: opus });
    expect(candidates).toEqual([{ selection: sonnet, tiers: [] }]);
  });
});

describe("describing a pair", () => {
  it("says what its effort is for and what its tiers are set up for", () => {
    expect(autoSelectCriterion({ selection: haiku, tiers: ["fast"] })).toBe(
      "haiku at low reasoning: good for quick, simple or mechanical work; set up for quick, low-cost tasks.",
    );
    expect(autoSelectCriterion({ selection: opus, tiers: ["deep", "ticket"] })).toContain(
      "set up for complex reasoning, planning, and review and one ticket and its optional worktree",
    );
    expect(autoSelectCriterion({ selection: sonnet, tiers: [] })).toBe(
      "sonnet at medium reasoning: good for everyday coding, editing and explaining.",
    );
    expect(autoSelectCriterion({ selection: max, tiers: [] })).toContain("hardest");
  });

  it("stays inside the decision bounds", () => {
    const long = { ...opus, modelId: "x".repeat(600) };
    expect(autoSelectCriterion({ selection: long, tiers: [] }).length).toBeLessThanOrEqual(500);
  });
});

describe("the question", () => {
  const candidates = autoSelectCandidates(sonnet, { fast: haiku, deep: opus });

  it("is nothing to ask when there is nothing to choose", () => {
    expect(autoSelectRequest({ request: "hi" }, autoSelectCandidates(sonnet, {}))).toBeNull();
  });

  it("is one choice over every pair, and a well-formed decision request", () => {
    const asked = autoSelectRequest({ request: "rename a variable" }, candidates)!;
    expect(Object.keys(asked.questions)).toEqual(["model"]);
    const question = asked.questions["model"]!;
    expect(question.type).toBe("choice");
    expect(Object.keys((question as { criteria: object }).criteria)).toEqual([
      "option_1",
      "option_2",
      "option_3",
    ]);
    expect(asked.state).toEqual({ request: "rename a variable" });
    expect(checkDecisionRequest(asked).ok).toBe(true);
  });

  it("carries the parent's tier as a hint and clips a long request", () => {
    const asked = autoSelectRequest(
      { request: "x".repeat(AUTO_SELECT_MAX_REQUEST_CHARS + 50), tierHint: "deep" },
      candidates,
    )!;
    expect((asked.state["request"] as string).length).toBe(AUTO_SELECT_MAX_REQUEST_CHARS);
    expect(asked.state["tierHint"]).toBe("deep: Complex reasoning, planning, and review.");
    expect(autoSelectRequest({ request: "a", tierHint: null }, candidates)!.state).toEqual({
      request: "a",
    });
  });
});

function answered(
  choice: string,
  probabilities: Record<string, number>,
  confidence: number,
): DecisionAnswered {
  return {
    answers: { model: { type: "choice", choice, probabilities, confidence } },
    model: { where: "cloud", providerId: "typesafe", modelId: "jev" },
    elapsedMs: 12,
  };
}

describe("reading an answer", () => {
  const candidates = autoSelectCandidates(sonnet, { fast: haiku, deep: opus, global: max });

  it("is the chosen pair, with the likeliest others beside it", () => {
    const pick = readAutoSelect(
      answered("option_3", { option_1: 0.1, option_2: 0.123, option_3: 0.6, option_4: 0.177 }, 0.8),
      candidates,
    );
    expect(pick?.selection).toEqual(opus);
    expect(pick?.auto.confidence).toBe(0.8);
    expect(pick?.auto.alternatives).toEqual([
      { selection: max, probability: 0.18 },
      { selection: haiku, probability: 0.12 },
    ]);
    expect(pick?.auto.alternatives.length).toBeLessThanOrEqual(AUTO_SELECT_MAX_ALTERNATIVES);
  });

  it("leaves out an option the answer gave no weight", () => {
    const pick = readAutoSelect(answered("option_1", { option_1: 1 }, 1), candidates);
    expect(pick?.auto.alternatives).toEqual([]);
  });

  it("is no pick below the confidence threshold", () => {
    const unsure = answered("option_1", { option_1: 0.3 }, AUTO_SELECT_MIN_CONFIDENCE - 0.01);
    expect(readAutoSelect(unsure, candidates)).toBeNull();
    const sure = answered("option_1", { option_1: 0.9 }, AUTO_SELECT_MIN_CONFIDENCE);
    expect(readAutoSelect(sure, candidates)).not.toBeNull();
  });

  it("is no pick for an answer that is not to this question", () => {
    expect(readAutoSelect(answered("option_9", { option_9: 1 }, 1), candidates)).toBeNull();
    expect(readAutoSelect({ ...answered("option_1", {}, 1), answers: {} }, candidates)).toBeNull();
    expect(
      readAutoSelect(
        {
          ...answered("option_1", {}, 1),
          answers: { model: { type: "bool", value: true, probability: 1, confidence: 1 } },
        },
        candidates,
      ),
    ).toBeNull();
  });
});
