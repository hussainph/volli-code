/** Lab-only HOST catalog fixture at the fake preload boundary, never a production API swap. */
import type { IpcBridge } from "@volli/host-protocol/ipc";
import type { HostWorkspaceCreateInput } from "@volli/shared";
import type { HostWorkspacesApi } from "@renderer/lib/host-workspaces-api";

export function createHostWorkspacesIpcFixture() {
  let active: { hostId: string; api: HostWorkspacesApi } | null = null;
  const bridge: IpcBridge = {
    async request(request) {
      const input = request.input as { hostId?: string; path?: string; input?: unknown } | null;
      if (active !== null && input?.hostId === active.hostId) {
        if (
          request.path === "hostScope.query" &&
          request.type === "query" &&
          input.path === "workspaces.list"
        ) {
          return { ok: true, data: await active.api.list() };
        }
        if (
          request.path === "hostScope.mutate" &&
          request.type === "mutation" &&
          input.path === "workspaces.create"
        ) {
          return {
            ok: true,
            data: await active.api.create(input.input as HostWorkspaceCreateInput),
          };
        }
      }
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "No active lab HOST catalog fixture." },
      };
    },
    onEvent: () => () => {},
    cancel() {},
  };
  return {
    bridge,
    connect(hostId: string, api: HostWorkspacesApi) {
      const current = { hostId, api };
      active = current;
      return () => {
        if (active === current) active = null;
      };
    },
  };
}
