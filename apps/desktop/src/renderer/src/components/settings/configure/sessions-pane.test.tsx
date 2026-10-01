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
    expect(trigger?.querySelector("svg[aria-hidden] path")).not.toBeNull();
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
