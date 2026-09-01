import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  Credential,
  CredentialStore,
  Model,
  ModelsPublication,
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
  PiFileModelsStore,
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
    fetchOverlay: async (providerId, baseline) => {
      calls.push({ providerId, baseline });
      return result;
    },
  };
}

function failingSource(): CatalogSource {
  return {
    fetchOverlay: async () => {
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

  it("merges a fetched overlay over the static baseline by id", async () => {
    const replaced = model("acme", "acme-2", { name: "Acme 2 (updated)" });
    const added = model("acme", "acme-3");
    const wrapped = withRefreshableCatalog(
      baseProvider("acme", baseline),
      scriptedSource({ models: [replaced, added] }),
    );
    expect(wrapped.getModels()).toEqual(baseline);

    const { context } = refreshContext();
    await wrapped.refreshModels?.(context);
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["acme-1", "acme-2", "acme-3"]);
    expect(wrapped.getModels()[1]?.name).toBe("Acme 2 (updated)");
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

  it("restores persisted facts through current protocol and drops unpinned additions", async () => {
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const stored = {
      models: [
        model("acme", "acme-2", { name: "Acme 2 cached" }),
        model("acme", "unpinned-addition"),
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
      models: [added],
      checkedAt: 9_000,
      etag: '"v1"',
      lastModified: 123,
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
      fetchOverlay: async () => {
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
        models: { "glm-5.3": { modalities: { input: ["image"], output: ["text"] } } },
      },
    });
    expect(facts?.input).toEqual(["image"]);
  });

  it("falls back to every known fact the feed omits or leaves empty", () => {
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": { models: { "glm-5.3": { name: "" } } },
      }),
    ).toEqual([]);
  });

  it("uses a new model id when the feed leaves its name empty", () => {
    const [facts] = modelsDevCatalogFacts("opencode-go", [], {
      "opencode-go": { models: { "glm-5.3-flash": { ...feedEntry, name: "" } } },
    });
    expect(facts?.name).toBe("glm-5.3-flash");
  });

  it("caps a provider slice before an untrusted feed can grow the overlay", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`model-${index}`, feedEntry]),
    );
    expect(
      modelsDevCatalogFacts("opencode-go", [], { "opencode-go": { models: entries } }),
    ).toHaveLength(200);
  });

  it("emits nothing for a known model whose facts agree", () => {
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], {
        "opencode-go": {
          models: {
            "glm-5.3": {
              name: "glm-5.3",
              reasoning: false,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 1_000_000, output: 131_072 },
              cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("recognizes an unchanged tiered price on a known model", () => {
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
    ).toEqual([]);
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
    const [added] = modelsDevCatalogFacts("opencode-go", [glm53], {
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
        modelsDevCatalogFacts("opencode-go", [glm53], {
          "opencode-go": {
            models: { "glm-5.4": { ...feedEntry, cost: { input: 5, output: 30, tiers } } },
          },
        }),
      ).toEqual([]);
    }
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
    };
    expect(
      modelsDevCatalogFacts("opencode-go", [glm53], { "opencode-go": { models: cases } }),
    ).toEqual([]);
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
    const first = source.fetchOverlay("a", [model("a", "a-2")], { signal: signal() });
    const second = source.fetchOverlay("b", [model("b", "b-2")], { signal: signal() });
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
    await source.fetchOverlay("a", [], { signal: signal() });
    await source.fetchOverlay("a", [], { signal: signal() });
    expect(calls).toBe(1);
    at = 10_000;
    await source.fetchOverlay("a", [], { signal: signal() });
    expect(calls).toBe(2);
  });

  it("materializes a reviewed new id through its exact pinned protocol", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse({
          "opencode-go": {
            models: {
              "glm-5.3-flash": {
                name: "GLM-5.3-Flash",
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 1_000_000, output: 131_072 },
                cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
              },
            },
          },
        })) as typeof fetch,
    });

    const result = await source.fetchOverlay("opencode-go", [], { signal: signal() });

    expect(result.models).toEqual([
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

    const result = await source.fetchOverlay(
      "anthropic",
      [model("anthropic", "claude-fable-5", { api: "anthropic-messages" })],
      { signal: signal() },
    );

    expect(result.models).toEqual([]);
  });

  it("carries the response validators for the persisted entry", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () =>
        jsonResponse(document, {
          ETag: '"v7"',
          "Last-Modified": "Thu, 01 Jan 2026 00:00:00 GMT",
        })) as typeof fetch,
    });
    const result = await source.fetchOverlay("a", [], { signal: signal() });
    expect(result.etag).toBe('"v7"');
    expect(result.lastModified).toBe(Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"));
  });

  it("reports an HTTP failure by status and never by body", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("secret-ish body", { status: 503 })) as typeof fetch,
    });
    await expect(source.fetchOverlay("a", [], { signal: signal() })).rejects.toThrow(/HTTP 503/);
  });

  it("rejects a response past the configured readable bound", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("12345", { status: 200 })) as typeof fetch,
      maxBodyBytes: 4,
    });
    await expect(source.fetchOverlay("a", [], { signal: signal() })).rejects.toThrow(
      /exceeds the readable size bound/,
    );
  });

  it("rejects readable JSON whose root is not a provider map", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => jsonResponse([])) as typeof fetch,
    });
    await expect(source.fetchOverlay("a", [], { signal: signal() })).rejects.toThrow(
      /not a provider map/,
    );
  });

  it("reports unparseable JSON without quoting a byte of it", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (async () => new Response("<html>not json</html>", { status: 200 })) as typeof fetch,
    });
    const failure = await source
      .fetchOverlay("a", [], { signal: signal() })
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
    await expect(source.fetchOverlay("a", [], { signal: signal() })).rejects.toThrow(/HTTP 500/);
    await expect(source.fetchOverlay("a", [], { signal: signal() })).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("normalizes a non-Error transport rejection", async () => {
    const source = modelsDevCatalogSource({
      fetchFn: (() => Promise.reject("plain failure")) as typeof fetch,
    });
    await expect(source.fetchOverlay("a", [], { signal: signal() })).rejects.toThrow(
      /plain failure/,
    );
  });

  it("honors a caller that was already aborted with a non-Error reason", async () => {
    const controller = new AbortController();
    controller.abort("plain reason");
    const source = modelsDevCatalogSource({
      fetchFn: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    await expect(source.fetchOverlay("a", [], { signal: controller.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  it("lets one caller abort without killing the fetch others await", async () => {
    const gate = Promise.withResolvers<Response>();
    const source = modelsDevCatalogSource({ fetchFn: (() => gate.promise) as typeof fetch });
    const aborter = new AbortController();
    const abandoned = source.fetchOverlay("a", [], { signal: aborter.signal });
    const patient = source.fetchOverlay("b", [model("b", "b-2")], { signal: signal() });
    aborter.abort();
    await expect(abandoned).rejects.toThrow(/aborted/i);
    gate.resolve(jsonResponse(document));
    await expect(patient).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "b-2" })],
    });
  });
});

// --- the persistent store --------------------------------------------------

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
