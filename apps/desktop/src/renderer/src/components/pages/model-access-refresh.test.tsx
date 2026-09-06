// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
} from "@volli/shared";
import { toast } from "sonner";

import { ModelAccessSettings } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

const provider = {
  id: "acme",
  label: "Acme",
  state: "available" as const,
  accountLabel: null,
  billingSource: "unknown" as const,
  recovery: null,
  signIn: [],
  hasStoredCredential: true,
};
const model = (modelId: string, label: string) => ({
  providerId: "acme",
  modelId,
  label,
  state: "available" as const,
  reasoningLevels: ["off" as const],
  acceptsImageInput: false,
});

function snapshot(
  models: ModelAccessSnapshot["models"],
  refresh?: ModelAccessSnapshot["refresh"],
): ModelAccessSnapshot {
  return {
    observedAt: 1,
    providers: [provider],
    models,
    ...(refresh === undefined ? {} : { refresh }),
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderSettings(inspect: ModelAccessClient["inspect"]): Promise<void> {
  const client: ModelAccessClient = {
    inspect,
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={client}>
        <TooltipProvider>
          <ModelAccessSettings />
        </TooltipProvider>
      </ModelAccessProvider>,
    );
  });
}

function refreshButton(): HTMLButtonElement {
  const button = document.querySelector('[aria-label="Refresh models"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Refresh models button not found");
  return button;
}

describe("Model Access catalog refresh", () => {
  it("renders newly admitted rows immediately and reports the catalog change", async () => {
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockResolvedValueOnce(snapshot([model("stable", "Stable"), model("retired", "Retired")]))
      .mockResolvedValueOnce(
        snapshot([model("stable", "Stable"), model("pipeline", "Pipeline")], {
          added: 1,
          removed: 1,
          rejected: 0,
          refreshedProviderIds: ["acme"],
          failedProviderIds: [],
        }),
      );
    await renderSettings(inspect);
    expect(document.body.textContent).not.toContain("Pipeline");

    await act(async () => refreshButton().click());

    expect(document.body.textContent).toContain("Pipeline");
    expect(document.body.textContent).not.toContain("Retired");
    expect(toast.success).toHaveBeenCalledWith("Models refreshed: 1 added, 1 removed.");
  });

  it("reports a successful unchanged catalog distinctly", async () => {
    const stable = snapshot([model("stable", "Stable")]);
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockResolvedValueOnce(stable)
      .mockResolvedValueOnce(
        snapshot(stable.models, {
          added: 0,
          removed: 0,
          rejected: 0,
          refreshedProviderIds: ["acme"],
          failedProviderIds: [],
        }),
      );
    await renderSettings(inspect);

    await act(async () => refreshButton().click());

    expect(toast.info).toHaveBeenCalledWith("Model catalog unchanged.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reports partial provider failure and unsafe rejections without hiding applied rows", async () => {
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockResolvedValueOnce(snapshot([model("stable", "Stable")]))
      .mockResolvedValueOnce(
        snapshot([model("stable", "Stable"), model("pipeline", "Pipeline")], {
          added: 1,
          removed: 0,
          rejected: 1,
          refreshedProviderIds: ["acme"],
          failedProviderIds: ["other"],
        }),
      );
    await renderSettings(inspect);

    await act(async () => refreshButton().click());

    expect(document.body.textContent).toContain("Pipeline");
    expect(toast.warning).toHaveBeenCalledWith(
      "Models refreshed with issues: 1 provider failed; 1 model rejected as unsafe.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("reports a refresh where every provider failed as a failure, not unchanged", async () => {
    const stable = snapshot([model("stable", "Stable")]);
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockResolvedValueOnce(stable)
      .mockResolvedValueOnce(
        snapshot(stable.models, {
          added: 0,
          removed: 0,
          rejected: 0,
          refreshedProviderIds: [],
          failedProviderIds: ["acme", "other"],
        }),
      );
    await renderSettings(inspect);

    await act(async () => refreshButton().click());

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't refresh models: 2 providers failed.",
      expect.objectContaining({ closeButton: true }),
    );
    expect(toast.info).not.toHaveBeenCalled();
  });
});
