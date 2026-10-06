/**
 * `volli-hostd enroll` (VC-700): trust a device's public key, over SSH.
 *
 *   sudo volli-hostd enroll --system --public-key <spki> --name <label>
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
 * - An enrolled device acts as the person (policy actor `user`), so enrolling
 *   one must take authority that only the person holds, never the authority
 *   an agent holds:
 *   - **System install:** every Session runs as `volli`, so being able to
 *     act as `volli` is exactly what an agent can do. Enrollment therefore
 *     writes root's `/etc/volli-hostd-devices` and runs as root (sudo), as
 *     operator tokens do (VC-623). The service account can read the store
 *     but neither write it nor run this command.
 *   - **User install:** hostd and its agents run as the person's own login,
 *     which the desktop says ("agents share your account"). That login is
 *     the person, and could add an SSH key for itself anyway: enrolling as
 *     it grants nothing it did not hold.
 * - Only the public key crosses. The private key never leaves the device,
 *   and the credential it signs is short-lived and single-use, so a
 *   transcript of this channel admits no one.
 *
 * `--user` and `--data-dir` run as the account that owns the data
 * directory, never as root. Needs the host serving, since the host id is
 * minted at boot. Idempotent: the same key enrolled again answers the same
 * device.
 */
import { statSync } from "node:fs";

import type { HostdEnrollResult, InstallMode } from "@volli/host-install/contract";

import {
  dataDirDeviceStore,
  DeviceStoreError,
  enrollDevice,
  parseDevicePublicKey,
  type DeviceStore,
} from "./enrolled-devices";
import { ROOT_UID } from "./install";
import { layoutDeviceStore, type InstallLayout } from "./layout";
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
  /** Who a system store must belong to: root (0) on a box; the tests' own uid. */
  readonly trustedOwnerUid: number;
}

/** Where a command names: the data directory and the store its host reads. */
export function deviceTarget(
  command: { readonly mode: InstallMode | null; readonly dataDir: string | null },
  ports: Pick<EnrollPorts, "uid" | "layouts" | "trustedOwnerUid">,
  verb: string,
): { dataDir: string; store: DeviceStore } {
  const uid = ports.uid();
  if (command.mode === "system") {
    if (uid !== ROOT_UID) {
      throw new ManagementError(
        "not-root",
        `${verb} --system runs as root (sudo): a device acts as you, so the account agents run as must not be able to add one.`,
        [],
        77,
      );
    }
    const layout = ports.layouts.system;
    return { dataDir: layout.dataDir, store: layoutDeviceStore(layout, ports.trustedOwnerUid) };
  }
  if (uid === ROOT_UID) {
    throw new ManagementError(
      "is-root",
      `${verb} --user or --data-dir runs as the account that owns the data directory, not root.`,
    );
  }
  const dataDir = command.dataDir ?? ports.layouts[command.mode!].dataDir;
  if (command.dataDir !== null && command.dataDir === ports.layouts.system.dataDir) {
    // The system host reads root's store, never this directory's.
    throw new ManagementError(
      "usage",
      `${dataDir} is the system install's: run ${verb} --system as root.`,
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
      `${dataDir} belongs to another account: run ${verb} as the one volli-hostd runs as.`,
    );
  }
  return { dataDir, store: dataDirDeviceStore(dataDir) };
}

/** A store's refusal as the command's. */
export function storeRefusal(error: unknown): never {
  if (!(error instanceof DeviceStoreError)) throw error;
  const code =
    error.code === "unreadable"
      ? "store-unreadable"
      : error.code === "untrusted"
        ? "store-untrusted"
        : error.code;
  throw new ManagementError(code, error.message);
}

export async function runEnroll(
  command: EnrollCommand,
  ports: EnrollPorts,
): Promise<HostdEnrollResult> {
  const { dataDir, store } = deviceTarget(command, ports, "enroll");
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
  let outcome;
  try {
    outcome = enrollDevice(
      store,
      { publicKey: command.publicKey, name: command.name, via: "ssh" },
      { now: ports.now, newId: ports.newId },
    );
  } catch (error) {
    storeRefusal(error);
  }
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
