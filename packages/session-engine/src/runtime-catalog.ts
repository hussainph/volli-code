import type {
  ResolvedRuntimeCatalog,
  RuntimeCatalogBrowseInput,
  RuntimeCatalogSaveInput,
  RuntimeCatalogView,
  RuntimePreferences,
} from "@volli/shared";

/**
 * The transport-neutral Runtime Catalog Interface. Settings may inspect and
 * save; chat receives only `resolve`, never the exhaustive adapter inventory.
 */
export interface RuntimeCatalog {
  inspect(input: RuntimeCatalogBrowseInput): Promise<RuntimeCatalogView>;
  save(input: RuntimeCatalogSaveInput): Promise<RuntimePreferences>;
  resolve(input: { adapterId: string }): Promise<ResolvedRuntimeCatalog>;
}
