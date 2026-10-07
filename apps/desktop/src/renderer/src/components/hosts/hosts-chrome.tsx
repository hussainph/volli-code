/**
 * Where "Add a host…" and "Manage hosts…" go (VC-700 PR 3). While `cloud` is
 * on this registers both with VC-576's host-connection store — the switcher,
 * ⌘K and Settings → Hosts all open them through it — and mounts the
 * Add-a-host sheet and a remote host's sign-in sheet (VC-702), which the
 * switcher and Settings → Hosts open. With the flag off it renders nothing and registers
 * nothing, so the switcher (itself hidden then) keeps its fallbacks.
 */
import * as React from "react";

import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { useHostsWritable, useRemoteHostsStore } from "@renderer/stores/remote-hosts";

import { AddHostSheet } from "./add-host-sheet";
import { OpenProjectSheet } from "./open-project-sheet";
import { HostSignInSheet } from "./sign-ins/host-sign-in-sheet";
import { openAddHostSheet, openHostsSettings } from "./host-entry";
import { useHostSignInSheet } from "./sign-ins/remote-host-sign-in-source";
import { useCloudEnabled } from "./use-hosts";

export function HostsChrome() {
  const cloud = useCloudEnabled();
  // A read-only hosts file offers no Add, here as in Settings → Hosts.
  const writable = useHostsWritable();
  React.useEffect(() => {
    if (!cloud) return;
    const store = useHostConnectionStore.getState();
    store.setEntryPoints({
      addHost: writable ? openAddHostSheet : null,
      manageHosts: openHostsSettings,
    });
  }, [cloud, writable]);
  React.useEffect(() => {
    if (!cloud) return;
    return () => {
      useHostConnectionStore.getState().setEntryPoints({ addHost: null, manageHosts: null });
      useRemoteHostsStore.getState().closeAddHost();
      useRemoteHostsStore.getState().closeProjectSheet();
      useHostSignInSheet.getState().close();
    };
  }, [cloud]);
  return cloud ? (
    <>
      <AddHostSheet />
      <OpenProjectSheet />
      <HostSignInSheet />
    </>
  ) : null;
}
