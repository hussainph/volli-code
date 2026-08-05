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

/**
 * Wire shape for `runtimeCatalog.inspect`: the engine-shaped browse input plus
 * routing. `projectId` picks WHICH catalog answers — the host keeps one per
 * project directory — so it decides which checkout gets probed for models.
 * Omitting it asks the host's fallback directory, which is what a Session with
 * no project yet wants and what a project-scoped Settings screen never does.
 */
export type RuntimeCatalogInspectRequest = RuntimeCatalogBrowseInput & { projectId?: string };

/**
 * Wire shape for `runtimeCatalog.save`: the engine-shaped save input plus
 * routing.
 *
 * **Send the same `projectId` this client last inspected with.** A catalog
 * persists models out of the discovery snapshot it is holding, and the snapshot
 * belongs to that one catalog instance — so a save routed to a different (or
 * omitted) `projectId` reaches an instance that has discovered nothing and is
 * refused, no matter how recently the user inspected. The pairing cannot be
 * enforced here because the two calls are independent requests; a client that
 * lets a form default one and drop the other gets a refusal whose message
 * ("inspect before saving") describes a state the user cannot see they are in.
 */
export type RuntimeCatalogSaveRequest = RuntimeCatalogSaveInput & { projectId?: string };
