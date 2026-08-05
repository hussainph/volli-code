import type { SessionCapabilityState } from "./session-ledger";

/** Hard ceiling for the small user-curated model list any chat surface may receive. */
export const MAX_RUNTIME_PREFERENCE_MODELS = 50;

/** Stable model identity stored as user intent; labels and availability remain discovery facts. */
export interface RuntimeModelRef {
  providerId: string;
  modelId: string;
}

export interface RuntimeSelection {
  providerId: string;
  modelId: string;
  variant: string;
  agent: string;
}

/** The compact, versioned app preference. It never contains provider catalog payloads. */
export interface RuntimePreferences {
  version: 1;
  enabledModels: readonly RuntimeModelRef[];
  defaults: RuntimeSelection;
}

export interface RuntimeCatalogModel extends RuntimeModelRef {
  id: string;
  label: string;
  state: SessionCapabilityState;
  variants: readonly string[];
}

export interface RuntimeCatalogAgent {
  id: string;
  label: string;
  state: SessionCapabilityState;
  /**
   * `mode` and `hidden` are the harness's own declaration of which agents a
   * person may pick. OpenCode marks its internal machinery (compaction, title,
   * summary) `hidden` and its subagents `mode: "subagent"`; a picker filters on
   * these rather than on a denylist of names, so a second harness needs no UI
   * change to hide its own internals.
   */
  mode: string | null;
  hidden: boolean | null;
  description: string | null;
}

export interface RuntimeCatalogProvider {
  id: string;
  label: string;
  modelCount: number;
  availableModelCount: number;
  enabledModelCount: number;
}

export interface RuntimeCatalogBrowseInput {
  adapterId: string;
  providerId?: string;
  query?: string;
  offset?: number;
  limit?: number;
  refresh?: boolean;
}

/** One bounded Settings view. `models` contains only the requested page for one provider. */
export interface RuntimeCatalogView {
  adapterId: string;
  status: "available" | "unavailable" | "incompatible";
  reason: string | null;
  observedAt: number;
  runtimeVersion: string | null;
  providers: readonly RuntimeCatalogProvider[];
  models: readonly RuntimeCatalogModel[];
  modelTotal: number;
  preferences: RuntimePreferences;
}

export interface RuntimeCatalogChoices {
  providers: readonly string[];
  models: readonly RuntimeCatalogModel[];
  agents: readonly RuntimeCatalogAgent[];
}

/** The only payload chat consumes from exhaustive runtime discovery. */
export interface ResolvedRuntimeCatalog {
  adapterId: string;
  observedAt: number;
  catalog: RuntimeCatalogChoices;
  selection: RuntimeSelection;
}

export interface RuntimeCatalogSaveInput {
  adapterId: string;
  preferences: RuntimePreferences;
}

// The transport adds a `projectId` beside each of these to choose which catalog
// instance answers, and the rule pairing an `inspect` with the `save` that
// follows it lives on the `runtimeCatalog` router in `@volli/session-rpc` — the
// one place every request is actually shaped and validated. It was written here
// once as a pair of `…Request` aliases, but nothing could import them (this
// package sits below the edge, and `@volli/session-rpc` reaches it only through
// the handful of names `@volli/session-engine` re-exports), so the guidance sat
// on types no call site could be bound by while the router hand-rolled the same
// shapes in zod. Guidance a caller cannot reach is worse than none.
