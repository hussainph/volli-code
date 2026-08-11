import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessModel, ModelAccessProvider } from "@volli/shared";

import {
  canSaveDefaultModel,
  modelOptionLabel,
  ModelAccessAccounts,
  offerableModels,
  preferredReasoning,
  providerAccessLabel,
  providerRecoveryActionLabel,
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
      },
    ];

    expect(modelOptionLabel(MODEL, providers)).toBe("GPT-5.6 Sol · OpenAI Codex");
    // An unlabelled provider still has to be told apart from its namesakes.
    expect(modelOptionLabel(MODEL, [])).toBe("GPT-5.6 Sol · openai-codex");
  });

  it("summarizes only sanitized account and billing metadata", () => {
    const provider: ModelAccessProvider = {
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "available",
      accountLabel: "Personal subscription",
      billingSource: "subscription",
      recovery: null,
    };

    expect(providerAccessLabel(provider)).toBe("Personal subscription · Subscription");
    expect(
      providerAccessLabel({
        ...provider,
        state: "authentication-required",
        accountLabel: null,
        recovery: { kind: "external-sign-in" },
      }),
    ).toBe("Sign in required · Subscription");
  });

  it("turns sanitized recovery into a direct account action", () => {
    expect(providerRecoveryActionLabel({ kind: "external-sign-in" })).toBe("Sign in");
    expect(providerRecoveryActionLabel({ kind: "retry" })).toBe("Retry");
    expect(providerRecoveryActionLabel(null)).toBeNull();
  });

  it("renders external sign-in as a direct action and dispatches the selected provider", () => {
    const provider: ModelAccessProvider = {
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "authentication-required",
      accountLabel: null,
      billingSource: "subscription",
      recovery: { kind: "external-sign-in" },
    };
    const onRecover = vi.fn();
    const accounts = ModelAccessAccounts({
      providers: [provider],
      loading: false,
      recoveringProviderId: null,
      onRecover,
    });

    expect(renderToStaticMarkup(accounts)).toContain("Sign in");
    const action = findAction(accounts, "Sign in");
    expect(action).not.toBeNull();
    action?.props.onClick?.();
    expect(onRecover).toHaveBeenCalledWith(provider);
  });
});

interface ActionProps {
  children?: React.ReactNode;
  onClick?: () => void;
}

function findAction(node: React.ReactNode, label: string): React.ReactElement<ActionProps> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<ActionProps>;
  if (element.props.children === label && element.props.onClick) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findAction(child, label);
    if (found) return found;
  }
  return null;
}
