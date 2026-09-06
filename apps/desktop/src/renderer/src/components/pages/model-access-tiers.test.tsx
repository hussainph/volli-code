// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
} from "@volli/shared";

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

const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: 1,
  providers: [
    {
      id: "acme",
      label: "Acme",
      state: "available",
      accountLabel: null,
      billingSource: "unknown",
      recovery: null,
      signIn: [],
      hasStoredCredential: true,
    },
  ],
  models: [
    {
      providerId: "acme",
      modelId: "sonnet",
      label: "Sonnet",
      state: "available",
      reasoningLevels: ["low", "high"],
      acceptsImageInput: true,
    },
  ],
};

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

async function renderSettings(defaults: ModelAccessDefaults): Promise<void> {
  const client: ModelAccessClient = {
    inspect: async () => SNAPSHOT,
    defaults: async () => defaults,
    setDefault: async () => defaults,
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

function advancedButton(): HTMLButtonElement {
  const button = document.querySelector('[data-testid="advanced-tiers"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Advanced disclosure not found");
  return button;
}

function rowText(tier: string): string {
  return document.querySelector(`[data-testid="default-model-${tier}"]`)?.textContent ?? "";
}

describe("the advanced tiers in Model Access", () => {
  it("keeps Fast, Deep and Visual behind the Advanced row until it is opened", async () => {
    await renderSettings(EMPTY_MODEL_ACCESS_DEFAULTS);
    // Board / Ticket / Utility are where they always were.
    expect(document.querySelector('[data-testid="default-model-global"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="default-model-ticket"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="default-model-utility"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="default-model-fast"]')).toBeNull();

    await act(async () => advancedButton().click());

    expect(document.querySelector('[data-testid="default-model-fast"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="default-model-deep"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="default-model-visual"]')).not.toBeNull();
  });

  it("says what an unset advanced row uses instead — the Ticket default", async () => {
    await renderSettings({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: { providerId: "acme", modelId: "sonnet", reasoningLevel: "high" },
    });
    await act(async () => advancedButton().click());

    expect(rowText("fast")).toContain("Ticket default");
    expect(rowText("deep")).toContain("Ticket default");
    expect(rowText("visual")).toContain("Ticket default");
    // And the primary rows still say what THEY use: the Board row.
    expect(rowText("ticket")).toContain("Project default");
  });
});
