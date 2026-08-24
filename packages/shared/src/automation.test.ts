import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";

import { automationDraftProblem, automationOwnership, automationPinProblem } from "./automation";

const PIN: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

function snapshot(models: ModelAccessSnapshot["models"]): ModelAccessSnapshot {
  return { observedAt: 0, providers: [], models };
}

function accessModel(
  overrides: Partial<ModelAccessSnapshot["models"][number]> = {},
): ModelAccessSnapshot["models"][number] {
  return {
    providerId: PIN.providerId,
    modelId: PIN.modelId,
    label: "Claude Opus",
    state: "available",
    reasoningLevels: ["medium", "high"],
    acceptsImageInput: true,
    ...overrides,
  };
}

describe("automationOwnership", () => {
  it("reads a null projectId as global and a set one as project", () => {
    expect(automationOwnership({ projectId: null })).toBe("global");
    expect(automationOwnership({ projectId: "p1" })).toBe("project");
  });
});

describe("automationDraftProblem", () => {
  it("accepts a named draft with Instructions", () => {
    expect(automationDraftProblem({ name: "Review", instructions: "/tdd go" })).toBeNull();
  });

  it("refuses a blank name, including whitespace-only", () => {
    expect(automationDraftProblem({ name: "", instructions: "x" })).toMatch(/Name/);
    expect(automationDraftProblem({ name: "   ", instructions: "x" })).toMatch(/Name/);
  });

  it("refuses blank Instructions — a Run would have nothing to say", () => {
    expect(automationDraftProblem({ name: "Review", instructions: "" })).toMatch(/Instructions/);
    expect(automationDraftProblem({ name: "Review", instructions: "\n " })).toMatch(/Instructions/);
  });
});

describe("automationPinProblem", () => {
  it("accepts a pin the catalog can run at that reasoning level", () => {
    expect(automationPinProblem(snapshot([accessModel()]), PIN)).toBeNull();
  });

  it("refuses a model the catalog does not know", () => {
    expect(automationPinProblem(snapshot([]), PIN)).toMatch(/not currently available/);
  });

  it("refuses an unavailable model", () => {
    expect(automationPinProblem(snapshot([accessModel({ state: "unavailable" })]), PIN)).toMatch(
      /not currently available/,
    );
  });

  it("asks for sign-in when the provider needs it, rather than storing a dead pin", () => {
    expect(
      automationPinProblem(snapshot([accessModel({ state: "authentication-required" })]), PIN),
    ).toMatch(/Sign in/);
  });

  it("refuses a reasoning level the model's own scale does not offer, naming the valid ones", () => {
    const problem = automationPinProblem(
      snapshot([accessModel({ reasoningLevels: ["low", "medium"] })]),
      PIN,
    );
    expect(problem).toMatch(/"high"/);
    expect(problem).toMatch(/low, medium/);
  });
});
