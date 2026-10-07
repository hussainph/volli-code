/**
 * Which host a project's Sessions run on, for the rules a remote Session
 * follows in v1 (VC-713):
 *
 * - **Model:** the host's default only. A remote host offers no Model Access
 *   to a device yet (`model-access` is not in hostd's offer, VC-572), so this
 *   Mac's catalog would name models the box cannot run. The picker gives way
 *   to a label, and a Session is created and attached with no model of this
 *   Mac's choosing.
 * - **Attachments:** blobs live in this Mac's store, which the box cannot
 *   read, so the composer's attach row says "Not available on <host> yet" and
 *   a drop or paste attaches nothing.
 *
 * Like every host hook (`use-hosts.ts`), it answers "This Mac" while the
 * `cloud` flag is off WITHOUT subscribing to the host-connection store, so the
 * flag-off app pays nothing and draws exactly what it drew before.
 */
import * as React from "react";

import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";
import {
  hostOfProject,
  useHostConnectionStore,
  type HostConnectionState,
} from "@renderer/stores/host-connection";

/** What a local-only surface says for a remote project. */
export function notAvailableOn(hostName: string): string {
  return `Not available on ${hostName} yet`;
}

/** The remote host's name a project runs on, or `null` for This Mac (or no project). */
export function remoteHostNameOf(
  state: Pick<HostConnectionState, "hosts" | "projects">,
  projectId: string | null,
): string | null {
  if (projectId === null) return null;
  const host = hostOfProject(state, projectId);
  return host.local ? null : host.name;
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * {@link remoteHostNameOf} as a hook: `null` (This Mac) while `cloud` is off,
 * with no host-store subscription. A string, so a host change that leaves the
 * name alone re-renders nothing.
 */
export function useRemoteHostName(projectId: string | null): string | null {
  const cloud = useExperimentsStore((state) => isExperimentOn(state.snapshot, "cloud"));
  const subscribe = cloud ? useHostConnectionStore.subscribe : NO_SUBSCRIPTION;
  const read = () =>
    cloud ? remoteHostNameOf(useHostConnectionStore.getState(), projectId) : null;
  return React.useSyncExternalStore(subscribe, read, read);
}

/** {@link useRemoteHostName}, read once outside React (a store, a handler). */
export function remoteHostNameNow(projectId: string | null): string | null {
  if (!isExperimentOn(useExperimentsStore.getState().snapshot, "cloud")) return null;
  return remoteHostNameOf(useHostConnectionStore.getState(), projectId);
}
