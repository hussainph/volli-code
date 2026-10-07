// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
} from "@volli/shared";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import type { ModelAccessClient } from "@renderer/lib/model-access-client";
import { useHostModelSheet } from "@renderer/stores/host-model-sheet";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { registryHost } from "@renderer/stores/remote-hosts.test-support";
import { HostModelSheet } from "./host-model-sheet";
import { click, HETZNER_ID, hostWorld, type HostWorld } from "./hosts.test-support";
import { useHostSignInSheet } from "./sign-ins/remote-host-sign-in-source";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));
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
      modelId: "gpt",
      label: "GPT",
      state: "available",
      reasoningLevels: ["off"],
      acceptsImageInput: true,
    },
  ],
};
let world: HostWorld | null = null;
afterEach(async () => {
  await world?.cleanup();
  world = null;
  useHostModelSheet.getState().close();
  useHostSignInSheet.getState().close();
  useRemoteHostsStore.setState({ hosts: [], addHost: { open: false, target: "" } });
  vi.clearAllMocks();
});
function client(overrides: Partial<ModelAccessClient> = {}): ModelAccessClient {
  let defaults = EMPTY_MODEL_ACCESS_DEFAULTS;
  return {
    inspect: vi.fn(async () => SNAPSHOT),
    defaults: vi.fn(async () => defaults),
    hiddenModels: vi.fn(async () => []),
    setHiddenModels: vi.fn(async (value) => value),
    compactionPolicy: vi.fn(async () => DEFAULT_COMPACTION_POLICY),
    setCompactionPolicy: vi.fn(async (value) => value),
    codeModePolicy: vi.fn(async () => DEFAULT_CODE_MODE_POLICY),
    setCodeModePolicy: vi.fn(async (value) => value),
    pickerView: vi.fn(async () => "all" as const),
    setPickerView: vi.fn(async (value) => value),
    setDefault: vi.fn(async (purpose, selection) => {
      defaults = { ...defaults, [purpose]: selection };
      return defaults;
    }),
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  };
}
function dialog(): HTMLElement {
  return document.querySelector('[role="dialog"]')!;
}
async function open(makeClient = vi.fn(() => client())) {
  await world!.render(
    <TooltipProvider>
      <HostModelSheet makeClient={makeClient} />
    </TooltipProvider>,
  );
  await act(async () =>
    useHostModelSheet.getState().open({ hostId: HETZNER_ID, hostName: "hetzner-1" }),
  );
  return makeClient;
}
const READY = { status: "ready" as const, granted: ["host.model-defaults"] };

describe("Models on a host", () => {
  it.each([
    undefined,
    { status: "older" as const, granted: [] },
    { status: "ready" as const, granted: ["model-access"] },
  ])("names older or missing-feature hosts without making a call (%j)", async (hostScope) => {
    world = hostWorld({ hetzner: { hostScope } });
    useRemoteHostsStore
      .getState()
      .setHosts([registryHost({ id: HETZNER_ID, target: "deploy@box" })]);
    const makeClient = await open();
    expect(dialog().textContent).toContain("Models on hetzner-1");
    expect(dialog().textContent).toContain("Update hetzner-1 to choose its model here");
    expect(dialog().querySelector('[data-slot="spinner"]')).toBeNull();
    expect(makeClient).not.toHaveBeenCalled();
    await click(dialog(), "Re-add to update");
    expect(useRemoteHostsStore.getState().addHost).toMatchObject({
      open: true,
      target: "deploy@box",
    });
    expect(useHostModelSheet.getState().target).toBeNull();
  });

  it("keeps flag-off inert even when someone holds a recovery action", async () => {
    world = hostWorld({ cloud: false });
    const makeClient = await open();
    expect(useHostModelSheet.getState().target).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("reuses the model preferences, hides decisions/accounts and opens host Sign-ins", async () => {
    world = hostWorld({ hetzner: { hostScope: READY } });
    const source = client();
    const makeClient = await open(vi.fn(() => source));
    expect(makeClient).toHaveBeenCalledWith(
      HETZNER_ID,
      expect.objectContaining({ hostId: HETZNER_ID }),
    );
    const text = dialog().textContent;
    for (const label of ["Default models", "Compaction", "Code Mode", "Catalog"])
      expect(text).toContain(label);
    expect(text).not.toContain("Decision model");
    expect(text).not.toContain("Accounts");
    expect(source.beginSignIn).not.toHaveBeenCalled();
    expect(
      dialog().querySelector('[data-testid="default-model-global"] [role="combobox"]')?.textContent,
    ).toContain("Choose a model");
    await click(dialog(), "Sign-ins on hetzner-1…");
    expect(useHostModelSheet.getState().target).toBeNull();
    expect(useHostSignInSheet.getState().target).toEqual({
      hostId: HETZNER_ID,
      hostName: "hetzner-1",
      providerId: null,
    });
  });

  it("saves the host default through the reused picker", async () => {
    world = hostWorld({ hetzner: { hostScope: READY } });
    const source = client();
    await open(vi.fn(() => source));
    const trigger = dialog().querySelector<HTMLElement>(
      '[data-testid="default-model-global"] [role="combobox"]',
    )!;
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = () => {};
    try {
      trigger.focus();
      await act(async () =>
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
      );
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
        item.textContent?.includes("GPT"),
      )!;
      await act(async () => option.focus());
      await act(async () =>
        option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(source.setDefault).toHaveBeenCalledWith("global", {
        providerId: "acme",
        modelId: "gpt",
        reasoningLevel: "off",
      });
      expect(dialog().querySelector('[data-testid="default-model-global"]')?.textContent).toContain(
        "GPT",
      );
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });

  it("names lost HOST links, disposes pending reads, and reads fresh on reconnect", async () => {
    world = hostWorld({ hetzner: { hostScope: READY } });
    let rejectRead!: (error: Error) => void;
    const source = client({
      inspect: vi.fn(
        () =>
          new Promise<ModelAccessSnapshot>((_resolve, reject) => {
            rejectRead = reject;
          }),
      ),
    });
    const makeClient = await open(vi.fn(() => source));
    await act(async () => world!.setHetzner({ hostScope: { status: "unavailable", granted: [] } }));
    expect(dialog().textContent).toContain("Couldn’t reach hetzner-1");
    expect(dialog().textContent).not.toContain("Default models");
    await act(async () => rejectRead(new Error("late failure")));
    expect(toast.error).not.toHaveBeenCalled();
    vi.mocked(source.inspect).mockResolvedValue(SNAPSHOT);
    await act(async () => world!.setHetzner({ hostScope: READY }));
    expect(makeClient).toHaveBeenCalledTimes(2);
    expect(source.inspect).toHaveBeenCalledTimes(2);
    expect(dialog().textContent).toContain("Default models");
  });

  it("shows one named retry after a failed catalog read, and closes via the dialog", async () => {
    world = hostWorld({ hetzner: { hostScope: READY } });
    const source = client({
      inspect: vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(SNAPSHOT),
    });
    await open(vi.fn(() => source));
    expect(dialog().textContent).toContain("Couldn’t load models on hetzner-1");
    await click(dialog(), "Retry now");
    expect(dialog().textContent).toContain("Default models");
    await click(dialog(), "Close");
    expect(useHostModelSheet.getState().target).toBeNull();
  });
});
