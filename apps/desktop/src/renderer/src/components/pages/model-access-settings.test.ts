import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ModelAccessModel, ModelAccessProvider } from "@volli/shared";

import {
  canSaveDefaultModel,
  modelOptionLabel,
  ModelAccessAccounts,
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

  it("allows an explicit default before sign-in so the recovery Session is reachable", () => {
    expect(canSaveDefaultModel({ ...MODEL, state: "authentication-required" }, selection)).toBe(
      true,
    );
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
  it("makes authentication state visible in a selectable model label", () => {
    expect(modelOptionLabel({ ...MODEL, state: "authentication-required" })).toBe(
      "GPT-5.6 Sol — Sign in required",
    );
    expect(modelOptionLabel({ ...MODEL, state: "unavailable" })).toBe("GPT-5.6 Sol — Unavailable");
    expect(modelOptionLabel(MODEL)).toBe("GPT-5.6 Sol");
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
