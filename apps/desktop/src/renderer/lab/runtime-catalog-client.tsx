import * as React from "react";

import {
  RuntimeCatalogProvider,
  type RuntimeCatalogClient,
} from "@renderer/lib/runtime-catalog-client";

import { createSessionRpcClient } from "./session-rpc-client";

/** Adapts the Lab's tRPC transport to the renderer Runtime Catalog Interface. */
export function LabRuntimeCatalogProvider({ children }: React.PropsWithChildren) {
  const client = React.useMemo(() => createSessionRpcClient(), []);
  const adapter = React.useMemo<RuntimeCatalogClient>(
    () => ({
      inspect: (input) => client.runtimeCatalog.inspect.query(input),
      save: (input) =>
        client.runtimeCatalog.save.mutate({
          ...input,
          preferences: {
            ...input.preferences,
            enabledModels: input.preferences.enabledModels.map((model) => ({ ...model })),
          },
        }),
      resolve: (input) => client.runtimeCatalog.resolve.query(input),
    }),
    [client],
  );
  return <RuntimeCatalogProvider client={adapter}>{children}</RuntimeCatalogProvider>;
}
