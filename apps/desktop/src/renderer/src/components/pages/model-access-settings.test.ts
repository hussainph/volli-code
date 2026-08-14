import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessModel, ModelAccessProvider } from "@volli/shared";

import {
  canSaveDefaultModel,
  modelOptionLabel,
  offerableModels,
  preferredReasoning,
} from "./model-access-settings";

const MODEL: ModelAccessModel = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  label: "GPT-5.6 Sol",
  state: "available",
  reasoningLevels: ["low", "medium", "high"],
};

describe("default model reasoning", () => {
  it("preserves an available configured level", () => {
    expect(preferredReasoning(MODEL, "medium")).toBe("medium");
  });

  it("uses the model's highest declared level when changing models", () => {
    expect(preferredReasoning(MODEL, "xhigh")).toBe("high");
  });

  it("uses off only when a model declares no reasoning levels", () => {
    expect(preferredReasoning({ ...MODEL, reasoningLevels: [] }, undefined)).toBe("off");
  });
});

describe("default model availability", () => {
  const selection = {
    providerId: MODEL.providerId,
    modelId: MODEL.modelId,
    reasoningLevel: "high" as const,
  };

  it("refuses a default nobody is signed in to, whatever the catalog knows", () => {
    expect(canSaveDefaultModel({ ...MODEL, state: "authentication-required" }, selection)).toBe(
      false,
    );
    expect(canSaveDefaultModel(null, selection)).toBe(false);
  });

  it("uses off as the product policy for a model without reasoning controls", () => {
    expect(
      canSaveDefaultModel(
        { ...MODEL, reasoningLevels: [] },
        { ...selection, reasoningLevel: "off" },
      ),
    ).toBe(true);
  });

  it("rejects unavailable models and unsupported reasoning", () => {
    expect(canSaveDefaultModel({ ...MODEL, state: "unavailable" }, selection)).toBe(false);
    expect(canSaveDefaultModel(MODEL, { ...selection, reasoningLevel: "xhigh" })).toBe(false);
  });
});

describe("sanitized access presentation", () => {
  it("offers only models this profile is signed in to", () => {
    const signedOut = { ...MODEL, providerId: "azure-openai-responses" as const };
    expect(
      offerableModels([
        MODEL,
        { ...signedOut, state: "authentication-required" },
        { ...signedOut, state: "unavailable" },
      ]),
    ).toEqual([MODEL]);
  });

  it("names the provider beside a model whose name several providers share", () => {
    const providers: readonly ModelAccessProvider[] = [
      {
        id: "openai-codex",
        label: "OpenAI Codex",
        state: "available",
        accountLabel: null,
        billingSource: "subscription",
        recovery: null,
        signIn: [],
        hasStoredCredential: false,
      },
    ];

    expect(modelOptionLabel(MODEL, providers)).toBe("GPT-5.6 Sol · OpenAI Codex");
    // An unlabelled provider still has to be told apart from its namesakes.
    expect(modelOptionLabel(MODEL, [])).toBe("GPT-5.6 Sol · openai-codex");
  });
});
