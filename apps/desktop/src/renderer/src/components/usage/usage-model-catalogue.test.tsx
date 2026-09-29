// @vitest-environment jsdom
/**
 * The usage rows' catalogue read, at the boundary that makes it.
 *
 * Mounted against a real {@link ModelAccessProvider} over a stub client, the
 * shape `lib/model-access-client.test.tsx` uses: what is under test is which
 * question the hook asks, when it asks again, and what it answers when the read
 * fails or is cancelled — none of which a pure resolver can be asked about.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
} from "@volli/shared";

import {
  ModelAccessProvider,
  useModelAccessClient,
  type ModelAccessClient,
  type ModelAccessContextValue,
} from "@renderer/lib/model-access-client";
import type { UsageModelCatalogue } from "@renderer/components/usage/usage-rail-model";

import { useUsageModelCatalogue } from "./usage-model-catalogue";

function snapshot(label: string): ModelAccessSnapshot {
  return {
    observedAt: 1,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        state: "available",
        accountLabel: null,
        billingSource: "subscription",
        recovery: null,
        signIn: [],
        hasStoredCredential: true,
      },
    ],
    models: [
      {
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        label,
        state: "available",
        reasoningLevels: [],
        acceptsImageInput: true,
      },
    ],
  };
}

function testClient(inspect: ModelAccessClient["inspect"]): ModelAccessClient {
  return {
    inspect,
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    pickerView: async () => "all" as const,
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

/** Every value the hook has answered, in order — so a cancelled read is visible. */
let seen: (UsageModelCatalogue | null)[] = [];
/** The shared context, which is how a test moves the revision the way a sign-out does. */
let handle: ModelAccessContextValue | null = null;

function Probe(): null {
  const catalogue = useUsageModelCatalogue();
  handle = useModelAccessClient();
  seen.push(catalogue);
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(client: ModelAccessClient): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={client}>
        <Probe />
      </ModelAccessProvider>,
    );
  });
}

function latest(): UsageModelCatalogue | null {
  return seen.at(-1) ?? null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  seen = [];
  handle = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useUsageModelCatalogue", () => {
  it("asks for the HELD read and answers the catalogue whole", async () => {
    const inspect = vi.fn<ModelAccessClient["inspect"]>(async () => snapshot("Claude Opus 4.1"));
    await mount(testClient(inspect));

    // `inspect({})`, which the provider forwards as `{ refresh: false }` — its
    // HELD branch. Never a refresh: a rail naming a row must not send the app on
    // a 40-provider sweep, and the hold is what makes the read free for a
    // surface arriving after a composer has asked.
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({ refresh: false });
    expect(latest()?.models[0]?.label).toBe("Claude Opus 4.1");
    expect(latest()?.providers[0]?.label).toBe("Anthropic");
    // Nothing on screen before the read lands, which is what the rows draw as
    // the ids the ledger holds.
    expect(seen[0]).toBeNull();
  });

  it("reads again when the client's revision moves, and never on a timer", async () => {
    let call = 0;
    const inspect = vi.fn<ModelAccessClient["inspect"]>(async () => {
      call += 1;
      return snapshot(call === 1 ? "Claude Opus 4.1" : "Claude Opus 4.2");
    });
    await mount(testClient(inspect));
    expect(inspect).toHaveBeenCalledTimes(1);

    // A sign-out is what renames a model on these rows; the shared client bumps
    // its revision and re-mints the handle, which is what this hook depends on.
    await act(async () => {
      await handle?.signOut("anthropic");
    });

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(latest()?.models[0]?.label).toBe("Claude Opus 4.2");
  });

  it("keeps the last good catalogue when a later read fails", async () => {
    let fail = false;
    const inspect = vi.fn<ModelAccessClient["inspect"]>(async () => {
      if (fail) throw new Error("bridge refused");
      return snapshot("Claude Opus 4.1");
    });
    await mount(testClient(inspect));
    fail = true;

    await act(async () => {
      await handle?.signOut("anthropic");
    });

    // Not an empty catalogue: that would rename every row on screen back to an
    // id because one re-read failed. No toast either — nobody asked for a name.
    expect(latest()?.models[0]?.label).toBe("Claude Opus 4.1");
  });

  it("answers null when the first read fails, so the rows keep the ledger's ids", async () => {
    const inspect = vi.fn<ModelAccessClient["inspect"]>(async () => {
      throw new Error("bridge refused");
    });
    await mount(testClient(inspect));

    expect(latest()).toBeNull();
  });

  it("drops an answer that arrives after it was unmounted", async () => {
    const pending = Promise.withResolvers<ModelAccessSnapshot>();
    await mount(testClient(() => pending.promise));
    expect(latest()).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    await act(async () => {
      pending.resolve(snapshot("Claude Opus 4.1"));
      await pending.promise;
    });

    // The catalogue never reached a mounted surface — the read was cancelled,
    // not merely ignored on arrival.
    expect(seen.every((value) => value === null)).toBe(true);
  });
});
