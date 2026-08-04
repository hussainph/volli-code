import * as React from "react";

import {
  RuntimeCatalogProvider,
  type RuntimeCatalogClient,
} from "@renderer/lib/runtime-catalog-client";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/**
 * Adapts the app's Session RPC transport to the renderer Runtime Catalog
 * interface — the Lab's provider, with the IPC link where its HTTP client is.
 *
 * No `projectId` crosses here. These reads and writes come from app-wide
 * Settings, which is the fallback catalog's scope, and the router pairs an
 * inspect with the save that follows it by resolving both against the same
 * scope — so leaving the scope unspoken is what keeps them paired, rather than
 * something to remember to pass identically twice.
 */
export function DesktopRuntimeCatalogProvider({ children }: React.PropsWithChildren) {
  const adapter = React.useMemo<RuntimeCatalogClient>(
    () => ({
      inspect: (input) => sessionRpcClient().runtimeCatalog.inspect.query(input),
      // The router's zod input asks for a mutable array; the domain type it is
      // handed is readonly, and that is the whole of the difference.
      save: (input) =>
        sessionRpcClient().runtimeCatalog.save.mutate({
          ...input,
          preferences: {
            ...input.preferences,
            enabledModels: [...input.preferences.enabledModels],
          },
        }),
      resolve: (input) => sessionRpcClient().runtimeCatalog.resolve.query(input),
    }),
    [],
  );
  return <RuntimeCatalogProvider client={adapter}>{children}</RuntimeCatalogProvider>;
}
