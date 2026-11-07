import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MODEL_MARK_TINTS } from "@volli/shared";

import {
  ModelMark,
  modelFamily,
  modelProviderIdentity,
  providerLabelOf,
  providerMark,
} from "./model-identity";

const m = (providerId: string, modelId: string, label: string) => ({ providerId, modelId, label });

describe("provider tag identity", () => {
  it("keeps real provider names and qualifies duplicate display names with stable ids", () => {
    const providers = [
      { id: "openai", label: "OpenAI" },
      { id: "openai-codex", label: "OpenAI" },
    ];
    const model = m("openai-codex", "gpt-5", "GPT-5");
    expect(providerLabelOf(providers, model.providerId)).toBe("OpenAI");
    expect(providerLabelOf(providers, "missing")).toBe("missing");
    expect(modelProviderIdentity(model, [model], "OpenAI", providers)).toBe(
      "OpenAI · openai-codex",
    );
    expect(modelProviderIdentity(model, [model], "OpenAI Codex", providers)).toBe("OpenAI Codex");
  });

  it("distinguishes unknown providers and same-provider duplicate model labels without inline text", () => {
    const model = m("custom-a", "first", "Same model");
    const second = { ...model, modelId: "second" };
    expect(modelProviderIdentity(model, [model, second], "Custom")).toBe(
      "Custom · custom-a · first",
    );
    expect(modelProviderIdentity(second, [model, second], "Custom")).toBe(
      "Custom · custom-a · second",
    );
    const markup = renderToStaticMarkup(
      createElement(ModelMark, { model, providerLabel: "Custom" }),
    );
    expect(markup).toContain('aria-label="Custom · custom-a"');
    expect(markup.replace(/<[^>]+>/g, "")).toBe("C");
  });
});

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

describe("providerMark", () => {
  it.each(["nvidia", "minimax", "groq", "together", "cerebras", "fireworks"] as const)(
    "gives %s vetted artwork and its shared tint",
    (id) => {
      const mark = providerMark(id);
      expect(mark?.viewBox).toBe("0 0 24 24");
      expect(mark?.paths.length).toBeGreaterThan(0);
      expect(mark?.tint).toBe(MODEL_MARK_TINTS[id]);
    },
  );

  it("gives Cursor its published monochrome cube rather than a pointer fallback", () => {
    const mark = providerMark("cursor");
    expect(mark?.viewBox).toBe("0 0 24 24");
    expect(mark?.paths).toHaveLength(1);
    expect(mark?.paths[0]).toMatch(/^M11\.503\.131 1\.891 5\.678/);
    expect(mark?.tint).toBe(MODEL_MARK_TINTS.monochrome);
    const markup = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m("cursor", "unknown", "Cursor"),
        providerLabel: "Cursor",
      }),
    );
    expect(markup).toContain(`d="${mark!.paths[0]}"`);
    expect(markup).toContain('role="img"');
  });

  it("gives xAI its real monochrome mark rather than a letter", () => {
    expect(providerMark("xai")?.tint).toBe(MODEL_MARK_TINTS.monochrome);
    const markup = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m("xai", "grok-4.6", "Grok 4.6"),
        providerLabel: "xAI",
      }),
    );
    expect(markup).toContain("<svg");
    expect(markup).toContain('role="img"');
  });

  it.each([
    ["moonshotai", "kimi-coding"],
    ["moonshotai-cn", "kimi-coding"],
    ["minimax-cn", "minimax"],
    ["opencode", "opencode-go"],
  ])("reuses %s's existing vendor mark", (alias, original) => {
    expect(providerMark(alias!)).toBe(providerMark(original!));
  });

  it("maps Meta to the existing Llama family artwork", () => {
    const family = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m("custom", "llama-4", "Llama 4"),
        providerLabel: "Custom",
        by: "family",
      }),
    );
    const provider = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m("meta", "unknown", "Unknown"),
        providerLabel: "Meta",
      }),
    );
    expect(provider).toContain(`d="${providerMark("meta")!.paths[0]}"`);
    expect(family).toContain(`d="${providerMark("meta")!.paths[0]}"`);
  });

  it.each(["radius", "typesafe", "custom"])("keeps %s on the honest lettermark fallback", (id) => {
    expect(providerMark(id)).toBeNull();
    const markup = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m(id, "unknown", "Unknown"),
        providerLabel: id,
      }),
    );
    expect(markup).toContain("<span");
    expect(markup).not.toContain("<svg");
  });

  it.each([
    "groq",
    "xai",
    "together",
    "cerebras",
    "fireworks",
    "amazon-bedrock",
    "baseten",
    "ant-ling",
  ])("preserves %s's source winding rules when rendered", (id) => {
    const markup = renderToStaticMarkup(
      createElement(ModelMark, {
        model: m(id, "unknown", "Unknown"),
        providerLabel: id,
      }),
    );
    expect(markup).toContain('fill-rule="evenodd"');
    if (id === "cerebras" || id === "fireworks") {
      expect(markup).toContain('clip-rule="evenodd"');
    }
  });
});
