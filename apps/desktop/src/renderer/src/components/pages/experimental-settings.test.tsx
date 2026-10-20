// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveExperiments, type ExperimentSnapshot } from "@volli/shared";
import { toast } from "sonner";

const rpc = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn() }));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    settings: {
      experiments: { query: rpc.query },
      setExperiment: { mutate: rpc.mutate },
    },
  }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";

import { ExperimentalSettings } from "./experimental-settings";
import { SettingsPage } from "./settings-page";

let root: Root | null = null;
let container: HTMLElement | null = null;
const originalScrollTo = HTMLElement.prototype.scrollTo;

function snapshot(
  enabled: boolean,
  source: ExperimentSnapshot["cloud"]["source"] = "default",
): ExperimentSnapshot {
  return { cloud: { enabled, source } };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollTo = vi.fn();
  useExperimentsStore.setState({ snapshot: null });
  rpc.query.mockReset().mockResolvedValue(snapshot(false));
  rpc.mutate.mockReset().mockResolvedValue(snapshot(true, "storage"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useExperimentsStore.setState({ snapshot: null });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  HTMLElement.prototype.scrollTo = originalScrollTo;
});

async function renderPane(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ExperimentalSettings />));
}

function experimentSwitch(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(
    '[data-testid="experiment-cloud-switch"]',
  );
  if (control === null) throw new Error("Volli Cloud switch is missing");
  return control;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

describe("Settings → Experimental", () => {
  it.each(["dev", "canary", "stable"] as const)(
    "projects %s visibility into the actual Settings rail and deep links",
    async (kind) => {
      const experiments = resolveExperiments({ cloud: true }, [], kind);
      useExperimentsStore.getState().receive(experiments);
      rpc.query.mockResolvedValue(experiments);
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => root?.render(<SettingsPage initialCategoryKey="experimental" />));
      if (kind === "stable") {
        expect(container.textContent).not.toContain("Experimental");
        expect(container.textContent).not.toContain("Volli Cloud");
        expect(document.querySelector('[data-testid="experiment-cloud-switch"]')).toBeNull();
      } else {
        expect(container.textContent).toContain("Experimental");
        expect(experimentSwitch().disabled).toBe(false);
      }
    },
  );
  it("renders neither the hidden switch nor an empty Experimental section on stable", async () => {
    rpc.query.mockResolvedValueOnce({
      cloud: { enabled: false, source: "default", visible: false },
    });
    await renderPane();
    expect(container?.textContent).toBe("");
    expect(document.querySelector('[data-testid="experiment-cloud-switch"]')).toBeNull();
    expect(rpc.mutate).not.toHaveBeenCalled();
  });
  it("keeps the switch disabled until the registry snapshot loads", async () => {
    let resolveRead: ((value: ExperimentSnapshot) => void) | undefined;
    rpc.query.mockReturnValueOnce(
      new Promise<ExperimentSnapshot>((resolve) => {
        resolveRead = resolve;
      }),
    );

    await renderPane();

    expect(experimentSwitch().disabled).toBe(true);
    expect(experimentSwitch().getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Loading…");

    await act(async () => resolveRead?.(snapshot(false)));

    expect(experimentSwitch().disabled).toBe(false);
    expect(experimentSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("shows the cloud flag defaulting off", async () => {
    rpc.query.mockResolvedValueOnce(snapshot(false, "default"));

    await renderPane();

    expect(rpc.query).toHaveBeenCalledTimes(1);
    expect(experimentSwitch().getAttribute("aria-checked")).toBe("false");
    expect(experimentSwitch().disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Before enabling unstable cloud features, read the cloud threat model at https://github.com/hussainph/volli-code/blob/main/SECURITY.md#cloud-threat-model.",
    );
  });

  it("writes through the semantic API and adopts its returned snapshot", async () => {
    rpc.query.mockResolvedValueOnce(snapshot(false, "default"));
    rpc.mutate.mockResolvedValueOnce(snapshot(true, "storage"));
    await renderPane();

    await click(experimentSwitch());

    expect(rpc.mutate).toHaveBeenCalledWith({ id: "cloud", enabled: true });
    expect(experimentSwitch().getAttribute("aria-checked")).toBe("true");
    expect(experimentSwitch().disabled).toBe(false);
  });

  it("hands the saved snapshot to the app's flag readers, so cloud surfaces follow it live", async () => {
    useExperimentsStore.setState({ snapshot: null });
    rpc.mutate.mockResolvedValueOnce(snapshot(true, "storage"));
    await renderPane();

    await click(experimentSwitch());

    expect(isExperimentOn(useExperimentsStore.getState().snapshot, "cloud")).toBe(true);
    useExperimentsStore.setState({ snapshot: null });
  });

  it("heals the app's flag readers from a load, even one this page cannot save", async () => {
    useExperimentsStore.setState({ snapshot: null });
    rpc.query.mockResolvedValueOnce(snapshot(true, "environment"));
    await renderPane();

    expect(isExperimentOn(useExperimentsStore.getState().snapshot, "cloud")).toBe(true);
    useExperimentsStore.setState({ snapshot: null });
  });

  it("locks an environment-enabled flag and names its source", async () => {
    rpc.query.mockResolvedValueOnce(snapshot(true, "environment"));
    await renderPane();

    expect(experimentSwitch().getAttribute("aria-checked")).toBe("true");
    expect(experimentSwitch().disabled).toBe(true);
    expect(document.querySelector('[data-testid="experiment-source"]')?.textContent).toBe(
      "Set by environment",
    );

    await click(experimentSwitch());

    expect(rpc.mutate).not.toHaveBeenCalled();
  });

  it("toasts read errors and offers a working retry", async () => {
    rpc.query.mockRejectedValueOnce(new Error("database is locked"));
    rpc.query.mockResolvedValueOnce(snapshot(false));
    await renderPane();

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load experimental settings: database is locked",
      expect.anything(),
    );
    expect(experimentSwitch().disabled).toBe(true);
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();

    await click(retry!);

    expect(rpc.query).toHaveBeenCalledTimes(2);
    expect(experimentSwitch().disabled).toBe(false);
  });

  it("toasts a failed save and keeps the last stored value", async () => {
    rpc.query.mockResolvedValueOnce(snapshot(false, "default"));
    rpc.mutate.mockRejectedValueOnce(new Error("disk full"));
    await renderPane();

    await click(experimentSwitch());

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save experimental settings: disk full",
      expect.anything(),
    );
    expect(experimentSwitch().getAttribute("aria-checked")).toBe("false");
    expect(experimentSwitch().disabled).toBe(false);
  });

  it("disables a pending save and still reports its failure after navigation", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    rpc.mutate.mockReturnValueOnce(
      new Promise<ExperimentSnapshot>((_resolve, reject) => {
        rejectSave = (error: Error) => reject(error);
      }),
    );
    await renderPane();

    await click(experimentSwitch());
    expect(experimentSwitch().disabled).toBe(true);

    await act(async () => root?.unmount());
    root = null;
    await act(async () => rejectSave?.(new Error("late disk failure")));

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save experimental settings: late disk failure",
      expect.anything(),
    );
  });

  it("ignores a read that resolves after unmount", async () => {
    let resolveRead: ((value: ExperimentSnapshot) => void) | undefined;
    rpc.query.mockReturnValueOnce(
      new Promise<ExperimentSnapshot>((resolve) => {
        resolveRead = resolve;
      }),
    );
    await renderPane();

    await act(async () => root?.unmount());
    root = null;
    await act(async () => resolveRead?.(snapshot(true)));

    expect(toast.error).not.toHaveBeenCalled();
  });
});
