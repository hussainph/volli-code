// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type Project,
} from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { SessionsPane } from "./sessions-pane";

const PROJECT: Project = {
  id: "p1",
  name: "Project",
  path: "/tmp/project",
  ticketPrefix: "T",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

const CATALOG: ModelAccessSnapshot = { observedAt: 1, providers: [], models: [] };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function client(inspect: ModelAccessClient["inspect"]): ModelAccessClient {
  return {
    inspect,
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
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
}

async function renderPane(
  inspect: ModelAccessClient["inspect"],
  project: Project = PROJECT,
): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={client(inspect)}>
        <SessionsPane project={project} />
      </ModelAccessProvider>,
    );
  });
}

function tryAgainButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
}

describe("SessionsPane's model catalog", () => {
  it("draws the selected project model with its catalogue name and mark", async () => {
    const selection = {
      providerId: "anthropic",
      modelId: "claude-opus-4-1",
      reasoningLevel: "high" as const,
    };
    const inspect = vi.fn<ModelAccessClient["inspect"]>().mockResolvedValue({
      ...CATALOG,
      models: [
        {
          ...selection,
          label: "Claude Opus 4.1",
          state: "available",
          reasoningLevels: ["high"],
          acceptsImageInput: true,
        },
      ],
    });
    await renderPane(inspect, { ...PROJECT, sessionModel: selection });
    const trigger = document.getElementById("project-session-model");
    expect(trigger?.textContent).toContain("Claude Opus 4.1");
    expect(trigger?.textContent).not.toContain("claude-opus-4-1");
    const caption = trigger?.querySelector('[data-slot="model-name"]');
    expect(caption).toBeDefined();
    expect(caption).not.toBeNull();
    expect(caption?.parentElement?.querySelector(":scope > svg[aria-hidden] path")).not.toBeNull();
  });

  it("groups same-name models by provider and saves the chosen provider's IDs", async () => {
    const providers: ModelAccessSnapshot["providers"] = [
      { id: "openai", label: "OpenAI API" },
      { id: "openai-codex", label: "OpenAI Codex" },
    ].map((provider) => ({
      id: provider.id,
      label: provider.label,
      state: "available",
      accountLabel: null,
      billingSource: "unknown",
      recovery: null,
      signIn: [],
      hasStoredCredential: true,
    }));
    const selection = { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" as const };
    const inspect = vi.fn<ModelAccessClient["inspect"]>().mockResolvedValue({
      ...CATALOG,
      providers,
      models: providers.map((provider) => ({
        providerId: provider.id,
        modelId: selection.modelId,
        label: "GPT-5",
        state: "available",
        reasoningLevels: ["high"],
        acceptsImageInput: true,
      })),
    });
    const setSessionDefaults = vi.fn(async () => ({ ok: true, project: PROJECT }));
    vi.stubGlobal("api", { projects: { setSessionDefaults } });
    await renderPane(inspect, { ...PROJECT, sessionModel: selection });
    const trigger = document.getElementById("project-session-model");
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    const groups = [...document.querySelectorAll('[data-slot="select-group"]')];
    expect(groups).toHaveLength(2);
    for (const provider of providers) {
      const group = groups.find(
        (candidate) =>
          candidate.querySelector('[data-slot="select-label"]')?.textContent === provider.label,
      );
      expect(group).toBeDefined();
      const label = group?.querySelector('[data-slot="select-label"]');
      expect(group?.getAttribute("aria-labelledby")).toBe(label?.id);
      const caption = group?.querySelector('[data-slot="model-name"]');
      expect(caption?.textContent).toContain("GPT-5");
      expect(
        caption?.parentElement?.querySelector(":scope > svg[aria-hidden] path"),
      ).not.toBeNull();
    }
    const codexGroup = groups.find(
      (group) => group.querySelector('[data-slot="select-label"]')?.textContent === "OpenAI Codex",
    );
    const option = codexGroup?.querySelector<HTMLElement>('[data-slot="select-item"]');
    expect(option).toBeDefined();
    expect(option).not.toBeNull();
    await act(async () => option?.click());
    expect(setSessionDefaults).toHaveBeenCalledExactlyOnceWith({
      id: PROJECT.id,
      model: { ...selection, providerId: "openai-codex" },
    });
  });

  it("forces exactly one refresh when Try again is pressed", async () => {
    // The refresh bumps the shared revision, which re-runs this pane's effect;
    // a pane that reads that re-run as another retry would refresh forever.
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockRejectedValueOnce(new Error("main is not up"))
      .mockResolvedValue(CATALOG);
    await renderPane(inspect);
    expect(inspect.mock.calls).toEqual([[{ refresh: false }]]);

    const retry = tryAgainButton();
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(inspect.mock.calls).toEqual([[{ refresh: false }], [{ refresh: true }]]);
  });
});
