/**
 * `volli-hostd enroll` (VC-700): trust a device's public key, over SSH.
 *
 *   sudo -u volli volli-hostd enroll --system --public-key <spki> --name <label>
 *   volli-hostd enroll --user --public-key <spki> --name <label>
 *
 * The desktop runs this on the box over the SSH connection it just installed
 * through, and reads back the host id it pins. That is pairing for a host
 * added over SSH: no code, because SSH already proved both ends.
 *
 * **Why SSH access is enough to enroll** (docs/plans/host-protocol.md,
 * "Enrollment over SSH"):
 * - The box is authenticated by its SSH host key, which the person accepted
 *   by fingerprint (never blind accept-new), so the host id that comes back
 *   is this box's, and the key that goes in reaches this box unaltered.
 * - The person is authenticated by SSH as a login that can run hostd's own
 *   binary as hostd's own account. Whoever can do that can already read and
 *   rewrite the data directory, the database and the secret key: enrolling
 *   a device grants them nothing they did not have.
 * - Only the public key crosses. The private key never leaves the device,
 *   and the credential it signs is short-lived and single-use, so a
 *   transcript of this channel admits no one.
 *
 * Runs as the account that owns the data directory, never as root: root
 * would be writing into a directory the service account (and so any agent)
 * controls. Needs the host serving, since the host id is minted at boot.
 * Idempotent: the same key enrolled again answers the same device.
 */
import { statSync } from "node:fs";

import type { HostdEnrollResult, InstallMode } from "@volli/host-install/contract";

import {
  enrollDevice,
  enrolledDevicesPath,
  parseDevicePublicKey,
  readEnrolledDevices,
} from "./enrolled-devices";
import { ROOT_UID } from "./install";
import type { InstallLayout } from "./layout";
import { ManagementError } from "./management";
import { checkStatus, type StatusProbes } from "./status";

export interface EnrollCommand {
  readonly kind: "enroll";
  /** Where: an installed mode's data directory, or `dataDir` itself. */
  readonly mode: InstallMode | null;
  readonly dataDir: string | null;
  readonly publicKey: string;
  readonly name: string;
}

export interface EnrollPorts {
  readonly uid: () => number;
  readonly layouts: Readonly<Record<InstallMode, InstallLayout>>;
  readonly probes: StatusProbes;
  readonly version: string;
  readonly now: () => Date;
  readonly newId: () => string;
}

export async function runEnroll(
  command: EnrollCommand,
  ports: EnrollPorts,
): Promise<HostdEnrollResult> {
  const dataDir = command.dataDir ?? ports.layouts[command.mode!].dataDir;
  const uid = ports.uid();
  if (uid === ROOT_UID) {
    throw new ManagementError(
      "is-root",
      "enroll runs as the account volli-hostd runs as (sudo -u volli), not root.",
    );
  }
  let owner: number;
  try {
    owner = statSync(dataDir).uid;
  } catch {
    throw new ManagementError("not-installed", `There is no data directory at ${dataDir}.`);
  }
  if (owner !== uid) {
    throw new ManagementError(
      "data-dir-owner",
      `${dataDir} belongs to another account: run enroll as the one volli-hostd runs as.`,
    );
  }
  const report = await checkStatus(dataDir, ports.probes);
  const hostId = report.status?.hostId;
  if (report.verdict !== "serving" || typeof hostId !== "string") {
    throw new ManagementError(
      "not-serving",
      "volli-hostd is not serving here yet: start it, then enroll.",
      report.detail === undefined ? [] : [report.detail],
    );
  }
  const key = parseDevicePublicKey(command.publicKey);
  if (typeof key === "string") throw new ManagementError("bad-key", key);
  if (readEnrolledDevices(dataDir) === "unreadable") {
    throw new ManagementError(
      "store-unreadable",
      `${enrolledDevicesPath(dataDir)} is not an enrolled-devices file; not overwriting it.`,
    );
  }
  const outcome = enrollDevice(
    dataDir,
    { publicKey: command.publicKey, name: command.name, via: "ssh" },
    { now: ports.now, newId: ports.newId },
  );
  const listen = report.status!.hostProtocol;
  return {
    v: 1,
    ok: true,
    hostId,
    deviceId: outcome.device.deviceId,
    fingerprint: outcome.device.fingerprint,
    created: outcome.created,
    version: ports.version,
    listen:
      listen === undefined || listen === null ? null : { host: listen.host, port: listen.port },
  };
}
