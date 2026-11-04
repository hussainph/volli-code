// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ModelAccessProvider } from "@volli/shared";
import { useUiStore } from "@renderer/stores/ui";
import { ModelAccessFirstRun } from "./model-access-first-run";

const boundary = vi.hoisted(() => ({
  inspect: vi.fn(),
}));
vi.mock("@renderer/lib/model-access-client", () => ({
  useModelAccessClient: () => boundary,
}));
let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  useUiStore.getState().setSettingsOpen(false);
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root?.render(<ModelAccessFirstRun />));
  return container;
}

it("keeps model setup reachable from the paper sheet even when inspection fails", async () => {
  boundary.inspect.mockRejectedValue(new Error("Unavailable"));
  const host = await mount();
  expect(host.querySelector(".material-thick.rounded-sheet")).not.toBeNull();
  expect(host.querySelector('[data-slot="identity-tile"] svg')).not.toBeNull();
  expect(host.textContent).toContain("No model provider");
  const setup = [...host.querySelectorAll("button")].find((b) => b.textContent === "Model Access")!;
  expect(setup.dataset.variant).toBe("default");
  act(() => setup.click());
  expect(useUiStore.getState().settingsOpen).toBe(true);
  expect(useUiStore.getState().settingsCategory).toBe("model-access");
});

it("retains provider sign-in and signed-in/no-default branches", async () => {
  const provider: ModelAccessProvider = {
    id: "openai",
    label: "OpenAI",
    state: "authentication-required",
    accountLabel: null,
    billingSource: "unknown",
    recovery: { kind: "sign-in" },
    hasStoredCredential: false,
    signIn: [{ type: "api-key", label: "API key", isSubscription: false }],
  };
  boundary.inspect.mockResolvedValue({ providers: [provider], models: [] });
  const host = await mount();
  expect(host.textContent).toContain("Sign in");
  await act(async () => root?.unmount());
  root = createRoot(host);
  boundary.inspect.mockResolvedValue({ providers: [provider], models: [{ state: "available" }] });
  await act(async () => root?.render(<ModelAccessFirstRun />));
  expect(host.textContent).toContain("No default model");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Sign in")).toBe(false);
});
