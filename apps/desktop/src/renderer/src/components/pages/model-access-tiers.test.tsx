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
    {
      providerId: "acme",
      modelId: "blind",
      label: "Blind",
      state: "available",
      reasoningLevels: ["low", "high"],
      acceptsImageInput: false,
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
    pickerView: async () => "all" as const,
    setPickerView: async (view) => view,
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

function rowText(tier: string): string {
  return document.querySelector(`[data-testid="default-model-${tier}"]`)?.textContent ?? "";
}

describe("the model tiers in Model Access", () => {
  it("draws all six tiers as one tree, the kind-of-work rows under Ticket Sessions", async () => {
    await renderSettings(EMPTY_MODEL_ACCESS_DEFAULTS);
    for (const tier of ["global", "ticket", "utility", "fast", "deep", "visual"]) {
      expect(document.querySelector(`[data-testid="default-model-${tier}"]`)).not.toBeNull();
    }
    // No disclosure, no group headings: position carries the ladder.
    expect(document.querySelector('[data-testid="advanced-tiers"]')).toBeNull();
    expect(document.querySelector("h3")).toBeNull();
    const nested = document.querySelector('[data-testid="default-models-under-ticket"]');
    expect(nested).not.toBeNull();
    for (const tier of ["fast", "deep", "visual"]) {
      expect(nested?.querySelector(`[data-testid="default-model-${tier}"]`)).not.toBeNull();
    }
    for (const tier of ["global", "ticket", "utility"]) {
      expect(nested?.querySelector(`[data-testid="default-model-${tier}"]`)).toBeNull();
    }
    // Project precedence is the section's `(i)`, not a subtitle under its title.
    expect(document.querySelector('[data-slot="pref-section-description"]')).toBeNull();
    expect(document.querySelector('[aria-label="About Default models"]')).not.toBeNull();
  });

  it("names the row an unset row follows, as that row is labelled", async () => {
    await renderSettings({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: { providerId: "acme", modelId: "sonnet", reasoningLevel: "high" },
    });

    expect(rowText("fast")).toContain("Same as Ticket Sessions");
    expect(rowText("deep")).toContain("Same as Ticket Sessions");
    expect(rowText("visual")).toContain("Same as Ticket Sessions");
    expect(rowText("ticket")).toContain("Same as Board chats");
    // Utility says what actually happens, not the ladder's last resort.
    expect(rowText("utility")).toContain("Each chat's own model");
    // No caption restates what the row resolves to; the row above says it.
    expect(rowText("deep")).not.toContain("Sonnet");
    // And no disabled "Reasoning" control is drawn on a row that inherits.
    expect(
      document.querySelector('[data-testid="default-model-deep"] [aria-label="Reasoning level"]'),
    ).toBeNull();
  });

  it("carries the job as the row's (i) only where the label does not name it", async () => {
    // CLAUDE.md's copy rule: the label is the tier name, the `(i)` carries the
    // one-line job, and nothing becomes a paragraph under a control. The hint
    // lives in the glyph's tooltip, so what the row's own text holds is the
    // label and the control — never the job line.
    await renderSettings(EMPTY_MODEL_ACCESS_DEFAULTS);

    for (const tier of ["fast", "deep", "visual", "utility"]) {
      expect(
        document.querySelector(`[data-testid="default-model-${tier}"] [aria-label^="About"]`),
      ).not.toBeNull();
    }
    expect(rowText("fast")).not.toContain("Quick, low-cost tasks.");
    expect(rowText("global")).toBe("Board chatsChoose a model");
    expect(rowText("ticket")).toBe("Ticket SessionsSame as Board chats");
  });

  it("says why Visual inherits nothing when the Ticket model cannot read images", async () => {
    await renderSettings({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: { providerId: "acme", modelId: "sonnet", reasoningLevel: "high" },
      ticket: { providerId: "acme", modelId: "blind", reasoningLevel: "low" },
    });

    expect(
      document.querySelector('[data-testid="default-model-visual-blocked"]')?.textContent,
    ).toBe("The Ticket model can’t read images — choose one here.");
    expect(document.querySelector('[data-testid="default-model-deep-blocked"]')).toBeNull();
  });
});
