import * as React from "react";
import type {
  ResolvedRuntimeCatalog,
  RuntimeCatalogBrowseInput,
  RuntimeCatalogClearInput,
  RuntimeCatalogSaveInput,
  RuntimeCatalogView,
  RuntimePreferences,
} from "@volli/shared";

/** Renderer-facing adapter over whichever transport owns runtime discovery. */
export interface RuntimeCatalogClient {
  inspect(input: RuntimeCatalogBrowseInput): Promise<RuntimeCatalogView>;
  save(input: RuntimeCatalogSaveInput): Promise<RuntimePreferences>;
  clear(input: RuntimeCatalogClearInput): Promise<void>;
  resolve(input: { adapterId: string; projectId?: string }): Promise<ResolvedRuntimeCatalog>;
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
      clear: async (input) => {
        await client.clear(input);
        setPreferenceRevision((revision) => revision + 1);
      },
      preferenceRevision,
    }),
    [client, preferenceRevision],
  );
  return <RuntimeCatalogContext.Provider value={value}>{children}</RuntimeCatalogContext.Provider>;
}

/**
 * Live wherever a provider is mounted, which in the shipped app is everywhere:
 * `App.tsx` wraps `AppShell` in `DesktopRuntimeCatalogProvider`, and the lab
 * wraps its scratch in `LabRuntimeCatalogProvider`. Null is what is left — a
 * unit test rendering one settings pane through `renderToStaticMarkup`, with no
 * provider and no preload bridge under it. Nullable rather than throwing for
 * exactly that case: those tests render the surface to assert its markup, and a
 * hook that threw would make an unmounted transport a test failure instead of
 * the "nothing to fetch" the pane already knows how to draw.
 */
export function useRuntimeCatalogClient(): RuntimeCatalogContextValue | null {
  return React.useContext(RuntimeCatalogContext);
}
