import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessModel, ModelAccessProvider } from "@volli/shared";

import {
  availableModelsByProvider,
  defaultPickerModels,
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
  acceptsImageInput: true,
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

describe("default picker curation", () => {
  const hiddenSol = { providerId: MODEL.providerId, modelId: MODEL.modelId };
  const luna: ModelAccessModel = { ...MODEL, modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" };

  it("withholds hidden models from a default picker", () => {
    expect(defaultPickerModels([MODEL, luna], [hiddenSol], null)).toEqual([luna]);
  });

  it("keeps the currently configured model listed even when hidden", () => {
    expect(
      defaultPickerModels([MODEL, luna], [hiddenSol], {
        providerId: MODEL.providerId,
        modelId: MODEL.modelId,
        reasoningLevel: "high",
      }),
    ).toEqual([MODEL, luna]);
  });
});

describe("visibility grouping", () => {
  it("groups only offerable models, per provider, each in label order", () => {
    const other: ModelAccessModel = {
      ...MODEL,
      providerId: "anthropic",
      modelId: "claude-sonnet",
      label: "Claude Sonnet",
    };
    const groups = availableModelsByProvider(
      [
        MODEL,
        { ...MODEL, modelId: "gpt-5.6-astra", label: "GPT-5.6 Astra" },
        other,
        {
          ...other,
          modelId: "claude-haiku",
          label: "Claude Haiku",
          state: "authentication-required",
        },
      ],
      [
        {
          id: "anthropic",
          label: "Anthropic",
          state: "available",
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
          signIn: [],
          hasStoredCredential: true,
        },
      ],
    );

    expect(groups.map((group) => group.providerLabel)).toEqual(["Anthropic", "openai-codex"]);
    expect(groups[1]?.models.map((model) => model.label)).toEqual(["GPT-5.6 Astra", "GPT-5.6 Sol"]);
    // The signed-out Haiku never reaches a switch: there is nothing to curate
    // on a model no picker would offer anyway.
    expect(groups[0]?.models.map((model) => model.label)).toEqual(["Claude Sonnet"]);
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
