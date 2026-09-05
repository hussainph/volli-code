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
 * 2. {@link piDevCatalogSource} reads Pi's own provider feed — one GET per
 *    provider at `https://pi.dev/api/models/providers/<id>` — and takes its
 *    entries as **executable protocol**, not merely facts.
 *
 *    That is a deliberate change of authority from VC-135, which read
 *    models.dev and refused to let a feed set `api`, `baseUrl` or `compat`. The
 *    reasoning behind that refusal was sound and is unchanged: models.dev is a
 *    community catalogue that cannot know how a request is shaped —
 *    `thinkingLevelMap` values in the wild are provider-private strings
 *    (`"HIGH"`, `"default"`, `"none"`), so a generic feed can supply facts and
 *    only pi can supply protocol. What changed is the feed, not the standard.
 *    pi.dev is published by the same maintainers whose code this process
 *    already executes from npm; it is the feed Pi's own `pi update --models`
 *    applies verbatim through `withRemoteCatalog`; and its entries are
 *    literally pi-ai's `Model<Api>`, field for field. This is the executable
 *    protocol VC-135 concluded "only pi can supply", with pi supplying it, and
 *    believing it is strictly less trusting than running the package that
 *    serves it.
 *
 *    Trusting the publisher is not trusting the transport, so one thing the
 *    feed may not do is move traffic. A {@link redirectionGuard} admits an
 *    entry only when its `api` is one the provider's baseline already speaks
 *    and its `baseUrl` origin is one the baseline already reaches. (Sets, not
 *    single values: `opencode-go` alone serves three APIs across two origins,
 *    so "the provider's api" is not a well-defined thing to compare against.)
 *    A rejected entry is withheld and counted in `rejected`; the baseline model
 *    it would have replaced stays. The feed can therefore add models, correct
 *    prices, widen a thinking ladder and turn on `compat` flags, and cannot
 *    point any of it at another host — which is the one failure a compromised
 *    or mistaken feed could otherwise cause that a person could not see.
 *
 *    The `api` half of that guard has a measured price, recorded here so a
 *    future loosening starts from evidence. Across all 39 providers on
 *    2026-09-05 it withheld exactly 15 entries, all on `openrouter`, where
 *    pi.dev now serves the Anthropic models as `anthropic-messages` and the
 *    pinned baseline still speaks only `openai-completions`. Fourteen are
 *    baseline ids that keep working on their baseline shape; one
 *    (`anthropic/claude-fable-5.1`) is a genuinely new model that waits for a
 *    bump. A protocol switch changes the entire request encoding, so making it
 *    deliberate is the intent rather than a side effect — but it is the one
 *    place this guard costs a model rather than only forbidding a redirect.
 *
 *    Authority still runs one way only, on the same reasoning as VC-135 and one
 *    new one. A baseline id the feed omits is kept, because the staleness rule
 *    below establishes that the built-in catalog may legitimately be *newer*
 *    than the feed — so feed silence about an id is not evidence the model went
 *    away, and Pi's own overlay merges rather than replaces for the same
 *    reason. A refreshed-only id has no such backing: it exists because the
 *    feed listed it, so the feed dropping it is exactly the removal signal, and
 *    it is gone by not being rebuilt. Renames stay explicit, through
 *    {@link supersededModelId}. Because the merge base is always the baseline,
 *    "never empty a provider a person is using" is structural here rather than
 *    a special case, and an empty published list is failed outright.
 *
 *    Mirroring Pi, a feed whose `Last-Modified` is not newer than
 *    `getBuiltinModelDataGeneratedAt()` is ignored entirely, so a stale feed
 *    cannot roll a fresher pi-ai bump backwards. A feed that states no
 *    `Last-Modified` says nothing about its own age and is read normally.
 *
 *    models.dev is retired rather than kept alongside. Measured 2026-09-05,
 *    `https://pi.dev/api/models/providers` returns exactly the 39 provider ids
 *    this module wraps — the same set, in the same order — including
 *    `openai-codex`, which models.dev has never carried at all. There is no
 *    uncovered remainder to keep a second source of truth alive for.
 *
 * 3. {@link PiFileModelsStore} makes complete refreshed lists durable beside
 *    Pi's own `auth.json`. Every execution/inspection path awaits restore before
 *    its first model lookup. Exact baseline ids are rebased onto current Pi
 *    protocol; refreshed-only ids restore only with this policy version's
 *    admission proof *and* a fresh pass through the same redirection guard,
 *    because a cache outlives the fetch that filled it and a bump can retire
 *    the origin an entry was admitted against. The complete-list format marker
 *    also distinguishes new
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
 * **The feed is untrusted data, and trusting its publisher does not change
 * that.** Believing pi.dev's protocol is a judgement about who authors the
 * catalogue; it says nothing about what arrives over a socket. So every field
 * is type-checked before use and the resulting `Model` is built field by field
 * from an allowlist rather than spread from response bytes; entries that fail
 * are skipped rather than fatal; `compat`, `headers` and `samplingParams` are
 * accepted only as bounded inert JSON with no prototype-shaped keys; the body
 * and the entry count are bounded; and no error message ever quotes a
 * response byte.
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
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";

/** Pi's per-provider catalog feed; one document per provider id. */
export const PI_DEV_PROVIDERS_URL = "https://pi.dev/api/models/providers";

/**
 * A wedged catalog fetch may not hold the Refresh button's snapshot open.
 *
 * Pi's own `withRemoteCatalog` allows 4s per attempt. This is deliberately
 * more generous: pi retries on its own schedule across later runs, where this
 * is one press of a button whose only failure display is a Retry beside the
 * provider, so a timeout that fires on a slow link costs more here than the
 * extra seconds do.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** A non-forced refresh within this window trusts the persisted list. */
const CATALOG_FRESH_MS = 60 * 60 * 1000;

/** Upper bound on one provider's response. A provider slice is tens of KB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Upper bound on complete entries per provider; a feed gone wrong stays bounded. */
const MAX_PROVIDER_MODELS = 1_000;

/**
 * Bounds on the opaque JSON this module will carry into a runtime model.
 *
 * `compat` and `samplingParams` are read without knowing their vocabulary (see
 * {@link feedInertRecord}), so what stands in for a schema is a ceiling: deep
 * enough for pi's most nested real shape — `compat.openRouterRouting.order[]`
 * is three — with room to spare, and wide enough that no honest entry comes
 * near it.
 */
const MAX_INERT_DEPTH = 6;
const MAX_INERT_NODES = 512;

/** Keys that read as a prototype rather than as data, wherever they appear. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Bump whenever provider-level admission semantics change incompatibly.
 * Refreshed-only models carry this proof into the cache; restore accepts no
 * executable protocol minted by another version of the policy.
 *
 * 1 — VC-135: models.dev facts materialized through a Pi protocol class.
 * 2 — VC-255: pi.dev protocol behind the redirection guard. A model admitted
 *     under 1 was minted by inference from a community catalogue, which is not
 *     what this version means by admitted, so those cache entries do not
 *     restore and are simply re-fetched.
 */
const PROTOCOL_ADMISSION_VERSION = 2;
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

type ThinkingLevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

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
 * There is nothing for this provider to apply, and that is not a failure.
 *
 * The difference is the whole point. Under models.dev this covered a provider
 * the document did not carry — `openai-codex` had no entry at all, so every
 * refresh raised a provider error and Model Access offered a Retry that could
 * never succeed. pi.dev covers every wrapped provider, so the surviving cases
 * are a feed that answers 404/501 for an id and a feed older than the built-in
 * catalog. Both mean the same thing operationally: keep what is already there,
 * report neither success nor failure, and ask nobody to fix anything.
 *
 * The reason is carried so a log line says which of the two happened; the
 * behaviour is identical either way.
 */
export class CatalogSourceAbsent extends Error {
  constructor(providerId: string, reason = "publishes no list") {
    super(`Model catalog ${reason} for provider ${providerId}.`);
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

export interface PiDevSourceOptions {
  /** The provider-feed base URL. Defaults to {@link PI_DEV_PROVIDERS_URL}. */
  baseUrl?: string;
  /** Injectable transport for tests; the product uses the global `fetch`. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Injectable response bound for deterministic tests. */
  maxBodyBytes?: number;
  /** Per-provider list bound; exceeding it fails instead of truncating. */
  maxProviderModels?: number;
  /**
   * When the running pi-ai's built-in catalogs were generated. A feed no newer
   * than this is ignored, exactly as pi's own overlay ignores it.
   */
  builtinGeneratedAt?: () => number | undefined;
}

/** The last body this process accepted for one provider, and its validators. */
interface CachedProviderFeed {
  entries: Record<string, unknown>;
  etag?: string;
  lastModified?: number;
}

/**
 * Pi's provider feed as a {@link CatalogSource}.
 *
 * One GET per provider, on the caller's own signal joined to a timeout. The
 * documents are per-provider and small, so there is nothing for a refresh burst
 * to share and no reason for one provider's superseded refresh to disturb
 * another's request — which is what the shared-document memo and its
 * signal-racing existed to arrange, and why neither is here any more.
 *
 * The last accepted body is kept per provider so `If-None-Match` has something
 * to revalidate and a 304 can be answered without a second copy of the bytes.
 * That cache holds only bodies that already passed the staleness rule, so a
 * revalidation can never bring an ignored feed back.
 */
export function piDevCatalogSource(options: PiDevSourceOptions = {}): CatalogSource {
  const base = (options.baseUrl ?? PI_DEV_PROVIDERS_URL).replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxProviderModels = options.maxProviderModels ?? MAX_PROVIDER_MODELS;
  const builtinGeneratedAt = options.builtinGeneratedAt ?? getBuiltinModelDataGeneratedAt;
  const cached = new Map<string, CachedProviderFeed>();

  return {
    fetchCatalog: async (providerId, baseline, context) => {
      const previous = cached.get(providerId);
      const response = await fetchFn(`${base}/${encodeURIComponent(providerId)}`, {
        headers: {
          accept: "application/json",
          ...(previous?.etag === undefined ? {} : { "if-none-match": previous.etag }),
        },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      });
      // Pi's own overlay reads these two as "no feed here" rather than as a
      // failure, and so does this: the provider keeps the catalog pi ships.
      if (response.status === 404 || response.status === 501) {
        throw new CatalogSourceAbsent(providerId);
      }
      let feed: CachedProviderFeed;
      if (response.status === 304) {
        // A validator is only ever sent while the body behind it is still held,
        // so a 304 with nothing cached is a broken intermediary rather than an
        // unchanged catalog, and guessing which would be worse than failing.
        if (previous === undefined) {
          throw new Error(`Model catalog for ${providerId} answered 304 with nothing cached.`);
        }
        feed = previous;
      } else {
        if (!response.ok) {
          throw new Error(
            `Model catalog fetch failed: HTTP ${response.status} for provider ${providerId}.`,
          );
        }
        feed = await readProviderFeed(providerId, response, maxBodyBytes);
      }
      // Pi's staleness rule: a feed no newer than the catalog compiled into the
      // running package cannot be evidence of anything the package lacks, so a
      // lagging feed may not undo a bump. A feed that states no `Last-Modified`
      // has made no claim about its age and is read normally.
      const generatedAt = builtinGeneratedAt();
      if (
        feed.lastModified !== undefined &&
        generatedAt !== undefined &&
        feed.lastModified <= generatedAt
      ) {
        throw new CatalogSourceAbsent(providerId, "is older than the built-in catalog");
      }
      if (Object.keys(feed.entries).length > maxProviderModels) {
        throw new Error(`Model catalog for ${providerId} exceeds the model-count bound.`);
      }
      const { models, rejected } = admitPiDevCatalog(providerId, baseline, feed.entries);
      // The floor from VC-135, kept as an assertion rather than a mechanism:
      // the merge below always retains the baseline, so the only way here is a
      // provider pi itself ships empty, and publishing that would replace a
      // usable cached list with nothing.
      if (models.length === 0) {
        throw new Error(`Model catalog for ${providerId} would publish an empty list.`);
      }
      cached.set(providerId, feed);
      return {
        models,
        rejected,
        ...(feed.etag === undefined ? {} : { etag: feed.etag }),
        ...(feed.lastModified === undefined ? {} : { lastModified: feed.lastModified }),
      };
    },
  };
}

/** Read one provider's response into bounded, parsed, unvalidated entries. */
async function readProviderFeed(
  providerId: string,
  response: Response,
  maxBodyBytes: number,
): Promise<CachedProviderFeed> {
  // Refuse an oversized body before buffering it when the response says how
  // large it is, and again afterwards for the case where it lied or was silent.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new Error(`Model catalog for ${providerId} exceeds the readable size bound.`);
  }
  const text = await response.text();
  if (text.length > maxBodyBytes) {
    throw new Error(`Model catalog for ${providerId} exceeds the readable size bound.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never quote the body: it is third-party bytes and V8's own parse error
    // would echo the offending source text into a message.
    throw new Error(`Model catalog for ${providerId} is not readable JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Model catalog for ${providerId} is not a model map.`);
  }
  const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
  return {
    entries: parsed,
    ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag")! }),
    ...(Number.isNaN(lastModified) ? {} : { lastModified }),
  };
}

/**
 * Merge one provider's feed over the baseline pi ships.
 *
 * A feed entry replaces the baseline model of the same id and appends when the
 * id is new; a baseline id the feed omits is kept. An entry that fails the
 * redirection guard or any field check is withheld and counted, and the
 * baseline model it would have replaced simply stays — the feed may correct a
 * model or add one, and may never cost anyone a model that already works.
 *
 * Baseline order is preserved and new ids follow in feed order, so the picker
 * does not reshuffle itself on every refresh.
 */
function admitPiDevCatalog(
  providerId: string,
  baseline: readonly Model<Api>[],
  entries: Readonly<Record<string, unknown>>,
): { models: Model<Api>[]; rejected: number } {
  const guard = redirectionGuard(baseline);
  const baselineIds = new Set(baseline.map((model) => model.id));
  const admitted = new Map<string, Model<Api>>();
  let rejected = 0;
  for (const [id, raw] of Object.entries(entries)) {
    const model = piDevModel(providerId, id, raw, guard);
    if (model === undefined) {
      rejected += 1;
      continue;
    }
    admitted.set(id, model);
  }
  const models = baseline.map((model) => admitted.get(model.id) ?? model);
  for (const [id, model] of admitted) {
    if (!baselineIds.has(id)) models.push(model);
  }
  return { models, rejected };
}

/** Where this provider's baseline already sends requests, and how. */
interface RedirectionGuard {
  apis: ReadonlySet<string>;
  origins: ReadonlySet<string>;
}

/**
 * The redirection guard, built from the baseline pi ships.
 *
 * Sets rather than single values, because a provider is not required to speak
 * one protocol to one host: `opencode-go` alone serves three APIs across two
 * origins, so "the provider's api" would not name anything real to compare an
 * entry against. What the sets do express is the invariant worth having — the
 * feed may describe models on infrastructure this provider already talks to,
 * and may not introduce a protocol or a host of its own.
 */
function redirectionGuard(baseline: readonly Model<Api>[]): RedirectionGuard {
  const apis = new Set<string>();
  const origins = new Set<string>();
  for (const model of baseline) {
    const api = nonEmptyString(model.api);
    if (api !== undefined) apis.add(api);
    const origin = requestDestination(model.baseUrl);
    if (origin !== undefined) origins.add(origin);
  }
  return { apis, origins };
}

/**
 * Where a `baseUrl` would actually send, as a comparable destination.
 *
 * `undefined` for anything this module will not reason about, which is the
 * conservative answer everywhere it is used: an unreadable baseline `baseUrl`
 * contributes no destination, and an unreadable feed `baseUrl` matches none.
 *
 * The empty string is its own destination rather than an unreadable one, and it
 * has to be, because pi ships it: every `azure-openai-responses` model has
 * `baseUrl: ""`, since an Azure endpoint is a per-deployment resource the person
 * configures at runtime and the catalog cannot know. An empty `baseUrl` is not a
 * host — it is a deferral to that configuration — so a feed stating one
 * introduces no destination the baseline did not already defer on. Treating it
 * as unreadable instead rejected all 39 of Azure's entries and made the provider
 * permanently unrefreshable, which was measured before it was fixed.
 *
 * Embedded credentials are refused rather than normalized away, because
 * `https://user:pass@api.openai.com` has origin `https://api.openai.com` and
 * would pass an origin comparison while putting an `Authorization` header on
 * the wire that the baseline never had.
 */
function requestDestination(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.origin;
}

/**
 * One feed entry as an executable {@link Model}, or `undefined` to withhold it.
 *
 * The result is assembled field by field out of validated locals. Nothing is
 * spread from the parsed entry, so a key this module does not know about cannot
 * ride into a runtime model, and a key it does know about cannot arrive with a
 * type pi will not survive reading.
 */
function piDevModel(
  providerId: string,
  id: string,
  raw: unknown,
  guard: RedirectionGuard,
): Model<Api> | undefined {
  if (!isRecord(raw) || !safeKey(id)) return undefined;
  // An entry may restate its own identity; it may not contradict the map that
  // carries it, and it may not claim to belong to a different provider.
  if (raw.id !== undefined && raw.id !== id) return undefined;
  if (raw.provider !== undefined && raw.provider !== providerId) return undefined;

  // The guard. Every other field here is a claim about a model; these two are a
  // claim about where its requests go, and that one is not the feed's to make.
  const api = nonEmptyString(raw.api);
  const destination = requestDestination(raw.baseUrl);
  if (api === undefined || !guard.apis.has(api)) return undefined;
  if (destination === undefined || !guard.origins.has(destination)) return undefined;
  const baseUrl = raw.baseUrl as string;

  if (typeof raw.reasoning !== "boolean") return undefined;
  const input = inputModalities(raw.input);
  const cost = storedCost(raw.cost);
  const contextWindow = positiveInteger(raw.contextWindow);
  const maxTokens = positiveInteger(raw.maxTokens);
  if (input === undefined || cost === undefined) return undefined;
  if (contextWindow === undefined || maxTokens === undefined) return undefined;

  const thinkingLevelMap = feedThinkingLevelMap(raw.thinkingLevelMap);
  const headers = feedHeaders(raw.headers);
  const compat = feedInertRecord(raw.compat);
  const samplingParams = feedInertRecord(raw.samplingParams);
  if (thinkingLevelMap === null || headers === null) return undefined;
  if (compat === null || samplingParams === null) return undefined;

  return {
    id,
    name: nonEmptyString(raw.name) ?? id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: raw.reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(headers === undefined ? {} : { headers }),
    ...(compat === undefined ? {} : { compat }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
  } as Model<Api>;
}

/**
 * A feed thinking ladder: every value a level string or an explicit `null`.
 *
 * Keys are not restricted to pi's `ModelThinkingLevel`. Pi looks its ladder up
 * by known level name, so a level this build has never heard of is inert here
 * and is exactly what a bump-free catalog should be able to carry forward; an
 * allowlist would drop the next rung on the day it shipped. A value of the
 * wrong *type* is different — pi would send it — so it fails the entry.
 */
function feedThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined | null {
  const ladder = feedRecordOf(value, (entry) => entry === null || typeof entry === "string");
  return ladder === undefined || ladder === null ? ladder : (ladder as ThinkingLevelMap);
}

/** Feed headers: pi's `Model.headers` is `Record<string, string>`, exactly. */
function feedHeaders(value: unknown): Record<string, string> | undefined | null {
  const headers = feedRecordOf(value, (entry) => typeof entry === "string");
  return headers === undefined || headers === null ? headers : (headers as Record<string, string>);
}

/**
 * A bounded record whose every value passes `admits`, keyed safely.
 *
 * `undefined` for absent, `null` for present and not carryable.
 */
function feedRecordOf(
  value: unknown,
  admits: (entry: unknown) => boolean,
): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_INERT_NODES) return null;
  for (const [key, entry] of entries) {
    if (!safeKey(key) || !admits(entry)) return null;
  }
  return value;
}

/**
 * `compat` and `samplingParams`, as bounded inert JSON.
 *
 * Neither can be checked key by key from out here, and neither should be. Pi's
 * `compat` is a union of four API-specific shapes that gains keys on ordinary
 * bumps, and an allowlist would silently drop the new capability flag on the
 * day it shipped — which is the failure this whole module exists to prevent.
 * What *is* checkable without knowing the vocabulary is that the value is inert
 * data: plain JSON, finite numbers, bounded depth and node count, and no key
 * that reads as a prototype. That is enough to guarantee it can do nothing
 * except be read by the code that understands it.
 */
function feedInertRecord(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  return isInertJson(value, 0, { nodes: 0 }) ? value : null;
}

function isInertJson(value: unknown, depth: number, budget: { nodes: number }): boolean {
  if (depth > MAX_INERT_DEPTH) return false;
  budget.nodes += 1;
  if (budget.nodes > MAX_INERT_NODES) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isInertJson(entry, depth + 1, budget));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => safeKey(key) && isInertJson(entry, depth + 1, budget),
  );
}

/** A key that names data rather than a prototype, wherever it appears. */
function safeKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_KEYS.has(key);
}

/**
 * Restore a complete list before first lookup.
 *
 * Exact baseline ids are always rebased onto today's Pi protocol. A
 * refreshed-only id is accepted only when the cache says it was admitted by
 * this exact provider-level policy version and its protocol fields still pass
 * local structural validation. The cache is therefore persistence, never a
 * way for old or foreign request shape to outrank current code.
 *
 * The redirection guard is re-applied here rather than trusted from admission
 * time, and the two checks are deliberately the same code. A cache is a file on
 * disk that outlives the fetch that filled it: a pi-ai bump can retire the
 * origin an entry was admitted against, and nothing but this stops an edited
 * `models.json` from pointing a restored model at a host of its own.
 */
function restoreStoredCatalog(
  baseline: readonly Model<Api>[],
  stored: readonly Model<Api>[],
): Model<Api>[] {
  const baselineById = new Map(baseline.map((model) => [model.id, model]));
  const guard = redirectionGuard(baseline);
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
      !safeStoredProtocol(persisted, guard)
    ) {
      continue;
    }
    restored.push({ ...protocolOf(persisted), ...facts });
  }
  return restored;
}

function safeStoredProtocol(model: PersistedCatalogModel, guard: RedirectionGuard): boolean {
  const api = nonEmptyString(model.api);
  const destination = requestDestination(model.baseUrl);
  if (api === undefined || !guard.apis.has(api)) return false;
  // `""` is a destination, not a missing one — see {@link requestDestination}.
  // Reading it as missing dropped every Azure model the feed added, one restart
  // after adding them, which is the worst shape a bug like this can take.
  if (destination === undefined || !guard.origins.has(destination)) return false;
  if (typeof model.reasoning !== "boolean") return false;
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
/** Reduce one class's members to the evidence they actually agree on. */
/** Additive opt-ins at least two members corroborate; see {@link ADDITIVE_COMPAT_KEYS}. */
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

/** Whether interleaved reasoning is declared, and under which field name. */
/** Invalid legacy/cache entries fail closed rather than becoming runnable protocol. */
function storedModelFacts(model: Model<Api>): CatalogModelFacts | undefined {
  const id = nonEmptyString(model.id);
  const name = nonEmptyString(model.name);
  const input = inputModalities(model.input);
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
/** The input modalities pi models, de-duplicated; anything else is not one. */
function inputModalities(value: unknown): ("text" | "image")[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = [
    ...new Set(
      value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image"),
    ),
  ];
  return kept.length > 0 ? kept : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A price rate: any finite number, including a negative one.
 *
 * Negative is not nonsense here, it is pi's own sentinel. `openrouter/auto` and
 * `openrouter/auto-beta` ship `input: -1000000` in the built-in catalog, because
 * an auto-router's price is whatever the model it routes to charges and the
 * catalog cannot say in advance. Requiring `>= 0` therefore rejected two models
 * pi itself ships — which cost nothing visible on a refresh, since the baseline
 * kept them, and then dropped them outright on the next restart, because the
 * same validator gates {@link storedModelFacts}. Measured, then fixed.
 *
 * Being wrong about a rate misprices a usage report; it cannot malform a
 * request. That is the whole reason this field does not get the treatment the
 * protocol fields get.
 */
function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
