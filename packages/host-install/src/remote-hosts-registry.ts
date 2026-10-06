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

/** The key-store name of a host's device key. */
export function deviceKeyName(hostId: string): string {
  return `host:${hostId}`;
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

/**
 * The registry a file holds: every valid host, each id once. `problems` says
 * what was dropped (for the log); a file that is not a registry at all is
 * one problem and an empty registry.
 */
export function readRegistry(value: unknown): {
  readonly file: RegistryFile;
  readonly problems: readonly string[];
} {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.hosts)) {
    return { file: EMPTY_REGISTRY, problems: ["not a v1 registry"] };
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
  return { file: { v: 1, hosts }, problems };
}
