import * as React from "react";
import type { ModelAccessSnapshot, ModelSelection } from "@volli/shared";

export interface ModelAccessClient {
  inspect(input: { refresh?: boolean }): Promise<ModelAccessSnapshot>;
  defaultSelection(): Promise<ModelSelection | null>;
  setDefault(selection: ModelSelection): Promise<ModelSelection>;
  openExternalSignIn(): Promise<boolean>;
}

export interface ModelAccessContextValue extends ModelAccessClient {
  revision: number;
}

const ModelAccessContext = React.createContext<ModelAccessContextValue | null>(null);

export function ModelAccessProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: ModelAccessClient }>) {
  const [revision, setRevision] = React.useState(0);
  const value = React.useMemo<ModelAccessContextValue>(
    () => ({
      inspect: (input) => client.inspect(input),
      defaultSelection: () => client.defaultSelection(),
      openExternalSignIn: () => client.openExternalSignIn(),
      setDefault: async (selection) => {
        const saved = await client.setDefault(selection);
        setRevision((current) => current + 1);
        return saved;
      },
      revision,
    }),
    [client, revision],
  );
  return <ModelAccessContext.Provider value={value}>{children}</ModelAccessContext.Provider>;
}

export function useModelAccessClient(): ModelAccessContextValue | null {
  return React.useContext(ModelAccessContext);
}
