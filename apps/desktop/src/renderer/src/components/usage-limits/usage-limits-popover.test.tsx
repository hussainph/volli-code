// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
} from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import { UsageLimitsPopover } from "./usage-limits-popover";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const SNAPSHOT: ModelAccessSnapshot = {
  observedAt: NOW,
  models: [],
  providers: [
    {
      id: "xai",
      label: "xAI",
      state: "available",
      accountLabel: null,
      billingSource: "subscription",
      recovery: null,
      signIn: [],
      hasStoredCredential: true,
      usageLimits: {
        checkedAt: NOW,
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 96,
            resetsAt: "2026-03-03T18:00:00.000Z",
            windowDurationMins: 10_080,
          },
        ],
      },
    },
  ],
};

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  document.querySelectorAll('[data-slot="popover-content"]').forEach((node) => node.remove());
  root = null;
  container = null;
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
    pickerView: async () => "all",
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

async function renderPopover(inspect: ModelAccessClient["inspect"]): Promise<void> {
  root = createRoot(container!);
  await act(async () => {
    root?.render(
      <StrictMode>
        <ModelAccessProvider client={client(inspect)}>
          <UsageLimitsPopover now={NOW} />
        </ModelAccessProvider>
      </StrictMode>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${label} button not found`);
  return found;
}

describe("UsageLimitsPopover", () => {
  it("inspects on open and forces the header's explicit Refresh", async () => {
    const inspect = vi.fn<ModelAccessClient["inspect"]>().mockResolvedValue(SNAPSHOT);
    await renderPopover(inspect);

    await act(async () => button("Usage limits").click());
    expect(inspect).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(document.body.textContent).toContain("xAI");
    expect(document.body.textContent).toContain("4% left");

    await act(async () => button("Refresh usage limits").click());
    expect(inspect).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("drops a closed surface's late answer instead of overwriting the next open", async () => {
    let settleFirst: ((snapshot: ModelAccessSnapshot) => void) | undefined;
    const first = new Promise<ModelAccessSnapshot>((resolve) => {
      settleFirst = resolve;
    });
    const inspect = vi
      .fn<ModelAccessClient["inspect"]>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(SNAPSHOT);
    await renderPopover(inspect);

    await act(async () => button("Usage limits").click());
    await act(async () => button("Usage limits").click());
    await act(async () => button("Usage limits").click());
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("xAI");

    await act(async () => {
      settleFirst?.({ observedAt: NOW, models: [], providers: [] });
      await first;
    });
    expect(document.body.textContent).toContain("xAI");
    expect(document.body.textContent).not.toContain("No subscriptions with usage limits.");
  });
});
