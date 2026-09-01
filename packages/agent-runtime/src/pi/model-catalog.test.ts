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
  modelsDevOverlay,
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

  it("hands the source its own provider id and static baseline", async () => {
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    await wrapped.refreshModels?.(refreshContext().context);
    expect(source.calls).toEqual([{ providerId: "acme", baseline }]);
  });

  it("restores a persisted overlay without touching the network", async () => {
    const source = scriptedSource({ models: [] });
    const wrapped = withRefreshableCatalog(baseProvider("acme", baseline), source);
    const stored = {
      models: [model("acme", "acme-3"), model("other", "not-ours")],
      checkedAt: 1,
    };
    const { context } = refreshContext({ stored, allowNetwork: false, force: undefined });
    await wrapped.refreshModels?.(context);
    // The foreign entry is filtered exactly as radius filters its own store.
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["acme-1", "acme-2", "acme-3"]);
    expect(source.calls).toHaveLength(0);
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

describe("modelsDevOverlay", () => {
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

  it("adds a new model by inheriting request shape from its closest sibling", () => {
    const baseline = [model("opencode-go", "kimi-k3"), glm53, model("opencode-go", "glm-5.1")];
    const overlay = modelsDevOverlay("opencode-go", baseline, {
      "opencode-go": { models: { "glm-5.3-flash": feedEntry } },
    });
    expect(overlay).toHaveLength(1);
    const added = overlay[0];
    // The feed's facts...
    expect(added?.id).toBe("glm-5.3-flash");
    expect(added?.name).toBe("GLM-5.3-Flash");
    expect(added?.cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
    expect(added?.contextWindow).toBe(1_000_000);
    expect(added?.input).toEqual(["text", "image"]);
    // ...and the sibling's request shape, by reference where it is an object.
    expect(added?.api).toBe(glm53.api);
    expect(added?.baseUrl).toBe(glm53.baseUrl);
    expect(added?.compat).toBe(glm53.compat);
    expect(added?.thinkingLevelMap).toBe(glm53.thinkingLevelMap);
  });

  it("finds claude-fable-5.1 its own family, not another Claude", () => {
    const fable = model("anthropic", "claude-fable-5", {
      api: "anthropic-messages",
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    } as Partial<Model<Api>>);
    const baseline = [model("anthropic", "claude-opus-5"), fable];
    const overlay = modelsDevOverlay("anthropic", baseline, {
      anthropic: {
        models: {
          "claude-fable-5.1": {
            name: "Claude Fable 5.1",
            reasoning: true,
            limit: { context: 1_000_000, output: 128_000 },
            cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
          },
        },
      },
    });
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.name).toBe("Claude Fable 5.1");
    expect(overlay[0]?.thinkingLevelMap).toBe(fable.thinkingLevelMap);
    expect(overlay[0]?.api).toBe("anthropic-messages");
  });

  it("refreshes price, window and name on a known model but never its request shape", () => {
    const overlay = modelsDevOverlay("opencode-go", [glm53], {
      "opencode-go": {
        models: {
          "glm-5.3": {
            name: "GLM-5.3 (renamed)",
            cost: { input: 0.7, output: 2.2, cache_read: 0.13 },
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    });
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.name).toBe("GLM-5.3 (renamed)");
    expect(overlay[0]?.cost).toEqual({ input: 0.7, output: 2.2, cacheRead: 0.13, cacheWrite: 0 });
    expect(overlay[0]?.api).toBe(glm53.api);
    expect(overlay[0]?.compat).toBe(glm53.compat);
    expect(overlay[0]?.thinkingLevelMap).toBe(glm53.thinkingLevelMap);
  });

  it("emits nothing for a model the feed agrees with", () => {
    const overlay = modelsDevOverlay("opencode-go", [glm53], {
      "opencode-go": {
        models: {
          "glm-5.3": {
            name: "glm-5.3",
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1_000_000, output: 131_072 },
            cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
          },
        },
      },
    });
    expect(overlay).toEqual([]);
  });

  it("drops an inherited thinking map when the feed says the model does not reason", () => {
    const overlay = modelsDevOverlay("opencode-go", [glm53], {
      "opencode-go": {
        models: { "glm-5.3-lite": { ...feedEntry, name: "GLM-5.3-Lite", reasoning: false } },
      },
    });
    expect(overlay[0]?.reasoning).toBe(false);
    expect(overlay[0]?.thinkingLevelMap).toBeUndefined();
  });

  it("translates context pricing tiers and distrusts untranslatable ones", () => {
    const tiered = {
      ...feedEntry,
      cost: {
        input: 5,
        output: 30,
        cache_read: 0.5,
        tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272_000 } }],
      },
    };
    const [added] = modelsDevOverlay("opencode-go", [glm53], {
      "opencode-go": { models: { "glm-5.4": tiered } },
    });
    expect(added?.cost.tiers).toEqual([
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 0, inputTokensAbove: 272_000 },
    ]);

    const weird = {
      ...feedEntry,
      cost: { input: 5, output: 30, tiers: [{ input: 10, output: 45, tier: { type: "mystery" } }] },
    };
    // A price this module cannot faithfully translate is no price, and a new
    // model without a price is not added.
    expect(
      modelsDevOverlay("opencode-go", [glm53], {
        "opencode-go": { models: { "glm-5.4": weird } },
      }),
    ).toEqual([]);
  });

  it("skips what it cannot answer for: no sibling, no price, no window, no text", () => {
    const baseline = [glm53];
    const cases = {
      "zzz-total-stranger": feedEntry, // no plausible sibling
      "glm-5.5": { ...feedEntry, cost: undefined }, // no price
      "glm-5.6": { ...feedEntry, limit: { output: 1 } }, // no context window
      "glm-5.7": { ...feedEntry, modalities: { input: ["text"], output: ["video"] } }, // not a chat model
      "glm-5.8": "not even an object",
    };
    expect(modelsDevOverlay("opencode-go", baseline, { "opencode-go": { models: cases } })).toEqual(
      [],
    );
  });

  it("yields an empty overlay for providers the feed has no data on", () => {
    expect(modelsDevOverlay("acme", [model("acme", "m")], { other: { models: {} } })).toEqual([]);
    expect(modelsDevOverlay("acme", [model("acme", "m")], "garbage")).toEqual([]);
  });
});

// --- the shared fetch ------------------------------------------------------

describe("modelsDevCatalogSource", () => {
  const document = {
    a: {
      models: {
        "a-2": { name: "A2", limit: { context: 10, output: 5 }, cost: { input: 1, output: 2 } },
      },
    },
    b: {
      models: {
        "b-2": { name: "B2", limit: { context: 10, output: 5 }, cost: { input: 1, output: 2 } },
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
    const first = source.fetchOverlay("a", [model("a", "a-1")], { signal: signal() });
    const second = source.fetchOverlay("b", [model("b", "b-1")], { signal: signal() });
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

  it("lets one caller abort without killing the fetch others await", async () => {
    const gate = Promise.withResolvers<Response>();
    const source = modelsDevCatalogSource({ fetchFn: (() => gate.promise) as typeof fetch });
    const aborter = new AbortController();
    const abandoned = source.fetchOverlay("a", [], { signal: aborter.signal });
    const patient = source.fetchOverlay("b", [model("b", "b-1")], { signal: signal() });
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

  it("deletes one provider's entry and leaves the neighbors", async () => {
    const store = new PiFileModelsStore(path());
    await store.write("a", { models: [model("a", "m-a")] });
    await store.write("b", { models: [model("b", "m-b")] });
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
    const base = baseProvider("acme", [model("acme", "acme-1")]);
    const added = model("acme", "acme-2", { name: "Acme 2" });

    const first = createModels({
      credentials: credentialStore("acme"),
      modelsStore: new PiFileModelsStore(file),
    });
    first.setProvider(withRefreshableCatalog(base, scriptedSource({ models: [added] })));
    const refreshed = await first.refresh({ force: true });
    expect([...refreshed.errors.keys()]).toEqual([]);
    expect(first.getModel("acme", "acme-2")?.name).toBe("Acme 2");

    // A new collection over the same file, with a source that must not be
    // needed: the restore phase alone brings the overlay back. This is the
    // ticket's own verification — what the ModelsStore exists for.
    const second = createModels({
      credentials: credentialStore("acme"),
      modelsStore: new PiFileModelsStore(file),
    });
    second.setProvider(withRefreshableCatalog(base, failingSource()));
    const restored = await second.refresh({ allowNetwork: false });
    expect([...restored.errors.keys()]).toEqual([]);
    expect(second.getModel("acme", "acme-2")?.name).toBe("Acme 2");
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
