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
import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import {
  type CatalogFetchResult,
  type CatalogSource,
  attachRefreshableCatalog,
  modelsDevCatalogSource,
  modelsDevCatalogFacts,
  CatalogSourceAbsent,
  PiFileModelsStore,
  supersededModelId,
  withRefreshableCatalog,
} from "./model-catalog";
import { providerSignInMethods } from "./sign-in";

// --- fixtures --------------------------------------------------------------
//
// Nothing here reaches a network or pi-ai's real providers. Providers are the
// handful of members the wrapper touches plus throwing streams; the one test
// that runs pi's real refresh machinery does so through `createModels` with a
// scripted credential store and a scripted catalog source.

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

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
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
        __volliProtocolAdmission: 1,
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
      { baseUrl: "" },
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
      models: [{ ...added, __volliProtocolAdmission: 1 }],
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

// --- the models.dev mapping ------------------------------------------------

describe("modelsDevCatalogFacts", () => {
  const glm53 = model("opencode-go", "glm-5.3", {
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: { supportsStore: false, maxTokensField: "max_tokens" },
    thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
  } as Partial<Model<Api>>);

  const feedEntry = {
    name: "GLM-5.3-Flash",
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 131_072 },
    cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
  };

  it("maps a new model to facts and no executable protocol fields", () => {
    const [facts] = modelsDevCatalogFacts("opencode-go", [glm53], {
      "opencode-go": { models: { "glm-5.3-flash": feedEntry } },
    });

    expect(facts).toEqual({
      id: "glm-5.3-flash",
      name: "GLM-5.3-Flash",
      input: ["text", "image"],
      cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    });
    expect(facts).not.toHaveProperty("api");
    expect(facts).not.toHaveProperty("reasoning");
    expect(facts).not.toHaveProperty("thinkingLevelMap");
  });

  it("refreshes facts on a known model while ignoring executable assertions", () => {
    const [facts] = modelsDevCatalogFacts("opencode-go", [glm53], {
      "opencode-go": {
        models: {
          "glm-5.3": {
            name: "GLM-5.3 (renamed)",
            reasoning: false,
            tool_call: true,
            cost: { input: 0.7, output: 2.2, cache_read: 0.13 },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    });

    expect(facts?.name).toBe("GLM-5.3 (renamed)");
    expect(facts?.cost).toEqual({ input: 0.7, output: 2.2, cacheRead: 0.13, cacheWrite: 0 });
    expect(facts).not.toHaveProperty("reasoning");
  });

  it("detects a same-length input-modality change", () => {
    const [facts] = modelsDevCatalogFacts("opencode-go", [glm53], {
      "opencode-go": {
        models: {
          "glm-5.3": {
            tool_call: true,
            modalities: { input: ["image"], output: ["text"] },
          },
        },
      },
    });
    expect(facts?.input).toEqual(["image"]);
  });

  it("emits every known fact, falling back when the feed omits or leaves it empty", () => {
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": { models: { "glm-5.3": { name: "", tool_call: true } } },
      }),
    ).toEqual([
      {
        id: "glm-5.3",
        name: "glm-5.3",
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      },
    ]);
  });

  it("uses a new model id when the feed leaves its name empty", () => {
    const [facts] = modelsDevCatalogFacts("opencode-go", [], {
      "opencode-go": { models: { "glm-5.3-flash": { ...feedEntry, name: "" } } },
    });
    expect(facts?.name).toBe("glm-5.3-flash");
  });

  it("caps a provider slice before an untrusted feed can grow the overlay", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`model-${index}`, feedEntry]),
    );
    expect(
      modelsDevCatalogFacts("opencode-go", [], { "opencode-go": { models: entries } }),
    ).toHaveLength(1_000);
    // The same bound holds once retained baseline ids are appended, so a huge
    // feed cannot push the list past it by way of the retention pass either.
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], { "opencode-go": { models: entries } }),
    ).toHaveLength(1_000);
  });

  it("emits a known model whose facts agree because a refreshed list is complete", () => {
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": {
          models: {
            "glm-5.3": {
              name: "glm-5.3",
              reasoning: false,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 1_000_000, output: 131_072 },
              cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
            },
          },
        },
      }),
    ).toEqual([expect.objectContaining({ id: "glm-5.3" })]);
  });

  it("preserves an unchanged tiered price on a known model", () => {
    const tier = {
      input: 10,
      output: 45,
      cacheRead: 1,
      cacheWrite: 0,
      inputTokensAbove: 272_000,
    };
    const baseline = model("opencode-go", "tiered", {
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, tiers: [tier] },
    });
    expect(
      modelsDevCatalogFacts("opencode-go", [baseline], {
        "opencode-go": {
          models: {
            tiered: {
              tool_call: true,
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
                tiers: [
                  {
                    input: 10,
                    output: 45,
                    cache_read: 1,
                    tier: { type: "context", size: 272_000 },
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual([expect.objectContaining({ id: "tiered", cost: baseline.cost })]);
  });

  it("translates context pricing tiers and distrusts untranslatable ones", () => {
    const tiered = {
      ...feedEntry,
      cost: {
        input: 5,
        output: 30,
        cache_read: 0.5,
        tiers: [
          { input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272_000 } },
          { input: 20, output: 60, cache_write: 2, tier: { type: "context", size: 500_000 } },
        ],
      },
    };
    const [added] = modelsDevCatalogFacts("opencode-go", [], {
      "opencode-go": { models: { "glm-5.4": tiered } },
    });
    expect(added?.cost.tiers).toEqual([
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 0, inputTokensAbove: 272_000 },
      { input: 20, output: 60, cacheRead: 0, cacheWrite: 2, inputTokensAbove: 500_000 },
    ]);

    const invalidTiers: unknown[] = [
      "not an array",
      ["not an object"],
      [{ output: 45, tier: { type: "context", size: 1 } }],
      [{ input: 10, tier: { type: "context", size: 1 } }],
      [{ input: 10, output: 45, tier: "not an object" }],
      [{ input: 10, output: 45, tier: { type: "mystery", size: 1 } }],
      [{ input: 10, output: 45, tier: { type: "context" } }],
    ];
    for (const tiers of invalidTiers) {
      expect(
        modelsDevCatalogFacts("opencode-go", [], {
          "opencode-go": {
            models: { "glm-5.4": { ...feedEntry, cost: { input: 5, output: 30, tiers } } },
          },
        }),
      ).toEqual([]);
    }
  });

  it("keeps a baseline id whose row understates it, because Pi already vouched", () => {
    // models.dev is community-maintained. A row that says `tool_call: false`, or
    // omits the field, is a gap in the data — not evidence that a model Pi ships
    // and a person may have selected stopped being able to call tools.
    for (const understated of [{ tool_call: false }, { tool_call: undefined }]) {
      expect(
        modelsDevCatalogFacts("opencode-go", [glm53], {
          "opencode-go": { models: { "glm-5.3": { ...feedEntry, ...understated } } },
        }),
      ).toEqual([expect.objectContaining({ id: "glm-5.3" })]);
    }
  });

  it("keeps a baseline id the source has stopped listing", () => {
    // The feed may only take away what it gave. Measured against the live
    // catalogue, retiring pi ids on a feed omission costs three models that
    // work today, `openai/gpt-5-chat-latest` among them.
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": { models: { "something-else": feedEntry } },
      })
        .map((facts) => facts.id)
        .toSorted(),
    ).toEqual(["glm-5.3", "something-else"]);
  });

  it("withholds a new id the provider has already marked deprecated", () => {
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": {
          models: {
            "glm-5.3": feedEntry,
            "glm-5.4": { ...feedEntry, status: "deprecated" },
            "glm-5.5": { ...feedEntry, status: "beta" },
          },
        },
      }).map((facts) => facts.id),
    ).toEqual(["glm-5.3", "glm-5.5"]);
  });

  it("skips incomplete, non-text, and malformed new entries", () => {
    const cases = {
      "glm-5.4": { ...feedEntry, cost: "not an object" },
      "glm-5.5": { ...feedEntry, cost: { output: 1 } },
      "glm-5.6": { ...feedEntry, cost: { input: 1 } },
      "glm-5.7": { ...feedEntry, limit: "not an object" },
      "glm-5.8": { ...feedEntry, limit: { output: 1 } },
      "glm-5.9": { ...feedEntry, modalities: { output: ["text"] } },
      "glm-5.10": { ...feedEntry, modalities: { input: ["text"], output: ["video"] } },
      "glm-5.11": "not even an object",
      "glm-5.12": { ...feedEntry, modalities: "not an object" },
    };
    expect(modelsDevCatalogFacts("opencode-go", [], { "opencode-go": { models: cases } })).toEqual(
      [],
    );
  });

  it("yields no facts for providers or documents it cannot read", () => {
    expect(modelsDevCatalogFacts("acme", [model("acme", "m")], { other: { models: {} } })).toEqual(
      [],
    );
    expect(modelsDevCatalogFacts("acme", [model("acme", "m")], "garbage")).toEqual([]);
  });
});

// --- the shared fetch ------------------------------------------------------

describe("modelsDevCatalogSource", () => {
  const document = {
    a: {
      models: {
        "a-2": {
          name: "A2",
          family: "a",
          reasoning: false,
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 10, output: 5 },
          cost: { input: 1, output: 2 },
        },
      },
    },
    b: {
      models: {
        "b-2": {
          name: "B2",
          family: "b",
          reasoning: false,
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 10, output: 5 },
          cost: { input: 1, output: 2 },
        },
      },
    },
  };

  it("answers a whole concurrent refresh burst with one GET", async () => {
    let calls = 0;
    const gate = Promise.withResolvers<Response>();
    const source = modelsDevCatalogSource({
      fetchFn: (() => {
        calls++;
        return gate.promise;
      }) as typeof fetch,
    });
    const first = source.fetchCatalog("a", [model("a", "a-2")], { signal: signal() });
    const second = source.fetchCatalog("b", [model("b", "b-2")], { signal: signal() });
    gate.resolve(jsonResponse(document));
    const [forA, forB] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(forA.models.map((entry) => entry.id)).toEqual(["a-2"]);
    expect(forB.models.map((entry) => entry.id)).toEqual(["b-2"]);
  });

  it("refetches once the memo window has passed", async () => {
    let calls = 0;
    let at = 0;
    const source = modelsDevCatalogSource({
      fetchFn: (async () => {
        calls++;
        return jsonResponse(document);
      }) as typeof fetch,
      now: () => at,
    });
    await source.fetchCatalog("a", [], { signal: signal() });
    await source.fetchCatalog("a", [], { signal: signal() });
    expect(calls).toBe(1);
    at = 10_000;
    await source.fetchCatalog("a", [], { signal: signal() });
    expect(calls).toBe(2);
  });

  it("materializes a new id through an unambiguous provider protocol class", async () => {
    const classEntry = {
      family: "glm",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      tool_call: true,
      structured_output: true,
      temperature: true,
      interleaved: { field: "reasoning_content", enabled: true, marker: null },
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1_000_000, output: 131_072 },
      cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
    };
    const baseline = model("opencode-go", "glm-5.3", {
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
      },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              "glm-5.3": { ...classEntry, name: "GLM-5.3" },
              "glm-5.3-flash": { ...classEntry, name: "GLM-5.3-Flash" },
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("opencode-go", [baseline], { signal: signal() });

    expect(result.rejected).toBe(0);
    expect(result.models).toEqual([
      expect.objectContaining({ id: "glm-5.3" }),
      expect.objectContaining({
        id: "glm-5.3-flash",
        api: "openai-completions",
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoning: true,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      }),
    ]);
  });

  /** Pi carries the fallback target's own price, which is the giveaway: this is
   * one model's routing, not a shape the whole provider shares. */
  const FALLBACK_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it("never lends a sibling's per-model fallback routing to a new id", async () => {
    // `compat.allowedFallbackModels` names specific sibling models and carries
    // their prices. Pi's own type notes Anthropic rejects `fallbacks` for a
    // model with no permitted targets, so inheriting a neighbour's list would
    // build a request the upstream refuses. It is also the only thing telling
    // real `claude-opus-4-8` and `claude-opus-5` apart, so stripping it is what
    // lets that class stay unanimous and admit anything at all.
    const classEntry = {
      family: "claude",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      tool_call: true,
      temperature: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 8_000 },
      cost: { input: 1, output: 2 },
    };
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          acme: {
            models: {
              "opus-4-8": { ...classEntry, name: "Opus 4.8" },
              "opus-5": { ...classEntry, name: "Opus 5" },
              "opus-6-pipeline": { ...classEntry, name: "Opus 6" },
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog(
      "acme",
      [
        model("acme", "opus-4-8", {
          compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
        }),
        model("acme", "opus-5", {
          compat: {
            forceAdaptiveThinking: true,
            supportsStrictTools: true,
            allowedFallbackModels: [{ provider: "acme", model: "opus-4-8", cost: FALLBACK_COST }],
          },
        }),
      ],
      { signal: signal() },
    );

    // The two baseline models keep their own protocol untouched, including the
    // fallback list that belongs to `opus-5`.
    expect(result.models.find((entry) => entry.id === "opus-5")?.compat).toEqual({
      forceAdaptiveThinking: true,
      supportsStrictTools: true,
      allowedFallbackModels: [{ provider: "acme", model: "opus-4-8", cost: FALLBACK_COST }],
    });
    // The new id is admitted — the class was unanimous once the per-model fact
    // was set aside — and it carries no borrowed fallback routing.
    expect(result.models.find((entry) => entry.id === "opus-6-pipeline")?.compat).toEqual({
      forceAdaptiveThinking: true,
      supportsStrictTools: true,
    });
    expect(result.rejected).toBe(0);
  });

  it("drops compat entirely when stripping leaves a class nothing to say", async () => {
    const classEntry = {
      family: "claude",
      reasoning: true,
      tool_call: true,
      temperature: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 8_000 },
      cost: { input: 1, output: 2 },
    };
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          acme: {
            models: {
              "with-fallbacks": { ...classEntry, name: "With" },
              bare: { ...classEntry, name: "Bare" },
              pipeline: { ...classEntry, name: "Pipeline" },
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog(
      "acme",
      [
        model("acme", "with-fallbacks", {
          compat: {
            allowedFallbackModels: [{ provider: "acme", model: "bare", cost: FALLBACK_COST }],
          },
        }),
        // No `compat` at all: equal to its sibling once the per-model key goes.
        model("acme", "bare"),
      ],
      { signal: signal() },
    );

    const admitted = result.models.find((entry) => entry.id === "pipeline");
    expect(admitted).toBeDefined();
    expect(admitted?.compat).toBeUndefined();
  });

  it("rejects a new id when one provider capability class has conflicting Pi protocols", async () => {
    const classEntry = {
      family: "acme",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["high"] }],
      tool_call: true,
      temperature: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 8_000 },
      cost: { input: 1, output: 2 },
    };
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          acme: {
            models: {
              first: { ...classEntry, name: "First" },
              duplicate: { ...classEntry, name: "Duplicate" },
              second: { ...classEntry, name: "Second" },
              pipeline: { ...classEntry, name: "Pipeline" },
            },
          },
        })) as typeof fetch,
    });
    const result = await source.fetchCatalog(
      "acme",
      [
        model("acme", "first", { api: "openai-completions" }),
        model("acme", "duplicate", { api: "openai-completions" }),
        model("acme", "second", { api: "anthropic-messages" }),
      ],
      { signal: signal() },
    );

    expect(result.models.map((entry) => entry.id)).toEqual(["first", "duplicate", "second"]);
    expect(result.rejected).toBe(1);
  });

  it("rejects malformed or unmatched protocol capability classes", async () => {
    const valid = {
      name: "Stable",
      family: "acme",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["high"] }],
      tool_call: true,
      temperature: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 8_000 },
      cost: { input: 1, output: 2 },
    };
    const invalidCandidates: Record<string, unknown>[] = [
      { ...valid, family: undefined },
      { ...valid, reasoning: "yes" },
      { ...valid, reasoning_options: 7 },
      { ...valid, reasoning_options: "BAD_NUMBER" },
      { ...valid, reasoning_options: ["BAD_NUMBER"] },
      { ...valid, reasoning_options: { bad: "BAD_NUMBER" } },
      // A control this module cannot name is a control it cannot reason about.
      { ...valid, reasoning_options: [{ values: ["high"] }] },
      { ...valid, interleaved: "BAD_NUMBER" },
    ];
    for (const candidate of invalidCandidates) {
      let text = JSON.stringify({
        acme: { models: { stable: valid, pipeline: { ...candidate, name: "Pipeline" } } },
      });
      text = text.replaceAll('"BAD_NUMBER"', "1e400");
      const source = modelsDevCatalogSource({
        fetchFn: (async () => new Response(text, { status: 200 })) as typeof fetch,
      });
      const result = await source.fetchCatalog("acme", [model("acme", "stable")], {
        signal: signal(),
      });
      expect(result.models.map((entry) => entry.id)).toEqual(["stable"]);
      expect(result.rejected).toBe(1);
    }
  });

  it("reads every shape the interleaved field is allowed to take", async () => {
    // `interleaved` is a boolean or an object naming the field, and models.dev
    // populates it on 13% of rows. Each shape has to land in the same class as
    // itself and a different one from the others, or the key is not a key.
    const base = {
      name: "Model",
      family: "acme",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["high"] }],
      tool_call: true,
      temperature: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 8_000 },
      cost: { input: 1, output: 2 },
    };
    const admits = async (baselineShape: unknown, candidateShape: unknown): Promise<boolean> => {
      const source = modelsDevCatalogSource({
        fetchFn: (async () =>
          jsonResponse({
            acme: {
              models: {
                stable: { ...base, interleaved: baselineShape },
                pipeline: { ...base, name: "Pipeline", interleaved: candidateShape },
              },
            },
          })) as typeof fetch,
      });
      const result = await source.fetchCatalog("acme", [model("acme", "stable")], {
        signal: signal(),
      });
      return result.models.some((entry) => entry.id === "pipeline");
    };

    // Same shape, same class.
    expect(await admits(true, true)).toBe(true);
    expect(await admits({ field: "reasoning_content" }, { field: "reasoning_content" })).toBe(true);
    expect(await admits(undefined, false)).toBe(true);
    // A bare object names no field, which is the same claim as `true`.
    expect(await admits(true, {})).toBe(true);
    // Different shape, different class — nothing to inherit.
    expect(await admits(true, { field: "reasoning_details" })).toBe(false);
    expect(await admits(undefined, true)).toBe(false);
  });

  it("never empties a provider because its rows understate what Pi ships", async () => {
    // The regression this guards: one community feed edit must not be able to
    // take every model away from a provider a person is signed in to and using.
    for (const incompatible of [
      { tool_call: false },
      { tool_call: true, modalities: { input: ["text"], output: ["video"] } },
    ]) {
      const source = modelsDevCatalogSource({
        fetchFn: (async () =>
          jsonResponse({
            acme: {
              models: {
                stable: {
                  name: "Stable",
                  family: "acme",
                  reasoning: false,
                  limit: { context: 100_000, output: 8_000 },
                  cost: { input: 1, output: 2 },
                  ...incompatible,
                },
              },
            },
          })) as typeof fetch,
      });
      const result = await source.fetchCatalog("acme", [model("acme", "stable")], {
        signal: signal(),
      });
      expect(result.models.map((entry) => entry.id)).toEqual(["stable"]);
      expect(result.rejected).toBe(0);
    }
  });

  it("keeps every baseline model when the source describes an unrelated id space", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          acme: {
            models: {
              // A whole new id space: nothing here is a model pi vouches for.
              "unrelated-1": document.a.models["a-2"],
              "unrelated-2": document.a.models["a-2"],
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("acme", [model("acme", "stable")], {
      signal: signal(),
    });

    // Safe by construction rather than by a guard: classes are built only from
    // exact baseline joins, so an id space sharing nothing with pi produces no
    // class, admits nothing, and leaves the catalog exactly as it was.
    expect(result.models.map((entry) => entry.id)).toEqual(["stable"]);
    expect(result.rejected).toBe(2);
  });

  it("does not turn a prefix-similar unknown id into runnable protocol", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          anthropic: {
            models: {
              "claude-fable-5.1": {
                name: "Claude Fable 5.1",
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 1_000_000, output: 128_000 },
                cost: { input: 10, output: 50 },
              },
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog(
      "anthropic",
      [model("anthropic", "claude-fable-5", { api: "anthropic-messages" })],
      { signal: signal() },
    );

    // A name one character apart is not evidence. `claude-fable-5` is absent
    // from this feed, so it contributes no class and `claude-fable-5.1` has
    // nothing to inherit — while the baseline model itself is untouched.
    expect(result.models.map((entry) => entry.id)).toEqual(["claude-fable-5"]);
    expect(result.rejected).toBe(1);
  });

  it("carries the response validators for the persisted entry", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse(document, {
          ETag: '"v7"',
          "Last-Modified": "Thu, 01 Jan 2026 00:00:00 GMT",
        })) as typeof fetch,
    });
    const result = await source.fetchCatalog("a", [], { signal: signal() });
    expect(result.etag).toBe('"v7"');
    expect(result.lastModified).toBe(Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"));
  });

  it("marks a provider the document does not carry as unsourced, not failed", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => jsonResponse({ other: { models: {} } })) as typeof fetch,
    });
    await expect(source.fetchCatalog("acme", [], { signal: signal() })).rejects.toThrow(
      CatalogSourceAbsent,
    );
  });

  it("fails one provider instead of publishing a truncated complete list", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          acme: {
            models: {
              first: document.a.models["a-2"],
              second: document.a.models["a-2"],
            },
          },
        })) as typeof fetch,
      maxProviderModels: 1,
    });

    await expect(source.fetchCatalog("acme", [], { signal: signal() })).rejects.toThrow(
      /exceeds the model-count bound/,
    );
  });

  it("reports an HTTP failure by status and never by body", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("secret-ish body", { status: 503 })) as typeof fetch,
    });
    await expect(source.fetchCatalog("a", [], { signal: signal() })).rejects.toThrow(/HTTP 503/);
  });

  it("rejects a response past the configured readable bound", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("12345", { status: 200 })) as typeof fetch,
      maxBodyBytes: 4,
    });
    await expect(source.fetchCatalog("a", [], { signal: signal() })).rejects.toThrow(
      /exceeds the readable size bound/,
    );
  });

  it("rejects readable JSON whose root is not a provider map", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => jsonResponse([])) as typeof fetch,
    });
    await expect(source.fetchCatalog("a", [], { signal: signal() })).rejects.toThrow(
      /not a provider map/,
    );
  });

  it("reports unparseable JSON without quoting a byte of it", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch,
    });
    const failure = await source
      .fetchCatalog("a", [], { signal: signal() })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/not readable JSON/);
    expect((failure as Error).message).not.toMatch(/html/);
  });

  it("does not memoize a failure", async () => {
    let calls = 0;
    const source = modelsDevCatalogSource({
      fetchFn: (async () => {
        calls++;
        return calls === 1 ? new Response("x", { status: 500 }) : jsonResponse(document);
      }) as typeof fetch,
      memoMs: 0,
    });
    await expect(source.fetchCatalog("a", [], { signal: signal() })).rejects.toThrow(/HTTP 500/);
    await expect(source.fetchCatalog("a", [], { signal: signal() })).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("normalizes a non-Error transport rejection", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (() => Promise.reject("plain failure")) as typeof fetch,
    });
    await expect(source.fetchCatalog("a", [], { signal: signal() })).rejects.toThrow(
      /plain failure/,
    );
  });

  it("honors a caller that was already aborted with a non-Error reason", async () => {
    const controller = new AbortController();
    controller.abort("plain reason");
    const source = modelsDevCatalogSource({
      fetchFn: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    await expect(source.fetchCatalog("a", [], { signal: controller.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  it("lets one caller abort without killing the fetch others await", async () => {
    const gate = Promise.withResolvers<Response>();
    const source = modelsDevCatalogSource({ fetchFn: (() => gate.promise) as typeof fetch });
    const aborter = new AbortController();
    const abandoned = source.fetchCatalog("a", [], { signal: aborter.signal });
    const patient = source.fetchCatalog("b", [model("b", "b-2")], { signal: signal() });
    aborter.abort();
    await expect(abandoned).rejects.toThrow(/aborted/i);
    gate.resolve(jsonResponse(document));
    await expect(patient).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "b-2" })],
    });
  });
});

// --- the persistent store --------------------------------------------------

// --- real-provider fixtures ------------------------------------------------
//
// Everything above scripts its own shapes. This block does not: the baseline
// models are pi 0.84.3's own `opencode-go` entries, copied verbatim from
// `dist/models.generated.js`, and the feed rows carry the capability shapes
// models.dev really publishes for them. That is the join the product performs,
// and it is the only place these tests can catch a rule that is safe in the
// abstract but admits nothing — or the wrong thing — in production.
//
// Refresh these against `https://models.dev/api.json` and the pinned pi release
// when either moves; the ids below are the ones the pipeline cares about.

/** pi 0.84.3 `opencode-go` baseline, verbatim. */
const OPENCODE_GO_BASELINE = {
  "grok-4.5": {
    id: "grok-4.5",
    name: "Grok 4.5",
    api: "openai-responses",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    compat: { sessionAffinityFormat: "openai-nosession" },
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
  },
  hy3: {
    id: "hy3",
    name: "Hy3 (8x usage)",
    api: "openai-completions",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.0175, output: 0.0725, cacheRead: 0.004375, cacheWrite: 0 },
    compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    contextWindow: 256_000,
    maxTokens: 64_000,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  },
} as unknown as Record<string, Model<Api>>;

/** The models.dev row shape these providers really publish. */
function feedRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    tool_call: true,
    temperature: true,
    structured_output: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 500_000, output: 64_000 },
    cost: { input: 2, output: 6 },
    ...overrides,
  };
}

describe("admission against real opencode-go baseline shapes", () => {
  it("admits a new model whose only difference is one extra effort rung", async () => {
    // The measured production bottleneck. `grok-4.6` is protocol-identical to
    // `grok-4.5` but declares `xhigh` on top of low/medium/high. Keyed on the
    // exact effort VALUES that put them in different classes, and every class
    // held one member, so nothing new was ever admitted. Keyed on the reasoning
    // SHAPE they share, the new id inherits a ladder narrowed to what it
    // declares — and `xhigh` is still withheld, because no pi evidence covers
    // that rung.
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              "grok-4.5": feedRow({
                name: "Grok 4.5",
                family: "grok",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
                modalities: { input: ["text", "image"], output: ["text"] },
              }),
              "grok-4.6": feedRow({
                name: "Grok 4.6",
                family: "grok",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
                modalities: { input: ["text", "image"], output: ["text"] },
              }),
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("opencode-go", [OPENCODE_GO_BASELINE["grok-4.5"]!], {
      signal: signal(),
    });

    const minted = result.models.find((entry) => entry.id === "grok-4.6");
    expect(minted).toBeDefined();
    expect(minted).toMatchObject({
      api: "openai-responses",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      compat: { sessionAffinityFormat: "openai-nosession" },
    });
    expect(minted?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      // Declared by the feed, withheld anyway: pi's `grok-4.5` maps it to null,
      // so nothing here can vouch for how the provider spells that rung.
      xhigh: null,
      max: null,
    });
    expect(result.rejected).toBe(0);
  });

  it("leaves the class ladder alone for a model that declares no effort rungs", async () => {
    // Absence in the feed is a statement about the catalogue, not the model.
    // With nothing to narrow against, the new id runs what its siblings run —
    // and pi reads a missing level as supported, so dropping the map here would
    // widen the ladder rather than restrict it.
    const row = (extra: Record<string, unknown>) =>
      feedRow({
        family: "grok",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        ...extra,
      });
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              // A non-effort control declares no rungs to narrow against.
              "grok-4.5": row({
                name: "Grok 4.5",
                reasoning_options: [{ type: "budget_tokens", min: 1024 }],
              }),
              "grok-4.6": row({
                name: "Grok 4.6",
                reasoning_options: [{ type: "budget_tokens", min: 2048 }],
              }),
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("opencode-go", [OPENCODE_GO_BASELINE["grok-4.5"]!], {
      signal: signal(),
    });

    expect(result.models.find((entry) => entry.id === "grok-4.6")?.thinkingLevelMap).toEqual(
      OPENCODE_GO_BASELINE["grok-4.5"]!.thinkingLevelMap,
    );
  });

  it("lowers an inherited ladder to the rungs the new model itself declares", async () => {
    // `hy4-preview` declares none/high where pi's `hy3` also maps `low`. The
    // ladder is a ceiling, never a floor: `low` is withheld.
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              hy3: feedRow({
                name: "Hy3",
                family: "hy",
                reasoning: true,
                reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
              }),
              "hy4-preview": feedRow({
                name: "Hy4 Preview",
                family: "hy",
                reasoning: true,
                // The 42 is deliberate: this document is untrusted, and a rung
                // that is not a string names nothing the provider accepts.
                reasoning_options: [{ type: "effort", values: ["none", "high", 42] }],
              }),
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("opencode-go", [OPENCODE_GO_BASELINE.hy3!], {
      signal: signal(),
    });

    expect(result.models.find((entry) => entry.id === "hy4-preview")?.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("withholds a rung two class members disagree about", async () => {
    // pi's real `glm-5.2` and `glm-5.3` differ only in their ladders: `glm-5.3`
    // maps `low`, `glm-5.2` refuses it. Byte-identical unanimity called the
    // whole class unusable over that; intersecting keeps everything they agree
    // on and withholds only the rung in dispute.
    const row = (name: string) =>
      feedRow({
        name,
        family: "glm",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        limit: { context: 1_000_000, output: 131_072 },
      });
    const compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    };
    const ladder = {
      off: null,
      minimal: null,
      medium: null,
      xhigh: null,
      high: "high",
      max: "max",
    };
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              "glm-5.2": row("GLM-5.2"),
              "glm-5.3": row("GLM-5.3"),
              "glm-5.4": row("GLM-5.4"),
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog(
      "opencode-go",
      [
        model("opencode-go", "glm-5.2", {
          reasoning: true,
          compat,
          thinkingLevelMap: { ...ladder, low: null },
        }),
        model("opencode-go", "glm-5.3", {
          reasoning: true,
          compat,
          thinkingLevelMap: { ...ladder, low: "low" },
        }),
      ],
      { signal: signal() },
    );

    expect(result.models.find((entry) => entry.id === "glm-5.4")?.thinkingLevelMap).toEqual({
      ...ladder,
      low: null,
    });
  });

  it("does not surface a model the provider has retired", async () => {
    // Measured: 9 of opencode-go's rows carry `status`, and three of the four
    // ids the value-keyed rule admitted for it were deprecated. Pressing
    // Refresh must not spend its one visible effect on retired models.
    const base = {
      family: "grok",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      modalities: { input: ["text", "image"], output: ["text"] },
    };
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              "grok-4.5": feedRow({ ...base, name: "Grok 4.5" }),
              "grok-4.6": feedRow({ ...base, name: "Grok 4.6" }),
              "grok-4.4": feedRow({ ...base, name: "Grok 4.4", status: "deprecated" }),
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchCatalog("opencode-go", [OPENCODE_GO_BASELINE["grok-4.5"]!], {
      signal: signal(),
    });

    expect(result.models.map((entry) => entry.id)).toEqual(["grok-4.5", "grok-4.6"]);
    expect(result.rejected).toBe(1);
  });

  it("keeps an uncorroborated opt-in flag off, and an agreed one on", async () => {
    // A class of one cannot corroborate an additive capability. Measured
    // leave-one-out against the real catalogue: inheriting them from a single
    // sibling mints `gpt-5.2` with tool-search enabled, which pi leaves off.
    const row = feedRow({
      family: "gpt",
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["high"] }],
    });
    const withFlag = { supportsStrictMode: true, supportsToolSearch: true };
    const fetchFn = (async () =>
      jsonResponse({
        acme: {
          models: { "gpt-a": row, "gpt-b": row, "gpt-new": row },
        },
      })) as typeof fetch;

    const alone = await modelsDevCatalogSource({ fetchFn }).fetchCatalog(
      "acme",
      [model("acme", "gpt-a", { compat: withFlag })],
      { signal: signal() },
    );
    expect(alone.models.find((entry) => entry.id === "gpt-new")?.compat).toEqual({
      supportsStrictMode: true,
    });

    const corroborated = await modelsDevCatalogSource({ fetchFn }).fetchCatalog(
      "acme",
      [model("acme", "gpt-a", { compat: withFlag }), model("acme", "gpt-b", { compat: withFlag })],
      { signal: signal() },
    );
    expect(corroborated.models.find((entry) => entry.id === "gpt-new")?.compat).toEqual(withFlag);
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
    const base = baseProvider("opencode-go", [model("opencode-go", "ox-alpha-free")]);
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
