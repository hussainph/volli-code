import { describe, expect, it } from "vite-plus/test";
import { SKILL_POLICY_DEFAULT, type SkillReference } from "@volli/shared";

import { estimateTokens, skillBodyTokens, skillsIndexTokens } from "./skills-budget";

function skill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    name: "tdd",
    description: "Test-driven development.",
    body: "Write the failing test first.",
    invocation: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: ".agents/skills/tdd",
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates at the app's 4-chars-per-token heuristic, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("charges nothing for nothing", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("skillBodyTokens", () => {
  it("measures the body — activation reads the instructions, not the metadata", () => {
    expect(skillBodyTokens(skill({ body: "x".repeat(400) }))).toBe(100);
  });
});

describe("skillsIndexTokens", () => {
  it("charges for the index the runtime actually composes", () => {
    const tokens = skillsIndexTokens([skill()], {});
    // Preamble plus one entry: substantial, and strictly more than the entry alone.
    expect(tokens).toBeGreaterThan(estimateTokens("- tdd (.agents/skills/tdd/SKILL.md)"));
  });

  it("drops a skill ruled Manual — the budget lever this pane exists to pull", () => {
    const auto = skillsIndexTokens([skill()], {});
    const manual = skillsIndexTokens([skill()], { tdd: "manual" });
    expect(manual).toBeLessThan(auto);
  });

  it("is zero when nothing is advertised, matching the runtime's absent resource", () => {
    expect(skillsIndexTokens([skill()], { tdd: "off" })).toBe(0);
    expect(skillsIndexTokens([], {})).toBe(0);
  });
});
