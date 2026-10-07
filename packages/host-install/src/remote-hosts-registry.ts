/**
 * The remote-host registry (VC-700): the hosts this desktop added over SSH,
 * as one plain JSON file. Never a secret: a host's device key lives in the
 * caller's key store, under {@link deviceKeyName}, never here.
 */
import { isUuidV4 } from "@volli/host-protocol";

import type { InstallMode, ListenAddress } from "./contract";
import { parseSshTarget } from "./target";

export interface RegistryHost {
  /** hostd's `hostId`, pinned at enrollment. */
  readonly id: string;
  readonly name: string;
  /** The SSH target as the person typed it. */
  readonly target: string;
  readonly os: "linux" | "macos" | null;
  readonly mode: InstallMode;
  /** hostd's version at its last answer. */
  readonly version: string | null;
  /** This Mac's device id on the host. */
  readonly deviceId: string;
  /** ISO 8601. */
  readonly addedAt: string;
  /** Where hostd listens on the box: the tunnel's remote end. */
  readonly listen: ListenAddress;
  /** The Workspaces on this host this desktop opened, each with its own link. */
  readonly workspaceIds: readonly string[];
}

export interface RegistryFile {
  readonly v: 1;
  readonly hosts: readonly RegistryHost[];
}

export const EMPTY_REGISTRY: RegistryFile = { v: 1, hosts: [] };

/**
 * The key-store name of this Mac's device key for one enrollment on a host.
 * Per device, so a re-add's new key sits beside the old one until the
 * registry names it, and a failure in between loses neither.
 */
export function deviceKeyName(hostId: string, deviceId: string): string {
  return `host:${hostId}:${deviceId}`;
}

/** The key-store name of an add flow's device key, before it has a host. */
export function flowKeyName(flowId: string): string {
  return `flow:${flowId}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function isListen(value: unknown): value is ListenAddress {
  return (
    isRecord(value) &&
    isText(value.host) &&
    Number.isInteger(value.port) &&
    (value.port as number) > 0 &&
    (value.port as number) <= 65_535
  );
}

/** One host entry exactly as written, or `null` when any field is not what it must be. */
export function readRegistryHost(value: unknown): RegistryHost | null {
  if (!isRecord(value)) return null;
  const { id, name, target, os, mode, version, deviceId, addedAt, listen, workspaceIds } = value;
  const valid =
    isUuidV4(id) &&
    isText(name) &&
    isText(target) &&
    typeof parseSshTarget(target) !== "string" &&
    (os === null || os === "linux" || os === "macos") &&
    (mode === "system" || mode === "user") &&
    (version === null || isText(version)) &&
    isUuidV4(deviceId) &&
    isText(addedAt) &&
    isListen(listen) &&
    Array.isArray(workspaceIds) &&
    workspaceIds.every((workspace) => isUuidV4(workspace));
  if (!valid) return null;
  return {
    id,
    name,
    target,
    os,
    mode,
    version,
    deviceId,
    addedAt,
    listen: { host: listen.host, port: listen.port },
    workspaceIds: [...new Set(workspaceIds as string[])],
  };
}

/** What a registry file holds, read: its hosts, or why this Mac must leave it alone. */
export type RegistryRead =
  /** `problems` says what was dropped (for the log); the rest are kept. */
  | { readonly kind: "ok"; readonly file: RegistryFile; readonly problems: readonly string[] }
  /** Written by a newer Volli: never read past, never overwritten. */
  | { readonly kind: "newer"; readonly version: number }
  /** Not a registry at all: never overwritten either. */
  | { readonly kind: "unreadable"; readonly problem: string };

/**
 * The registry a file holds: every valid host, each id once. A file from a
 * newer Volli, or one that is not a registry, is reported, not emptied: the
 * caller keeps it as it is.
 */
export function readRegistry(value: unknown): RegistryRead {
  if (!isRecord(value)) return { kind: "unreadable", problem: "not a registry" };
  if (typeof value.v === "number" && Number.isInteger(value.v) && value.v > 1) {
    return { kind: "newer", version: value.v };
  }
  if (value.v !== 1 || !Array.isArray(value.hosts)) {
    return { kind: "unreadable", problem: "not a v1 registry" };
  }
  const hosts: RegistryHost[] = [];
  const problems: string[] = [];
  value.hosts.forEach((raw: unknown, index) => {
    const host = readRegistryHost(raw);
    if (host === null) problems.push(`host ${index} is malformed`);
    else if (hosts.some((other) => other.id === host.id)) {
      problems.push(`host ${index} repeats ${host.id}`);
    } else hosts.push(host);
  });
  return { kind: "ok", file: { v: 1, hosts }, problems };
}
