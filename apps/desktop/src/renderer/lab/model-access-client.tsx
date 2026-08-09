import * as React from "react";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

const DEFAULT_SELECTION: ModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoningLevel: "high",
};

const ACCESS: ModelAccessSnapshot = {
  observedAt: 1,
  providers: [
    {
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "available",
      accountLabel: null,
      billingSource: "subscription",
      recovery: null,
    },
  ],
  models: [
    {
      providerId: DEFAULT_SELECTION.providerId,
      modelId: DEFAULT_SELECTION.modelId,
      label: "GPT-5.6 Sol",
      state: "available",
      reasoningLevels: ["off", "low", "medium", "high", "xhigh"],
    },
  ],
};

export function LabModelAccessProvider({ children }: React.PropsWithChildren) {
  const client = React.useMemo<ModelAccessClient>(
    () => ({
      inspect: async () => ACCESS,
      defaultSelection: async () => DEFAULT_SELECTION,
      setDefault: async (selection) => selection,
      openExternalSignIn: async () => true,
    }),
    [],
  );
  return <ModelAccessProvider client={client}>{children}</ModelAccessProvider>;
}
