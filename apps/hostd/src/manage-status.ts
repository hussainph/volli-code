/**
 * `volli-hostd status --json` (VC-700): everything the desktop's probe and
 * the host's settings page need to know about a managed install, as one
 * line of JSON (`HostdManagedStatus`, `@volli/host-install/contract`).
 *
 *   sudo -u volli volli-hostd status --json --system
 *   volli-hostd status --json --user
 *   volli-hostd status --json --data-dir <dir>      # no unit, just the host
 *   volli-hostd status --json                       # whichever is installed
 *
 * The plain `status --data-dir` keeps its M1 answer and exit codes; this
 * exits with the same codes (0 serving, 1 refusing, 3 not serving).
 *
 * It reports the installed releases, the unit, user lingering, the running
 * host (its version, host id and listener) and the enrolled devices, never
 * their keys (a system install's from root's `/etc/volli-hostd-devices`). Run as another account than the data directory's owner, the
 * host and its devices read as unknown rather than failing the whole answer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  HOSTD_MANAGEMENT_LEVEL,
  type HostdManagedStatus,
  type InstallMode,
} from "@volli/host-install/contract";

import { dataDirDeviceStore, describeDevice, readEnrolledDevices } from "./enrolled-devices";
import { currentVersion, installedReleases } from "./install";
import type { InstallLayout } from "./layout";
import { layoutDeviceStore, SERVICE_UNIT } from "./layout";
import { agentState, lingerOf, readManaged, unitState, type RunTool } from "./management";
import { checkStatus, type StatusProbes } from "./status";

export interface ManagedStatusCommand {
  readonly kind: "status-json";
  /** `null`: whichever mode is installed, system first. */
  readonly mode: InstallMode | null;
  /** `--data-dir`: just that host, no install or unit. */
  readonly dataDir: string | null;
}

export interface ManagedStatusPorts {
  readonly layouts: Readonly<Record<InstallMode, InstallLayout>>;
  readonly run: RunTool;
  readonly probes: StatusProbes;
  readonly login: () => string;
  readonly uid: () => number;
  readonly version: string;
  /** Who a system install's device store must belong to: root (0) on a box. */
  readonly trustedOwnerUid: number;
}

export async function managedStatus(
  command: ManagedStatusCommand,
  ports: ManagedStatusPorts,
): Promise<HostdManagedStatus> {
  const mode = command.dataDir !== null ? null : (command.mode ?? installedMode(ports.layouts));
  const layout = mode === null ? null : ports.layouts[mode];
  const dataDir = command.dataDir ?? layout?.dataDir ?? null;
  const report = dataDir === null ? null : await checkStatus(dataDir, ports.probes);
  const status = report?.status ?? null;
  // A system install's devices are root's (readable by anyone); a data
  // directory's are its owner's.
  const store =
    layout !== null
      ? layoutDeviceStore(layout, ports.trustedOwnerUid)
      : dataDir === null
        ? null
        : dataDirDeviceStore(dataDir);
  const devices = store === null ? null : readEnrolledDevices(store);
  const managed = layout === null ? null : readManaged(layout);
  const releases = layout === null ? [] : installedReleases(layout);
  const flat = layout?.mode === "system" && existsSync(join(layout.root, "bin/volli-hostd"));
  return {
    v: 1,
    management: HOSTD_MANAGEMENT_LEVEL,
    binary: { version: ports.version },
    mode,
    install:
      layout === null || (releases.length === 0 && !flat)
        ? null
        : {
            root: layout.root,
            current: currentVersion(layout),
            releases,
            flat,
            port: managed?.port ?? null,
          },
    unit:
      layout === null
        ? null
        : layout.manager === "launchd"
          ? agentState(ports.run, layout, ports.uid())
          : unitState(ports.run, layout.mode),
    // Lingering is logind's; a Mac's agent outlives an SSH login regardless.
    linger:
      layout?.mode === "user" && layout.manager === "systemd"
        ? lingerOf(ports.run, ports.login())
        : null,
    dataDir,
    verdict: report?.verdict ?? "not-serving",
    detail: report === null ? "not installed" : (report.detail ?? null),
    running:
      status === null
        ? null
        : {
            state: status.state,
            version: status.version,
            pid: status.pid,
            hostId: status.hostId ?? null,
            listen:
              status.hostProtocol === undefined || status.hostProtocol === null
                ? null
                : { host: status.hostProtocol.host, port: status.hostProtocol.port },
          },
    devices: devices === null || typeof devices === "string" ? null : devices.map(describeDevice),
  };
}

/**
 * The installed mode: a system install (managed, or the runbook's hand-made
 * one) before a user unit, since a box has one or the other.
 */
function installedMode(layouts: Readonly<Record<InstallMode, InstallLayout>>): InstallMode | null {
  const { system, user } = layouts;
  if (
    system.manager === "systemd" &&
    (existsSync(system.managedFile) || existsSync(join(system.unitDir, SERVICE_UNIT)))
  )
    return "system";
  const userUnit = user.agentPlist ?? join(user.unitDir, SERVICE_UNIT);
  if (existsSync(user.managedFile) || existsSync(userUnit)) return "user";
  return null;
}
