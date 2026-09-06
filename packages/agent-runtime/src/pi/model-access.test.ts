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

import { inspectPiModelAccess, PROBE_TIMEOUT_MS, type UsageLimitsSource } from "./model-access";
import type { RefreshableCatalogs } from "./model-catalog";
import { UsageLimitsHolder } from "./usage-limits/holder";
import { UsageProbeSchedule } from "./usage-limits/probe";

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

function model(
  providerId: string,
  id: string,
  contextWindow?: number,
  input?: readonly ("text" | "image")[],
): Model<Api> {
  return {
    id,
    name: id,
    provider: providerId,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(input === undefined ? {} : { input }),
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

function catalogs(
  refresh: RefreshableCatalogs["refresh"],
  providerIds: readonly string[] = [],
): RefreshableCatalogs {
  return {
    providerIds,
    restore: async () => ({
      aborted: false,
      errors: new Map(),
      rejectedByProvider: new Map(),
      refreshedProviderIds: [],
    }),
    refresh,
  };
}

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

describe("inspectPiModelAccess public/native refresh phases", () => {
  it("probes each provider once across the preflight and the snapshot", async () => {
    // The preflight decides which feeds a refresh should reach; the snapshot
    // needs the same credential answer. A catalog refresh cannot change it, so
    // asking twice would only buy a second OAuth round-trip per provider.
    let checkAuth = 0;
    let getAvailable = 0;
    const models = fakeModels([
      {
        provider: provider("connected"),
        checkAuth: async () => {
          checkAuth++;
          return { type: "oauth" };
        },
        getAvailable: async () => {
          getAvailable++;
          return [model("connected", "m")];
        },
        known: [model("connected", "m")],
      },
    ]);

    const result = await inspectPiModelAccess(
      {
        models,
        credentials: null,
        catalogs: catalogs(
          async () => ({
            aborted: false,
            errors: new Map(),
            rejectedByProvider: new Map([["connected", 0]]),
            refreshedProviderIds: ["connected"],
          }),
          ["connected"],
        ),
      },
      () => 0,
      { refresh: true },
    );

    expect({ checkAuth, getAvailable }).toEqual({ checkAuth: 1, getAvailable: 1 });
    expect(providersById(result.providers).connected?.state).toBe("available");
  });

  it("carries a preflight credential failure into the snapshot without re-asking", async () => {
    const secret = "sk-live-should-never-surface";
    let checkAuth = 0;
    const models = fakeModels([
      {
        provider: provider("broken"),
        checkAuth: async () => {
          checkAuth++;
          throw new Error(secret);
        },
        getAvailable: async () => [],
        known: [model("broken", "m")],
      },
    ]);

    const result = await inspectPiModelAccess(
      {
        models,
        credentials: null,
        catalogs: catalogs(
          async () => ({
            aborted: false,
            errors: new Map(),
            rejectedByProvider: new Map(),
            refreshedProviderIds: [],
          }),
          ["broken"],
        ),
      },
      () => 0,
      { refresh: true },
    );

    expect(checkAuth).toBe(1);
    const broken = providersById(result.providers).broken;
    expect(broken?.state).toBe("unavailable");
    expect(broken?.recovery).toEqual({ kind: "retry" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("treats a preflight that times out as a provider it cannot reach", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => ({
      aborted: false,
      errors: new Map<string, Error>(),
      rejectedByProvider: new Map<string, number>(),
      refreshedProviderIds: [] as readonly string[],
    }));
    const models = fakeModels([
      { provider: provider("hung"), checkAuth: forever, getAvailable: forever },
    ]);

    const snapshot = inspectPiModelAccess(
      { models, credentials: null, catalogs: catalogs(refresh, ["hung"]) },
      () => 0,
      { refresh: true },
    );
    // Two bounds in sequence: the preflight's, then the snapshot probe's.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const resolved = await snapshot;

    // No credential resolved, so no public feed was asked for on its behalf.
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }));
    const hung = providersById(resolved.providers).hung;
    expect(hung?.state).toBe("unavailable");
    expect(hung?.recovery).toEqual({ kind: "retry" });
  });

  it("honors cancellation reported by the credential-independent public phase", async () => {
    const models = fakeModels([
      {
        provider: provider("connected"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [model("connected", "m")],
      },
    ]);

    await expect(
      inspectPiModelAccess(
        {
          models,
          credentials: null,
          catalogs: catalogs(
            async () => ({
              aborted: true,
              errors: new Map(),
              rejectedByProvider: new Map(),
              refreshedProviderIds: [],
            }),
            ["connected"],
          ),
        },
        () => 0,
        { refresh: true },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("runs connected native providers beside public catalogs and reports their success", async () => {
    const dynamic = {
      ...provider("native"),
      refreshModels: async () => undefined,
    } as Provider;
    const models = fakeModels([
      {
        provider: dynamic,
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [model("native", "m")],
        known: [model("native", "m")],
      },
    ]);
    const refresh = vi.spyOn(models, "refresh").mockResolvedValue({
      aborted: false,
      errors: new Map(),
    });

    const result = await inspectPiModelAccess(
      {
        models,
        credentials: null,
        catalogs: catalogs(async () => ({
          aborted: false,
          errors: new Map(),
          rejectedByProvider: new Map(),
          refreshedProviderIds: [],
        })),
      },
      () => 0,
      { refresh: true },
    );

    expect(refresh).toHaveBeenCalledWith({ force: true, providers: ["native"] });
    expect(result.refresh?.refreshedProviderIds).toEqual(["native"]);
  });

  it("honors cancellation reported by Pi's native phase", async () => {
    const dynamic = {
      ...provider("native"),
      refreshModels: async () => undefined,
    } as Provider;
    const models = fakeModels([
      {
        provider: dynamic,
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [],
      },
    ]);
    vi.spyOn(models, "refresh").mockResolvedValue({ aborted: true, errors: new Map() });

    await expect(
      inspectPiModelAccess(
        {
          models,
          credentials: null,
          catalogs: catalogs(async () => ({
            aborted: false,
            errors: new Map(),
            rejectedByProvider: new Map(),
            refreshedProviderIds: [],
          })),
        },
        () => 0,
        { refresh: true },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
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

  it("reports image input, and assumes it when the catalog does not say", async () => {
    // The attach affordance gates on this (VC-50). A model that genuinely lists
    // only text must read as false, but an entry with no `input` at all reads
    // as true: an attachment a model cannot see still materializes into the
    // workspace and is still named in the brief by path, so guessing "yes"
    // degrades to a file reference while guessing "no" removes the affordance.
    const known = [
      model("vision", "sees", undefined, ["text", "image"]),
      model("vision", "text-only", undefined, ["text"]),
      model("vision", "unstated"),
    ];
    const models = fakeModels([
      {
        provider: provider("vision"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => known,
        known,
      },
    ]);

    const resolved = await inspectPiModelAccess({ models, credentials: null }, () => 0);
    const byId = Object.fromEntries(resolved.models.map((entry) => [entry.modelId, entry]));

    expect(byId.sees?.acceptsImageInput).toBe(true);
    expect(byId["text-only"]?.acceptsImageInput).toBe(false);
    expect(byId.unstated?.acceptsImageInput).toBe(true);
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

/** A fetch that records every URL it was asked and answers from a script. */
function usageSource(
  answer: (url: string) => Response | Promise<Response>,
): UsageLimitsSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    holder: new UsageLimitsHolder(),
    schedule: new UsageProbeSchedule(),
    calls,
    fetch: async (url) => {
      calls.push(url);
      return answer(url);
    },
  };
}

const usageJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe("inspectPiModelAccess usage limits", () => {
  const ANTHROPIC_BODY = {
    five_hour: { utilization: 37, resets_at: "2026-03-01T14:00:00Z" },
    seven_day: { utilization: 4, resets_at: "2026-03-05T09:30:00Z" },
  };

  /** The scripted collection plus `getAuth`, which only the usage probe calls. */
  function modelsWithAuth(specs: readonly Spec[], token: string | undefined): Models {
    const base = fakeModels(specs);
    return Object.assign(base, {
      getAuth: async () => (token === undefined ? undefined : { auth: { apiKey: token } }),
    }) as Models;
  }

  it("carries a subscribed account's windows on its provider row and nothing on the rest", async () => {
    const source = usageSource(() => usageJson(ANTHROPIC_BODY));
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => ({ type: "oauth" }),
          getAvailable: async () => [model("anthropic", "claude")],
        },
        {
          provider: provider("openai"),
          checkAuth: async () => ({ type: "api_key" }),
          getAvailable: async () => [model("openai", "gpt")],
        },
      ],
      "sk-ant-oat",
    );

    const resolved = await inspectPiModelAccess(
      { models, credentials: null, usageLimits: source },
      () => 42,
    );
    const byId = providersById(resolved.providers);

    expect(byId.anthropic?.usageLimits).toEqual({
      checkedAt: 42,
      windows: [
        expect.objectContaining({ id: "five_hour", usedPercent: 37 }),
        expect.objectContaining({ id: "seven_day", usedPercent: 4 }),
      ],
    });
    expect(byId.openai).not.toHaveProperty("usageLimits");
    expect(source.calls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
    expect(source.holder.get("anthropic")).toBe(byId.anthropic?.usageLimits);
  });

  it("reports an API-key account unsupported without asking the endpoint", async () => {
    const source = usageSource(() => usageJson(ANTHROPIC_BODY));
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => ({ type: "api_key" }),
          getAvailable: async () => [model("anthropic", "claude")],
        },
      ],
      "sk-ant-api",
    );

    const resolved = await inspectPiModelAccess(
      { models, credentials: null, usageLimits: source },
      () => 7,
    );

    expect(providersById(resolved.providers).anthropic?.usageLimits).toEqual({
      checkedAt: 7,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
    expect(source.calls).toEqual([]);
  });

  it("keeps the last good read when the endpoint fails, and shows the failure when there is none", async () => {
    let status = 200;
    const source = usageSource(() => usageJson(status === 200 ? ANTHROPIC_BODY : {}, status));
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => ({ type: "oauth" }),
          getAvailable: async () => [model("anthropic", "claude")],
        },
      ],
      "sk-ant-oat",
    );
    const inspect = (now: number, refresh = false) =>
      inspectPiModelAccess({ models, credentials: null, usageLimits: source }, () => now, {
        refresh,
      });

    status = 500;
    const failed = await inspect(1);
    expect(providersById(failed.providers).anthropic?.usageLimits).toEqual({
      checkedAt: 1,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });

    status = 200;
    const good = await inspect(2);
    const goodLimits = providersById(good.providers).anthropic?.usageLimits;
    expect(goodLimits?.windows).toHaveLength(2);

    status = 500;
    const failedAgain = await inspect(3, true);
    expect(providersById(failedAgain.providers).anthropic?.usageLimits).toBe(goodLimits);
    expect(source.calls).toHaveLength(3);
  });

  it("does not ask the endpoint again within the freshness hold unless refreshing", async () => {
    const source = usageSource(() => usageJson(ANTHROPIC_BODY));
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => ({ type: "oauth" }),
          getAvailable: async () => [model("anthropic", "claude")],
        },
      ],
      "sk-ant-oat",
    );
    const inspect = (now: number, refresh = false) =>
      inspectPiModelAccess({ models, credentials: null, usageLimits: source }, () => now, {
        refresh,
      });

    const first = await inspect(1_000);
    const second = await inspect(2_000);
    expect(source.calls).toHaveLength(1);
    expect(providersById(second.providers).anthropic?.usageLimits).toBe(
      providersById(first.providers).anthropic?.usageLimits,
    );
    await inspect(3_000, true);
    expect(source.calls).toHaveLength(2);
  });

  it("folds a hung endpoint as a failed probe under the same bound, leaving the provider available", async () => {
    vi.useFakeTimers();
    const source = usageSource(() => new Promise<Response>(() => {}));
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => ({ type: "oauth" }),
          getAvailable: async () => [model("anthropic", "claude")],
        },
      ],
      "sk-ant-oat",
    );

    const snapshot = inspectPiModelAccess(
      { models, credentials: null, usageLimits: source },
      () => 9,
    );
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const resolved = await snapshot;
    const anthropic = providersById(resolved.providers).anthropic;

    expect(anthropic?.state).toBe("available");
    expect(anthropic?.usageLimits).toEqual({
      checkedAt: 9,
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
  });

  it("clears a provider's held windows once it is signed out", async () => {
    const source = usageSource(() => usageJson(ANTHROPIC_BODY));
    source.holder.apply("anthropic", {
      observedAt: 0,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 50 }],
    });
    const models = modelsWithAuth(
      [
        {
          provider: provider("anthropic"),
          checkAuth: async () => undefined,
          getAvailable: async () => [],
        },
      ],
      undefined,
    );

    const resolved = await inspectPiModelAccess(
      { models, credentials: null, usageLimits: source },
      () => 0,
    );

    expect(providersById(resolved.providers).anthropic).not.toHaveProperty("usageLimits");
    expect(source.holder.get("anthropic")).toBeUndefined();
  });

  it("inspects exactly as before when no usage source is given", async () => {
    const models = fakeModels([
      {
        provider: provider("anthropic"),
        checkAuth: async () => ({ type: "oauth" }),
        getAvailable: async () => [model("anthropic", "claude")],
      },
    ]);
    const resolved = await inspectPiModelAccess({ models, credentials: null }, () => 0);
    expect(providersById(resolved.providers).anthropic).not.toHaveProperty("usageLimits");
  });
});
