/**
 * Whether a project is a remote host's, read once outside React (VC-711):
 * for the stores and handlers that reach THIS Mac's main process through
 * `window.api` with a project id, which means nothing there for a project a
 * remote host serves. Each such entry point asks this first and stands down:
 * a read answers empty without a call, a person's write says
 * "Not available on <host> yet" ({@link refuseRemote}).
 *
 * Always `null` with the `cloud` flag off, without reading the host store,
 * so the flag-off app behaves exactly as before.
 */
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { boardProtocol } from "@renderer/lib/board-protocol";

import { isExperimentOn, useExperimentsStore } from "./experiments";
import {
  hostOfProject,
  isRemoteProject,
  useHostConnectionStore,
  type HostRecord,
} from "./host-connection";

/** The remote host serving the project now, or `null` for This Mac's (and with the flag off). */
export function remoteHostNow(projectId: string | null | undefined): HostRecord | null {
  if (projectId === null || projectId === undefined) return null;
  if (!isExperimentOn(useExperimentsStore.getState().snapshot, "cloud")) return null;
  const state = useHostConnectionStore.getState();
  return isRemoteProject(state, projectId) ? hostOfProject(state, projectId) : null;
}

/**
 * The remote host serving a ticket's project, by the board that holds it,
 * or `null`. A remote project's board only ever rides the protocol path, so a
 * ticket no followed board holds is This Mac's.
 */
export function remoteHostOfTicketNow(ticketId: string | null | undefined): HostRecord | null {
  if (ticketId === null || ticketId === undefined) return null;
  return remoteHostNow(boardProtocol()?.sync.workspaceOf(ticketId));
}

/** {@link refuseRemote} for an action keyed by a ticket. */
export function refuseRemoteTicket(ticketId: string | null | undefined): boolean {
  const host = remoteHostOfTicketNow(ticketId);
  if (host === null) return false;
  toast(notAvailableOn(host), { id: "host-local-only" });
  return true;
}

const NO_SUBSCRIPTION = () => () => {};
const readCloud = (): boolean => isExperimentOn(useExperimentsStore.getState().snapshot, "cloud");

/**
 * {@link remoteHostNow} for a component: the remote host serving the project,
 * or `null`. With the `cloud` flag off it holds no host-store subscription at
 * all, so the flag-off app pays nothing. Light on purpose (no projects or
 * theme store behind it): every local-only surface, down to a file tab,
 * mounts behind it.
 */
export function useRemoteProjectHost(projectId: string | null): HostRecord | null {
  const cloud = useSyncExternalStore(useExperimentsStore.subscribe, readCloud, readCloud);
  const read = () => (cloud ? remoteHostNow(projectId) : null);
  return useSyncExternalStore(
    cloud ? useHostConnectionStore.subscribe : NO_SUBSCRIPTION,
    read,
    read,
  );
}

/** What a local-only surface says for a remote project. */
export function notAvailableOn(host: Pick<HostRecord, "name">): string {
  return `Not available on ${host.name} yet`;
}

/**
 * The guard a person's local-only action takes: `true` (and says why, once)
 * when the project is a remote host's, so the caller stops before
 * `window.api`; `false` for This Mac's projects.
 */
export function refuseRemote(projectId: string | null | undefined): boolean {
  const host = remoteHostNow(projectId);
  if (host === null) return false;
  toast(notAvailableOn(host), { id: "host-local-only" });
  return true;
}
