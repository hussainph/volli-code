import { createTRPCClient } from "@trpc/client";
import { hostLinkTrpcLink } from "@volli/host-protocol/client-link";
import type { HostRouter } from "@volli/session-rpc";
import type {
  HostWorkspaceCreateInput,
  HostWorkspaceCreateResult,
  HostWorkspaceList,
} from "@volli/shared";

import { relayHostScope } from "./relay-host-scope";

/** Typed HOST catalog: no Workspace has to be open to make these calls. */
export interface HostWorkspacesApi {
  list(): Promise<HostWorkspaceList>;
  create(input: HostWorkspaceCreateInput): Promise<HostWorkspaceCreateResult>;
}
export function hostWorkspacesApi(hostId: string): HostWorkspacesApi {
  const client = createTRPCClient<HostRouter>({
    links: [hostLinkTrpcLink(relayHostScope(hostId))],
  });
  return {
    list: () => client.workspaces.list.query(),
    create: (input) => client.workspaces.create.mutate(input),
  };
}
