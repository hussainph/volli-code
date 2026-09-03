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
 * 1. {@link withRefreshableCatalog} wraps a static built-in provider without
 *    changing auth or request dispatch. Before initialization it serves Pi's
 *    baseline; after a successful restore/refresh it serves the source's
 *    complete reconciled list, so additions, removals and renames all take
 *    effect. {@link attachRefreshableCatalog} owns the public refresh phase and
 *    its persistence directly. It does not ask Pi to resolve credentials, so a
 *    connected provider always reaches a public feed even though Pi's own
 *    dynamic-provider network phase is credential-gated.
 *
 * 2. {@link modelsDevCatalogSource} reads models.dev's `api.json`, the same
 *    catalogue Pi's generator uses. It is authoritative only for provider
 *    membership and declared facts/capabilities: id, name, cost, limits, input
 *    modalities, tool support, family, reasoning controls, interleaving,
 *    temperature and structured output. Pi remains authoritative for every
 *    executable field (`api`, `baseUrl`, `compat`, `reasoning`, headers,
 *    sampling parameters and `thinkingLevelMap`). Exact baseline joins build
 *    provider-level protocol classes from that capability tuple. A new id is
 *    admitted only when its exact class has one unanimous Pi protocol; missing
 *    or conflicting evidence is counted as unsafe and withheld. No id pin and
 *    no fuzzy sibling search participates, and per-model routing facts are
 *    stripped before a class can carry them onto another id. One whole-document
 *    GET is shared by a burst, while validation and failures stay
 *    provider-scoped.
 *
 *    Authority runs one way only. The feed may *remove* a model by no longer
 *    listing it, but it may not *disqualify* one Pi already ships: this is a
 *    community catalogue, and a row that omits `tool_call` is a gap in the data
 *    rather than proof that a working model stopped working. A provider whose
 *    admitted list would retain none of its baseline is failed instead of
 *    published, so no feed edit can empty a catalog a person is using.
 *
 * 3. {@link PiFileModelsStore} makes complete refreshed lists durable beside
 *    Pi's own `auth.json`. Every execution/inspection path awaits restore before
 *    its first model lookup. Exact baseline ids are rebased onto current Pi
 *    protocol; refreshed-only ids restore only with this policy version's
 *    admission proof. The complete-list format marker also distinguishes new
 *    caches from VC-135's legacy append-only overlays, which are migrated as
 *    overlays so an upgrade cannot accidentally erase the rest of a provider.
 *    The cache takes no credential lock and treats unreadable data as empty:
 *    atomic whole-file writes are enough for public, recoverable data.
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
 * each provider list is bounded, and no error message ever quotes response bytes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  InMemoryModelsStore,
  type Api,
  type Model,
  type ModelCost,
  type ModelCostTier,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsStore,
  type ModelsStoreEntry,
  type ModelsStoreOperationOptions,
  type MutableModels,
  type Provider,
  type RefreshModelsContext,
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

/** A non-forced refresh within this window trusts the persisted list. */
const CATALOG_FRESH_MS = 60 * 60 * 1000;

/** Upper bound on a response this module is willing to parse. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Upper bound on complete entries per provider; a feed gone wrong stays bounded. */
const MAX_PROVIDER_MODELS = 1_000;

/**
 * Bump whenever provider-level admission semantics change incompatibly.
 * Refreshed-only models carry this proof into the cache; restore accepts no
 * executable protocol minted by another version of the policy.
 */
const PROTOCOL_ADMISSION_VERSION = 1;
const PROTOCOL_ADMISSION_FIELD = "__volliProtocolAdmission";
const CATALOG_FORMAT_VERSION = 2;
const CATALOG_FORMAT_FIELD = "__volliCatalogFormat";
const CATALOG_DIAGNOSTIC = Symbol("catalog-diagnostic");

type PersistedCatalogModel = Model<Api> & { [PROTOCOL_ADMISSION_FIELD]?: number };
type PersistedCatalogEntry = ModelsStoreEntry & { [CATALOG_FORMAT_FIELD]?: number };
interface CatalogDiagnostic {
  rejected: number;
}
type ManagedCatalogProvider = Omit<Provider, "refreshModels"> & {
  refreshModels(context: RefreshModelsContext): Promise<void>;
  [CATALOG_DIAGNOSTIC]: CatalogDiagnostic;
};

/** Facts a generic catalogue may own without choosing how a request is sent. */
export type CatalogModelFacts = Pick<
  Model<Api>,
  "id" | "name" | "input" | "cost" | "contextWindow" | "maxTokens"
>;

type CatalogModelProtocol = Omit<Model<Api>, keyof CatalogModelFacts>;

/**
 * A provider-level executable protocol class.
 *
 * models.dev is authoritative for the capability tuple in
 * {@link protocolClassKey}; Pi is authoritative for how that tuple is sent.
 * Every exact baseline id present in the feed contributes its Pi protocol to
 * its class, and a new id sharing that class is minted from the evidence the
 * class agrees on. This is structural, never a fuzzy id/family-neighbour
 * search: an id that lands in no class is rejected rather than guessed at.
 *
 * The three parts are held to different standards, because they fail
 * differently:
 *
 * - {@link core} is how the request is addressed and encoded — `api`,
 *   `baseUrl`, `provider`, `reasoning`, headers, sampling, and every `compat`
 *   key that changes the wire shape or defaults to `true`. Getting one wrong
 *   produces a request the provider refuses, so the class is usable only if
 *   every member states it identically. Disagreement makes the class unusable
 *   rather than picking a winner.
 * - {@link ladder} is the thinking-level map, intersected: a level survives
 *   only where every member maps it the same way, and anything else becomes an
 *   explicit `null`. Pi reads an *absent* level as supported, so withholding
 *   has to be written down rather than omitted.
 * - {@link additive} are opt-in capability flags that pi documents
 *   `Default: false` and enables per model. A single model cannot corroborate
 *   one, so a class of one publishes none of them: the failure mode is a
 *   feature that stays off, not a request the model rejects.
 */
interface ProviderProtocolClass {
  core: CatalogModelProtocol;
  ladder: ThinkingLevelMap | undefined;
  additive: Record<string, unknown>;
  /** Core evidence disagreed; nothing may be minted from this class. */
  unusable: boolean;
}

type ThinkingLevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;
type ThinkingLevel = keyof ThinkingLevelMap;

/** Pi's thinking ladder, widest last. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

/**
 * `compat` flags a class of one may not lend out.
 *
 * Every key here is documented `Default: false` in pi's own types and is turned
 * on per model by the generated catalogue — grammar tools, tool search, extra
 * tool channels. Withholding one costs a feature; inventing one costs a request
 * the provider rejects, so an uncorroborated flag stays off.
 *
 * Deliberately absent: `forceAdaptiveThinking`, which is `Default: false` but
 * whose documentation says models that *require* the adaptive format set it —
 * omitting it malforms their requests, so it belongs to the core. Every
 * `Default: true` flag (`supportsTemperature`, `supportsToolReferences`, …) is
 * absent for the mirror-image reason: dropping one turns the behaviour *on*,
 * and `supportsTemperature: false` exists precisely because Claude Opus 4.7+
 * rejects a temperature.
 */
const ADDITIVE_COMPAT_KEYS: readonly string[] = [
  "allowEmptySignature",
  "sendSessionAffinityHeaders",
  "supportsAdditionalTools",
  "supportsExplicitPromptCacheMode",
  "supportsOpenAIGrammarTools",
  "supportsStrictTools",
  "supportsThinkingTokenBudget",
  "supportsToolSearch",
  "zaiToolStream",
];

/** Exact catalogue identity policy; applied only when the canonical id exists. */
const SUPERSEDED_MODEL_IDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "opencode-go": { "ox-alpha-free": "glm-5.3-flash" },
};

/**
 * The id this catalogue policy renamed `modelId` to, when it named one.
 *
 * The same table that hides a stale alias from the picker also tells stored
 * preferences where that alias went. A default or a hidden-row entry naming a
 * renamed model is then carried across rather than dropped on the floor: the
 * rename is a fact about the catalogue, and forgetting it would quietly cost
 * someone the model they chose.
 */
export function supersededModelId(providerId: string, modelId: string): string | undefined {
  return SUPERSEDED_MODEL_IDS[providerId]?.[modelId];
}

/**
 * Per-model facts that must never ride a protocol class onto another id.
 *
 * `allowedFallbackModels` names specific sibling models and carries their
 * prices: it is routing for one model, not the provider's wire protocol. Pi's
 * own type says Anthropic rejects `fallbacks` for a model with no permitted
 * targets, so lending a sibling's list to a new id would build a request the
 * upstream refuses. Stripping it also stops a purely per-model fact from
 * splitting an otherwise unanimous class — `claude-opus-4-8` and
 * `claude-opus-5` differ by nothing else.
 */
const MODEL_SCOPED_COMPAT_KEYS: readonly string[] = ["allowedFallbackModels"];

/**
 * The source publishes no list for this provider at all.
 *
 * Not a failure, and the difference is the whole point: models.dev has no
 * `openai-codex` provider — those models are served by the ChatGPT backend, not
 * the public API platform — so every refresh raised a provider error for it and
 * Model Access offered a Retry that could never succeed. A provider with no
 * public list simply keeps the catalog pi ships, which for it is the complete
 * and correct one. Nothing is applied, nothing failed, and nobody is asked to
 * fix it.
 *
 * Aliasing such a provider onto a neighbouring feed id was considered and
 * rejected: pi's baseline would supply the right protocol, but the neighbour's
 * membership list is wrong, and inventing models a backend does not serve is
 * the failure this ticket exists to prevent.
 */
export class CatalogSourceAbsent extends Error {
  constructor(providerId: string) {
    super(`Model catalog has no list for provider ${providerId}.`);
    this.name = "CatalogSourceAbsent";
  }
}

/** What one provider's catalog fetch may read. */
export interface CatalogFetchContext {
  /** pi's shared refresh signal — always present, honoured for blocking work. */
  signal: AbortSignal;
}

/** One fetched complete list, with the response validators worth persisting. */
export interface CatalogFetchResult {
  /** Complete admitted list; it replaces the previous provider catalog. */
  models: readonly Model<Api>[];
  /** Source ids withheld because agent capability or executable protocol was not provable. */
  rejected?: number;
  /** Opaque validator from the catalog response's ETag header, stored verbatim. */
  etag?: string;
  /** Unix timestamp (ms) from the catalog response's Last-Modified header. */
  lastModified?: number;
}

/**
 * Where a wrapped provider's complete current list comes from.
 *
 * The static baseline supplies current Pi protocol evidence. A provider the
 * source does not name fails that provider's refresh rather than publishing an
 * empty list, so an absent feed cannot erase a usable cached/baseline catalog.
 */
export interface CatalogSource {
  fetchCatalog(
    providerId: string,
    baseline: readonly Model<Api>[],
    context: CatalogFetchContext,
  ): Promise<CatalogFetchResult>;
}

/** Injectable clock, for tests that assert freshness windows. */
export interface RefreshableCatalogOptions {
  now?: () => number;
  /** Persistence used by the credential-independent public refresh path. */
  store?: ModelsStore;
}

/** Public catalogs attached to one Pi collection. */
export interface PublicCatalogRefreshResult extends ModelsRefreshResult {
  readonly rejectedByProvider: ReadonlyMap<string, number>;
  readonly refreshedProviderIds: readonly string[];
}

export interface RefreshableCatalogs {
  /** Provider ids owned by this public catalog path. */
  readonly providerIds: readonly string[];
  /** Restore persisted lists without touching a network. */
  restore(options?: Pick<ModelsRefreshOptions, "signal">): Promise<PublicCatalogRefreshResult>;
  /** Fetch selected public lists without resolving provider credentials. */
  refresh(options?: ModelsRefreshOptions): Promise<PublicCatalogRefreshResult>;
}

/**
 * A static built-in provider, given the dynamic-provider contract.
 *
 * Everything except the catalog is the base provider's own by spread: auth
 * (both objects, including their lazy OAuth loaders), `filterModels`, streams
 * and the deferred pair — the wrapped providers all come from pi's
 * `createProvider`, whose members are closures, so copying references is
 * copying behavior. Only `getModels` is overridden and `refreshModels` is
 * added as the internal restore/fetch transaction the public coordinator calls.
 */
export function withRefreshableCatalog(
  base: Provider,
  source: CatalogSource,
  options: RefreshableCatalogOptions = {},
): Provider {
  const now = options.now ?? Date.now;
  let refreshed: readonly Model<Api>[] | undefined;
  const diagnostic: CatalogDiagnostic = { rejected: 0 };
  const wrapped: ManagedCatalogProvider = {
    ...base,
    [CATALOG_DIAGNOSTIC]: diagnostic,
    // Before a successful restore/refresh the immutable Pi baseline remains
    // available. Afterwards the source's list is complete authority: retaining
    // absent baseline ids here would make removals and renames impossible.
    getModels: () => refreshed ?? base.getModels(),
    refreshModels: async (context: RefreshModelsContext): Promise<void> => {
      // Restore phase: pi calls this once with network disallowed before any
      // auth resolution, which is what brings a persisted list back at
      // startup. Foreign entries are filtered exactly as radius filters them —
      // a store another version wrote may hold models this provider disowns.
      if (context.stored) {
        // Stored Models are persistence encoding, not executable authority.
        // Exact baseline ids rebase through today's Pi; refreshed-only ids
        // require the current admission proof, so old cache bytes cannot roll
        // corrected request shape back.
        const stored = context.stored as PersistedCatalogEntry;
        const restored = restoreStoredCatalog(
          base.getModels(),
          stored.models.filter((model) => model.provider === base.id),
        );
        const complete = stored[CATALOG_FORMAT_FIELD] === CATALOG_FORMAT_VERSION;
        if (
          !(await context.publish({
            update: () => {
              refreshed = complete
                ? reconcileCatalog(base.id, restored)
                : mergeLegacyCatalog(base.id, base.getModels(), restored);
            },
          }))
        ) {
          return;
        }
      }
      if (!context.allowNetwork || context.signal.aborted) return;
      if (context.force !== true && isFresh(context.stored, now())) return;
      const fetched = await source.fetchCatalog(base.id, base.getModels(), {
        signal: context.signal,
      });
      const admitted = markCatalogAdmissions(base.getModels(), fetched.models);
      diagnostic.rejected = fetched.rejected ?? 0;
      if (context.signal.aborted) return;
      await context.publish({
        persist: {
          models: admitted,
          checkedAt: now(),
          ...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
          ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
          [CATALOG_FORMAT_FIELD]: CATALOG_FORMAT_VERSION,
        } as PersistedCatalogEntry,
        update: () => {
          refreshed = reconcileCatalog(base.id, admitted.map(withoutAdmissionMarker));
        },
      });
    },
  };
  return wrapped;
}

/**
 * Wrap every static provider in the collection.
 *
 * A provider that already implements `refreshModels` (radius) is dynamic in
 * its own right and owns its own feed; wrapping it would clobber a contract
 * pi wrote, so it is left alone.
 *
 * The returned coordinator is the intended way to drive these providers, and
 * every caller in this repository reaches them through it — both
 * `inspectPiModelAccess` and `restoreCatalogs` name the non-public ids when
 * they call Pi's own `models.refresh`. A bare unfiltered `models.refresh()`
 * would drive the wrappers through Pi's credential-gated path as well; that
 * costs a duplicate fetch and a duplicate write of identical bytes rather than
 * corrupting anything (`isFresh` absorbs the unforced case outright), but it is
 * work nobody asked for. Filter by provider id when adding a caller.
 */
export function attachRefreshableCatalog(
  models: MutableModels,
  source: CatalogSource,
  options: RefreshableCatalogOptions = {},
): RefreshableCatalogs {
  const store = options.store ?? new InMemoryModelsStore();
  const managed = new Map<string, ManagedCatalogProvider>();
  for (const provider of models.getProviders()) {
    if (provider.refreshModels !== undefined) continue;
    const wrapped = withRefreshableCatalog(provider, source, options) as ManagedCatalogProvider;
    managed.set(provider.id, wrapped);
    models.setProvider(wrapped);
  }

  const run = async (
    refreshOptions: ModelsRefreshOptions,
    allowNetwork: boolean,
  ): Promise<PublicCatalogRefreshResult> => {
    const signal = refreshOptions.signal ?? new AbortController().signal;
    if (signal.aborted) {
      return {
        aborted: true,
        errors: new Map(),
        rejectedByProvider: new Map(),
        refreshedProviderIds: [],
      };
    }
    const selected = refreshOptions.providers ? new Set(refreshOptions.providers) : undefined;
    const attempted = [...managed.values()].filter(
      (provider) => selected === undefined || selected.has(provider.id),
    );
    const errors = new Map<string, Error>();
    // Each provider reports its own rejected count back through its result.
    // Reading it off the provider after the fact would let two overlapping
    // refreshes — a second window, the CLI — answer each other's question.
    const counts = await Promise.all(
      attempted.map(async (provider): Promise<readonly [string, number] | undefined> => {
        const diagnostic = provider[CATALOG_DIAGNOSTIC];
        diagnostic.rejected = 0;
        try {
          const stored = await store.read(provider.id, { signal });
          await provider.refreshModels({
            stored,
            allowNetwork,
            force: allowNetwork ? refreshOptions.force : undefined,
            signal,
            publish: async (publication) => {
              signal.throwIfAborted();
              // This wrapper publishes either an update-only restore or one
              // complete persisted list; it never deletes its public cache.
              if (publication.persist !== undefined) {
                await store.write(provider.id, publication.persist as ModelsStoreEntry, { signal });
              }
              signal.throwIfAborted();
              publication.update!();
              return true;
            },
          });
          return [provider.id, diagnostic.rejected];
        } catch (error) {
          // A provider the source does not carry is neither refreshed nor
          // failed: it keeps pi's catalog, and reporting it would put a
          // permanent Retry beside a provider that is working fine.
          if (!signal.aborted && !(error instanceof CatalogSourceAbsent)) {
            errors.set(provider.id, error instanceof Error ? error : new Error(String(error)));
          }
          return undefined;
        }
      }),
    );
    const succeeded = counts.filter((entry) => entry !== undefined);
    return {
      aborted: signal.aborted,
      errors,
      rejectedByProvider: new Map(succeeded),
      refreshedProviderIds: succeeded.map(([providerId]) => providerId),
    };
  };

  return {
    providerIds: [...managed.keys()],
    restore: (restoreOptions = {}) => run(restoreOptions, false),
    refresh: (refreshOptions = {}) => run(refreshOptions, refreshOptions.allowNetwork ?? true),
  };
}

function markCatalogAdmissions(
  baseline: readonly Model<Api>[],
  catalog: readonly Model<Api>[],
): Model<Api>[] {
  const baselineIds = new Set(baseline.map((model) => model.id));
  return catalog.map((model) =>
    baselineIds.has(model.id)
      ? model
      : ({
          ...model,
          [PROTOCOL_ADMISSION_FIELD]: PROTOCOL_ADMISSION_VERSION,
        } as PersistedCatalogModel),
  );
}

function mergeLegacyCatalog(
  providerId: string,
  baseline: readonly Model<Api>[],
  overlay: readonly Model<Api>[],
): Model<Api>[] {
  const merged = [...baseline];
  for (const model of overlay) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
  }
  return reconcileCatalog(providerId, merged);
}

function reconcileCatalog(providerId: string, catalog: readonly Model<Api>[]): Model<Api>[] {
  const reconciled = [...catalog];
  const superseded = SUPERSEDED_MODEL_IDS[providerId];
  if (superseded === undefined) return reconciled;
  const present = new Set(reconciled.map((model) => model.id));
  return reconciled.filter((model) => {
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
  /** Per-provider complete-list bound; exceeding it fails instead of truncating. */
  maxProviderModels?: number;
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
  const maxProviderModels = options.maxProviderModels ?? MAX_PROVIDER_MODELS;
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
    fetchCatalog: async (providerId, baseline, context) => {
      const loaded = await raceSignal(load(), context.signal);
      const listed = modelsDevProviderModels(providerId, loaded.document);
      if (listed === undefined) throw new CatalogSourceAbsent(providerId);
      if (Object.keys(listed).length > maxProviderModels) {
        throw new Error(`Model catalog for ${providerId} exceeds the model-count bound.`);
      }
      const facts = modelsDevCatalogFacts(providerId, baseline, loaded.document);
      const admitted = materializeCatalog(
        baseline,
        facts,
        providerProtocolClasses(baseline, listed),
        listed,
      );
      const admittedIds = new Set(admitted.map((model) => model.id));
      const rejected = Object.keys(listed).filter((id) => !admittedIds.has(id)).length;
      return {
        models: admitted,
        rejected,
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
 * function, and the tests hold the ticket's factual cases directly. Executable
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
    if (facts.length >= MAX_PROVIDER_MODELS) break;
    if (!isRecord(raw)) continue;
    const existing = byId.get(id);
    if (!admitsCatalogEntry(raw, existing !== undefined)) continue;
    const modelFacts = existing === undefined ? addedFacts(id, raw) : refreshedFacts(existing, raw);
    if (modelFacts !== undefined) facts.push(modelFacts);
  }
  // The removal policy, in one line: the feed may only take away what it gave.
  //
  // An id pi ships and the feed omits is kept. Measured against the live
  // catalogue, dropping those retires three models that work right now —
  // `openai/gpt-5-chat-latest`, `zai/glm-5.2-highspeed` and
  // `google/gemini-robotics-er-1.6-preview` — on no better evidence than a
  // community catalogue not having got to them. A refreshed-only id has no such
  // backing: it exists because the feed listed it, so the feed dropping it is
  // exactly the removal signal, and it is gone by not being rebuilt here.
  // Renames stay explicit, through {@link supersededModelId}.
  for (const model of baseline) {
    if (facts.length >= MAX_PROVIDER_MODELS) break;
    if (!(model.id in listed)) facts.push(catalogFactsOf(model));
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
  return updated;
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
  baseline: readonly Model<Api>[],
  facts: readonly CatalogModelFacts[],
  classes: ReadonlyMap<string, ProviderProtocolClass>,
  listed: Readonly<Record<string, unknown>>,
): Model<Api>[] {
  const baselineById = new Map(baseline.map((model) => [model.id, model]));
  const materialized: Model<Api>[] = [];
  for (const entry of facts) {
    const existing = baselineById.get(entry.id);
    let protocol: CatalogModelProtocol | Model<Api> | undefined = existing;
    if (protocol === undefined) {
      // Facts are produced only from record-valued rows in this same list.
      const raw = listed[entry.id] as Record<string, unknown>;
      const classKey = protocolClassKey(raw);
      const candidate = classKey === undefined ? undefined : classes.get(classKey);
      if (candidate !== undefined && !candidate.unusable) protocol = mintProtocol(candidate, raw);
    }
    if (protocol === undefined) continue;
    materialized.push({
      ...protocol,
      ...entry,
      ...(existing === undefined ? { [PROTOCOL_ADMISSION_FIELD]: PROTOCOL_ADMISSION_VERSION } : {}),
    } as PersistedCatalogModel);
  }
  return materialized;
}

/**
 * Restore a complete list before first lookup.
 *
 * Exact baseline ids are always rebased onto today's Pi protocol. A
 * refreshed-only id is accepted only when the cache says it was admitted by
 * this exact provider-level policy version and its protocol fields still pass
 * local structural validation. The cache is therefore persistence, never a
 * way for old or foreign request shape to outrank current code.
 */
function restoreStoredCatalog(
  baseline: readonly Model<Api>[],
  stored: readonly Model<Api>[],
): Model<Api>[] {
  const baselineById = new Map(baseline.map((model) => [model.id, model]));
  const restored: Model<Api>[] = [];
  for (const model of stored) {
    const facts = storedModelFacts(model);
    if (facts === undefined) continue;
    const current = baselineById.get(facts.id);
    if (current !== undefined) {
      restored.push({ ...current, ...facts });
      continue;
    }
    const persisted = model as PersistedCatalogModel;
    if (
      persisted[PROTOCOL_ADMISSION_FIELD] !== PROTOCOL_ADMISSION_VERSION ||
      !safeStoredProtocol(persisted)
    ) {
      continue;
    }
    restored.push({ ...protocolOf(persisted), ...facts });
  }
  return restored;
}

function safeStoredProtocol(model: PersistedCatalogModel): boolean {
  if (
    nonEmptyString(model.api) === undefined ||
    nonEmptyString(model.baseUrl) === undefined ||
    typeof model.reasoning !== "boolean"
  ) {
    return false;
  }
  if (model.compat !== undefined && !isRecord(model.compat)) return false;
  if (model.headers !== undefined && !headerRecord(model.headers)) return false;
  if (model.samplingParams !== undefined && !isRecord(model.samplingParams)) return false;
  if (model.thinkingLevelMap !== undefined) {
    if (!isRecord(model.thinkingLevelMap)) return false;
    for (const value of Object.values(model.thinkingLevelMap)) {
      if (value !== null && typeof value !== "string") return false;
    }
  }
  return true;
}

function headerRecord(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => typeof entry === "string" || entry === null);
}

/** Build one provider's protocol classes from exact baseline joins. */
function providerProtocolClasses(
  baseline: readonly Model<Api>[],
  listed: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ProviderProtocolClass> {
  const members = new Map<string, Model<Api>[]>();
  for (const model of baseline) {
    const raw = listed[model.id];
    if (!isRecord(raw)) continue;
    const classKey = protocolClassKey(raw);
    if (classKey === undefined) continue;
    const group = members.get(classKey);
    if (group === undefined) members.set(classKey, [model]);
    else group.push(model);
  }
  return new Map([...members].map(([classKey, group]) => [classKey, protocolClassOf(group)]));
}

/** Reduce one class's members to the evidence they actually agree on. */
function protocolClassOf(group: readonly Model<Api>[]): ProviderProtocolClass {
  const cores = group.map(coreProtocolOf);
  const coreKey = JSON.stringify(cores[0]);
  return {
    // Every member states the same core, or nothing may be minted at all.
    core: cores[0]!,
    unusable: cores.some((core) => JSON.stringify(core) !== coreKey),
    ladder: intersectLadders(group),
    additive: corroboratedAdditive(group),
  };
}

/**
 * The part of a protocol every member of a class must state identically.
 *
 * Facts, the thinking ladder, per-model routing and the additive opt-ins are
 * all handled separately; what is left is how the request is addressed and
 * encoded, and it is not negotiable.
 */
function coreProtocolOf(model: Model<Api>): CatalogModelProtocol {
  const { thinkingLevelMap: _ladder, ...protocol } = protocolOf(model);
  if (!isRecord(protocol.compat)) return protocol;
  const compat: Record<string, unknown> = { ...protocol.compat };
  for (const key of [...MODEL_SCOPED_COMPAT_KEYS, ...ADDITIVE_COMPAT_KEYS]) delete compat[key];
  const { compat: _compat, ...rest } = protocol;
  return (Object.keys(compat).length === 0 ? rest : { ...rest, compat }) as CatalogModelProtocol;
}

/**
 * The thinking levels a whole class agrees on.
 *
 * A level survives only where every member maps it identically. Anything else
 * becomes an explicit `null`, never an omission: pi reads a *missing* entry for
 * `off`…`high` as supported, so "we could not agree" has to be written down or
 * it silently reads as "yes".
 */
function intersectLadders(group: readonly Model<Api>[]): ThinkingLevelMap | undefined {
  const ladders = group.map((model) => model.thinkingLevelMap);
  const intersected: Record<string, string | null> = {};
  let stated = false;
  for (const level of THINKING_LEVELS) {
    const values = ladders.map((ladder) => ladder?.[level]);
    const [first] = values;
    if (values.every((value) => value === first)) {
      if (first === undefined) continue;
      intersected[level] = first;
    } else {
      intersected[level] = null;
    }
    stated = true;
  }
  return stated ? (intersected as ThinkingLevelMap) : undefined;
}

/** Additive opt-ins at least two members corroborate; see {@link ADDITIVE_COMPAT_KEYS}. */
function corroboratedAdditive(group: readonly Model<Api>[]): Record<string, unknown> {
  const corroborated: Record<string, unknown> = {};
  if (group.length < 2) return corroborated;
  for (const key of ADDITIVE_COMPAT_KEYS) {
    const values = group.map((model) => (isRecord(model.compat) ? model.compat[key] : undefined));
    const [first] = values;
    if (first !== undefined && values.every((value) => value === first)) corroborated[key] = first;
  }
  return corroborated;
}

/**
 * Mint one new id's protocol from its class.
 *
 * The class supplies the ceiling; the candidate's own declared effort values
 * can only lower it. A level whose provider string the candidate does not
 * declare becomes `null` — that is how `grok-4.6` inherits `grok-4.5`'s shape
 * without claiming a rung no Pi evidence covers. A candidate that declares no
 * ladder is left with the class's, which is what its siblings run.
 */
function mintProtocol(
  candidate: ProviderProtocolClass,
  entry: Record<string, unknown>,
): CatalogModelProtocol {
  const compat = { ...(isRecord(candidate.core.compat) ? candidate.core.compat : {}) };
  for (const [key, value] of Object.entries(candidate.additive)) compat[key] = value;
  const declared = declaredEffortValues(entry);
  const ladder =
    candidate.ladder === undefined || declared === undefined
      ? candidate.ladder
      : narrowLadder(candidate.ladder, declared);
  return {
    ...candidate.core,
    ...(Object.keys(compat).length === 0 ? {} : { compat }),
    ...(ladder === undefined ? {} : { thinkingLevelMap: ladder }),
  } as CatalogModelProtocol;
}

function narrowLadder(ladder: ThinkingLevelMap, declared: ReadonlySet<string>): ThinkingLevelMap {
  const narrowed: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    const mapped = ladder[level];
    if (mapped === undefined) continue;
    narrowed[level] = mapped !== null && declared.has(mapped) ? mapped : null;
  }
  return narrowed as ThinkingLevelMap;
}

/**
 * The effort strings this row says the model accepts.
 *
 * `undefined` when the row declares no effort ladder — which is a statement
 * about the feed, not about the model, so it narrows nothing.
 */
function declaredEffortValues(entry: Record<string, unknown>): ReadonlySet<string> | undefined {
  const declared = new Set<string>();
  for (const option of reasoningOptionList(entry.reasoning_options) ?? []) {
    if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
    // The document is untrusted: a rung that is not a string names nothing the
    // provider could accept, so it cannot widen what this model may be sent.
    const rungs = option.values.filter((value) => typeof value === "string");
    for (const rung of rungs) declared.add(rung);
  }
  return declared.size > 0 ? declared : undefined;
}

function reasoningOptionList(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function withoutAdmissionMarker(model: Model<Api>): Model<Api> {
  const persisted = model as PersistedCatalogModel;
  const { [PROTOCOL_ADMISSION_FIELD]: _admission, ...runtimeModel } = persisted;
  return runtimeModel;
}

function protocolOf(model: Model<Api>): CatalogModelProtocol {
  const persisted = model as PersistedCatalogModel;
  const {
    id: _id,
    name: _name,
    input: _input,
    cost: _cost,
    contextWindow: _contextWindow,
    maxTokens: _maxTokens,
    [PROTOCOL_ADMISSION_FIELD]: _admission,
    ...protocol
  } = persisted;
  return protocol;
}

function modelsDevProviderModels(
  providerId: string,
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const provider = document[providerId];
  return isRecord(provider) && isRecord(provider.models) ? provider.models : undefined;
}

/**
 * The models.dev fields that may distinguish request behavior.
 *
 * All are capability declarations, not names guessed from an id. A model must
 * support text output and tools before it can join a coding-agent catalog.
 *
 * The key deliberately reads reasoning *shape* — which kinds of control the
 * model exposes — rather than the exact effort strings. Keying on the values
 * made the key a per-model identifier: `grok-4.6` offers
 * `low|medium|high|xhigh` where `grok-4.5` offers `low|medium|high`, and that
 * one extra string put two protocol-identical models in different classes, so
 * essentially every class held exactly one member and every genuinely new id
 * fell outside all of them. The values are not lost — {@link mintProtocol} uses
 * the candidate's own to narrow the ladder it inherits, which is the job they
 * can actually do soundly.
 *
 * `family` stays in the key. Dropping it was measured against the real feed and
 * mints wrong `api`/`baseUrl` inside `opencode-go`, which serves three
 * different APIs across two base URLs.
 */
function protocolClassKey(entry: Record<string, unknown>): string | undefined {
  if (entry.tool_call !== true || !declaresTextOutput(entry)) return undefined;
  const family = nonEmptyString(entry.family);
  if (family === undefined || typeof entry.reasoning !== "boolean") return undefined;
  const reasoningShape = reasoningControlShape(entry.reasoning_options);
  const interleaved = interleavedShape(entry.interleaved);
  if (reasoningShape === undefined || interleaved === undefined) return undefined;
  return JSON.stringify({
    family,
    reasoning: entry.reasoning,
    reasoningShape,
    interleaved,
    temperature: typeof entry.temperature === "boolean" ? entry.temperature : null,
    structuredOutput: typeof entry.structured_output === "boolean" ? entry.structured_output : null,
  });
}

/**
 * Which kinds of reasoning control a row declares, sorted and de-duplicated.
 *
 * `null` for a row that declares none. `undefined` — rejecting the row — only
 * for a shape this module cannot read at all.
 */
function reasoningControlShape(value: unknown): readonly string[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const types = new Set<string>();
  for (const option of value) {
    if (!isRecord(option)) return undefined;
    const type = nonEmptyString(option.type);
    if (type === undefined) return undefined;
    types.add(type);
  }
  return [...types].toSorted();
}

/** Whether interleaved reasoning is declared, and under which field name. */
function interleavedShape(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return "none";
  if (value === true) return "any";
  if (!isRecord(value)) return undefined;
  const field = nonEmptyString(value.field);
  return field === undefined ? "any" : `field:${field}`;
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
function storedModelFacts(model: Model<Api>): CatalogModelFacts | undefined {
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
    return undefined;
  }
  return { id, name, input, cost, contextWindow, maxTokens };
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

/**
 * Whether one feed row may hold a place in this provider's list.
 *
 * The two directions are deliberately asymmetric, because the evidence behind
 * them is. Pi already vouches that a baseline id is an executable agent model,
 * and this is a community-maintained catalogue: a row that omits `tool_call`,
 * or sets it false by mistake, is a gap in the data, not grounds to retire a
 * model that works and that somebody may have selected. Membership is the part
 * the feed genuinely owns — an id it stops listing never reaches this function
 * at all, and *that* is what removes a model.
 *
 * A new id has no Pi backing whatsoever, so it carries the whole burden: it
 * must declare tool calling and text output itself, and must not be one the
 * provider has already marked retired.
 */
function admitsCatalogEntry(entry: Record<string, unknown>, knownToPi: boolean): boolean {
  if (knownToPi) return true;
  return entry.tool_call === true && declaresTextOutput(entry) && entry.status !== "deprecated";
}

function declaresTextOutput(entry: Record<string, unknown>): boolean {
  const modalities = isRecord(entry.modalities) ? entry.modalities : undefined;
  return Array.isArray(modalities?.output) && modalities.output.includes("text");
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
    ...(value[CATALOG_FORMAT_FIELD] === CATALOG_FORMAT_VERSION
      ? { [CATALOG_FORMAT_FIELD]: CATALOG_FORMAT_VERSION }
      : {}),
  } as PersistedCatalogEntry;
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
