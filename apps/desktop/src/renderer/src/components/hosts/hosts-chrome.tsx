/**
 * Where "Add a host…" and "Manage hosts…" go (VC-700 PR 3). While `cloud` is
 * on this registers both with VC-576's host-connection store — the switcher,
 * ⌘K and Settings → Hosts all open them through it — and mounts the
 * Add-a-host sheet. With the flag off it renders nothing and registers
 * nothing, so the switcher (itself hidden then) keeps its fallbacks.
 */
import * as React from "react";

import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import { AddHostSheet } from "./add-host-sheet";
import { openAddHostSheet, openHostsSettings } from "./host-entry";
import { useCloudEnabled } from "./use-hosts";

export function HostsChrome() {
  const cloud = useCloudEnabled();
  React.useEffect(() => {
    if (!cloud) return;
    const store = useHostConnectionStore.getState();
    store.setEntryPoints({ addHost: openAddHostSheet, manageHosts: openHostsSettings });
    return () => {
      useHostConnectionStore.getState().setEntryPoints({ addHost: null, manageHosts: null });
      useRemoteHostsStore.getState().closeAddHost();
    };
  }, [cloud]);
  return cloud ? <AddHostSheet /> : null;
}
