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
 * `projectId` crosses here now: it rides on the input object each call
 * already forwards, so a caller that sets it gets a project-scoped read or
 * write and a caller that omits it gets the global one. App-wide Settings
 * still omits it — those reads and writes are the fallback catalog's scope.
 * The Configure page is the caller that sets it, resolving and saving against
 * one project's override. The router pairs an inspect with the save that
 * follows it by resolving both against the same scope, so a caller must send
 * `save` the same `projectId` (or lack of one) that its preceding `inspect`
 * used.
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
      clear: (input) => sessionRpcClient().runtimeCatalog.clear.mutate(input),
      resolve: (input) => sessionRpcClient().runtimeCatalog.resolve.query(input),
    }),
    [],
  );
  return <RuntimeCatalogProvider client={adapter}>{children}</RuntimeCatalogProvider>;
}
