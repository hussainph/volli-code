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
  mode: string | null;
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
