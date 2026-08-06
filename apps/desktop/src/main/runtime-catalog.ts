import type Database from "better-sqlite3";
import type { NativeProbeContext, NativeProbeResult, RuntimeCatalog } from "@volli/session-engine";
import {
  MAX_RUNTIME_PREFERENCE_MODELS,
  type RuntimeCatalogAgent,
  type RuntimeCatalogModel,
  type RuntimeCatalogProvider,
  type RuntimeModelRef,
  type RuntimePreferences,
  type RuntimeSelection,
} from "@volli/shared";

import { setAppState } from "./db/app-state-repo";
import { prepared } from "./db/prepared";
import { getProjectRuntimeRecord, setProjectRuntimeRecord } from "./db/projects-repo";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const MAX_CURATED_AGENTS = 50;
const MAX_MODEL_VARIANTS = 20;

export interface RuntimeCatalogDiscoveryAdapter {
  id: string;
  profileId: string;
  discover(context: NativeProbeContext, signal: AbortSignal): Promise<NativeProbeResult>;
}

export interface RuntimeCatalogOptions {
  db: Database.Database;
  directory: string;
  adapters: readonly RuntimeCatalogDiscoveryAdapter[];
  now?: () => number;
}

interface DiscoverySnapshot {
  observedAt: number;
  result: NativeProbeResult;
}

interface StoredRuntimeRecord {
  preferences: RuntimePreferences;
  observedAt: number;
  models: readonly RuntimeCatalogModel[];
  agents: readonly RuntimeCatalogAgent[];
}

/** A stored record plus WHICH scope produced it — the view's `preferencesOrigin`. */
interface LoadedRuntimeRecord {
  record: StoredRuntimeRecord;
  origin: "global" | "project";
}

/**
 * Owns exhaustive provider discovery, bounded Settings browsing, and compact
 * runtime preferences. Callers never receive the adapter's raw catalog.
 *
 * SCOPE IS A PARAMETER, not construction. A `projectId` on a request selects
 * which stored record answers it; the catalog INSTANCE is still keyed by
 * project directory alone (`runtime-catalog-hub.ts`), so two projects sharing a
 * checkout share one instance — and one instance answers for whichever project
 * is asking. Injecting the scope at construction instead would give those two
 * projects one preferences store between them, which is precisely the collision
 * the per-project column exists to end.
 */
export function createRuntimeCatalog(options: RuntimeCatalogOptions): RuntimeCatalog {
  const now = options.now ?? Date.now;
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  const snapshots = new Map<string, DiscoverySnapshot>();
  const pending = new Map<string, Promise<DiscoverySnapshot>>();

  const discover = async (adapterId: string, refresh = false): Promise<DiscoverySnapshot> => {
    const adapter = adapters.get(adapterId);
    if (!adapter) throw new Error(`Runtime catalog adapter ${adapterId} was not found`);
    const cached = snapshots.get(adapterId);
    if (cached && !refresh) return cached;
    const inFlight = pending.get(adapterId);
    if (inFlight && !refresh) return inFlight;
    const request = adapter
      .discover(
        { profileId: adapter.profileId, directory: options.directory },
        new AbortController().signal,
      )
      .then((result) => {
        const snapshot = { observedAt: now(), result };
        snapshots.set(adapterId, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (pending.get(adapterId) === request) pending.delete(adapterId);
      });
    pending.set(adapterId, request);
    return request;
  };

  return {
    async inspect(input) {
      const snapshot = await discover(input.adapterId, input.refresh);
      const catalog = capabilityCatalog(snapshot.result);
      const stored = loadStoredRecord(options.db, input.adapterId, input.projectId);
      const preferences = effectivePreferences(stored?.record.preferences ?? null, catalog.agents);
      const providers = providerSummaries(catalog.models, preferences.enabledModels);
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const matching = input.providerId
        ? catalog.models.filter(
            (model) =>
              model.providerId === input.providerId &&
              (query.length === 0 ||
                model.label.toLocaleLowerCase().includes(query) ||
                model.modelId.toLocaleLowerCase().includes(query)),
          )
        : [];
      const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInteger(input.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
      return {
        adapterId: input.adapterId,
        status: snapshot.result.status,
        reason: snapshot.result.status === "available" ? null : snapshot.result.reason,
        observedAt: snapshot.observedAt,
        runtimeVersion:
          snapshot.result.status === "available" ? snapshot.result.runtime.version : null,
        providers,
        models: matching.slice(offset, offset + limit),
        modelTotal: matching.length,
        preferences,
        preferencesOrigin: stored?.origin ?? "global",
      };
    },

    async save(input) {
      const normalized = normalizePreferences(input.preferences);
      const snapshot = snapshots.get(input.adapterId);
      if (!snapshot) {
        throw new Error("Inspect the Runtime Catalog before saving model preferences");
      }
      const discovered = capabilityCatalog(snapshot.result);
      // The stored `models` are THIS catalog's discovery ∩ enabled. For a
      // project-scoped save that means pinning can narrow what "inherit" was
      // showing: a model enabled app-wide but not discoverable in this checkout
      // gets no snapshot entry here, so the project cannot offer it. That is the
      // honest outcome — a checkout cannot run what it cannot see — but it is
      // the one place "Custom pins what was inherited" is not literally true.
      const enabled = new Set(normalized.enabledModels.map(modelRefKey));
      const record: StoredRuntimeRecord = {
        preferences: normalized,
        observedAt: snapshot.observedAt,
        models: discovered.models
          .filter((model) => enabled.has(modelRefKey(model)))
          .slice(0, MAX_RUNTIME_PREFERENCE_MODELS)
          .map(compactStoredModel),
        agents: discovered.agents.slice(0, MAX_CURATED_AGENTS).map(compactStoredAgent),
      };
      const payload = JSON.stringify({ recordVersion: 1, ...record });
      // Presence of `projectId` IS the scope. The two writes store the identical
      // payload, so a project override is answerable on its own rather than
      // against whatever the global record happens to hold (see migration 019).
      if (input.projectId === undefined) {
        setAppState(options.db, preferenceKey(input.adapterId), payload, now());
      } else {
        setProjectRuntimeRecord(options.db, input.projectId, input.adapterId, payload, now());
      }
      return normalized;
    },

    /**
     * Deliberately WITHOUT `save`'s "inspect first" precondition. That rule
     * exists because a save persists models out of the discovery snapshot this
     * instance is holding, and there is nothing to persist from if it never
     * discovered. A clear persists nothing — it drops the project's key and the
     * global record answers again — so requiring a probe first would refuse
     * "stop overriding this" for want of evidence it does not use.
     */
    async clear(input) {
      setProjectRuntimeRecord(options.db, input.projectId, input.adapterId, null, now());
    },

    async resolve(input) {
      const stored = loadStoredRecord(options.db, input.adapterId, input.projectId);
      if (!stored) return emptyResolvedCatalog(input.adapterId);
      const { record } = stored;
      const enabled = new Set(record.preferences.enabledModels.map(modelRefKey));
      const models = record.models.filter(
        (model) => model.state === "available" && enabled.has(modelRefKey(model)),
      );
      const selection = repairSelection(record.preferences.defaults, models, record.agents);
      return {
        adapterId: input.adapterId,
        observedAt: record.observedAt,
        catalog: {
          providers: [...new Set(models.map((model) => model.providerId))],
          models,
          agents: record.agents,
        },
        selection,
      };
    },
  };
}

function capabilityCatalog(result: NativeProbeResult): {
  models: RuntimeCatalogModel[];
  agents: RuntimeCatalogAgent[];
} {
  if (result.status !== "available") return { models: [], agents: [] };
  const models: RuntimeCatalogModel[] = [];
  const agents: RuntimeCatalogAgent[] = [];
  for (const item of result.capabilities.catalog) {
    const detail = isRecord(item.detail) ? item.detail : null;
    if (item.kind === "model" && detail) {
      const providerId = nonEmptyString(detail["providerId"]);
      const modelId = nonEmptyString(detail["modelId"]);
      if (!providerId || !modelId) continue;
      models.push({
        id: item.id,
        label: item.label,
        state: item.state,
        providerId,
        modelId,
        variants: stringArray(detail["variants"]),
      });
    } else if (item.kind === "agent") {
      agents.push({
        id: item.id,
        label: item.label,
        state: item.state,
        mode: detail ? nonEmptyString(detail["mode"]) : null,
        hidden: detail ? booleanValue(detail["hidden"]) : null,
        description: detail ? nonEmptyString(detail["description"]) : null,
      });
    }
  }
  return {
    models: models.toSorted(
      (left, right) =>
        left.providerId.localeCompare(right.providerId) || left.label.localeCompare(right.label),
    ),
    agents: agents.toSorted((left, right) => left.label.localeCompare(right.label)),
  };
}

function providerSummaries(
  models: readonly RuntimeCatalogModel[],
  enabledModels: readonly RuntimeModelRef[],
): RuntimeCatalogProvider[] {
  const enabled = new Set(enabledModels.map(modelRefKey));
  const providers = new Map<string, RuntimeCatalogModel[]>();
  for (const model of models) {
    const entries = providers.get(model.providerId) ?? [];
    entries.push(model);
    providers.set(model.providerId, entries);
  }
  return [...providers.entries()]
    .map(([id, entries]) => ({
      id,
      label: id,
      modelCount: entries.length,
      availableModelCount: entries.filter((model) => model.state === "available").length,
      enabledModelCount: entries.filter((model) => enabled.has(modelRefKey(model))).length,
    }))
    .filter((provider) => provider.availableModelCount > 0 || provider.enabledModelCount > 0)
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

function effectivePreferences(
  stored: RuntimePreferences | null,
  agents: readonly RuntimeCatalogAgent[],
): RuntimePreferences {
  if (stored) return normalizePreferences(stored);
  return {
    version: 1,
    enabledModels: [],
    defaults: {
      providerId: "",
      modelId: "",
      variant: "",
      agent: agents.find((agent) => agent.state === "available")?.id ?? "",
    },
  };
}

function emptyResolvedCatalog(adapterId: string) {
  return {
    adapterId,
    observedAt: 0,
    catalog: { providers: [], models: [], agents: [] },
    selection: { providerId: "", modelId: "", variant: "", agent: "" },
  };
}

function compactStoredModel(model: RuntimeCatalogModel): RuntimeCatalogModel {
  return {
    id: model.id,
    label: model.label,
    state: model.state,
    providerId: model.providerId,
    modelId: model.modelId,
    variants: model.variants.slice(0, MAX_MODEL_VARIANTS),
  };
}

function compactStoredAgent(agent: RuntimeCatalogAgent): RuntimeCatalogAgent {
  return {
    id: agent.id,
    label: agent.label,
    state: agent.state,
    mode: agent.mode,
    // Kept alongside `mode` because the composer's agent picker filters on both;
    // dropping it here is what let `compaction` reach the picker.
    hidden: agent.hidden,
    // Settings owns exhaustive descriptions. Chat needs only a compact mode label.
    description: null,
  };
}

function repairSelection(
  requested: RuntimeSelection,
  models: readonly RuntimeCatalogModel[],
  agents: readonly RuntimeCatalogAgent[],
): RuntimeSelection {
  const requestedModel = models.find(
    (model) => model.providerId === requested.providerId && model.modelId === requested.modelId,
  );
  const model = requestedModel ?? models[0];
  const requestedAgent = agents.find(
    (agent) => agent.id === requested.agent && agent.state === "available",
  );
  const agent = requestedAgent ?? agents.find((entry) => entry.state === "available");
  return {
    providerId: model?.providerId ?? "",
    modelId: model?.modelId ?? "",
    variant: model?.variants.includes(requested.variant)
      ? requested.variant
      : (model?.variants[0] ?? ""),
    agent: agent?.id ?? "",
  };
}

function normalizePreferences(value: RuntimePreferences): RuntimePreferences {
  const seen = new Set<string>();
  const enabledModels = value.enabledModels
    .slice(0, MAX_RUNTIME_PREFERENCE_MODELS)
    .flatMap((model) => {
      const providerId = model.providerId.trim();
      const modelId = model.modelId.trim();
      const key = modelRefKey({ providerId, modelId });
      if (!providerId || !modelId || seen.has(key)) return [];
      seen.add(key);
      return [{ providerId, modelId }];
    });
  return {
    version: 1,
    enabledModels,
    defaults: {
      providerId: value.defaults.providerId.trim(),
      modelId: value.defaults.modelId.trim(),
      variant: value.defaults.variant.trim(),
      agent: value.defaults.agent.trim(),
    },
  };
}

/**
 * The record that answers for one adapter at one scope, and which scope that
 * was. A project's own record wins; ANY reason it cannot serve — the project
 * overrides nothing for this adapter, or the row is there but no longer parses
 * — falls through to the global record rather than throwing. Both are read at
 * boot-adjacent moments with no UI to surface a failure in, and inheriting the
 * global record is survivable and visible where an exception is neither.
 */
function loadStoredRecord(
  db: Database.Database,
  adapterId: string,
  projectId?: string,
): LoadedRuntimeRecord | null {
  if (projectId !== undefined) {
    const record = parseStoredRecord(getProjectRuntimeRecord(db, projectId, adapterId));
    if (record) return { record, origin: "project" };
  }
  const record = parseStoredRecord(globalStoredRecord(db, adapterId));
  return record ? { record, origin: "global" } : null;
}

/** The global record's raw JSON — one keyed row, not the whole `app_state` table. */
function globalStoredRecord(db: Database.Database, adapterId: string): string | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(preferenceKey(adapterId));
  return row?.value ?? null;
}

function parseStoredRecord(raw: string | null): StoredRuntimeRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const preferences = parsePreferences(
      isRecord(value["preferences"]) ? value["preferences"] : value,
    );
    if (!preferences) return null;
    if (!Array.isArray(value["models"]) || !Array.isArray(value["agents"])) return null;
    const observedAt = value["observedAt"];
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return null;
    return {
      preferences,
      observedAt,
      models: value["models"].flatMap(parseStoredModel).slice(0, MAX_RUNTIME_PREFERENCE_MODELS),
      agents: value["agents"].flatMap(parseStoredAgent).slice(0, MAX_CURATED_AGENTS),
    };
  } catch {
    return null;
  }
}

function parsePreferences(value: unknown): RuntimePreferences | null {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["enabledModels"])) {
    return null;
  }
  const defaults = value["defaults"];
  if (!isRecord(defaults)) return null;
  const enabledModels = value["enabledModels"].flatMap((entry): RuntimeModelRef[] => {
    if (!isRecord(entry)) return [];
    const providerId = nonEmptyString(entry["providerId"]);
    const modelId = nonEmptyString(entry["modelId"]);
    return providerId && modelId ? [{ providerId, modelId }] : [];
  });
  const providerId = stringValue(defaults["providerId"]);
  const modelId = stringValue(defaults["modelId"]);
  const variant = stringValue(defaults["variant"]);
  const agent = stringValue(defaults["agent"]);
  if (providerId === null || modelId === null || variant === null || agent === null) return null;
  return normalizePreferences({
    version: 1,
    enabledModels,
    defaults: { providerId, modelId, variant, agent },
  });
}

function parseStoredModel(value: unknown): RuntimeCatalogModel[] {
  if (!isRecord(value)) return [];
  const id = nonEmptyString(value["id"]);
  const label = nonEmptyString(value["label"]);
  const providerId = nonEmptyString(value["providerId"]);
  const modelId = nonEmptyString(value["modelId"]);
  const state = capabilityState(value["state"]);
  if (!id || !label || !providerId || !modelId || !state) return [];
  return [
    {
      id,
      label,
      providerId,
      modelId,
      state,
      variants: stringArray(value["variants"]).slice(0, MAX_MODEL_VARIANTS),
    },
  ];
}

function parseStoredAgent(value: unknown): RuntimeCatalogAgent[] {
  if (!isRecord(value)) return [];
  const id = nonEmptyString(value["id"]);
  const label = nonEmptyString(value["label"]);
  const state = capabilityState(value["state"]);
  if (!id || !label || !state) return [];
  return [
    {
      id,
      label,
      state,
      mode: nonEmptyString(value["mode"]),
      hidden: booleanValue(value["hidden"]),
      description: null,
    },
  ];
}

function capabilityState(value: unknown): RuntimeCatalogModel["state"] | null {
  return value === "available" || value === "unavailable" || value === "unknown" ? value : null;
}

function preferenceKey(adapterId: string): string {
  return `volli:runtime-preferences:${adapterId}`;
}

function modelRefKey(model: RuntimeModelRef): string {
  return `${model.providerId}\u0000${model.modelId}`;
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
