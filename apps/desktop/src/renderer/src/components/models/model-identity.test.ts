import { describe, expect, it } from "vite-plus/test";

import { modelFamily, needsProvider } from "./model-identity";

const m = (providerId: string, modelId: string, label: string) => ({ providerId, modelId, label });

describe("modelFamily", () => {
  it("reads the family off the id or the label, not the provider", () => {
    expect(modelFamily(m("github-copilot", "claude-opus-4.5", "Claude Opus 4.5"))).toBe("claude");
    expect(modelFamily(m("opencode-go", "gpt-5.6-luna", "GPT-5.6 Luna"))).toBe("openai");
    expect(modelFamily(m("openai-codex", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"))).toBe(
      "openai",
    );
    expect(modelFamily(m("openai", "o3-mini", "o3 mini"))).toBe("openai");
    expect(modelFamily(m("google-vertex", "gemini-2.5-pro", "Gemini 2.5 Pro"))).toBe("gemini");
  });

  it("has no family for the long tail rather than guessing", () => {
    expect(modelFamily(m("xai", "grok-4.6", "Grok 4.6"))).toBeNull();
    expect(modelFamily(m("zai", "glm-5.2", "GLM-5.2"))).toBeNull();
    // "gpt" inside another word is not GPT.
    expect(modelFamily(m("x", "egpt-thing", "Egpt Thing"))).toBeNull();
  });
});

describe("needsProvider", () => {
  const list = [
    m("anthropic", "claude-opus-4-5", "Claude Opus 4.5"),
    m("github-copilot", "claude-opus-4.5", "Claude Opus 4.5"),
    m("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
  ];

  it("is the composer's rule: the provider only where the name alone is ambiguous", () => {
    expect(needsProvider(list, list[0]!)).toBe(true);
    expect(needsProvider(list, list[1]!)).toBe(true);
    expect(needsProvider(list, list[2]!)).toBe(false);
  });

  it("does not call a model ambiguous with itself", () => {
    expect(needsProvider([list[0]!], list[0]!)).toBe(false);
  });
});
