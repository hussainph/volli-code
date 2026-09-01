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
 *    out of it. The mapping refreshes only what the feed actually knows —
 *    cost, context window, max tokens, name, reasoning flag, input modalities
 *    — and *inherits* what only pi knows. `api`, `compat`, `baseUrl` and
 *    `thinkingLevelMap` decide how a request is shaped, and their values in
 *    the wild are provider-private strings (`"HIGH"`, `"default"`, `"none"`)
 *    that no generic feed can supply: a matched model keeps its static
 *    entry's, and a new model inherits from the static sibling whose id it
 *    most resembles (`claude-fable-5.1` from `claude-fable-5`, `glm-5.3-flash`
 *    from `glm-5.3`). A new model with no plausible sibling, no price or no
 *    window is skipped rather than guessed at — an overlay model always
 *    carries the metadata compaction and cost telemetry divide by. What this
 *    deliberately cannot catch is an API-shape flip on an *existing* model
 *    (grok's `openai-completions` → `openai-responses` in 0.84.3); that class
 *    of change names pi request code and still rides the pinned bump.
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
 * Handed the static baseline because the overlay is *derived from* it: updated
 * entries start from their static selves and new entries inherit request shape
 * from a static sibling. A provider the source has no data for yields an empty
 * overlay, which merges to exactly the static catalog.
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
    getModels: () => mergeCatalog(base.getModels(), overlay),
    refreshModels: async (context: RefreshModelsContext): Promise<void> => {
      // Restore phase: pi calls this once with network disallowed before any
      // auth resolution, which is what brings a persisted overlay back at
      // startup. Foreign entries are filtered exactly as radius filters them —
      // a store another version wrote may hold models this provider disowns.
      if (context.stored) {
        const restored = context.stored.models.filter((model) => model.provider === base.id);
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
  baseline: readonly Model<Api>[],
  overlay: readonly Model<Api>[],
): Model<Api>[] {
  const merged = [...baseline];
  for (const model of overlay) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  return merged;
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
      if (text.length > MAX_BODY_BYTES) {
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
        if (inFlight === shared) inFlight = undefined;
      });
    return shared;
  };

  return {
    fetchOverlay: async (providerId, baseline, context) => {
      const loaded = await raceSignal(load(), context.signal);
      return {
        models: modelsDevOverlay(providerId, baseline, loaded.document),
        ...(loaded.etag === undefined ? {} : { etag: loaded.etag }),
        ...(loaded.lastModified === undefined ? {} : { lastModified: loaded.lastModified }),
      };
    },
  };
}

/**
 * One provider's overlay, derived from the models.dev document.
 *
 * Exported for tests: this is the whole feed-to-`Model` policy in one pure
 * function, and the tests that pin the ticket's motivating cases (a price cut
 * on an existing model, a stealth alias renamed, a sibling-inherited new
 * model) exercise it directly.
 */
export function modelsDevOverlay(
  providerId: string,
  baseline: readonly Model<Api>[],
  document: unknown,
): Model<Api>[] {
  if (!isRecord(document)) return [];
  const provider = document[providerId];
  const listed = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined;
  if (listed === undefined) return [];
  const byId = new Map(baseline.map((model) => [model.id, model]));
  const overlay: Model<Api>[] = [];
  for (const [id, raw] of Object.entries(listed)) {
    if (overlay.length >= MAX_OVERLAY_MODELS) break;
    if (!isRecord(raw) || !producesText(raw)) continue;
    const existing = byId.get(id);
    const model =
      existing === undefined ? addedModel(baseline, id, raw) : refreshedModel(existing, raw);
    if (model !== undefined) overlay.push(model);
  }
  return overlay;
}

/**
 * A known model, with the facts the feed carries refreshed over it.
 *
 * Undefined when nothing moved, so the overlay and the persisted entry hold
 * actual differences rather than a copy of the static catalog. Request shape —
 * `api`, `baseUrl`, `compat`, `headers`, `thinkingLevelMap` — is the static
 * entry's own; the one exception is a model the feed says no longer reasons,
 * whose thinking map would otherwise advertise levels it cannot take.
 */
function refreshedModel(model: Model<Api>, entry: Record<string, unknown>): Model<Api> | undefined {
  const limit = isRecord(entry.limit) ? entry.limit : undefined;
  const updated: Model<Api> = {
    ...model,
    name: nonEmptyString(entry.name) ?? model.name,
    cost: costOf(entry) ?? model.cost,
    contextWindow: positiveInteger(limit?.context) ?? model.contextWindow,
    maxTokens: positiveInteger(limit?.output) ?? model.maxTokens,
    reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : model.reasoning,
    input: inputsOf(entry) ?? model.input,
  };
  if (!updated.reasoning) delete updated.thinkingLevelMap;
  return sameModelFacts(model, updated) ? undefined : updated;
}

/**
 * A model the static catalog has never heard of, built from a sibling.
 *
 * The sibling contributes everything the feed cannot know; the feed
 * contributes identity, price and limits, which are required — a model
 * without a price cannot be metered and a model without a window cannot be
 * compacted against, and Model Access already treats an unknown window as
 * uncompactable. No sibling, no model: guessing an API shape produces a
 * catalog entry whose every request fails, which is worse than absence.
 */
function addedModel(
  baseline: readonly Model<Api>[],
  id: string,
  entry: Record<string, unknown>,
): Model<Api> | undefined {
  const sibling = closestSibling(baseline, id);
  if (sibling === undefined) return undefined;
  const cost = costOf(entry);
  const limit = isRecord(entry.limit) ? entry.limit : undefined;
  const contextWindow = positiveInteger(limit?.context);
  const maxTokens = positiveInteger(limit?.output);
  if (cost === undefined || contextWindow === undefined || maxTokens === undefined) {
    return undefined;
  }
  const reasoning = entry.reasoning === true;
  const added: Model<Api> = {
    ...sibling,
    id,
    name: nonEmptyString(entry.name) ?? id,
    reasoning,
    input: inputsOf(entry) ?? sibling.input,
    cost,
    contextWindow,
    maxTokens,
  };
  if (!reasoning) delete added.thinkingLevelMap;
  return added;
}

/**
 * The static model whose id shares the longest prefix with the new one.
 *
 * Longest common prefix is how model families actually spell themselves —
 * `glm-5.3-flash` next to `glm-5.3`, `claude-fable-5.1` next to
 * `claude-fable-5` — and picking the closest family member matters on
 * mixed-API providers, where the wrong sibling means the wrong request shape.
 * The threshold scales down for very short ids so `o4` can still find `o3`;
 * ties prefer the closest id length, then lexicographic order, so the choice
 * is deterministic under catalog reordering.
 */
function closestSibling(baseline: readonly Model<Api>[], id: string): Model<Api> | undefined {
  const threshold = Math.min(3, Math.ceil(id.length / 2));
  let best: Model<Api> | undefined;
  let bestPrefix = 0;
  for (const model of baseline) {
    const prefix = commonPrefixLength(model.id, id);
    if (prefix < threshold || prefix < bestPrefix) continue;
    if (prefix > bestPrefix || best === undefined || closerId(model.id, best.id, id)) {
      best = model;
      bestPrefix = prefix;
    }
  }
  return best;
}

function commonPrefixLength(a: string, b: string): number {
  const bound = Math.min(a.length, b.length);
  let length = 0;
  while (length < bound && a[length] === b[length]) length++;
  return length;
}

function closerId(candidate: string, incumbent: string, id: string): boolean {
  const candidateDistance = Math.abs(candidate.length - id.length);
  const incumbentDistance = Math.abs(incumbent.length - id.length);
  if (candidateDistance !== incumbentDistance) return candidateDistance < incumbentDistance;
  return candidate < incumbent;
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

function sameModelFacts(a: Model<Api>, b: Model<Api>): boolean {
  return (
    a.name === b.name &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    a.reasoning === b.reasoning &&
    a.thinkingLevelMap === b.thinkingLevelMap &&
    sameCost(a.cost, b.cost) &&
    sameInputs(a.input, b.input)
  );
}

function sameCost(a: ModelCost, b: ModelCost): boolean {
  if (
    a.input !== b.input ||
    a.output !== b.output ||
    a.cacheRead !== b.cacheRead ||
    a.cacheWrite !== b.cacheWrite
  ) {
    return false;
  }
  const aTiers = a.tiers ?? [];
  const bTiers = b.tiers ?? [];
  return (
    aTiers.length === bTiers.length &&
    aTiers.every((tier, index) => {
      const other = bTiers[index];
      return (
        other !== undefined &&
        tier.input === other.input &&
        tier.output === other.output &&
        tier.cacheRead === other.cacheRead &&
        tier.cacheWrite === other.cacheWrite &&
        tier.inputTokensAbove === other.inputTokensAbove
      );
    })
  );
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
