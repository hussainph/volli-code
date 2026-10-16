/** A box's dedicated device-authenticated HOST link, reached through desktop main.
 * No Workspace identity is invented or borrowed. Sign-in flows remain main-owned. */
import type { HostLinkCallOptions } from "@volli/host-protocol/client-link";
import { OPEN_LINK, useHostConnectionStore, type HostLinkView } from "../stores/host-connection";
import {
  relayConnection,
  type RelayedHostLink,
  type RelayHostLinkOptions,
  type RelayLinkStateSource,
} from "./relay-host-link";
import { sessionRpcClient, type SessionRpcClient } from "./session-rpc-ipc-link";

export interface RelayHostScopeOptions extends Omit<RelayHostLinkOptions, "rpc"> {
  readonly rpc?: Pick<SessionRpcClient, "hostScope">;
}
export interface RelayedHostScopeLink extends Omit<RelayedHostLink, "workspaceId"> {
  readonly hostId: string;
}
const NOT_READY: HostLinkView = Object.freeze({ status: "connecting" });

function hostState(hostId: string): RelayLinkStateSource {
  return {
    // Only the HOST welcome matters here. A ready Workspace cannot make a
    // failed HOST link usable, nor can a fenced Workspace block a ready HOST.
    getState: () =>
      useHostConnectionStore.getState().hosts.find((host) => host.id === hostId)?.hostScope
        ?.status === "ready"
        ? OPEN_LINK
        : NOT_READY,
    subscribe: (listener) => useHostConnectionStore.subscribe(() => listener()),
  };
}
function context(options: HostLinkCallOptions | undefined) {
  return options?.trace === undefined ? {} : { context: { trace: options.trace } };
}

export function relayHostScope(
  hostId: string,
  options: RelayHostScopeOptions = {},
): RelayedHostScopeLink {
  const rpc = () => options.rpc ?? sessionRpcClient();
  return {
    hostId,
    ...relayConnection(
      { ...options, state: options.state ?? hostState(hostId) },
      {
        query: (path, input, callOptions) =>
          rpc().hostScope.query.query({ hostId, path, input }, context(callOptions)),
        mutate: (path, input, callOptions) =>
          rpc().hostScope.mutate.mutate({ hostId, path, input }, context(callOptions)),
        subscribe: (path, input, lastEventId, handlers, callOptions) =>
          rpc().hostScope.subscribe.subscribe(
            { hostId, path, input, ...(lastEventId === undefined ? {} : { lastEventId }) },
            { ...context(callOptions), ...handlers },
          ),
      },
    ),
  };
}
