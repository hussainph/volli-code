import type { SessionCapabilitySnapshot } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { deriveRuntimeCatalog, resolveRuntimeSelection } from "./session-model";

const snapshot: SessionCapabilitySnapshot = {
  id: "caps-1",
  adapterId: "opencode",
  attachmentId: "attachment-1",
  profileId: "native",
  revision: 3,
  observedAt: 10,
  expiresAt: null,
  features: [],
  catalog: [
    {
      kind: "model",
      id: "anthropic/disabled",
      label: "Disabled model",
      state: "unavailable",
      evidence: "reported",
      detail: { providerId: "anthropic", modelId: "disabled", variants: ["high"] },
    },
    {
      kind: "model",
      id: "openai/codex",
      label: "Codex",
      state: "available",
      evidence: "reported",
      detail: { providerId: "openai", modelId: "codex", variants: ["low", "high"] },
    },
    {
      kind: "agent",
      id: "plan",
      label: "Plan",
      state: "available",
      evidence: "reported",
      detail: { mode: "primary", description: "Read-only planning" },
    },
  ],
};

describe("native Session runtime picker", () => {
  it("derives provider, model, effort, and agent mode from reported capabilities", () => {
    expect(deriveRuntimeCatalog(snapshot)).toEqual({
      providers: ["openai"],
      models: [
        {
          id: "anthropic/disabled",
          label: "Disabled model",
          state: "unavailable",
          providerId: "anthropic",
          modelId: "disabled",
          variants: ["high"],
        },
        {
          id: "openai/codex",
          label: "Codex",
          state: "available",
          providerId: "openai",
          modelId: "codex",
          variants: ["low", "high"],
        },
      ],
      agents: [
        {
          id: "plan",
          label: "Plan",
          state: "available",
          mode: "primary",
          description: "Read-only planning",
        },
      ],
    });
  });

  it("keeps a valid choice and otherwise prefers an available runtime", () => {
    const catalog = deriveRuntimeCatalog(snapshot);
    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "missing",
        modelId: "missing",
        variant: "missing",
        agent: "missing",
      }),
    ).toEqual({ providerId: "openai", modelId: "codex", variant: "low", agent: "plan" });
    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "openai",
        modelId: "codex",
        variant: "high",
        agent: "plan",
      }),
    ).toEqual({ providerId: "openai", modelId: "codex", variant: "high", agent: "plan" });
  });

  it("does not submit through catalog entries the adapter reports as unavailable", () => {
    const catalog = deriveRuntimeCatalog({
      ...snapshot,
      catalog: snapshot.catalog.map((item) =>
        Object.assign({}, item, { state: "unavailable" as const }),
      ),
    });

    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "",
        modelId: "",
        variant: "",
        agent: "",
      }),
    ).toEqual({ providerId: "", modelId: "", variant: "", agent: "" });
  });
});
