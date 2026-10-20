/** Model preferences over a box's person-only HOST connection, never local Model Access IPC. */
import { createTRPCClient } from "@trpc/client";
import { hostLinkTrpcLink } from "@volli/host-protocol/client-link";
import type { HostRouter } from "@volli/session-rpc";

import type { ModelAccessClient } from "./model-access-client";
import { relayHostScope, type RelayedHostScopeLink } from "./relay-host-scope";

function signInsOnly(): Promise<never> {
  return Promise.reject(new Error("Use Sign-ins on the host to manage its accounts"));
}

export function hostModelAccessClient(
  hostId: string,
  link: RelayedHostScopeLink = relayHostScope(hostId),
): ModelAccessClient {
  const rpc = createTRPCClient<HostRouter>({ links: [hostLinkTrpcLink(link)] }).hostModels;
  return {
    inspect: (input) => rpc.inspect.query(input),
    defaults: () => rpc.defaults.query(),
    setDefault: (purpose, selection) => rpc.setDefault.mutate({ purpose, selection }),
    hiddenModels: () => rpc.hiddenModels.query(),
    setHiddenModels: (hidden) => rpc.setHiddenModels.mutate([...hidden]),
    compactionPolicy: () => rpc.compactionPolicy.query(),
    setCompactionPolicy: (policy) =>
      rpc.setCompactionPolicy.mutate({ autoCompaction: policy.autoCompaction }),
    codeModePolicy: () => rpc.codeModePolicy.query(),
    setCodeModePolicy: (policy) =>
      rpc.setCodeModePolicy.mutate({ enabled: policy.enabled, models: { ...policy.models } }),
    pickerView: () => rpc.pickerView.query(),
    setPickerView: (view) => rpc.setPickerView.mutate(view),
    // Account management belongs to the already-owned host sign-in sheet.
    beginSignIn: signInsOnly,
    signOut: signInsOnly,
  };
}
