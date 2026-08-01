import type Database from "better-sqlite3";
import type { NativeProbeContext, NativeProbeResult, RuntimeCatalog } from "@volli/session-engine";
import type {
  RuntimeCatalogAgent,
  RuntimeCatalogModel,
  RuntimeCatalogProvider,
  RuntimeModelRef,
  RuntimePreferences,
  RuntimeSelection,
} from "@volli/shared";

import { getAllAppState, setAppState } from "./db/app-state-repo";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

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

/**
 * Owns exhaustive provider discovery, bounded Settings browsing, and compact
 * runtime preferences. Callers never receive the adapter's raw catalog.
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
      const preferences = effectivePreferences(
        loadPreferences(options.db, input.adapterId),
        catalog.models,
        catalog.agents,
      );
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
      };
    },

    async save(input) {
      const normalized = normalizePreferences(input.preferences);
      setAppState(options.db, preferenceKey(input.adapterId), JSON.stringify(normalized), now());
      return normalized;
    },

    async resolve(input) {
      const snapshot = await discover(input.adapterId);
      const catalog = capabilityCatalog(snapshot.result);
      const preferences = effectivePreferences(
        loadPreferences(options.db, input.adapterId),
        catalog.models,
        catalog.agents,
      );
      const enabled = new Set(preferences.enabledModels.map(modelRefKey));
      const models = catalog.models.filter(
        (model) => model.state === "available" && enabled.has(modelRefKey(model)),
      );
      const selection = repairSelection(preferences.defaults, models, catalog.agents);
      return {
        adapterId: input.adapterId,
        observedAt: snapshot.observedAt,
        catalog: {
          providers: [...new Set(models.map((model) => model.providerId))],
          models,
          agents: catalog.agents,
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
  models: readonly RuntimeCatalogModel[],
  agents: readonly RuntimeCatalogAgent[],
): RuntimePreferences {
  if (stored) return normalizePreferences(stored);
  const available = models.filter((model) => model.state === "available");
  const first = available[0];
  return {
    version: 1,
    enabledModels: available.map(({ providerId, modelId }) => ({ providerId, modelId })),
    defaults: {
      providerId: first?.providerId ?? "",
      modelId: first?.modelId ?? "",
      variant: first?.variants[0] ?? "",
      agent: agents.find((agent) => agent.state === "available")?.id ?? "",
    },
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
  const enabledModels = value.enabledModels.flatMap((model) => {
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

function loadPreferences(db: Database.Database, adapterId: string): RuntimePreferences | null {
  const raw = getAllAppState(db)[preferenceKey(adapterId)];
  if (!raw) return null;
  try {
    return parsePreferences(JSON.parse(raw));
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
