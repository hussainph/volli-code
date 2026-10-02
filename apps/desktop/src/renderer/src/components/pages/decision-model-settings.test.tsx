// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DecisionModelCatalogEntry, DecisionModelSetting } from "@volli/shared";

import type { DecisionModelResult, DecisionModelSettingsView } from "../../../../ipc/contract";
import type { Project } from "@volli/shared";

import {
  cloudSetting,
} from "./decision-model-model";

import {
  CloudOptInDialog,
  DecisionModelSettings,
  ProjectDecisionModelRow,
} from "./decision-model-settings";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

const receipts = vi.hoisted(() => new Map<string, string>());
vi.mock("@renderer/lib/app-state-storage", () => ({
  appStateStorage: {
    getItem: vi.fn((key: string) => receipts.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => receipts.set(key, value)),
  },
  flushPendingAppStateKey: vi.fn(async () => true),
}));

const ZEN: DecisionModelCatalogEntry = {
  providerId: "opencode",
  providerLabel: "OpenCode Zen",
  modelId: "jev-1.13-free",
  label: "Jev 1.13 Free",
  state: "needs-setup",
  inputUsdPerMillion: 0,
  contextWindow: 32_000,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  receipts.clear();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function stubApi(global: DecisionModelSetting, project?: DecisionModelSetting) {
  let view: DecisionModelSettingsView = {
    global,
    ...(project === undefined ? {} : { project }),
    catalog: [ZEN],
  };
  const set = vi.fn(
    async (
      scope: { scope: string },
      setting: DecisionModelSetting | null,
    ): Promise<DecisionModelResult> => {
      view =
        scope.scope === "global"
          ? { ...view, global: setting ?? view.global }
          : { ...view, project: setting };
      return { ok: true as const, settings: view };
    },
  );
  const test = vi.fn(async () => ({
    ok: true as const,
    test: { ok: true as const, elapsedMs: 42.4, probability: 0.97 },
  }));
  const appState = new Map<string, string>();
  const bootstrap = vi.fn(async () => ({
    ok: true as const,
    data: { appState: Object.fromEntries(appState) },
  }));
  const setAppState = vi.fn(async (key: string, value: string) => {
    appState.set(key, value);
    return { ok: true } as { ok: true } | { ok: false; error: string };
  });
  vi.stubGlobal("api", {
    decisionModel: { get: async () => ({ ok: true as const, settings: view }), set, test },
    data: { bootstrap },
    appState: { set: setAppState },
  });
  return { set, test, appState, bootstrap, setAppState };
}

async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

describe("Settings → Models → Decision model", () => {
  it("offers None, Local and Cloud, and turns the model off at once", async () => {
    const { set } = stubApi({
      kind: "local",
      server: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "default",
    });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(button("Local").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("None").click());
    expect(set).toHaveBeenCalledWith({ scope: "global" }, { kind: "none" });
  });

  it("saves and tests a local server from its two fields", async () => {
    const { set, test } = stubApi({ kind: "none" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Local").click());
    const id = document.querySelector<HTMLInputElement>("#decision-model-id");
    expect(id).not.toBeNull();
    await act(async () => button("Test").click());
    expect(test).toHaveBeenCalledWith({
      kind: "local",
      server: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "default",
    });
    expect(document.querySelector('[data-testid="decision-model-test-result"]')?.textContent).toBe(
      "Answered in 42 ms",
    );
    await act(async () => button("Save").click());
    expect(set).toHaveBeenCalledWith(
      { scope: "global" },
      expect.objectContaining({ kind: "local", baseUrl: "http://127.0.0.1:8080" }),
    );
  });

  it("keeps saying what a saved cloud model sends, and routes its missing key to sign-in", async () => {
    stubApi({
      kind: "cloud",
      providerId: "opencode",
      modelId: "jev-1.13-free",
      optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
    });
    const onSignIn = vi.fn();
    await render(<DecisionModelSettings onSignIn={onSignIn} />);
    expect(document.querySelector('[data-testid="decision-model-sends"]')?.textContent).toMatch(
      /Jev 1\.13 Free · OpenCode Zen runs off this Mac\. Using it sends .*page content/,
    );
    expect(document.body.textContent).toContain("Needs setup");
    await act(async () => button("Sign in to OpenCode Zen").click());
    expect(onSignIn).toHaveBeenCalledWith("opencode");
  });

  // A deliberately narrow opt-in proves the disclosure uses only what the
  // person agreed to, not every purpose this build supports.
  const NARROW_OPT_IN = { acceptedAt: 1, purposes: [] } as never;

  it("names only the purposes the person opted into on the app-wide page", async () => {
    stubApi({
      kind: "cloud",
      providerId: "opencode",
      modelId: "jev-1.13-free",
      optIn: NARROW_OPT_IN,
    });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    const line = document.querySelector('[data-testid="decision-model-sends"]')?.textContent ?? "";
    expect(line).toMatch(/runs off this Mac/);
    expect(line).not.toMatch(/page content|Session text/);
  });

  it("names only the opted-in purposes in a project, own or inherited, and nothing for local", async () => {
    const project = { id: "project-1" } as Project;
    const cloud = { kind: "cloud", providerId: "opencode", modelId: "jev-1.13-free" } as const;
    // A project's own opt-in wins over the inherited one.
    stubApi(
      { ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } },
      { ...cloud, optIn: NARROW_OPT_IN },
    );
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    const own =
      document.querySelector('[data-testid="project-decision-model-sends"]')?.textContent ?? "";
    expect(own).toMatch(/runs off this Mac/);
    expect(own).not.toMatch(/page content|Session text/);
    await act(async () => root?.unmount());
    container?.remove();

    // Inheriting: the app-wide opt-in applies, and says what it covers.
    stubApi({ ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } });
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(
      document.querySelector('[data-testid="project-decision-model-sends"]')?.textContent,
    ).toMatch(/Using it sends .*page content/);
    await act(async () => root?.unmount());
    container?.remove();

    stubApi({ kind: "local", server: "llama-cpp", baseUrl: "http://127.0.0.1:8080", modelId: "m" });
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(document.querySelector('[data-testid="project-decision-model-sends"]')).toBeNull();
  });

  it("asks nothing and saves nothing when Cloud is pressed until a model is chosen", async () => {
    const { set } = stubApi({ kind: "none" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Cloud").click());
    expect(document.querySelector('[data-testid="decision-model-cloud"]')).not.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});

function disclosure(): string | null | undefined {
  return document.querySelector('[data-testid="decision-model-sends"]')?.textContent;
}

function extensionDialog(): Element | null {
  return document.querySelector('[role="alertdialog"]');
}

describe("the cloud opt-in", () => {
  it("says what leaves the Mac, and only Allow writes", async () => {
    const onAllow = vi.fn();
    const onCancel = vi.fn();
    await render(<CloudOptInDialog entry={ZEN} onAllow={onAllow} onCancel={onCancel} />);
    expect(document.body.textContent).toContain("Send decisions to Jev 1.13 Free · OpenCode Zen?");
    expect(document.body.textContent).toMatch(/Session text, tool results and page content/);
    expect(document.body.textContent).not.toContain("bare tool call");
    await act(async () => button("Cancel").click());
    expect(onCancel).toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
    await act(async () => button("Allow").click());
    expect(onAllow).toHaveBeenCalledWith(ZEN);
  });
});

const switchEl = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-testid="decision-model-auto-pick"] button')!;

describe("Pick models automatically (VC-432)", () => {
  const cloud = {
    kind: "cloud",
    providerId: "opencode",
    modelId: "jev-1.13-free",
  } as const;

  it("is off by default, and turning it on asks once before extending the opt-in", async () => {
    const { set } = stubApi({ ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    await act(async () => switchEl().click());
    // Asked, and nothing written yet; the dialog says what this purpose sends.
    expect(set).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/choose models\?/);
    expect(document.body.textContent).toMatch(/first message of a new chat/);
    await act(async () => button("Cancel").click());
    expect(set).not.toHaveBeenCalled();

    await act(async () => switchEl().click());
    await act(async () => button("Allow").click());
    expect(set).toHaveBeenCalledWith(
      { scope: "global" },
      expect.objectContaining({
        kind: "cloud",
        optIn: expect.objectContaining({ purposes: ["agent.classify", "model.select"] }),
      }),
    );
  });

  it("extends and withdraws model selection without changing authority consent", async () => {
    const { set } = stubApi(cloudSetting(ZEN, 1));
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(disclosure()).toContain("bare tool call");
    expect(disclosure()).not.toContain("first message of a new chat");
    await act(async () => switchEl().click());
    expect(extensionDialog()?.textContent).toContain("first message of a new chat");
    expect(extensionDialog()?.textContent).not.toContain("bare tool call");
    expect(set).not.toHaveBeenCalled();
    await act(async () => button("Allow").click());
    expect(set).toHaveBeenLastCalledWith(
      { scope: "global" },
      expect.objectContaining({
        optIn: {
          acceptedAt: expect.any(Number),
          purposes: ["agent.classify", "model.select"],
        },
      }),
    );
    expect(disclosure()).toContain("first message of a new chat");
    await act(async () => switchEl().click());
    expect(set).toHaveBeenLastCalledWith(
      { scope: "global" },
      expect.objectContaining({
        optIn: expect.objectContaining({ purposes: ["agent.classify"] }),
      }),
    );
    expect(disclosure()).toContain("bare tool call");
    expect(disclosure()).not.toContain("first message of a new chat");
  });

  it("turns off at once, keeping the rest of the opt-in", async () => {
    const { set } = stubApi({
      ...cloud,
      optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] },
    });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    await act(async () => switchEl().click());
    expect(set).toHaveBeenCalledWith(
      { scope: "global" },
      expect.objectContaining({ optIn: expect.objectContaining({ purposes: ["agent.classify"] }) }),
    );
  });

  it("has no switch without a cloud model", async () => {
    stubApi({ kind: "none" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(document.querySelector('[data-testid="decision-model-auto-pick"]')).toBeNull();
  });

  it("is on a project's own cloud model, and absent while it inherits", async () => {
    const project = { id: "project-1" } as Project;
    const { set } = stubApi(
      { ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify"] } },
      { ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] } },
    );
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    const own = document.querySelector<HTMLButtonElement>(
      '[data-testid="project-decision-model-auto-pick"] button',
    )!;
    expect(own.getAttribute("aria-checked")).toBe("true");
    await act(async () => own.click());
    expect(set).toHaveBeenCalledWith(
      { scope: "project", projectId: "project-1" },
      expect.objectContaining({ optIn: expect.objectContaining({ purposes: ["agent.classify"] }) }),
    );
    await act(async () => root?.unmount());
    container?.remove();

    stubApi({ ...cloud, optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] } });
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(document.querySelector('[data-testid="project-decision-model-auto-pick"]')).toBeNull();
  });
});
