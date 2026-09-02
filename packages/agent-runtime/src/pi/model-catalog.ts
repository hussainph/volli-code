/**
 * A model catalog that can move without a pi-ai bump.
 *
 * pi-ai's built-in provider catalogs are generated at *publish* time and ship
 * frozen: `Provider.refreshModels` is optional, exactly one built-in provider
 * (radius) implements it, and so Model Access's "Refresh models" button re-read
 * the same static lists forever. Meanwhile the churn that matters — a new
 * frontier model, a 50% price cut — lands on providers whose pi catalogs wait
 * for the next release. This module is the durable answer, in three parts:
 *
 * 1. {@link withRefreshableCatalog} wraps a static built-in provider and gives
 *    it the dynamic-provider contract: `getModels()` merges a fetched overlay
 *    over the static baseline, and `refreshModels()` restores and publishes
 *    that overlay through pi's own transactional `RefreshModelsContext`, with
 *    the same restore/fetch/publish shape radius and `createProvider` use.
 *    Delegation is by spread, never by enumerating fields, so a member a
 *    future pi adds (`fetchDeferred` and `cancelDeferred` arrived this way in
 *    0.84.0) rides along instead of being silently dropped — and auth is the
 *    base provider's own objects untouched, so sign-in, sign-out and the
 *    sign-in buttons cannot tell the wrapper from the original.
 *
 * 2. {@link modelsDevCatalogSource} is the one overlay feed, for every wrapped
 *    provider uniformly: models.dev's `api.json`, the same catalogue pi's own
 *    generator reads, keyed by the same provider ids. One refresh burst costs
 *    one GET — the document is whole-catalogue, so concurrent per-provider
 *    refreshes share a single in-flight request and each slice their provider
 *    out of it. The mapping owns facts only — cost, context/output limits,
 *    name and input modalities. `api`, `compat`, `baseUrl`, `reasoning` and
 *    `thinkingLevelMap` are executable protocol, with provider-private values
 *    a generic feed cannot supply. Exact existing ids therefore re-materialize
 *    over the current Pi baseline, while new ids require an exact reviewed
 *    entry in `PINNED_MODEL_PROTOCOLS`; fuzzy sibling inheritance is forbidden.
 *    Restore performs the same materialization, so a cache written before a Pi
 *    bump cannot roll corrected request shape back. API-shape flips still ride
 *    the pinned Pi bump (or an explicit Volli protocol pin), while factual
 *    price/window updates move at runtime. Exact supersession policy retires a
 *    known stealth alias only when its canonical id is present.
 *
 * 3. {@link PiFileModelsStore} makes the overlay durable. `piOwnedModelAccess`
 *    passes pi's `Models` no `modelsStore`, so pi fell back to its in-memory
 *    store and any fetched catalog died at restart. This one is a JSON file
 *    beside Pi's own `auth.json` — the same profile directory, so the
 *    `$PI_CODING_AGENT_DIR` isolation that keeps a packaged smoke run off a
 *    developer's credentials keeps it off their catalog cache too. Unlike the
 *    credential store it takes no cross-process lock and treats an unreadable
 *    file as empty: this is a cache of public catalog data, a torn read costs
 *    one re-fetch rather than a session, and whole-file atomic renames are
 *    enough to keep any reader consistent.
 *
 * The coupling bet, stated so a future bump knows where to look: this file
 * targets `refreshModels` / `RefreshModelsContext` / `ModelsStore`, the typed
 * surface that was redesigned once between 0.81.0 and 0.84.2 and has been
 * byte-stable since. Every member used here is typed, so the next redesign is
 * a compile error in this file on `pnpm install`, not an empty model list at
 * runtime — the same rule `sign-in.ts` states for itself.
 *
 * **The feed is untrusted data.** Every field read out of `api.json` is
 * type-checked before use, malformed entries are skipped rather than fatal,
 * the overlay is capped, and no error message ever quotes response bytes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Api,
  Model,
  ModelCost,
  ModelCostTier,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
  MutableModels,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

/** The whole-catalogue document models.dev publishes, and pi's generator reads. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** A wedged catalog fetch may not hold the Refresh button's snapshot open. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long one fetched document answers for the whole burst. `Models.refresh`
 * starts every provider's refresh concurrently, so ~40 wrapped providers would
 * otherwise cost ~40 GETs of the same file; long enough to cover a burst's
 * stragglers, short enough that a second press of the button is a real fetch.
 */
const MEMO_MS = 5_000;

/** A non-forced refresh within this window trusts the persisted overlay. */
const CATALOG_FRESH_MS = 60 * 60 * 1000;

/** Upper bound on a response this module is willing to parse. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Upper bound on overlay entries per provider; a feed gone wrong stays bounded. */
const MAX_OVERLAY_MODELS = 200;

/** Facts a generic catalogue may own without choosing how a request is sent. */
export type CatalogModelFacts = Pick<
  Model<Api>,
  "id" | "name" | "input" | "cost" | "contextWindow" | "maxTokens"
>;

type CatalogModelProtocol = Omit<Model<Api>, keyof CatalogModelFacts>;

/**
 * Executable protocol for runtime additions reviewed by exact provider/model id.
 *
 * models.dev cannot say which Pi API implementation, compatibility flags, or
 * provider-private thinking values a model needs. Unknown ids therefore remain
 * catalogue candidates, never runnable Models, until this narrow table vouches
 * for their wire shape. Factual fields still come from the live feed.
 */
const PINNED_MODEL_PROTOCOLS: Readonly<
  Record<string, Readonly<Record<string, CatalogModelProtocol>>>
> = {
  "opencode-go": {
    "glm-5.3-flash": {
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
    },
  },
};

/** Exact catalogue identity policy; applied only when the canonical id exists. */
const SUPERSEDED_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "opencode-go": { "ox-alpha-free": "glm-5.3-flash" },
};

/** What one provider's overlay fetch may read. */
export interface CatalogFetchContext {
  /** pi's shared refresh signal — always present, honoured for blocking work. */
  signal: AbortSignal;
}

/** One fetched overlay, with the response validators worth persisting. */
export interface CatalogFetchResult {
  /** Complete overlay models; each replaces or extends the static baseline by id. */
  models: readonly Model<Api>[];
  /** Opaque validator from the catalog response's ETag header, stored verbatim. */
  etag?: string;
  /** Unix timestamp (ms) from the catalog response's Last-Modified header. */
  lastModified?: number;
}

/**
 * Where a wrapped provider's overlay comes from.
 *
 * Handed the static baseline because accepted models are materialized through
 * its current executable protocol; reviewed additions use an exact local pin.
 * A provider the source has no data for yields an empty overlay, which merges
 * to exactly the static catalog.
 */
export interface CatalogSource {
  fetchOverlay(
    providerId: string,
    baseline: readonly Model<Api>[],
    context: CatalogFetchContext,
  ): Promise<CatalogFetchResult>;
}

/** Injectable clock, for tests that assert freshness windows. */
export interface RefreshableCatalogOptions {
  now?: () => number;
}

/**
 * A static built-in provider, given the dynamic-provider contract.
 *
 * Everything except the catalog is the base provider's own by spread: auth
 * (both objects, including their lazy OAuth loaders), `filterModels`, streams
 * and the deferred pair — the wrapped providers all come from pi's
 * `createProvider`, whose members are closures, so copying references is
 * copying behavior. Only `getModels` is overridden and only `refreshModels`
 * is added, and the merge mirrors `createProvider`'s own overlay rule: an
 * overlay model replaces the baseline entry with its id, or extends the list.
 */
export function withRefreshableCatalog(
  base: Provider,
  source: CatalogSource,
  options: RefreshableCatalogOptions = {},
): Provider {
  const now = options.now ?? Date.now;
  let overlay: readonly Model<Api>[] = [];
  return {
    ...base,
    getModels: () => mergeCatalog(base.id, base.getModels(), overlay),
    refreshModels: async (context: RefreshModelsContext): Promise<void> => {
      // Restore phase: pi calls this once with network disallowed before any
      // auth resolution, which is what brings a persisted overlay back at
      // startup. Foreign entries are filtered exactly as radius filters them —
      // a store another version wrote may hold models this provider disowns.
      if (context.stored) {
        // Stored Models are persistence encoding, not executable authority.
        // Project them back to facts and materialize them through today's
        // baseline/pins so a Pi bump cannot be rolled back by an old cache.
        const restored = materializeCatalog(
          base.id,
          base.getModels(),
          context.stored.models
            .filter((model) => model.provider === base.id)
            .flatMap(storedModelFacts),
        );
        if (
          !(await context.publish({
            update: () => {
              overlay = restored;
            },
          }))
        ) {
          return;
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      if (context.force !== true && isFresh(context.stored, now())) return;
      const fetched = await source.fetchOverlay(base.id, base.getModels(), {
        signal: context.signal,
      });
      if (context.signal.aborted) return;
      await context.publish({
        persist: {
          models: fetched.models,
          checkedAt: now(),
          ...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
          ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
        },
        update: () => {
          overlay = fetched.models;
        },
      });
    },
  };
}

/**
 * Wrap every static provider in the collection.
 *
 * A provider that already implements `refreshModels` (radius) is dynamic in
 * its own right and owns its own feed; wrapping it would clobber a contract
 * pi wrote, so it is left alone.
 */
export function attachRefreshableCatalog(
  models: MutableModels,
  source: CatalogSource,
  options: RefreshableCatalogOptions = {},
): void {
  for (const provider of models.getProviders()) {
    if (provider.refreshModels !== undefined) continue;
    models.setProvider(withRefreshableCatalog(provider, source, options));
  }
}

function mergeCatalog(
  providerId: string,
  baseline: readonly Model<Api>[],
  overlay: readonly Model<Api>[],
): Model<Api>[] {
  const merged = [...baseline];
  for (const model of overlay) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  const superseded = SUPERSEDED_MODEL_IDS[providerId];
  if (superseded === undefined) return merged;
  const present = new Set(merged.map((model) => model.id));
  return merged.filter((model) => {
    const canonicalId = superseded[model.id];
    return canonicalId === undefined || !present.has(canonicalId);
  });
}

function isFresh(stored: Readonly<ModelsStoreEntry> | undefined, at: number): boolean {
  return stored?.checkedAt !== undefined && at - stored.checkedAt < CATALOG_FRESH_MS;
}

export interface ModelsDevSourceOptions {
  /** The catalogue document to read. Defaults to {@link MODELS_DEV_URL}. */
  url?: string;
  /** Injectable transport for tests; the product uses the global `fetch`. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  memoMs?: number;
  /** Injectable response bound for deterministic tests. */
  maxBodyBytes?: number;
  now?: () => number;
}

interface FetchedDocument {
  document: Record<string, unknown>;
  etag?: string;
  lastModified?: number;
  at: number;
}

/**
 * The models.dev catalogue as a {@link CatalogSource}.
 *
 * One GET per burst: the first caller starts the request, everyone else in the
 * memo window shares its result, and each caller slices its own provider out
 * of the shared document. The request runs on its own timeout signal rather
 * than any caller's — pi supersedes per-provider refreshes with per-provider
 * aborts, and one provider's superseded refresh must not kill the document
 * thirty-eight others are waiting on. Each caller still honours its own
 * signal by racing it against the shared fetch.
 */
export function modelsDevCatalogSource(options: ModelsDevSourceOptions = {}): CatalogSource {
  const url = options.url ?? MODELS_DEV_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const memoMs = options.memoMs ?? MEMO_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const now = options.now ?? Date.now;
  let memo: FetchedDocument | undefined;
  let inFlight: Promise<FetchedDocument> | undefined;

  const load = (): Promise<FetchedDocument> => {
    if (memo !== undefined && now() - memo.at < memoMs) return Promise.resolve(memo);
    if (inFlight !== undefined) return inFlight;
    const request = (async (): Promise<FetchedDocument> => {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Model catalog fetch failed: HTTP ${response.status} from ${url}.`);
      }
      const text = await response.text();
      if (text.length > maxBodyBytes) {
        throw new Error(`Model catalog at ${url} exceeds the readable size bound.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Never quote the body: it is third-party bytes and V8's own parse
        // error would echo the offending source text into a message.
        throw new Error(`Model catalog at ${url} is not readable JSON.`);
      }
      if (!isRecord(parsed)) throw new Error(`Model catalog at ${url} is not a provider map.`);
      const lastModifiedHeader = response.headers.get("last-modified");
      const lastModified =
        lastModifiedHeader === null ? Number.NaN : Date.parse(lastModifiedHeader);
      return {
        document: parsed,
        etag: response.headers.get("etag") ?? undefined,
        ...(Number.isNaN(lastModified) ? {} : { lastModified }),
        at: now(),
      };
    })();
    const shared = request.then((result) => {
      memo = result;
      return result;
    });
    inFlight = shared;
    void shared
      .catch(() => undefined)
      .then(() => {
        inFlight = undefined;
      });
    return shared;
  };

  return {
    fetchOverlay: async (providerId, baseline, context) => {
      const loaded = await raceSignal(load(), context.signal);
      return {
        models: materializeCatalog(
          providerId,
          baseline,
          modelsDevCatalogFacts(providerId, baseline, loaded.document),
        ),
        ...(loaded.etag === undefined ? {} : { etag: loaded.etag }),
        ...(loaded.lastModified === undefined ? {} : { lastModified: loaded.lastModified }),
      };
    },
  };
}

/**
 * One provider's factual updates, derived from the models.dev document.
 *
 * Exported for tests: this is the whole feed-to-facts policy in one pure
 * function, and the tests pin the ticket's factual cases directly. Executable
 * materialization is tested through {@link modelsDevCatalogSource} instead.
 */
export function modelsDevCatalogFacts(
  providerId: string,
  baseline: readonly Model<Api>[],
  document: unknown,
): CatalogModelFacts[] {
  if (!isRecord(document)) return [];
  const provider = document[providerId];
  const listed = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined;
  if (listed === undefined) return [];
  const byId = new Map(baseline.map((model) => [model.id, model]));
  const facts: CatalogModelFacts[] = [];
  for (const [id, raw] of Object.entries(listed)) {
    if (facts.length >= MAX_OVERLAY_MODELS) break;
    if (!isRecord(raw) || !producesText(raw)) continue;
    const existing = byId.get(id);
    const modelFacts = existing === undefined ? addedFacts(id, raw) : refreshedFacts(existing, raw);
    if (modelFacts !== undefined) facts.push(modelFacts);
  }
  return facts;
}

/** A known model with only feed-owned catalogue facts refreshed. */
function refreshedFacts(
  model: Model<Api>,
  entry: Record<string, unknown>,
): CatalogModelFacts | undefined {
  const limit = isRecord(entry.limit) ? entry.limit : undefined;
  const current = catalogFactsOf(model);
  const updated: CatalogModelFacts = {
    ...current,
    name: nonEmptyString(entry.name) ?? current.name,
    cost: costOf(entry) ?? current.cost,
    contextWindow: positiveInteger(limit?.context) ?? current.contextWindow,
    maxTokens: positiveInteger(limit?.output) ?? current.maxTokens,
    input: inputsOf(entry) ?? current.input,
  };
  return sameCatalogFacts(current, updated) ? undefined : updated;
}

/** A new catalogue candidate; executable protocol is admitted separately. */
function addedFacts(id: string, entry: Record<string, unknown>): CatalogModelFacts | undefined {
  const cost = costOf(entry);
  const limit = isRecord(entry.limit) ? entry.limit : undefined;
  const contextWindow = positiveInteger(limit?.context);
  const maxTokens = positiveInteger(limit?.output);
  const input = inputsOf(entry);
  if (
    cost === undefined ||
    contextWindow === undefined ||
    maxTokens === undefined ||
    input === undefined
  ) {
    return undefined;
  }
  return {
    id,
    name: nonEmptyString(entry.name) ?? id,
    input,
    cost,
    contextWindow,
    maxTokens,
  };
}

/** Materialize feed/store facts only through today's exact executable protocol. */
function materializeCatalog(
  providerId: string,
  baseline: readonly Model<Api>[],
  facts: readonly CatalogModelFacts[],
): Model<Api>[] {
  const baselineById = new Map(baseline.map((model) => [model.id, model]));
  const pins = PINNED_MODEL_PROTOCOLS[providerId];
  const materialized: Model<Api>[] = [];
  for (const entry of facts) {
    const protocol = baselineById.get(entry.id) ?? pins?.[entry.id];
    if (protocol === undefined) continue;
    materialized.push({ ...protocol, ...entry });
  }
  return materialized;
}

function catalogFactsOf(model: Model<Api>): CatalogModelFacts {
  return {
    id: model.id,
    name: model.name,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/** Invalid legacy/cache entries fail closed rather than becoming runnable protocol. */
function storedModelFacts(model: Model<Api>): CatalogModelFacts[] {
  const id = nonEmptyString(model.id);
  const name = nonEmptyString(model.name);
  const input = inputsOf({ modalities: { input: model.input } });
  const cost = storedCost(model.cost);
  const contextWindow = positiveInteger(model.contextWindow);
  const maxTokens = positiveInteger(model.maxTokens);
  if (
    id === undefined ||
    name === undefined ||
    input === undefined ||
    cost === undefined ||
    contextWindow === undefined ||
    maxTokens === undefined
  ) {
    return [];
  }
  return [{ id, name, input, cost, contextWindow, maxTokens }];
}

function storedCost(value: unknown): ModelCost | undefined {
  if (!isRecord(value)) return undefined;
  const input = rate(value.input);
  const output = rate(value.output);
  const cacheRead = rate(value.cacheRead);
  const cacheWrite = rate(value.cacheWrite);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const tiers = storedTiers(value.tiers);
  return tiers === null
    ? undefined
    : { input, output, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) };
}

function storedTiers(value: unknown): ModelCostTier[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const tiers: ModelCostTier[] = [];
  for (const tier of value) {
    if (!isRecord(tier)) return null;
    const input = rate(tier.input);
    const output = rate(tier.output);
    const cacheRead = rate(tier.cacheRead);
    const cacheWrite = rate(tier.cacheWrite);
    const inputTokensAbove = positiveInteger(tier.inputTokensAbove);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      inputTokensAbove === undefined
    ) {
      return null;
    }
    tiers.push({ input, output, cacheRead, cacheWrite, inputTokensAbove });
  }
  return tiers;
}

/** Price mapping is all-or-nothing: a cost with unmappable tiers is no cost. */
function costOf(entry: Record<string, unknown>): ModelCost | undefined {
  const cost = isRecord(entry.cost) ? entry.cost : undefined;
  if (cost === undefined) return undefined;
  const input = rate(cost.input);
  const output = rate(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const tiers = tiersOf(cost.tiers);
  if (tiers === null) return undefined;
  return {
    input,
    output,
    cacheRead: rate(cost.cache_read) ?? 0,
    cacheWrite: rate(cost.cache_write) ?? 0,
    ...(tiers === undefined ? {} : { tiers }),
  };
}

/**
 * models.dev spells a pricing tier `{ ..., tier: { type: "context", size } }`;
 * pi spells it `{ ..., inputTokensAbove }`. Null means "present but not
 * translatable", which {@link costOf} treats as distrust of the whole price.
 */
function tiersOf(value: unknown): ModelCostTier[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const tiers: ModelCostTier[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const input = rate(raw.input);
    const output = rate(raw.output);
    const tier = isRecord(raw.tier) ? raw.tier : undefined;
    const size = positiveInteger(tier?.size);
    if (input === undefined || output === undefined) return null;
    if (tier?.type !== "context" || size === undefined) return null;
    tiers.push({
      input,
      output,
      cacheRead: rate(raw.cache_read) ?? 0,
      cacheWrite: rate(raw.cache_write) ?? 0,
      inputTokensAbove: size,
    });
  }
  return tiers;
}

/** A model whose output is not text is not a chat model; leave it out. */
function producesText(entry: Record<string, unknown>): boolean {
  const modalities = isRecord(entry.modalities) ? entry.modalities : undefined;
  const output = modalities?.output;
  return !Array.isArray(output) || output.includes("text");
}

function inputsOf(entry: Record<string, unknown>): ("text" | "image")[] | undefined {
  const modalities = isRecord(entry.modalities) ? entry.modalities : undefined;
  const input = modalities?.input;
  if (!Array.isArray(input)) return undefined;
  const kept = [
    ...new Set(
      input.filter((value): value is "text" | "image" => value === "text" || value === "image"),
    ),
  ];
  return kept.length > 0 ? kept : undefined;
}

function sameCatalogFacts(a: CatalogModelFacts, b: CatalogModelFacts): boolean {
  return (
    a.name === b.name &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    sameCost(a.cost, b.cost) &&
    sameInputs(a.input, b.input)
  );
}

function sameCost(a: ModelCost, b: ModelCost): boolean {
  return costKey(a) === costKey(b);
}

function costKey(cost: ModelCost): string {
  return JSON.stringify([
    cost.input,
    cost.output,
    cost.cacheRead,
    cost.cacheWrite,
    ...(cost.tiers ?? []).map((tier) => [
      tier.input,
      tier.output,
      tier.cacheRead,
      tier.cacheWrite,
      tier.inputTokensAbove,
    ]),
  ]);
}

function sameInputs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The catalog cache, as a {@link ModelsStore}.
 *
 * `{ "<providerId>": ModelsStoreEntry }`, whole-file, beside `auth.json`. The
 * differences from `PiFileCredentialStore` are all deliberate: no advisory
 * lock, because no other process shares this file's write discipline and the
 * worst concurrent outcome is a lost cache update the next refresh repeats;
 * tolerant reads, because a cache that cannot be read is simply empty and
 * heals itself, where credentials that cannot be read are a state worth
 * failing loudly over. Writes stay whole-file atomic renames — a torn file
 * would read as garbage, and garbage reads as empty, but there is no reason
 * to ever produce one. Entries another version wrote in a shape this one
 * cannot read are dropped individually rather than fatally.
 */
export class PiFileModelsStore implements ModelsStore {
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async read(
    providerId: string,
    options?: ModelsStoreOperationOptions,
  ): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.#load())[providerId];
  }

  write(
    providerId: string,
    entry: ModelsStoreEntry,
    options?: ModelsStoreOperationOptions,
  ): Promise<void> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      const stored = await this.#load();
      await this.#save({ ...stored, [providerId]: entry });
    });
  }

  delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    return this.#serialize(async () => {
      options?.signal?.throwIfAborted();
      const stored = await this.#load();
      if (stored[providerId] === undefined) return;
      const { [providerId]: _removed, ...rest } = stored;
      await this.#save(rest);
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    // As in the credential store: a failed pass must not poison the chain, and
    // the caller gets the rejection while the tail stays settled.
    const run = this.#chain.then(work, work);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<Record<string, ModelsStoreEntry>> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch {
      // Missing or unreadable is the same empty cache; the next refresh fills it.
      return {};
    }
    return readCatalogFile(text) ?? {};
  }

  async #save(stored: Record<string, ModelsStoreEntry>): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(stored, null, 2), "utf8");
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function readCatalogFile(text: string): Record<string, ModelsStoreEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stored: Record<string, ModelsStoreEntry> = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    const entry = asStoreEntry(value);
    if (entry !== undefined) stored[providerId] = entry;
  }
  return stored;
}

/**
 * Minimal shape checks, then trust: this store reads back what pi's own
 * `publish` wrote through it, the same stance the credential store takes with
 * `asCredential`. A list element that is not recognizably a model is dropped;
 * validators with the wrong type are dropped; a `models`-less entry is not an
 * entry.
 */
function asStoreEntry(value: unknown): ModelsStoreEntry | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
  const models = value.models.filter(
    (model): model is Model<Api> =>
      isRecord(model) && typeof model.id === "string" && typeof model.provider === "string",
  );
  return {
    models,
    ...(typeof value.checkedAt === "number" ? { checkedAt: value.checkedAt } : {}),
    ...(typeof value.lastModified === "number" ? { lastModified: value.lastModified } : {}),
    ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
  };
}

/**
 * Resolve with the shared promise, or reject when this caller's own refresh is
 * superseded — without cancelling the fetch other callers still await. The
 * shared promise always has handlers attached here, so an abandoned fetch's
 * rejection is never unhandled.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Model catalog fetch was aborted");
  error.name = "AbortError";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
