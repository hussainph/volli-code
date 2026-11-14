// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ModelAccessProvider } from "@volli/shared";
import { ModelAccessAccounts } from "./provider-accounts";
import { availableProviderRows, providerStatus } from "./provider-accounts-model";
import type { ModelAccessContextValue } from "@renderer/lib/model-access-client";
const boundary = vi.hoisted(() => ({
  client: null as Pick<ModelAccessContextValue, "beginSignIn" | "signOut"> | null,
}));
vi.mock("@renderer/lib/model-access-client", () => ({
  useModelAccessClient: () => boundary.client,
}));

const provider = (id: string, label = id): ModelAccessProvider => ({
  id,
  label,
  state: "authentication-required",
  accountLabel: null,
  billingSource: "unknown",
  recovery: { kind: "sign-in" },
  signIn: [{ type: "api-key", label: "API key", isSubscription: false }],
  hasStoredCredential: false,
});
const providers = [
  "zai",
  "openrouter",
  "google",
  "openai",
  "anthropic",
  "github-copilot",
  "mistral",
].map((id) => provider(id));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  boundary.client = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("prioritizes common providers and keeps a requested account visible", () => {
  expect(availableProviderRows(providers, "", false).map((p) => p.id)).toEqual([
    "anthropic",
    "openai",
    "google",
    "github-copilot",
    "openrouter",
  ]);
  expect(availableProviderRows(providers, "", false, "zai")[0]?.id).toBe("zai");
  expect(availableProviderRows(providers, " MISTRAL ", false).map((p) => p.id)).toEqual([
    "mistral",
  ]);
  expect(availableProviderRows(providers, "", true)).toHaveLength(providers.length);
});
it("says only known account or billing status", () => {
  expect(providerStatus(provider("openai"))).toBeNull();
  expect(providerStatus({ ...provider("openai"), state: "unavailable" })).toBe("Unavailable");
  expect(
    providerStatus({
      ...provider("openai"),
      accountLabel: "API key",
      billingSource: "subscription",
    }),
  ).toBe("API key · Subscription");
});
it("shows account marks, compact rows and all providers on request", async () => {
  const connected = {
    ...provider("azure-openai-responses", "Azure OpenAI"),
    state: "available" as const,
  };
  await act(async () =>
    root.render(
      <ModelAccessAccounts
        providers={[...providers, connected]}
        onRecover={vi.fn()}
        onChanged={vi.fn()}
      />,
    ),
  );
  const accounts = host.querySelector('[data-slot="model-access-accounts"]')!;
  const available = host.querySelector('[data-slot="model-access-accounts-available"]')!;
  expect(
    accounts.querySelector('[data-testid="account-azure-openai-responses"] svg path'),
  ).not.toBeNull();
  expect(accounts.querySelector('[data-slot="identity-tile"] svg')).not.toBeNull();
  expect(available.querySelectorAll('[data-testid^="account-"]')).toHaveLength(5);
  expect(available.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(5);
  // The Settings account lists name each provider in the row (VC-1228).
  expect(accounts.textContent).toContain("Azure OpenAI");
  expect(accounts.querySelector('[role="img"][aria-label="Azure OpenAI"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Unknown");
  expect(host.textContent).not.toContain("Sign in required");
  const showAll = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Show all 7 providers",
  )!;
  await act(async () => showAll.click());
  expect(available.querySelectorAll('[data-testid^="account-"]')).toHaveLength(7);
  expect(available.textContent).toContain("mistral");
});
it("searches beyond the preview without needing Show all", async () => {
  await act(async () =>
    root.render(
      <ModelAccessAccounts providers={providers} onRecover={vi.fn()} onChanged={vi.fn()} />,
    ),
  );
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search providers"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "mistral",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const available = host.querySelector('[data-slot="model-access-accounts-available"]')!;
  expect(available.querySelectorAll('[data-testid^="account-"]')).toHaveLength(1);
  expect(available.textContent).toContain("mistral");
  expect(available.textContent).not.toContain("Show all");
});

it("preserves provider sign-in questions and responses through the existing client", async () => {
  const respond = vi.fn().mockResolvedValue(undefined);
  const beginSignIn = vi
    .fn<ModelAccessContextValue["beginSignIn"]>()
    .mockImplementation(async (_id, _type, update) => {
      update({
        attemptId: "a",
        kind: "prompt",
        prompt: {
          kind: "secret",
          promptId: "p",
          message: "API key",
          placeholder: null,
          options: [],
        },
      });
      return { attemptId: "a", respond, cancel: vi.fn().mockResolvedValue(undefined) };
    });
  boundary.client = { beginSignIn, signOut: vi.fn() };
  await act(async () =>
    root.render(
      <ModelAccessAccounts providers={providers} onRecover={vi.fn()} onChanged={vi.fn()} />,
    ),
  );
  await act(async () =>
    host
      .querySelector('[data-testid="account-anthropic"]')!
      .parentElement!.querySelector<HTMLButtonElement>("button")!
      .click(),
  );
  expect(beginSignIn).toHaveBeenCalledWith("anthropic", "api-key", expect.any(Function));
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "test-value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(respond).toHaveBeenCalledWith("p", "test-value");
});
