import * as React from "react";
import type {
  ResolvedRuntimeCatalog,
  RuntimeCatalogBrowseInput,
  RuntimeCatalogSaveInput,
  RuntimeCatalogView,
  RuntimePreferences,
} from "@volli/shared";

/** Renderer-facing adapter over whichever transport owns runtime discovery. */
export interface RuntimeCatalogClient {
  inspect(input: RuntimeCatalogBrowseInput): Promise<RuntimeCatalogView>;
  save(input: RuntimeCatalogSaveInput): Promise<RuntimePreferences>;
  resolve(input: { adapterId: string }): Promise<ResolvedRuntimeCatalog>;
}

export interface RuntimeCatalogContextValue extends RuntimeCatalogClient {
  /** Advances after a saved preference so open chat surfaces can re-resolve. */
  preferenceRevision: number;
}

const RuntimeCatalogContext = React.createContext<RuntimeCatalogContextValue | null>(null);

export function RuntimeCatalogProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: RuntimeCatalogClient }>) {
  const [preferenceRevision, setPreferenceRevision] = React.useState(0);
  const value = React.useMemo<RuntimeCatalogContextValue>(
    () => ({
      inspect: (input) => client.inspect(input),
      resolve: (input) => client.resolve(input),
      save: async (input) => {
        const saved = await client.save(input);
        setPreferenceRevision((revision) => revision + 1);
        return saved;
      },
      preferenceRevision,
    }),
    [client, preferenceRevision],
  );
  return <RuntimeCatalogContext.Provider value={value}>{children}</RuntimeCatalogContext.Provider>;
}

/** Null in the shipped app until its production transport is wired. */
export function useRuntimeCatalogClient(): RuntimeCatalogContextValue | null {
  return React.useContext(RuntimeCatalogContext);
}
