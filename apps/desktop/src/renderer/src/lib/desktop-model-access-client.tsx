import * as React from "react";

import { createModelAccessTerminal } from "@renderer/components/sessions/session-create";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { scratchScope } from "@renderer/stores/sessions";

export function DesktopModelAccessProvider({ children }: React.PropsWithChildren) {
  const project = useSelectedProject();
  const client = React.useMemo<ModelAccessClient>(() => {
    const rpc = sessionRpcClient();
    return {
      inspect: (input) => rpc.modelAccess.inspect.query(input),
      defaultSelection: () => rpc.modelAccess.defaultSelection.query(),
      setDefault: (selection) => rpc.modelAccess.setDefault.mutate(selection),
      openExternalSignIn: async () => {
        if (project === null) {
          toastError("Select a project before opening Model Access.");
          return false;
        }
        return openProjectModelAccess(project.id);
      },
    };
  }, [project]);
  return <ModelAccessProvider client={client}>{children}</ModelAccessProvider>;
}

export async function openProjectModelAccess(
  projectId: string,
  openTerminal: typeof createModelAccessTerminal = createModelAccessTerminal,
): Promise<boolean> {
  return (await openTerminal(scratchScope(projectId))) !== null;
}
