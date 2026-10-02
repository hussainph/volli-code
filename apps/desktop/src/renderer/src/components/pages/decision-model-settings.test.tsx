// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import type { DecisionModelCatalogEntry, DecisionModelSetting } from "@volli/shared";

import type { DecisionModelResult, DecisionModelSettingsView } from "../../../../ipc/contract";
import type { Project } from "@volli/shared";

import {
  AUTHORITY_REASON_SOURCE_KEY,
  authorityOptInExtensionKey,
  cloudSetting,
} from "./decision-model-model";
import { AUTHORITY_SHADOW_REVIEW_ENABLED_KEY } from "../../../../authority-review-preferences";
import { appStateStorage, flushPendingAppStateKey } from "@renderer/lib/app-state-storage";

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

describe("the global shadow review opt-in", () => {
  it("starts off and persists both enable and disable independently of model selection", async () => {
    const { setAppState, set } = stubApi({ kind: "none" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    const control = document.querySelector<HTMLButtonElement>("#authority-shadow-review");
    expect(control?.getAttribute("aria-checked")).toBe("false");
    await act(async () => control?.click());
    expect(setAppState).toHaveBeenLastCalledWith(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "true");
    expect(control?.getAttribute("aria-checked")).toBe("true");
    await act(async () => control?.click());
    expect(setAppState).toHaveBeenLastCalledWith(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "false");
    expect(set).not.toHaveBeenCalled();
  });

  it("reads a saved opt-in and retains it when the block reason changes", async () => {
    const { appState } = stubApi({ kind: "none" });
    appState.set(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "true");
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Risk category").click());
    expect(document.querySelector("#authority-shadow-review")?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("keeps the spending switch usable when block-reason state is corrupt", async () => {
    const { appState, setAppState } = stubApi({ kind: "none" });
    appState.set(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "true");
    appState.set(AUTHORITY_REASON_SOURCE_KEY, "broken JSON");
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    const control = document.querySelector<HTMLButtonElement>("#authority-shadow-review");
    expect(control?.getAttribute("aria-checked")).toBe("true");
    await act(async () => control?.click());
    expect(setAppState).toHaveBeenLastCalledWith(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "false");
    expect(control?.getAttribute("aria-checked")).toBe("false");
  });

  it.each([false, true])(
    "does not let an earlier settings retry replace a saved shadow opt-in=%s",
    async (enabled) => {
      const { appState, bootstrap, setAppState } = stubApi({ kind: "none" });
      appState.set(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, JSON.stringify(!enabled));
      appState.set(AUTHORITY_REASON_SOURCE_KEY, "broken JSON");
      await render(<DecisionModelSettings onSignIn={() => undefined} />);
      const control = document.querySelector<HTMLButtonElement>("#authority-shadow-review");
      expect(control).not.toBeNull();
      // Capture the old durable value, but deliver it only after the person
      // saves the new choice. A retry must not make a spending control lie.
      const stale = { ok: true as const, data: { appState: Object.fromEntries(appState) } };
      let finishRead!: (value: typeof stale) => void;
      bootstrap.mockImplementationOnce(
        () => new Promise<typeof stale>((resolve) => (finishRead = resolve)),
      );
      await act(async () => button("Retry").click());
      expect(bootstrap).toHaveBeenCalledTimes(2);
      await act(async () => control!.click());
      expect(setAppState).toHaveBeenLastCalledWith(
        AUTHORITY_SHADOW_REVIEW_ENABLED_KEY,
        JSON.stringify(enabled),
      );
      expect(appState.get(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY)).toBe(JSON.stringify(enabled));
      await act(async () => finishRead(stale));
      expect(control!.getAttribute("aria-checked")).toBe(String(enabled));
    },
  );

  it.each(["refused", "rejected"])(
    "surfaces a %s shadow save, retains the durable choice, and can retry",
    async (failure) => {
      const { appState, setAppState } = stubApi({ kind: "none" });
      appState.set(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "true");
      if (failure === "refused")
        setAppState.mockResolvedValueOnce({ ok: false, error: "disk full" });
      else setAppState.mockRejectedValueOnce(new Error("disk full"));
      await render(<DecisionModelSettings onSignIn={() => undefined} />);
      const control = document.querySelector<HTMLButtonElement>("#authority-shadow-review");
      expect(control).not.toBeNull();
      await act(async () => control!.click());
      expect(control!.getAttribute("aria-checked")).toBe("true");
      expect(control!.disabled).toBe(false);
      expect(appState.get(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY)).toBe("true");
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("disk full"),
        expect.any(Object),
      );
      await act(async () => control!.click());
      expect(setAppState).toHaveBeenLastCalledWith(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, "false");
      expect(appState.get(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY)).toBe("false");
      expect(control!.getAttribute("aria-checked")).toBe("false");
      await unmount();
      await render(<DecisionModelSettings onSignIn={() => undefined} />);
      expect(document.querySelector("#authority-shadow-review")?.getAttribute("aria-checked")).toBe(
        "false",
      );
    },
  );

  it("waits for durable shadow save and prevents a second write while pending", async () => {
    const { appState, setAppState } = stubApi({ kind: "none" });
    let finishWrite!: () => void;
    setAppState.mockImplementationOnce(
      (key, value) =>
        new Promise((resolve) => {
          finishWrite = () => {
            appState.set(key, value);
            resolve({ ok: true });
          };
        }),
    );
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    const control = document.querySelector<HTMLButtonElement>("#authority-shadow-review");
    expect(control).not.toBeNull();
    await act(async () => control!.click());
    expect(control!.getAttribute("aria-checked")).toBe("false");
    expect(control!.disabled).toBe(true);
    expect(appState.has(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY)).toBe(false);
    await act(async () => control!.click());
    expect(setAppState).toHaveBeenCalledOnce();
    await act(async () => finishWrite());
    expect(control!.getAttribute("aria-checked")).toBe("true");
    expect(control!.disabled).toBe(false);
    expect(appState.get(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY)).toBe("true");
    await unmount();
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(document.querySelector("#authority-shadow-review")?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it.each([
    { raw: undefined, enabled: false },
    { raw: "true", enabled: true },
    { raw: "false", enabled: false },
    { raw: '"true"', enabled: false },
    { raw: "null", enabled: false },
    { raw: "invalid", enabled: false },
  ])("only displays a strict saved shadow opt-in ($raw)", async ({ raw, enabled }) => {
    const { appState, setAppState } = stubApi({ kind: "none" });
    if (raw !== undefined) appState.set(AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, raw);
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(document.querySelector("#authority-shadow-review")?.getAttribute("aria-checked")).toBe(
      String(enabled),
    );
    expect(setAppState).not.toHaveBeenCalled();
  });
});

describe("the global Block reason choice", () => {
  it("defaults to utility with no utility model configured, persists JSON, and reads it on remount", async () => {
    const { setAppState, bootstrap } = stubApi({ kind: "none" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(button("Utility model").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll('[data-testid="authority-reason-source"]')).toHaveLength(1);
    await act(async () => button("Risk category").click());
    expect(setAppState).toHaveBeenCalledWith(
      AUTHORITY_REASON_SOURCE_KEY,
      JSON.stringify("category"),
    );
    expect(button("Risk category").getAttribute("aria-pressed")).toBe("true");
    await unmount();
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(button("Risk category").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Utility model").click());
    expect(setAppState).toHaveBeenLastCalledWith(
      AUTHORITY_REASON_SOURCE_KEY,
      JSON.stringify("utility"),
    );
  });

  it("reads an existing category choice without rewriting it", async () => {
    const { appState, setAppState } = stubApi({ kind: "none" });
    appState.set(AUTHORITY_REASON_SOURCE_KEY, JSON.stringify("category"));
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(button("Risk category").getAttribute("aria-pressed")).toBe("true");
    expect(setAppState).not.toHaveBeenCalled();
  });

  it.each(["refused", "rejected"])(
    "surfaces a %s save and retains the durable selection for retry",
    async (failure) => {
      const { setAppState } = stubApi({ kind: "none" });
      if (failure === "refused")
        setAppState.mockResolvedValueOnce({ ok: false, error: "disk full" });
      else setAppState.mockRejectedValueOnce(new Error("disk full"));
      await render(<DecisionModelSettings onSignIn={() => undefined} />);
      await act(async () => button("Risk category").click());
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't save the block reason choice: disk full",
        expect.objectContaining({ closeButton: true }),
      );
      expect(button("Utility model").getAttribute("aria-pressed")).toBe("true");
      expect(button("Risk category").disabled).toBe(false);
      await act(async () => button("Risk category").click());
      expect(button("Risk category").getAttribute("aria-pressed")).toBe("true");
    },
  );

  it.each(["refused", "rejected", "invalid"])(
    "surfaces a %s load and offers retry",
    async (failure) => {
      const { bootstrap, appState, setAppState } = stubApi({ kind: "none" });
      if (failure === "refused") {
        bootstrap.mockResolvedValueOnce({ ok: false, error: "read failed" } as never);
      } else if (failure === "rejected") {
        bootstrap.mockRejectedValueOnce(new Error("read failed"));
      } else {
        appState.set(AUTHORITY_REASON_SOURCE_KEY, "broken JSON");
      }
      await render(<DecisionModelSettings onSignIn={() => undefined} />);
      expect(document.body.textContent).toContain("Couldn't read the block reason choice");
      expect(document.querySelector('[aria-label="Block reason"]')).toBeNull();
      expect(setAppState).not.toHaveBeenCalled();
      appState.delete(AUTHORITY_REASON_SOURCE_KEY);
      await act(async () => button("Retry").click());
      expect(button("Utility model").getAttribute("aria-pressed")).toBe("true");
    },
  );

  it("does not add a per-project reason axis", async () => {
    const { bootstrap } = stubApi({ kind: "none" });
    await render(
      <ProjectDecisionModelRow project={{ id: "p1" } as Project} onSaved={() => undefined} />,
    );
    expect(document.querySelector('[data-testid="authority-reason-source"]')).toBeNull();
    expect(bootstrap).not.toHaveBeenCalled();
  });
});

const LEGACY_CLOUD: DecisionModelSetting = {
  kind: "cloud",
  providerId: ZEN.providerId,
  modelId: ZEN.modelId,
  optIn: { acceptedAt: 1, purposes: ["agent.classify"] },
};

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

function disclosure(): string | null | undefined {
  return document.querySelector('[data-testid="decision-model-sends"]')?.textContent;
}

function extensionDialog(): Element | null {
  return document.querySelector('[role="alertdialog"]');
}

describe("extending an existing cloud opt-in", () => {
  it("discloses user messages and the bare call, and saves expanded global authority only on Allow", async () => {
    const { set } = stubApi(LEGACY_CLOUD);
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()?.textContent).toContain("Allow tool-call review");
    expect(extensionDialog()?.textContent).toMatch(
      /user messages and the bare tool call \(name and arguments\) off this Mac/,
    );
    expect(extensionDialog()?.textContent).toMatch(
      /does not send assistant prose, reasoning, tool outputs or tool descriptions/,
    );
    expect(set).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="decision-model-sends"]')?.textContent,
    ).not.toContain("user messages");
    await act(async () => button("Allow tool-call review").click());
    expect(set).toHaveBeenCalledWith(
      { scope: "global" },
      expect.objectContaining({
        kind: "cloud",
        providerId: ZEN.providerId,
        modelId: ZEN.modelId,
        optIn: { acceptedAt: expect.any(Number), purposes: ["agent.classify", "authority.judge"] },
      }),
    );
    expect(extensionDialog()).toBeNull();
    expect(appStateStorage.setItem).not.toHaveBeenCalled();
    await unmount();
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()).toBeNull();
  });

  it("extends authority without removing model selection and discloses only opted-in purposes", async () => {
    const { set } = stubApi({
      ...LEGACY_CLOUD,
      optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] },
    });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(disclosure()).toContain("first message of a new chat");
    expect(disclosure()).not.toContain("bare tool call");
    await act(async () => button("Allow tool-call review").click());
    expect(set).toHaveBeenLastCalledWith(
      { scope: "global" },
      expect.objectContaining({
        optIn: {
          acceptedAt: expect.any(Number),
          purposes: ["agent.classify", "authority.judge", "model.select"],
        },
      }),
    );
    expect(disclosure()).toContain("bare tool call");
    expect(disclosure()).toContain("first message of a new chat");
    await unmount();
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()).toBeNull();
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
  });

  it("persists a decline without changing the opt-in, and does not nag on remount", async () => {
    const { set } = stubApi(LEGACY_CLOUD);
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Not now").click());
    const key = authorityOptInExtensionKey(LEGACY_CLOUD, null)!;
    expect(appStateStorage.setItem).toHaveBeenCalledWith(key, "declined");
    expect(flushPendingAppStateKey).toHaveBeenCalledWith(key);
    expect(set).not.toHaveBeenCalled();
    expect(extensionDialog()).toBeNull();
    await unmount();
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()).toBeNull();
  });

  it("honours a durable decline seeded at app startup", async () => {
    receipts.set(authorityOptInExtensionKey(LEGACY_CLOUD, null)!, "declined");
    stubApi(LEGACY_CLOUD);
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()).toBeNull();
  });

  it("extends a project's own opt-in without changing the global model", async () => {
    const { set } = stubApi({ kind: "none" }, LEGACY_CLOUD);
    await render(
      <ProjectDecisionModelRow
        project={{ id: "project-1" } as Project}
        onSaved={() => undefined}
      />,
    );
    await act(async () => button("Allow tool-call review").click());
    expect(set).toHaveBeenCalledWith(
      { scope: "project", projectId: "project-1" },
      expect.objectContaining({
        optIn: { acceptedAt: expect.any(Number), purposes: ["agent.classify", "authority.judge"] },
      }),
    );
    expect(extensionDialog()).toBeNull();
  });

  it("keeps declines scope-specific and does not create an override for an inherited agreement", async () => {
    receipts.set(authorityOptInExtensionKey(LEGACY_CLOUD, null)!, "declined");
    const project = { id: "project-1" } as Project;
    const { set } = stubApi(LEGACY_CLOUD, LEGACY_CLOUD);
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(extensionDialog()).not.toBeNull();
    await act(async () => button("Not now").click());
    expect(appStateStorage.setItem).toHaveBeenCalledWith(
      authorityOptInExtensionKey(LEGACY_CLOUD, project.id),
      "declined",
    );
    expect(set).not.toHaveBeenCalled();
    await unmount();
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(extensionDialog()).toBeNull();
    await unmount();
    stubApi(LEGACY_CLOUD);
    await render(<ProjectDecisionModelRow project={project} onSaved={() => undefined} />);
    expect(extensionDialog()).toBeNull();
  });

  it("asks nothing for an already expanded cloud agreement", async () => {
    stubApi(cloudSetting(ZEN, 42));
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    expect(extensionDialog()).toBeNull();
  });

  it("surfaces a refused extension save while retaining the retry", async () => {
    const { set } = stubApi(LEGACY_CLOUD);
    set.mockResolvedValueOnce({ ok: false, error: "disk full" });
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Allow tool-call review").click());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't enable tool-call review: disk full",
      expect.objectContaining({ closeButton: true }),
    );
    expect(extensionDialog()).not.toBeNull();
    expect(appStateStorage.setItem).not.toHaveBeenCalled();
  });

  it("keeps the extension available to retry when saving fails", async () => {
    const { set } = stubApi(LEGACY_CLOUD);
    set.mockRejectedValueOnce(new Error("disk full"));
    await render(<DecisionModelSettings onSignIn={() => undefined} />);
    await act(async () => button("Allow tool-call review").click());
    expect(extensionDialog()).not.toBeNull();
    expect(appStateStorage.setItem).not.toHaveBeenCalled();
    await act(async () => button("Allow tool-call review").click());
    expect(extensionDialog()).toBeNull();
  });
});

describe("the cloud opt-in", () => {
  it("says what leaves the Mac, and only Allow writes", async () => {
    const onAllow = vi.fn();
    const onCancel = vi.fn();
    await render(<CloudOptInDialog entry={ZEN} onAllow={onAllow} onCancel={onCancel} />);
    expect(document.body.textContent).toContain("Send decisions to Jev 1.13 Free · OpenCode Zen?");
    expect(document.body.textContent).toMatch(/Session text, tool results and page content/);
    expect(document.body.textContent).toMatch(/user's messages and the bare tool call/);
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
          purposes: ["agent.classify", "authority.judge", "model.select"],
        },
      }),
    );
    expect(disclosure()).toContain("first message of a new chat");
    await act(async () => switchEl().click());
    expect(set).toHaveBeenLastCalledWith(
      { scope: "global" },
      expect.objectContaining({
        optIn: expect.objectContaining({ purposes: ["agent.classify", "authority.judge"] }),
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
