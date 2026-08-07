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
  /**
   * Which scope answers. Present, the project's own stored record does — and
   * falls back to the global one for any adapter it does not override; absent,
   * the global record alone. Presence IS the scope: there is no separate
   * "scope" field to disagree with it.
   */
  projectId?: string;
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
  /**
   * WHICH scope the `preferences` above came out of. A project-scoped view
   * answers `"project"` only when that project actually stores a record for
   * this adapter — a project that overrides nothing, or whose stored record no
   * longer parses, reads `"global"`, because that is what it is resolving.
   *
   * Without it an inherit/override control has nothing to read: the inherited
   * preferences and an override that happens to equal them are the same bytes,
   * and the difference between them is the whole state that control edits.
   */
  preferencesOrigin: "global" | "project";
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
  /** Present, this writes the project's override; absent, the global record. */
  projectId?: string;
  adapterId: string;
  preferences: RuntimePreferences;
}

/**
 * Drops a project's override for one adapter, so it inherits the global record
 * again. `projectId` is required — there is nothing to clear at global scope,
 * where "no preferences" is a save away and an empty record is a real answer.
 */
export interface RuntimeCatalogClearInput {
  projectId: string;
  adapterId: string;
}

// `projectId` sits ON the input types above rather than beside them. The
// transport used to add it and strip it, which is why it was once written down
// here as a pair of `…Request` aliases — but nothing could import those (this
// package sits below the edge, and `@volli/session-rpc` reaches it only through
// the handful of names `@volli/session-engine` re-exports), so the guidance sat
// on types no call site could be bound by while the router hand-rolled the same
// shapes in zod. Guidance a caller cannot reach is worse than none; an optional
// field on the type every caller already holds is the reachable version of it.
//
// The rule pairing an `inspect` with the `save` that follows it still lives on
// the `runtimeCatalog` router in `@volli/session-rpc` — the one place every
// request is actually shaped and validated.
