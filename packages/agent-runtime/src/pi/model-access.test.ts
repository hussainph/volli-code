import type {
  Api,
  AuthCheck,
  CredentialStore,
  Model,
  Models,
  Provider,
  ProviderAuth,
} from "@earendil-works/pi-ai";
import type { ModelAccessProvider } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { inspectPiModelAccess, PROBE_TIMEOUT_MS } from "./model-access";

// --- fixtures --------------------------------------------------------------
//
// Nothing here reaches pi-ai's real providers or a network. Each `Provider` is
// the three fields the inspection reads, and each `Models` is the handful of
// members it calls; a probe's behavior is whatever the test scripts, so a hung
// provider is a promise that never settles rather than a real socket left open.

function oauth(overrides: Partial<NonNullable<ProviderAuth["oauth"]>> = {}): ProviderAuth["oauth"] {
  return {
    name: "Example (OAuth)",
    login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    refresh: async (credential) => credential,
    toAuth: async () => ({}),
    ...overrides,
  };
}

function provider(id: string): Provider {
  return { id, name: id, auth: { oauth: oauth() } } as unknown as Provider;
}

function model(providerId: string, id: string, contextWindow?: number): Model<Api> {
  return {
    id,
    name: id,
    provider: providerId,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  } as unknown as Model<Api>;
}

interface Spec {
  provider: Provider;
  checkAuth: (signal: AbortSignal | undefined) => Promise<AuthCheck | undefined>;
  getAvailable: (signal: AbortSignal | undefined) => Promise<readonly Model<Api>[]>;
  known?: readonly Model<Api>[];
}

function fakeModels(specs: readonly Spec[]): Models {
  const byId = new Map(specs.map((spec) => [spec.provider.id, spec]));
  const at = (id: string): Spec => {
    const spec = byId.get(id);
    if (spec === undefined) throw new Error(`no scripted provider ${id}`);
    return spec;
  };
  return {
    getProviders: () => specs.map((spec) => spec.provider),
    getProvider: (id: string) => byId.get(id)?.provider,
    getModels: (id?: string) => (id === undefined ? [] : (byId.get(id)?.known ?? [])),
    checkAuth: (id: string, options?: { signal?: AbortSignal }) =>
      at(id).checkAuth(options?.signal),
    getAvailable: (id: string, options?: { signal?: AbortSignal }) =>
      at(id).getAvailable(options?.signal),
    refresh: async () => ({ aborted: false, errors: new Map() }),
  } as unknown as Models;
}

/** An auth result that resolves `ms` from now (a timer the test's fake clock drives). */
function authAfter(ms: number, value: AuthCheck | undefined): Spec["checkAuth"] {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Available models that resolve `ms` from now, paired with {@link authAfter}. */
function availableAfter(ms: number, value: readonly Model<Api>[]): Spec["getAvailable"] {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** A probe that never settles and never reacts to its signal — a wedged provider. */
const forever = (): Promise<never> => new Promise(() => {});

/** Stays in flight until its signal aborts, then rejects — a live, cancellable probe. */
const rejectOnAbort = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

/** Index a snapshot's providers by id for direct assertions. */
function providersById(
  providers: readonly ModelAccessProvider[],
): Record<string, ModelAccessProvider> {
  return Object.fromEntries(providers.map((entry) => [entry.id, entry]));
}

/** Drain the microtask queue so every probe has reached its first await. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("inspectPiModelAccess concurrency", () => {
  it("probes every provider at once rather than one after another", async () => {
    const gate = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const held: Spec["checkAuth"] = async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return undefined;
    };
    const ids = ["a", "b", "c", "d", "e"];
    const models = fakeModels(
      ids.map((id) => ({ provider: provider(id), checkAuth: held, getAvailable: async () => [] })),
    );

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 1);
    // Let all probes start; if the loop were sequential only the first would be
    // in flight, so a peak equal to the provider count is the whole claim.
    await flush();
    const peakWhileGated = peak;
    gate.resolve();
    const resolved = await snapshot;

    expect(peakWhileGated).toBe(ids.length);
    expect(resolved.providers).toHaveLength(ids.length);
  });

  it("is bounded by the slowest single probe, not the sum of all probes", async () => {
    vi.useFakeTimers();
    const SLOW_MS = 1_000;
    const ids = Array.from({ length: 20 }, (_, index) => `p${index}`);
    const models = fakeModels(
      ids.map((id) => ({
        provider: provider(id),
        checkAuth: authAfter(SLOW_MS, { type: "oauth" }),
        getAvailable: availableAfter(SLOW_MS, [model(id, "m")]),
      })),
    );

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 7);
    // One slow window resolves the whole snapshot. Twenty sequential probes
    // would need twenty windows, and this single advance would leave it pending.
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    const resolved = await snapshot;

    expect(resolved.providers).toHaveLength(ids.length);
    expect(resolved.providers.every((entry) => entry.state === "available")).toBe(true);
  });
});

describe("inspectPiModelAccess timeout", () => {
  it("reports a hung provider unavailable while the rest of the snapshot arrives", async () => {
    vi.useFakeTimers();
    const models = fakeModels([
      {
        provider: provider("fast"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [model("fast", "m1")],
      },
      { provider: provider("hung"), checkAuth: forever, getAvailable: forever },
      {
        provider: provider("ready"),
        checkAuth: async () => undefined,
        getAvailable: async () => [],
      },
    ]);

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 42);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const resolved = await snapshot;
    const byId = providersById(resolved.providers);

    expect(byId.fast?.state).toBe("available");
    expect(byId.ready?.state).toBe("authentication-required");
    expect(byId.hung?.state).toBe("unavailable");
    // A timeout is a probe failure, so recovery offers another attempt.
    expect(byId.hung?.recovery).toEqual({ kind: "retry" });
    expect(resolved.observedAt).toBe(42);
  });

  it("does not time out a snapshot whose probes settle just in time", async () => {
    vi.useFakeTimers();
    const models = fakeModels([
      {
        provider: provider("slow"),
        checkAuth: authAfter(PROBE_TIMEOUT_MS - 1, { type: "oauth" }),
        getAvailable: availableAfter(PROBE_TIMEOUT_MS - 1, [model("slow", "m")]),
      },
    ]);

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 0);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const resolved = await snapshot;

    expect(providersById(resolved.providers).slow?.state).toBe("available");
  });
});

describe("inspectPiModelAccess error containment", () => {
  it("reports a rejected probe unavailable and leaks no provider error text", async () => {
    const secret = "sk-live-must-never-surface";
    const models = fakeModels([
      {
        provider: provider("boom"),
        checkAuth: async () => {
          throw new Error(secret);
        },
        getAvailable: async () => {
          throw new Error(`response body: ${secret}`);
        },
      },
      {
        provider: provider("ready"),
        checkAuth: async () => undefined,
        getAvailable: async () => [],
      },
    ]);

    const resolved = await inspectPiModelAccess({ models, credentials: null }, () => 0);
    const byId = providersById(resolved.providers);

    expect(byId.boom?.state).toBe("unavailable");
    expect(byId.boom?.recovery).toEqual({ kind: "retry" });
    expect(byId.ready?.state).toBe("authentication-required");
    expect(JSON.stringify(resolved)).not.toContain(secret);
  });

  it("keeps a timed-out probe's provider text out of the snapshot without aborting it", async () => {
    vi.useFakeTimers();
    const secret = "sk-timeout-secret";
    let probeSignal: AbortSignal | undefined;
    const models = fakeModels([
      {
        provider: provider("hung"),
        // A timeout stops waiting but does not interrupt a live credential
        // refresh: a refresh token can rotate before the credential store
        // persists its replacement. This rejection lands after the snapshot
        // and must still remain contained by allSettled.
        checkAuth: (signal) => {
          probeSignal = signal;
          return new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error(secret)), PROBE_TIMEOUT_MS + 1),
          );
        },
        getAvailable: forever,
      },
    ]);

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 0);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const resolved = await snapshot;

    expect(providersById(resolved.providers).hung?.state).toBe("unavailable");
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    expect(probeSignal?.aborted).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain(secret);
    await vi.advanceTimersByTimeAsync(1);
  });
});

describe("inspectPiModelAccess abort", () => {
  it("cancels an in-flight probe and throws, rather than returning a degraded snapshot", async () => {
    const controller = new AbortController();
    let probeSignal: AbortSignal | undefined;
    const models = fakeModels([
      {
        provider: provider("a"),
        checkAuth: (signal) => {
          probeSignal = signal;
          return rejectOnAbort(signal);
        },
        getAvailable: rejectOnAbort,
      },
    ]);

    const snapshot = inspectPiModelAccess({ models, credentials: null }, () => 0, {
      signal: controller.signal,
    });
    await flush();
    expect(probeSignal).toBeInstanceOf(AbortSignal);
    expect(probeSignal?.aborted).toBe(false);
    controller.abort();

    await expect(snapshot).rejects.toThrow(/abort/i);
    // The caller's cancellation reached the in-flight probe, not just a wrapper.
    expect(probeSignal?.aborted).toBe(true);
  });
});

describe("inspectPiModelAccess catalog sizes", () => {
  it("floors a usable context window and omits a missing or zero one", async () => {
    // Pi types `contextWindow` as required, but a gateway entry can still carry
    // 0 or garbage; "no window" must stay distinguishable from a zero-token one.
    const known = [
      model("sized", "windowed", 200_000.5),
      model("sized", "zero", 0),
      model("sized", "unsized"),
    ];
    const models = fakeModels([
      {
        provider: provider("sized"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => known,
        known,
      },
    ]);

    const resolved = await inspectPiModelAccess({ models, credentials: null }, () => 0);
    const byId = Object.fromEntries(resolved.models.map((entry) => [entry.modelId, entry]));

    expect(byId.windowed?.contextWindow).toBe(200_000);
    expect(byId.zero?.contextWindow).toBeUndefined();
    expect(byId.unsized?.contextWindow).toBeUndefined();
  });
});

describe("inspectPiModelAccess stored credentials", () => {
  it("marks a provider whose credential the store lists, alongside concurrent probes", async () => {
    const credentials = {
      list: async () => [{ providerId: "kept", type: "oauth" as const }],
    } as unknown as CredentialStore;
    const models = fakeModels([
      {
        provider: provider("kept"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [],
      },
      {
        provider: provider("none"),
        checkAuth: async () => undefined,
        getAvailable: async () => [],
      },
    ]);

    const resolved = await inspectPiModelAccess({ models, credentials }, () => 0);
    const byId = providersById(resolved.providers);

    expect(byId.kept?.hasStoredCredential).toBe(true);
    expect(byId.none?.hasStoredCredential).toBe(false);
  });
});
