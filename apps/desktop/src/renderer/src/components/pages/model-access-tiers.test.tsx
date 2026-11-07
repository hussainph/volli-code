// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessDefaults,
  type ModelAccessSnapshot,
} from "@volli/shared";

import { ModelAccessSettings } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";

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

async function renderSettings(defaults: ModelAccessDefaults, inDialog = false): Promise<void> {
  let savedDefaults = defaults;
  const client: ModelAccessClient = {
    inspect: async () => SNAPSHOT,
    defaults: async () => savedDefaults,
    setDefault: async (purpose, selection) => {
      savedDefaults = { ...savedDefaults, [purpose]: selection };
      return savedDefaults;
    },
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
    setCodeModePolicy: async (policy) => policy,
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
          {inDialog ? (
            <Dialog defaultOpen>
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>Models</DialogTitle>
                <ModelAccessSettings />
              </DialogContent>
            </Dialog>
          ) : (
            <ModelAccessSettings />
          )}
        </TooltipProvider>
      </ModelAccessProvider>,
    );
  });
}

function rowText(tier: string): string {
  return document.querySelector(`[data-testid="default-model-${tier}"]`)?.textContent ?? "";
}

// This component remains the remote-host model sheet, not app Settings' pane.
describe("the model tiers in the remote-host Model Access sheet", () => {
  it("keeps a newly mounted model mark quiet on pointer selection so one Escape closes Models", async () => {
    vi.useFakeTimers();
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      await renderSettings(EMPTY_MODEL_ACCESS_DEFAULTS, true);
      await act(async () => vi.advanceTimersByTime(0));
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-testid="default-model-global"] [data-slot="select-trigger"]',
      )!;
      // jsdom lacks pointer capture; the trigger does not hold one in this gesture.
      trigger.hasPointerCapture = () => false;
      expect(trigger.textContent).toBe("Choose a model");
      expect(trigger.querySelector('[data-slot="help-tag"]')).toBeNull();
      await act(async () => {
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }),
        );
      });
      await act(async () =>
        trigger.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }),
        ),
      );
      await act(async () => vi.advanceTimersByTime(0));
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (node) => node.querySelector('[data-slot="model-name"]')?.textContent === "Sonnet",
      )!;
      expect(option).toBeDefined();
      await act(async () => {
        option.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
            clientY: 100,
          }),
        );
        option.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "mouse",
            button: 0,
            clientY: 100,
          }),
        );
        option.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerType: "mouse",
            button: 0,
            clientY: 100,
          }),
        );
      });
      await act(async () => vi.advanceTimersByTime(0));
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(trigger.querySelector('[data-slot="help-tag"]')).not.toBeNull();
      expect(trigger.querySelector('[data-slot="model-name"]')?.textContent).toBe("Sonnet");
      // Radix's close autofocus, not a test-issued trigger.focus().
      expect(document.activeElement).toBe(trigger);
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
      vi.useRealTimers();
    }
  });
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
    // No caption under the section title, and no info button either.
    const section = document.querySelector('[data-slot="pref-section-title"]')!.closest("section")!;
    expect(section.textContent).not.toContain("A project with a pinned model");
    expect(section.querySelector('[aria-label^="About"]')).toBeNull();
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

  it("draws every tier as its label and control, with no purpose line under it", async () => {
    await renderSettings(EMPTY_MODEL_ACCESS_DEFAULTS);

    for (const tier of ["global", "ticket", "utility", "fast", "deep", "visual"]) {
      const row = document.querySelector(`[data-testid="default-model-${tier}"]`)!;
      expect(row.querySelector("p")).toBeNull();
      expect(row.querySelector('[aria-label^="About"]')).toBeNull();
    }
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
    ).toBe("Ticket model can’t read images");
    expect(document.querySelector('[data-testid="default-model-deep-blocked"]')).toBeNull();
  });
});
