import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  Credential,
  CredentialStore,
  Model,
  ModelsPublication,
  ModelsStore,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vite-plus/test";

import {
  type CatalogFetchResult,
  type CatalogSource,
  attachRefreshableCatalog,
  piDevCatalogSource,
  CatalogSourceAbsent,
  PiFileModelsStore,
  supersededModelId,
  withRefreshableCatalog,
} from "./model-catalog";
import { providerSignInMethods } from "./sign-in";

// --- fixtures --------------------------------------------------------------
//
// Nothing here reaches a network. Providers are the handful of members the
// wrapper touches plus throwing streams; the one test that runs pi's real
// refresh machinery does so through `createModels` with a scripted credential
// store and a scripted catalog source.
//
// One test is a deliberate exception to the "no real providers" half: the wire
// test builds pi's real `openai` provider and drives `streamSimple` through an
// injected `fetch` that captures the payload and fails the request. Asserting a
// `thinkingLevelMap` proves what this module stored; only pi's own request
// builder proves what that map makes it send, which is the thing the ticket is
// actually about.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-catalog-"));
}

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...overrides,
  } as Model<Api>;
}

const notStreamed = (): never => {
  throw new Error("streaming is not under test");
};

function baseProvider(id: string, models: readonly Model<Api>[]): Provider {
  return {
    id,
    name: `${id} display name`,
    baseUrl: "https://example.test",
    auth: {
      apiKey: {
        name: `${id} API key`,
        login: async () => ({ type: "api_key", key: "k" }),
        resolve: async () => ({ auth: { apiKey: "k" }, source: "scripted" }),
      },
      oauth: {
        name: `${id} (OAuth)`,
        isSubscription: true,
        login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
        refresh: async (credential: unknown) => credential,
        toAuth: async () => ({}),
      },
    },
    getModels: () => models,
    filterModels: (list: readonly Model<Api>[]) => list,
    stream: notStreamed,
    streamSimple: notStreamed,
    fetchDeferred: notStreamed,
    cancelDeferred: async () => {},
  } as unknown as Provider;
}

function scriptedSource(
  result: CatalogFetchResult,
): CatalogSource & { calls: { providerId: string; baseline: readonly Model<Api>[] }[] } {
  const calls: { providerId: string; baseline: readonly Model<Api>[] }[] = [];
  return {
    calls,
    fetchCatalog: async (providerId, baseline) => {
      calls.push({ providerId, baseline });
      return result;
    },
  };
}

function failingSource(): CatalogSource {
  return {
    fetchCatalog: async () => {
      throw new Error("no catalog today");
    },
  };
}

/** A publish that applies updates immediately, the way pi's own does on success. */
function refreshContext(overrides: Partial<RefreshModelsContext> = {}): {
  context: RefreshModelsContext;
  publications: ModelsPublication[];
} {
  const publications: ModelsPublication[] = [];
  const context: RefreshModelsContext = {
    publish: async (publication) => {
      publications.push(publication);
      publication.update?.();
      return true;
    },
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { context, publications };
}

function credentialStore(providerId: string): CredentialStore {
  return {
    read: async () => ({ type: "api_key", key: "k" }),
    list: async () => [{ providerId, type: "api_key" }],
    modify: async (
      _id: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ) => fn({ type: "api_key", key: "k" }),
    delete: async () => {},
  } as unknown as CredentialStore;
}

const signal = (): AbortSignal => new AbortController().signal;

const ownRefresh = async (): Promise<void> => {};

// --- the wrapper -----------------------------------------------------------

describe("withRefreshableCatalog", () => {
  const baseline = [model("acme", "acme-1"), model("acme", "acme-2")];

  it("delegates everything but the catalog by reference", () => {
    const base = baseProvider("acme", baseline);
    const wrapped = withRefreshableCatalog(base, scriptedSource({ models: [] }));
    // Spread, not enumeration: the fields pi added in 0.84.0 ride along, and
    // auth is the very same object, lazy OAuth loader included.
    expect(wrapped.auth).toBe(base.auth);
    expect(wrapped.stream).toBe(base.stream);
    expect(wrapped.streamSimple).toBe(base.streamSimple);
    expect(wrapped.filterModels).toBe(base.filterModels);
    expect(wrapped.fetchDeferred).toBe(base.fetchDeferred);
    expect(wrapped.cancelDeferred).toBe(base.cancelDeferred);
    expect(wrapped.id).toBe(base.id);
    expect(wrapped.name).toBe(base.name);
    expect(wrapped.baseUrl).toBe(base.baseUrl);
  });

  it("offers exactly the sign-in methods the base provider offers", () => {
    const base = baseProvider("acme", baseline);
    const wrapped = withRefreshableCatalog(base, scriptedSource({ models: [] }));
    expect(providerSignInMethods(wrapped)).toEqual(providerSignInMethods(base));
  });

  it("replaces the static baseline with a fetched complete list", async () => {
    const replaced = model("acme", "acme-2", { name: "Acme 2 (updated)" });
    const added = model("acme", "acme-3");
    const wrapped = withRefreshableCatalog(
      baseProvider("acme", baseline),
      scriptedSource({ models: [replaced, added] }),
    );
    expect(wrapped.getModels()).toEqual(baseline);

    const { context } = refreshContext();
    await wrapped.refreshModels?.(context);
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["acme-2", "acme-3"]);
    expect(wrapped.getModels()[0]?.name).toBe("Acme 2 (updated)");
  });

  it("hides an exact stale alias whenever its canonical id is present", async () => {
    const alias = model("opencode-go", "ox-alpha-free");
    const canonical = model("opencode-go", "glm-5.3-flash");
    const wrapped = withRefreshableCatalog(
      baseProvider("opencode-go", [alias]),
      scriptedSource({ models: [canonical] }),
    );

    await wrapped.refreshModels?.(refreshContext().context);

    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["glm-5.3-flash"]);
  });

  it("keeps an exact alias while its canonical id is absent", () => {
    const alias = model("opencode-go", "ox-alpha-free");
    const wrapped = withRefreshableCatalog(
      baseProvider("opencode-go", [alias]),
      scriptedSource({ models: [] }),
    );

    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["ox-alpha-free"]);
  });

  it("hands the source its own provider id and static baseline", async () => {
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    await wrapped.refreshModels?.(refreshContext().context);
    expect(source.calls).toEqual([{ providerId: "acme", baseline }]);
  });

  it("migrates a legacy overlay without treating it as a complete list", async () => {
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const stored = {
      models: [
        model("acme", "acme-2", { name: "Acme 2 cached" }),
        { ...model("acme", "unpinned-addition"), __volliProtocolAdmission: 1 } as Model<Api>,
        model("other", "not-ours"),
      ],
      checkedAt: 1,
    };
    const { context } = refreshContext({ stored, allowNetwork: false, force: undefined });
    await wrapped.refreshModels?.(context);

    expect(wrapped.getModels().map((entry) => [entry.id, entry.name])).toEqual([
      ["acme-1", "acme-1"],
      ["acme-2", "Acme 2 cached"],
    ]);
    expect(source.calls).toHaveLength(0);
  });

  it("refuses to restore a model another admission policy let in", async () => {
    // VC-135 admitted refreshed-only models by inferring a protocol class from
    // models.dev; VC-255 admits them by reading pi.dev. A cache written under
    // the older policy is not evidence for the newer one, so the entry does not
    // come back — it is re-fetched, or it is gone.
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const cached = (admission: number): Model<Api> =>
      ({
        ...model("acme", `admitted-under-${admission}`),
        __volliProtocolAdmission: admission,
      }) as Model<Api>;
    const { context } = refreshContext({
      stored: {
        models: [cached(1), cached(2), cached(99)],
        __volliCatalogFormat: 2,
        checkedAt: 1,
      } as never,
      allowNetwork: false,
      force: undefined,
    });
    await wrapped.refreshModels?.(context);

    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["admitted-under-2"]);
  });

  it("rebases cached facts onto the current baseline protocol after a Pi change", async () => {
    const current = model("acme", "acme-2", {
      api: "anthropic-messages",
      baseUrl: "https://current.example/v2",
      reasoning: true,
      compat: { supportsToolChoice: true },
      thinkingLevelMap: { off: null, high: "HIGH" },
      headers: { "x-current": "yes" },
      samplingParams: { temperature: 0.2 },
    } as Partial<Model<Api>>);
    const cached = model("acme", "acme-2", {
      name: "Cached name",
      cost: { input: 9, output: 10, cacheRead: 1, cacheWrite: 2 },
      api: "openai-completions",
      baseUrl: "https://stale.example/v1",
      reasoning: false,
      compat: { supportsStore: false },
      thinkingLevelMap: { low: "low" },
      headers: { "x-stale": "yes" },
      samplingParams: { temperature: 1 },
    } as Partial<Model<Api>>);
    const wrapped = withRefreshableCatalog(
      baseProvider("acme", [current]),
      scriptedSource({ models: [] }),
    );

    await wrapped.refreshModels?.(
      refreshContext({
        stored: { models: [cached] },
        allowNetwork: false,
        force: undefined,
      }).context,
    );

    expect(wrapped.getModels()[0]).toEqual({
      ...current,
      name: "Cached name",
      cost: { input: 9, output: 10, cacheRead: 1, cacheWrite: 2 },
    });
  });

  it("drops every malformed persisted fact shape and restores a valid tiered one", async () => {
    const validCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
    const validTier = {
      input: 2,
      output: 4,
      cacheRead: 0.2,
      cacheWrite: 0.3,
      inputTokensAbove: 10_000,
    };
    const cached = (id: string, overrides: Record<string, unknown>): Model<Api> =>
      ({ ...model("acme", id), ...overrides }) as Model<Api>;
    const invalidCosts: unknown[] = [
      null,
      { output: 2, cacheRead: 0.1, cacheWrite: 0 },
      { input: 1, cacheRead: 0.1, cacheWrite: 0 },
      { input: 1, output: 2, cacheWrite: 0 },
      { input: 1, output: 2, cacheRead: 0.1 },
      { ...validCost, tiers: "not an array" },
      { ...validCost, tiers: ["not an object"] },
      { ...validCost, tiers: [{ ...validTier, input: undefined }] },
      { ...validCost, tiers: [{ ...validTier, output: undefined }] },
      { ...validCost, tiers: [{ ...validTier, cacheRead: undefined }] },
      { ...validCost, tiers: [{ ...validTier, cacheWrite: undefined }] },
      { ...validCost, tiers: [{ ...validTier, inputTokensAbove: undefined }] },
    ];
    const valid = model("acme", "valid", { cost: { ...validCost, tiers: [validTier] } });
    const storedModels = [
      cached("", {}),
      cached("bad-name", { name: "" }),
      cached("bad-input", { input: [] }),
      ...invalidCosts.map((cost, index) => cached(`bad-cost-${index}`, { cost })),
      cached("bad-context", { contextWindow: 0 }),
      cached("bad-output", { maxTokens: 0 }),
      valid,
    ];
    const wrapped = withRefreshableCatalog(
      baseProvider("acme", [valid]),
      scriptedSource({ models: [] }),
    );

    await wrapped.refreshModels?.(
      refreshContext({
        stored: { models: storedModels },
        allowNetwork: false,
        force: undefined,
      }).context,
    );

    expect(wrapped.getModels()).toEqual([valid]);
  });

  it("restores refreshed-only protocol only when every cached field remains safe", async () => {
    const restore = async (overrides: Record<string, unknown>): Promise<readonly Model<Api>[]> => {
      const wrapped = withRefreshableCatalog(
        baseProvider("acme", [model("acme", "baseline")]),
        scriptedSource({ models: [] }),
      );
      const cached = {
        ...model("acme", "pipeline"),
        __volliProtocolAdmission: 2,
        ...overrides,
      } as Model<Api>;
      await wrapped.refreshModels?.(
        refreshContext({
          stored: {
            models: [cached],
            __volliCatalogFormat: 2,
          } as never,
          allowNetwork: false,
          force: undefined,
        }).context,
      );
      return wrapped.getModels();
    };

    const invalid: Record<string, unknown>[] = [
      { api: "" },
      // The redirection guard, re-applied at restore: a cache is a file that
      // outlives the fetch that filled it, and a bump can retire the origin an
      // entry was admitted against.
      { api: "anthropic-messages" },
      { baseUrl: "https://elsewhere.test/v1" },
      { baseUrl: "https://user:pass@example.test/v1" },
      { baseUrl: "" },
      { baseUrl: 7 },
      { reasoning: "yes" },
      { compat: [] },
      { headers: { bad: 1 } },
      { samplingParams: [] },
      { thinkingLevelMap: [] },
      { thinkingLevelMap: { low: 1 } },
    ];
    for (const protocol of invalid) expect(await restore(protocol)).toEqual([]);
    await expect(restore({ thinkingLevelMap: undefined })).resolves.toEqual([
      expect.objectContaining({ id: "pipeline" }),
    ]);

    await expect(
      restore({
        compat: {},
        headers: { "x-string": "yes", "x-null": null },
        samplingParams: {},
        thinkingLevelMap: { off: null, low: "low" },
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "pipeline" })]);
  });

  it("restores a cached model whose provider defers its baseUrl to runtime", async () => {
    // Azure again, on the other side of a restart. `baseUrl: ""` is what every
    // `azure-openai-responses` model ships, so reading it as a missing URL let
    // Astra refresh in and then vanish on the next launch — admitted on Monday,
    // gone on Tuesday, with nothing to point at.
    const azure = model("azure-openai-responses", "baseline", {
      api: "azure-openai-responses",
      baseUrl: "",
    } as Partial<Model<Api>>);
    const wrapped = withRefreshableCatalog(
      baseProvider("azure-openai-responses", [azure]),
      scriptedSource({ models: [] }),
    );
    const cached = {
      ...model("azure-openai-responses", "gpt-6-astra", {
        api: "azure-openai-responses",
        baseUrl: "",
      } as Partial<Model<Api>>),
      __volliProtocolAdmission: 2,
    } as Model<Api>;
    await wrapped.refreshModels?.(
      refreshContext({
        stored: { models: [azure, cached], __volliCatalogFormat: 2 } as never,
        allowNetwork: false,
        force: undefined,
      }).context,
    );

    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["baseline", "gpt-6-astra"]);
  });

  it("stops after a superseded publish rather than fetching for a dead generation", async () => {
    const source = scriptedSource({ models: [model("acme", "acme-3")] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const { context } = refreshContext({
      stored: { models: [], checkedAt: 1 },
      publish: async () => false,
    });
    await wrapped.refreshModels?.(context);
    expect(source.calls).toHaveLength(0);
    expect(wrapped.getModels()).toEqual(baseline);
  });

  it("persists the overlay with a freshness stamp and the response validators", async () => {
    const added = model("acme", "acme-3");
    const wrapped = withRefreshableCatalog(
      baseProvider("acme", baseline),
      scriptedSource({ models: [added], etag: '"v1"', lastModified: 123 }),
      { now: () => 9_000 },
    );
    const { context, publications } = refreshContext();
    await wrapped.refreshModels?.(context);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.persist).toEqual({
      models: [{ ...added, __volliProtocolAdmission: 2 }],
      checkedAt: 9_000,
      etag: '"v1"',
      lastModified: 123,
      __volliCatalogFormat: 2,
    });
  });

  it("trusts a fresh persisted catalog unless the refresh is forced", async () => {
    const source = scriptedSource({ models: [model("acme", "acme-3")] });
    let at = 1_000_000;
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source, {
      now: () => at,
    });
    const stored = { models: [], checkedAt: at - 1_000 };

    await wrapped.refreshModels?.(refreshContext({ stored, force: undefined }).context);
    expect(source.calls).toHaveLength(0);

    await wrapped.refreshModels?.(refreshContext({ stored, force: true }).context);
    expect(source.calls).toHaveLength(1);

    at += 2 * 60 * 60 * 1000; // stale now
    await wrapped.refreshModels?.(refreshContext({ stored, force: undefined }).context);
    expect(source.calls).toHaveLength(2);
  });

  it("does not publish a fetch superseded while it was in flight", async () => {
    const controller = new AbortController();
    const source: CatalogSource = {
      fetchCatalog: async () => {
        controller.abort();
        return { models: [model("acme", "acme-3")] };
      },
    };
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const { context, publications } = refreshContext({ signal: controller.signal });

    await wrapped.refreshModels?.(context);

    expect(publications).toEqual([]);
    expect(wrapped.getModels()).toEqual(baseline);
  });

  it("keeps the previous catalog when the source fails", async () => {
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), failingSource());
    await expect(wrapped.refreshModels?.(refreshContext().context)).rejects.toThrow(
      /no catalog today/,
    );
    expect(wrapped.getModels()).toEqual(baseline);
  });
});

describe("supersededModelId", () => {
  it("tells stored preferences where a renamed model went, and only that", () => {
    // The same table that hides the stale alias from the picker is what lets a
    // default naming it survive the rename instead of being cleared.
    expect(supersededModelId("opencode-go", "ox-alpha-free")).toBe("glm-5.3-flash");
    expect(supersededModelId("opencode-go", "glm-5.3")).toBeUndefined();
    expect(supersededModelId("anthropic", "ox-alpha-free")).toBeUndefined();
  });
});

describe("a provider the source does not carry", () => {
  it("keeps pi's catalog and reports neither success nor failure", async () => {
    // models.dev has no `openai-codex` provider at all. Before this, every
    // refresh recorded a provider error for it and Model Access offered a
    // Retry that could never work.
    const models = createModels();
    const baseline = [model("openai-codex", "gpt-5.6-sol")];
    models.setProvider(baseProvider("openai-codex", baseline));
    const catalogs = attachRefreshableCatalog(models, {
      fetchCatalog: async (providerId) => {
        throw new CatalogSourceAbsent(providerId);
      },
    });

    const result = await catalogs.refresh();

    expect(result.errors.size).toBe(0);
    expect(result.refreshedProviderIds).toEqual([]);
    expect(models.getProvider("openai-codex")?.getModels()).toEqual(baseline);
  });
});

describe("attachRefreshableCatalog", () => {
  it("wraps static providers and leaves dynamic ones their own refresh", () => {
    const models = createModels({ credentials: credentialStore("static") });
    models.setProvider(baseProvider("static", [model("static", "m-1")]));
    models.setProvider({
      ...baseProvider("dynamic", []),
      id: "dynamic",
      refreshModels: ownRefresh,
    } as Provider);
    attachRefreshableCatalog(models, scriptedSource({ models: [] }));
    expect(models.getProvider("static")?.refreshModels).toBeDefined();
    expect(models.getProvider("dynamic")?.refreshModels).toBe(ownRefresh);
  });

  it("returns immediately when its public refresh is already aborted", async () => {
    const models = createModels();
    models.setProvider(baseProvider("acme", [model("acme", "m-1")]));
    const catalogs = attachRefreshableCatalog(models, scriptedSource({ models: [] }));
    const controller = new AbortController();
    controller.abort();

    await expect(catalogs.refresh({ signal: controller.signal })).resolves.toEqual({
      aborted: true,
      errors: new Map(),
      rejectedByProvider: new Map(),
      refreshedProviderIds: [],
    });
  });

  it("refreshes only selected providers and restores every provider offline", async () => {
    const models = createModels();
    models.setProvider(baseProvider("a", [model("a", "a-1")]));
    models.setProvider(baseProvider("b", [model("b", "b-1")]));
    const source = scriptedSource({ models: [] });
    const catalogs = attachRefreshableCatalog(models, source);

    await catalogs.restore();
    expect(source.calls).toEqual([]);
    await catalogs.refresh({ providers: ["a"] });
    expect(source.calls.map((call) => call.providerId)).toEqual(["a"]);
  });

  it("normalizes a non-Error store failure and suppresses one caused by abort", async () => {
    const models = createModels();
    models.setProvider(baseProvider("acme", [model("acme", "m-1")]));
    const failingStore = {
      read: async () => Promise.reject("plain store failure"),
      write: async () => undefined,
      delete: async () => undefined,
    } as ModelsStore;
    const failed = attachRefreshableCatalog(models, scriptedSource({ models: [] }), {
      store: failingStore,
    });
    const result = await failed.refresh();
    expect(result.errors.get("acme")).toEqual(new Error("plain store failure"));

    const errorModels = createModels();
    errorModels.setProvider(baseProvider("acme", [model("acme", "m-1")]));
    const errorResult = await attachRefreshableCatalog(errorModels, failingSource()).refresh();
    expect(errorResult.errors.get("acme")).toEqual(new Error("no catalog today"));

    const controller = new AbortController();
    const abortedStore = {
      ...failingStore,
      read: async () => {
        controller.abort();
        throw new Error("aborted store read");
      },
    } as ModelsStore;
    const nextModels = createModels();
    nextModels.setProvider(baseProvider("acme", [model("acme", "m-1")]));
    const aborted = attachRefreshableCatalog(nextModels, scriptedSource({ models: [] }), {
      store: abortedStore,
    });
    await expect(aborted.refresh({ signal: controller.signal })).resolves.toMatchObject({
      aborted: true,
      errors: new Map(),
    });
  });
});

// --- the pi.dev feed -------------------------------------------------------
//
// Fixtures below marked "verbatim" are the bytes pi.dev really served on
// 2026-09-05, pasted unedited. They are the whole point of the ticket: if the
// admission rules are wrong about the real feed, every scripted test above can
// still pass. Refresh them from `https://pi.dev/api/models/providers/<id>` when
// the shape moves.

/** `https://pi.dev/api/models/providers/openai` → `gpt-6-astra`, verbatim. */
const ASTRA_OPENAI = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  provider: "openai",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
  },
  contextWindow: 272000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
  },
};

/** `https://pi.dev/api/models/providers/openai-codex` → `gpt-6-astra`, verbatim. */
const ASTRA_CODEX = {
  id: "gpt-6-astra",
  name: "GPT-6 Astra",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
  },
  contextWindow: 272000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
  },
};

/** pi 0.84.3's `openai` / `openai-codex` protocol, as a baseline stands in it. */
const OPENAI_BASELINE = model("openai", "gpt-5.6-sol", {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
  compat: { supportsStrictMode: true },
} as Partial<Model<Api>>);

const CODEX_BASELINE = model("openai-codex", "gpt-5.6-sol", {
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
  compat: { supportsOpenAIGrammarTools: true },
} as Partial<Model<Api>>);

/** A minimal well-formed feed entry, in pi's own `Model` spelling. */
function feedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Acme One",
    api: "openai-completions",
    provider: "acme",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...overrides,
  };
}

/** A source wired to one canned body, with the staleness rule switched off. */
function piDevSource(
  body: unknown,
  init: ResponseInit = {},
  overrides: Parameters<typeof piDevCatalogSource>[0] = {},
): CatalogSource & { requests: { url: string; headers: Headers }[] } {
  const requests: { url: string; headers: Headers }[] = [];
  const source = piDevCatalogSource({
    fetchFn: (async (url: string, init2?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init2?.headers) });
      return typeof body === "string" || body instanceof Response
        ? (body as Response)
        : new Response(JSON.stringify(body), { status: 200, ...init });
    }) as unknown as typeof fetch,
    builtinGeneratedAt: () => undefined,
    ...overrides,
  });
  return { ...source, requests };
}

/** The same, but the body is bytes the test wrote, not an object it stringified. */
function rawPiDevSource(body: string): CatalogSource {
  return piDevCatalogSource({
    builtinGeneratedAt: () => undefined,
    fetchFn: (async () => new Response(body, { status: 200 })) as typeof fetch,
  });
}

describe("piDevCatalogSource", () => {
  const acme = model("acme", "acme-1");

  it("admits GPT-6 Astra with pi.dev's protocol, not an inference from it", async () => {
    // The ticket's whole case, asserted on the bytes pi.dev really serves.
    // `off: null` is the one that matters: Astra's thinking cannot be turned
    // off, and every class-inference path this replaces reached that value —
    // when it reached it at all — by a coincidence between two catalogues.
    const source = piDevSource({ "gpt-6-astra": ASTRA_OPENAI });
    const result = await source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });

    const astra = result.models.find((entry) => entry.id === "gpt-6-astra");
    expect(astra?.thinkingLevelMap?.off).toBe(null);
    expect(astra?.thinkingLevelMap).toEqual(ASTRA_OPENAI.thinkingLevelMap);
    expect(astra?.cost).toEqual(ASTRA_OPENAI.cost);
    expect(astra?.contextWindow).toBe(272_000);
    expect(astra?.compat).toEqual(ASTRA_OPENAI.compat);
    expect(astra?.api).toBe("openai-responses");
    expect(result.rejected).toBe(0);
    // The baseline model the feed did not mention is still there.
    expect(result.models.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-6-astra"]);
  });

  it("puts Astra's real effort on the wire, and never turns its thinking off", async () => {
    // The end of the argument, run through pi's own request builder rather than
    // asserted about a field. pi reads `thinkingLevelMap.off`: `null` means the
    // rung does not exist, so an unset level sends no `reasoning` at all and the
    // API's own default (low) applies. A ladder inherited from the GPT-5.6
    // siblings says `off: "none"` instead, and then every unset-level request
    // tells a model whose thinking cannot be turned off to turn it off.
    const source = piDevSource({ "gpt-6-astra": ASTRA_OPENAI });
    const result = await source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });
    const astra = result.models.find((entry) => entry.id === "gpt-6-astra")!;

    // Offered levels come straight from the map: no `off`, no `minimal`.
    expect(getSupportedThinkingLevels(astra)).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const openai = builtinProviders().find((entry) => entry.id === "openai")!;
    const wire = async (candidate: Model<Api>, reasoning?: string): Promise<unknown> => {
      let body: Record<string, unknown> | undefined;
      const stream = openai.streamSimple(
        candidate,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {
          apiKey: "test-key",
          ...(reasoning === undefined ? {} : { reasoning }),
          fetch: (async (_url: string, init: RequestInit) => {
            body = JSON.parse(String(init.body)) as Record<string, unknown>;
            return new Response("", { status: 500 });
          }) as unknown as typeof fetch,
        } as never,
      );
      try {
        for await (const chunk of stream) void chunk;
      } catch {
        // The capture always fails the request; the payload is the assertion.
      }
      return body?.reasoning;
    };

    expect(await wire(astra, "xhigh")).toEqual({ effort: "xhigh", summary: "auto" });
    expect(await wire(astra, "max")).toEqual({ effort: "max", summary: "auto" });
    expect(await wire(astra)).toBeUndefined();

    const inherited = {
      ...astra,
      thinkingLevelMap: { ...astra.thinkingLevelMap, off: "none" },
    } as Model<Api>;
    expect(await wire(inherited)).toEqual({ effort: "none" });
  });

  it("admits Astra on openai-codex too, with the ChatGPT backend's own shape", async () => {
    // models.dev has never carried `openai-codex` at all, so this provider had
    // no path to a new model by any amount of class tuning.
    const source = piDevSource({ "gpt-6-astra": ASTRA_CODEX });
    const result = await source.fetchCatalog("openai-codex", [CODEX_BASELINE], {
      signal: signal(),
    });

    const astra = result.models.find((entry) => entry.id === "gpt-6-astra");
    expect(astra?.api).toBe("openai-codex-responses");
    expect(astra?.baseUrl).toBe("https://chatgpt.com/backend-api");
    // Codex maps `minimal` onto `low` where the API platform withholds it.
    expect(astra?.thinkingLevelMap?.minimal).toBe("low");
    expect(astra?.thinkingLevelMap?.off).toBe(null);
    expect(astra?.compat).toEqual(ASTRA_CODEX.compat);
  });

  it("asks one URL per provider, with the accept header and no validator yet", async () => {
    const source = piDevSource({ "acme-1": feedEntry() });
    await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(source.requests).toHaveLength(1);
    expect(source.requests[0]?.url).toBe("https://pi.dev/api/models/providers/acme");
    expect(source.requests[0]?.headers.get("accept")).toBe("application/json");
    expect(source.requests[0]?.headers.get("if-none-match")).toBe(null);
  });

  it("escapes a provider id rather than letting it shape the path", async () => {
    const source = piDevSource({});
    await source.fetchCatalog("../../evil", [acme], { signal: signal() }).catch(() => undefined);

    expect(source.requests[0]?.url).toBe("https://pi.dev/api/models/providers/..%2F..%2Fevil");
  });

  it("replaces a baseline model the feed restates, and keeps one it omits", async () => {
    const source = piDevSource({
      "acme-1": feedEntry({ name: "Acme One, repriced", cost: { input: 9, output: 9 } }),
    });
    const result = await source.fetchCatalog("acme", [acme, model("acme", "acme-2")], {
      signal: signal(),
    });

    expect(result.models.map((entry) => entry.id)).toEqual(["acme-1", "acme-2"]);
    // A cost missing `cacheRead`/`cacheWrite` is not a cost pi can bill with.
    expect(result.models[0]).toEqual(acme);
    expect(result.rejected).toBe(1);
  });

  it("carries a corrected price and a widened ladder onto a baseline model", async () => {
    const source = piDevSource({
      "acme-1": feedEntry({
        cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0 },
        thinkingLevelMap: { off: null, max: "max" },
      }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models[0]?.cost).toEqual({
      input: 0.5,
      output: 1,
      cacheRead: 0.05,
      cacheWrite: 0,
    });
    expect(result.models[0]?.thinkingLevelMap).toEqual({ off: null, max: "max" });
    expect(result.rejected).toBe(0);
  });

  it("preserves baseline order and appends new ids in feed order", async () => {
    const source = piDevSource({
      "acme-9": feedEntry({ name: "Nine" }),
      "acme-1": feedEntry(),
      "acme-7": feedEntry({ name: "Seven" }),
    });
    const result = await source.fetchCatalog("acme", [model("acme", "acme-2"), acme], {
      signal: signal(),
    });

    expect(result.models.map((entry) => entry.id)).toEqual([
      "acme-2",
      "acme-1",
      "acme-9",
      "acme-7",
    ]);
  });

  // --- the redirection guard ------------------------------------------------

  it("withholds an entry whose baseUrl origin is foreign to the provider", async () => {
    const source = piDevSource({
      "acme-1": feedEntry({ baseUrl: "https://evil.test/v1" }),
      "acme-new": feedEntry({ baseUrl: "https://evil.test/v1" }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    // The baseline model the feed tried to move is untouched, and the new model
    // it tried to serve from another host never exists.
    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(2);
  });

  it("withholds an entry whose api the provider's baseline does not speak", async () => {
    const source = piDevSource({ "acme-new": feedEntry({ api: "anthropic-messages" }) });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(1);
  });

  it("admits any api and origin the provider's own baseline already uses", async () => {
    // `opencode-go` really does serve three APIs across two origins, which is
    // why the guard compares against sets and not against one value.
    const baseline = [
      model("opencode-go", "grok-4.5", {
        api: "openai-responses",
        baseUrl: "https://opencode.ai/zen/go/v1",
      } as Partial<Model<Api>>),
      model("opencode-go", "hy3", {
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
      } as Partial<Model<Api>>),
      model("opencode-go", "claude-x", {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.test/v1",
      } as Partial<Model<Api>>),
    ];
    const source = piDevSource({
      "grok-4.6": feedEntry({
        provider: "opencode-go",
        api: "openai-responses",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
      "claude-y": feedEntry({
        provider: "opencode-go",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.test/v1",
      }),
      // The cross-product the guard does not authorize is not the point: both
      // halves are individually present in the baseline, so this is admitted,
      // and that is the honest limit of an origin/api guard.
      crossed: feedEntry({
        provider: "opencode-go",
        api: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/go/v1",
      }),
    });
    const result = await source.fetchCatalog("opencode-go", baseline, { signal: signal() });

    expect(result.models.map((entry) => entry.id)).toEqual([
      "grok-4.5",
      "hy3",
      "claude-x",
      "grok-4.6",
      "claude-y",
      "crossed",
    ]);
    expect(result.rejected).toBe(0);
  });

  it("admits an entry with no baseUrl where the baseline itself has none", async () => {
    // Measured against the live feed, and a bug until it was: every one of pi's
    // `azure-openai-responses` models ships `baseUrl: ""`, because an Azure
    // endpoint is a per-deployment resource configured at runtime. Reading that
    // as an unreadable URL rejected all 39 entries and left the provider
    // permanently unrefreshable.
    const azure = model("azure-openai-responses", "gpt-5.6-sol", {
      api: "azure-openai-responses",
      baseUrl: "",
    } as Partial<Model<Api>>);
    const source = piDevSource({
      "gpt-6-astra": feedEntry({
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        baseUrl: "",
      }),
      // Still guarded: an empty baseline baseUrl authorizes no real host.
      elsewhere: feedEntry({
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        baseUrl: "https://evil.test/v1",
      }),
    });
    const result = await source.fetchCatalog("azure-openai-responses", [azure], {
      signal: signal(),
    });

    expect(result.models.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-6-astra"]);
    expect(result.models[1]?.baseUrl).toBe("");
    expect(result.rejected).toBe(1);
  });

  it("does not let an empty feed baseUrl through a provider that has a real one", async () => {
    const source = piDevSource({ "acme-new": feedEntry({ baseUrl: "" }) });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(1);
  });

  it("refuses a baseUrl that smuggles credentials past an origin comparison", async () => {
    // `https://user:pass@example.test` has origin `https://example.test`, so an
    // origin comparison alone would admit it while putting an Authorization
    // header on the wire that the baseline never had.
    const source = piDevSource({
      "acme-new": feedEntry({ baseUrl: "https://user:pass@example.test/v1" }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(1);
  });

  it("refuses a port or scheme change on an origin it otherwise recognizes", async () => {
    const source = piDevSource({
      ported: feedEntry({ baseUrl: "https://example.test:8443/v1" }),
      plaintext: feedEntry({ baseUrl: "http://example.test/v1" }),
      relative: feedEntry({ baseUrl: "/v1" }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(3);
  });

  it("withholds an entry that claims a different provider or contradicts its id", async () => {
    const source = piDevSource({
      "acme-new": feedEntry({ provider: "other" }),
      "acme-other": feedEntry({ id: "something-else" }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(2);
  });

  // --- untrusted bytes ------------------------------------------------------

  it("skips a malformed entry without failing the provider around it", async () => {
    const source = piDevSource({
      "no-api": feedEntry({ api: undefined }),
      "no-reasoning": feedEntry({ reasoning: "yes" }),
      "no-window": feedEntry({ contextWindow: 0 }),
      "float-window": feedEntry({ contextWindow: 1.5 }),
      "no-tokens": feedEntry({ maxTokens: -1 }),
      "no-input": feedEntry({ input: ["video"] }),
      "input-not-array": feedEntry({ input: "text" }),
      "cost-not-a-number": feedEntry({
        cost: { input: "1", output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
      "cost-missing-a-rate": feedEntry({ cost: { input: 1, output: 2 } }),
      "bad-tier": feedEntry({
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ input: 1 }] },
      }),
      "not-an-object": 7,
      "null-entry": null,
      good: feedEntry({ name: "Good" }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models.map((entry) => entry.id)).toEqual(["acme-1", "good"]);
    expect(result.rejected).toBe(12);
  });

  it("builds a model field by field, so unknown keys never ride into runtime", async () => {
    const source = piDevSource({
      good: feedEntry({ name: "Good", family: "acme", releaseDate: "2026-09-03", weight: 3 }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(Object.keys(result.models[1]!).toSorted()).toEqual([
      "api",
      "baseUrl",
      "contextWindow",
      "cost",
      "id",
      "input",
      "maxTokens",
      "name",
      "provider",
      "reasoning",
    ]);
  });

  it("keeps a model priced with pi's own negative auto-router sentinel", async () => {
    // `openrouter/auto` really ships `input: -1000000` in pi's built-in catalog:
    // an auto-router costs whatever it routes to, and the catalog cannot say in
    // advance. Rejecting that withheld two models pi itself ships, and — through
    // the same validator on the restore path — dropped them on the next restart.
    const auto = model("openrouter", "openrouter/auto", {
      baseUrl: "https://openrouter.ai/api/v1",
      cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 },
    } as Partial<Model<Api>>);
    const source = piDevSource({
      "openrouter/auto": feedEntry({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 },
      }),
    });
    const result = await source.fetchCatalog("openrouter", [auto], { signal: signal() });

    expect(result.rejected).toBe(0);
    expect(result.models[0]?.cost.input).toBe(-1_000_000);
  });

  it("withholds an entry whose thinking ladder or headers are the wrong type", async () => {
    const source = piDevSource({
      "bad-ladder": feedEntry({ thinkingLevelMap: { low: 3 } }),
      "ladder-not-object": feedEntry({ thinkingLevelMap: ["low"] }),
      "bad-headers": feedEntry({ headers: { "x-a": null } }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(3);
  });

  it("withholds an entry carrying a prototype-shaped key, in any position", async () => {
    // Written as bytes on purpose. A JS object literal cannot express this:
    // `{ __proto__: x }` sets the prototype and leaves no own key behind, so a
    // fixture built the ordinary way would test nothing. `JSON.parse` does
    // create the own property, which is exactly why the check has to exist.
    const source = rawPiDevSource(
      JSON.stringify({
        "in-ladder": feedEntry({ thinkingLevelMap: {} }),
        "in-compat": feedEntry({ compat: { nested: {} } }),
      })
        .replace('"thinkingLevelMap":{}', '"thinkingLevelMap":{"__proto__":"low"}')
        .replace('"nested":{}', '"nested":{"__proto__":{"polluted":true}}'),
    );
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("carries an unknown thinking level rather than dropping the next rung", async () => {
    // Pi reads its ladder by known level name, so a level this build has not
    // heard of is inert — and an allowlist would have dropped `xhigh` on the
    // day it shipped, which is the failure this module exists to prevent.
    const source = piDevSource({
      "acme-new": feedEntry({ thinkingLevelMap: { low: "low", ultra: "ultra" } }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models[1]?.thinkingLevelMap).toEqual({ low: "low", ultra: "ultra" });
  });

  it("carries a compat flag this build has never heard of", async () => {
    const source = piDevSource({
      "acme-new": feedEntry({
        compat: { supportsStrictMode: true, supportsSomethingNew: true, order: ["a", "b"] },
      }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models[1]?.compat).toEqual({
      supportsStrictMode: true,
      supportsSomethingNew: true,
      order: ["a", "b"],
    });
  });

  it("withholds compat that is not bounded inert JSON", async () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const wide: Record<string, boolean> = {};
    for (let index = 0; index < 600; index += 1) wide[`k${index}`] = true;
    const source = piDevSource({
      "too-deep": feedEntry({ compat: deep }),
      "too-wide": feedEntry({ compat: wide }),
      "not-a-record": feedEntry({ compat: ["supportsStrictMode"] }),
      "sampling-not-a-record": feedEntry({ samplingParams: 4 }),
    });
    const result = await source.fetchCatalog("acme", [acme], { signal: signal() });

    expect(result.models).toEqual([acme]);
    expect(result.rejected).toBe(4);
  });

  it("bounds the entry count, the declared size and the buffered size", async () => {
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) many[`m${index}`] = feedEntry();
    await expect(
      piDevSource(many, {}, { maxProviderModels: 4 }).fetchCatalog("acme", [acme], {
        signal: signal(),
      }),
    ).rejects.toThrow("exceeds the model-count bound");

    await expect(
      piDevSource({ good: feedEntry() }, {}, { maxBodyBytes: 10 }).fetchCatalog("acme", [acme], {
        signal: signal(),
      }),
    ).rejects.toThrow("exceeds the readable size bound");

    const source = piDevCatalogSource({
      maxBodyBytes: 10,
      builtinGeneratedAt: () => undefined,
      fetchFn: (async () =>
        new Response("{}", { status: 200, headers: { "content-length": "999" } })) as typeof fetch,
    });
    await expect(source.fetchCatalog("acme", [acme], { signal: signal() })).rejects.toThrow(
      "exceeds the readable size bound",
    );
  });

  it("reports unreadable bytes without quoting one of them", async () => {
    const secret = "s3cret-token-in-the-body";
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => undefined,
      fetchFn: (async () => new Response(`{"a": ${secret}`, { status: 200 })) as typeof fetch,
    });

    await expect(source.fetchCatalog("acme", [acme], { signal: signal() })).rejects.toThrow(
      /is not readable JSON/,
    );
    await source.fetchCatalog("acme", [acme], { signal: signal() }).catch((error: unknown) => {
      expect(String(error)).not.toContain(secret);
    });
  });

  it("refuses a body whose root is not a model map", async () => {
    await expect(
      piDevSource([feedEntry()]).fetchCatalog("acme", [acme], { signal: signal() }),
    ).rejects.toThrow("is not a model map");
  });

  it("reports an HTTP failure by status and never by body", async () => {
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => undefined,
      fetchFn: (async () => new Response("upstream said secret", { status: 500 })) as typeof fetch,
    });

    await expect(source.fetchCatalog("acme", [acme], { signal: signal() })).rejects.toThrow(
      "HTTP 500 for provider acme",
    );
  });

  it("refuses to publish an empty list for a provider pi ships empty", async () => {
    await expect(piDevSource({}).fetchCatalog("acme", [], { signal: signal() })).rejects.toThrow(
      "would publish an empty list",
    );
  });

  // --- absence, freshness and revalidation ----------------------------------

  it("keeps a provider's baseline when the feed has no list for it", async () => {
    for (const status of [404, 501]) {
      const source = piDevCatalogSource({
        builtinGeneratedAt: () => undefined,
        fetchFn: (async () => new Response(null, { status })) as typeof fetch,
      });
      await expect(source.fetchCatalog("acme", [acme], { signal: signal() })).rejects.toThrow(
        CatalogSourceAbsent,
      );
    }
  });

  it("ignores a feed no newer than the built-in catalog", async () => {
    const generatedAt = Date.parse("2026-08-24T10:56:49.000Z");
    const stale = piDevSource(
      { "gpt-6-astra": ASTRA_OPENAI },
      { headers: { "last-modified": new Date(generatedAt - 1000).toUTCString() } },
      { builtinGeneratedAt: () => generatedAt },
    );
    await expect(
      stale.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() }),
    ).rejects.toThrow(CatalogSourceAbsent);

    // Equal is also not newer: a feed generated from the same snapshot as the
    // package cannot be evidence of anything the package lacks.
    const same = piDevSource(
      { "gpt-6-astra": ASTRA_OPENAI },
      { headers: { "last-modified": new Date(generatedAt).toUTCString() } },
      { builtinGeneratedAt: () => generatedAt },
    );
    await expect(
      same.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() }),
    ).rejects.toThrow(CatalogSourceAbsent);

    const fresh = piDevSource(
      { "gpt-6-astra": ASTRA_OPENAI },
      { headers: { "last-modified": new Date(generatedAt + 1000).toUTCString() } },
      { builtinGeneratedAt: () => generatedAt },
    );
    const result = await fresh.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });
    expect(result.models.map((entry) => entry.id)).toContain("gpt-6-astra");
    expect(result.lastModified).toBe(generatedAt + 1000);
  });

  it("reads a feed that states no age, and one this build cannot date", async () => {
    const undated = piDevSource(
      { "gpt-6-astra": ASTRA_OPENAI },
      {},
      { builtinGeneratedAt: () => Date.parse("2099-01-01T00:00:00Z") },
    );
    const result = await undated.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });
    expect(result.models.map((entry) => entry.id)).toContain("gpt-6-astra");
    expect(result.lastModified).toBeUndefined();

    const undatable = piDevSource(
      { "gpt-6-astra": ASTRA_OPENAI },
      { headers: { "last-modified": "not a date" } },
      { builtinGeneratedAt: () => Date.parse("2099-01-01T00:00:00Z") },
    );
    const undated2 = await undatable.fetchCatalog("openai", [OPENAI_BASELINE], {
      signal: signal(),
    });
    expect(undated2.lastModified).toBeUndefined();
    expect(undated2.models.map((entry) => entry.id)).toContain("gpt-6-astra");
  });

  it("revalidates with the stored etag and leaves the list intact on 304", async () => {
    let calls = 0;
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => undefined,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        calls += 1;
        const sent = new Headers(init?.headers).get("if-none-match");
        if (sent === '"v1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify({ "gpt-6-astra": ASTRA_OPENAI }), {
          status: 200,
          headers: { etag: '"v1"' },
        });
      }) as unknown as typeof fetch,
    });

    const first = await source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });
    expect(first.etag).toBe('"v1"');

    const second = await source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() });
    expect(calls).toBe(2);
    expect(second.etag).toBe('"v1"');
    expect(second.models).toEqual(first.models);
    expect(second.models.map((entry) => entry.id)).toContain("gpt-6-astra");
  });

  it("fails rather than guess when a 304 arrives with nothing cached", async () => {
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => undefined,
      fetchFn: (async () => new Response(null, { status: 304 })) as typeof fetch,
    });

    await expect(source.fetchCatalog("acme", [acme], { signal: signal() })).rejects.toThrow(
      "304 with nothing cached",
    );
  });

  it("never revalidates its way back to a feed the staleness rule rejected", async () => {
    // The cache backing `If-None-Match` only ever holds bodies that were
    // applied, so an ignored feed leaves no validator to revalidate against.
    const generatedAt = Date.parse("2026-08-24T10:56:49.000Z");
    let sentValidator: string | null = "unset";
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => generatedAt,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        sentValidator = new Headers(init?.headers).get("if-none-match");
        return new Response(JSON.stringify({ "gpt-6-astra": ASTRA_OPENAI }), {
          status: 200,
          headers: {
            etag: '"stale"',
            "last-modified": new Date(generatedAt - 1000).toUTCString(),
          },
        });
      }) as unknown as typeof fetch,
    });

    await expect(
      source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() }),
    ).rejects.toThrow(CatalogSourceAbsent);
    await expect(
      source.fetchCatalog("openai", [OPENAI_BASELINE], { signal: signal() }),
    ).rejects.toThrow(CatalogSourceAbsent);
    expect(sentValidator).toBe(null);
  });

  it("honors the caller's own abort signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("superseded"));
    const source = piDevCatalogSource({
      builtinGeneratedAt: () => undefined,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await expect(
      source.fetchCatalog("acme", [acme], { signal: controller.signal }),
    ).rejects.toThrow("superseded");
  });
});

describe("PiFileModelsStore", () => {
  const path = (): string => join(scratch(), "volli-models.json");

  it("round-trips an entry across store instances, which is what restart is", async () => {
    const file = path();
    const entry = {
      models: [model("acme", "acme-3")],
      checkedAt: 42,
      etag: '"v1"',
      lastModified: 7,
    };
    await new PiFileModelsStore(file).write("acme", entry);
    await expect(new PiFileModelsStore(file).read("acme")).resolves.toEqual(entry);
  });

  it("reads an absent file and an absent provider as nothing", async () => {
    const store = new PiFileModelsStore(path());
    await expect(store.read("acme")).resolves.toBeUndefined();
    await store.write("other", { models: [] });
    await expect(store.read("acme")).resolves.toBeUndefined();
  });

  it("treats an unreadable cache as empty and heals it on the next write", async () => {
    const file = path();
    writeFileSync(file, "{ not json", "utf8");
    const store = new PiFileModelsStore(file);
    await expect(store.read("acme")).resolves.toBeUndefined();
    await store.write("acme", { models: [model("acme", "m")] });
    await expect(new PiFileModelsStore(file).read("acme")).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "m" })],
    });
  });

  it("drops entries and list elements another shape wrote, keeping the readable rest", async () => {
    const file = path();
    writeFileSync(
      file,
      JSON.stringify({
        good: {
          models: [model("acme", "m"), "junk", { id: 1 }],
          checkedAt: "not a number",
          etag: 5,
        },
        bad: { models: "nope" },
        worse: 3,
      }),
      "utf8",
    );
    const store = new PiFileModelsStore(file);
    const good = await store.read("good");
    expect(good?.models.map((entry) => entry.id)).toEqual(["m"]);
    expect(good?.checkedAt).toBeUndefined();
    expect(good?.etag).toBeUndefined();
    await expect(store.read("bad")).resolves.toBeUndefined();
    await expect(store.read("worse")).resolves.toBeUndefined();
  });

  it("honors an already-aborted store operation and keeps the write queue usable", async () => {
    const store = new PiFileModelsStore(path());
    const controller = new AbortController();
    controller.abort();
    const failed = store.write("a", { models: [] }, { signal: controller.signal });
    const after = store.write("b", { models: [model("b", "m-b")] });

    await expect(failed).rejects.toThrow(/abort/i);
    await expect(after).resolves.toBeUndefined();
    await expect(store.read("b")).resolves.toBeDefined();
    await expect(store.read("b", { signal: controller.signal })).rejects.toThrow(/abort/i);
    await expect(store.delete("b", { signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  it("treats a JSON value that is not a provider map as an empty cache", async () => {
    const file = path();
    writeFileSync(file, "[]", "utf8");
    await expect(new PiFileModelsStore(file).read("acme")).resolves.toBeUndefined();
  });

  it("deletes one provider's entry and leaves the neighbors", async () => {
    const store = new PiFileModelsStore(path());
    await store.write("a", { models: [model("a", "m-a")] });
    await store.write("b", { models: [model("b", "m-b")] });
    await store.delete("a");
    await store.delete("a");
    await expect(store.read("a")).resolves.toBeUndefined();
    await expect(store.read("b")).resolves.toBeDefined();
  });

  it("serializes concurrent writes so neither drops the other's entry", async () => {
    const file = path();
    const store = new PiFileModelsStore(file);
    await Promise.all([
      store.write("a", { models: [model("a", "m-a")] }),
      store.write("b", { models: [model("b", "m-b")] }),
    ]);
    const reread = new PiFileModelsStore(file);
    await expect(reread.read("a")).resolves.toBeDefined();
    await expect(reread.read("b")).resolves.toBeDefined();
  });

  it("creates the parent directory the way a fresh profile needs", async () => {
    const file = join(scratch(), "deeper", "still", "volli-models.json");
    await new PiFileModelsStore(file).write("acme", { models: [] });
    await expect(new PiFileModelsStore(file).read("acme")).resolves.toEqual({ models: [] });
  });
});

// --- pi's real refresh machinery, end to end -------------------------------

describe("catalog refresh through pi's own Models", () => {
  it("fetches on force, persists, and the model survives a restart", async () => {
    const file = join(scratch(), "volli-models.json");
    // Baseline and addition share an origin, as a real provider's do: the
    // restore path re-applies the redirection guard, so a cached model pointing
    // somewhere the baseline never reaches does not come back.
    const base = baseProvider("opencode-go", [
      model("opencode-go", "ox-alpha-free", { baseUrl: "https://opencode.ai/zen/go/v1" }),
    ]);
    const added = model("opencode-go", "glm-5.3-flash", {
      name: "GLM-5.3-Flash",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
    });

    const first = createModels({
      credentials: credentialStore("opencode-go"),
      modelsStore: new PiFileModelsStore(file),
    });
    first.setProvider(withRefreshableCatalog(base, scriptedSource({ models: [added] })));
    const refreshed = await first.refresh({ force: true });
    expect([...refreshed.errors.keys()]).toEqual([]);
    expect(first.getModel("opencode-go", "glm-5.3-flash")?.name).toBe("GLM-5.3-Flash");
    expect(first.getModel("opencode-go", "ox-alpha-free")).toBeUndefined();

    // A new collection over the same file, with a source that must not be
    // needed: the restore phase alone brings the overlay back. This is the
    // ticket's own verification — what the ModelsStore exists for.
    const second = createModels({
      credentials: credentialStore("opencode-go"),
      modelsStore: new PiFileModelsStore(file),
    });
    second.setProvider(withRefreshableCatalog(base, failingSource()));
    const restored = await second.refresh({ allowNetwork: false });
    expect([...restored.errors.keys()]).toEqual([]);
    expect(second.getModel("opencode-go", "glm-5.3-flash")?.name).toBe("GLM-5.3-Flash");
    expect(second.getModel("opencode-go", "ox-alpha-free")).toBeUndefined();
  });

  it("surfaces a failing source as that one provider's refresh error", async () => {
    const models = createModels({
      credentials: credentialStore("acme"),
      modelsStore: new PiFileModelsStore(join(scratch(), "volli-models.json")),
    });
    models.setProvider(
      withRefreshableCatalog(baseProvider("acme", [model("acme", "acme-1")]), failingSource()),
    );
    const result = await models.refresh({ force: true });
    expect(result.errors.get("acme")?.message).toMatch(/no catalog today/);
    // The static catalog is untouched by the failure.
    expect(models.getModel("acme", "acme-1")).toBeDefined();
  });
});
