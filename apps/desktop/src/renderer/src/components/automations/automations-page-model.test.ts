import { describe, expect, it } from "vite-plus/test";
import type { Automation, AutomationRun } from "@volli/shared";

import {
  INSTRUCTIONS_PLACEHOLDER,
  MANUAL_TRIGGER_LABEL,
  duplicateName,
  groupByOwnership,
  ownershipLabel,
  runAutomationLabel,
  runModelLabel,
  runModelTitle,
  runtimeLabel,
} from "./automations-page-model";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    automationName: "Review",
    ticketId: "t1",
    sessionId: "s1",
    model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    createdAt: 10,
    ...overrides,
  };
}

describe("vocabulary", () => {
  it("names the default Trigger as a complete answer, not an absent one", () => {
    expect(MANUAL_TRIGGER_LABEL).toBe("Only when I run it");
  });

  it("pushes the Instructions placeholder toward /skill rather than prose", () => {
    expect(INSTRUCTIONS_PLACEHOLDER.startsWith("/skill")).toBe(true);
    expect(INSTRUCTIONS_PLACEHOLDER).toContain("@");
  });
});

describe("ownershipLabel", () => {
  it("names the two places an Automation can be listed", () => {
    expect(ownershipLabel(automation())).toBe("This project");
    expect(ownershipLabel(automation({ projectId: null }))).toBe("All projects");
  });
});

describe("runtimeLabel", () => {
  it("says inherit as a sentence rather than leaving a blank", () => {
    expect(runtimeLabel(null)).toBe("Default model");
  });

  it("prints a pin as one model-and-reasoning pair, never half of it", () => {
    expect(
      runtimeLabel({ providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" }),
    ).toBe("claude-opus · high");
  });

  it("says a corrupt stored Runtime is unreadable instead of reading it as inherit", () => {
    // The whole reason `InvalidAutomationRuntime` exists: coercing it to null
    // would silently change a saved Automation's execution policy.
    expect(runtimeLabel({ kind: "invalid", raw: { model: "gpt-9" } })).toBe("Unreadable runtime");
  });
});

describe("a Run prints its own evidence", () => {
  it("shows the model and reasoning it resolved at launch", () => {
    expect(runModelLabel(run())).toBe("claude-opus · high");
    expect(runModelTitle(run())).toBe("anthropic / claude-opus · high");
  });

  it("prints a level a current build no longer knows exactly as recorded", () => {
    const historical = run({
      model: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "galactic" },
    });
    expect(runModelLabel(historical)).toBe("gpt-5 · galactic");
  });

  it("keeps the Automation name a deleted record left behind", () => {
    expect(runAutomationLabel(run())).toBe("Review");
    expect(runAutomationLabel(run({ automationId: null, automationName: null }))).toBe("Run once");
  });
});

describe("groupByOwnership", () => {
  it("splits the list without re-sorting either half", () => {
    const own = [automation({ id: "a" }), automation({ id: "b", name: "Aardvark" })];
    const global = [automation({ id: "g", projectId: null })];
    expect(groupByOwnership([...own, ...global])).toEqual({ project: own, global });
  });

  it("answers two empty halves for an empty list", () => {
    expect(groupByOwnership([])).toEqual({ project: [], global: [] });
  });
});

describe("duplicateName", () => {
  it("makes the copy distinguishable at a glance and sorts it beside its source", () => {
    expect(duplicateName("Review", ["Review"])).toBe("Review (copy)");
  });

  it("counts from 2, so duplicating the duplicate does not collide either", () => {
    expect(duplicateName("Review", ["Review", "Review (copy)"])).toBe("Review (copy 2)");
    expect(duplicateName("Review", ["Review", "Review (copy)", "Review (copy 2)"])).toBe(
      "Review (copy 3)",
    );
  });

  it("takes the plain suffix when nothing has claimed it", () => {
    expect(duplicateName("Review", [])).toBe("Review (copy)");
  });
});
