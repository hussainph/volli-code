/**
 * `volli-hostd devices list | revoke <deviceId>` (VC-700): the devices
 * enrolled with this host, and taking one back.
 *
 *   volli-hostd devices list --system | --user | --data-dir <dir>
 *   sudo volli-hostd devices revoke <deviceId> --system
 *   volli-hostd devices revoke <deviceId> --user | --data-dir <dir>
 *
 * Revoking keeps the entry, with `revokedAt`, so what the device did stays
 * attributed; its connections close at the door's next check and its
 * credentials are refused from then on. Enrolling the same key again makes
 * a new device. A system install's store is root's (`enrolled-devices.ts`),
 * so revoking there runs as root, as enrolling does; anyone may list it,
 * since it holds no secret.
 */
import type {
  HostdDevicesResult,
  HostdRevokeResult,
  InstallMode,
} from "@volli/host-install/contract";

import { deviceTarget, storeRefusal, type EnrollPorts } from "./enroll";
import {
  dataDirDeviceStore,
  describeDevice,
  readDeviceStore,
  revokeDevice,
  type RevokeOutcome,
} from "./enrolled-devices";
import { layoutDeviceStore } from "./layout";
import { ManagementError } from "./management";

export interface DevicesCommand {
  readonly kind: "devices";
  readonly action: "list" | "revoke";
  readonly mode: InstallMode | null;
  readonly dataDir: string | null;
  /** The device `revoke` takes back; `null` for `list`. */
  readonly deviceId: string | null;
}

export type DevicesPorts = Pick<EnrollPorts, "uid" | "layouts" | "trustedOwnerUid" | "now">;

export function runDevices(
  command: DevicesCommand,
  ports: DevicesPorts,
): HostdDevicesResult | HostdRevokeResult {
  if (command.action === "list") {
    const store =
      command.mode === "system"
        ? layoutDeviceStore(ports.layouts.system, ports.trustedOwnerUid)
        : dataDirDeviceStore(command.dataDir ?? ports.layouts[command.mode!].dataDir);
    const read = readDeviceStore(store);
    if (!read.ok) {
      throw new ManagementError(
        read.problem === "untrusted" ? "store-untrusted" : "store-unreadable",
        read.reason,
      );
    }
    return { v: 1, ok: true, devices: read.devices.map(describeDevice) };
  }
  const { store } = deviceTarget(command, ports, "devices revoke");
  let outcome: RevokeOutcome;
  try {
    outcome = revokeDevice(store, command.deviceId!, ports.now);
  } catch (error) {
    storeRefusal(error);
  }
  return { v: 1, ok: true, device: describeDevice(outcome.device), changed: outcome.changed };
}
