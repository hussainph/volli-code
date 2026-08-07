import type {
  ResolvedRuntimeCatalog,
  RuntimeCatalogBrowseInput,
  RuntimeCatalogClearInput,
  RuntimeCatalogSaveInput,
  RuntimeCatalogView,
  RuntimePreferences,
} from "@volli/shared";

export { MAX_RUNTIME_PREFERENCE_MODELS } from "@volli/shared";

/**
 * The transport-neutral Runtime Catalog Interface. Settings may inspect, save
 * and clear; chat receives only `resolve`, never the exhaustive adapter
 * inventory.
 *
 * Every verb carries the scope in its input: an optional `projectId` means the
 * project's stored record answers (falling back to the global one), and its
 * absence means the global record does. `clear` is the one exception, and
 * requires one — it drops a project's override, which is the only thing there
 * is to drop.
 */
export interface RuntimeCatalog {
  inspect(input: RuntimeCatalogBrowseInput): Promise<RuntimeCatalogView>;
  save(input: RuntimeCatalogSaveInput): Promise<RuntimePreferences>;
  clear(input: RuntimeCatalogClearInput): Promise<void>;
  resolve(input: { adapterId: string; projectId?: string }): Promise<ResolvedRuntimeCatalog>;
}
