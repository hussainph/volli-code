/**
 * Where a managed install lives (VC-700), for each of the two modes the
 * owner ruled (VC-615, 2026-10-07):
 *
 * | | `system` (sudo) | `user` (no sudo) |
 * |---|---|---|
 * | releases, `current` | `/opt/volli-hostd/releases/<v>`, `/opt/volli-hostd/current` | `$XDG_DATA_HOME/volli-hostd/…` |
 * | data directory | `/var/lib/volli-hostd` (the `volli` account's home, 0700) | `$XDG_STATE_HOME/volli-hostd` (0700) |
 * | unit | `/etc/systemd/system/volli-hostd.{service,socket}` + drop-ins | `$XDG_CONFIG_HOME/systemd/user/volli-hostd.service` |
 * | secret key | `/etc/volli-hostd/session-secrets.key` | `$XDG_CONFIG_HOME/volli-hostd/session-secrets.key` |
 * | enrolled devices | `/etc/volli-hostd-devices` (root's, 0644) | `<data dir>/enrolled-devices.json` (0600) |
 * | agent socket | `/run/volli-hostd.sock`, bound by systemd as root | `<data dir>/volli.sock` |
 * | runs as | `volli`, so agents never act as you | you: agents share your account |
 *
 * Enrolled devices act as the person, so a system install keeps them where
 * only root writes (`enrolled-devices.ts`): never in the data directory,
 * which the account every agent runs as owns.
 *
 * Releases sit side by side and `current` is a symlink, so an upgrade is one
 * rename and the release before it is the rollback, as the M1 runbook kept
 * `/opt/volli-hostd.prev-*`. The system layout shares `/opt/volli-hostd` with
 * the runbook's hand-made (flat) install, which `install` adopts in place.
 */
import { join } from "node:path";

import type { InstallMode } from "@volli/host-install/contract";

import {
  DEFAULT_DEVICES_FILE,
  enrolledDevicesPath,
  rootDeviceStore,
  type DeviceStore,
} from "./enrolled-devices";

export const SERVICE_UNIT = "volli-hostd.service";
export const SOCKET_UNIT = "volli-hostd.socket";
/** The drop-in `install` owns and rewrites; a person's own drop-ins sit beside it. */
export const MANAGED_DROP_IN = "50-volli-managed.conf";
/** The runbook's name for the secret-key drop-in, kept so adoption recognises it. */
export const SECRET_KEY_DROP_IN = "secret-key.conf";

export interface InstallLayout {
  readonly mode: InstallMode;
  readonly root: string;
  readonly releasesDir: string;
  readonly currentLink: string;
  /** What `install` configured (`managed.ts`); `start` converges to it. */
  readonly managedFile: string;
  readonly binLinkDir: string;
  readonly dataDir: string;
  readonly unitDir: string;
  readonly dropInDir: string;
  readonly keyFile: string;
  /** Where enrolled device keys live; a system install's is root's. */
  readonly devicesFile: string;
  readonly socketPath: string;
  /** The account the unit runs as; `null` for a user unit. */
  readonly serviceUser: string | null;
}

export interface LayoutEnvironment {
  /** Prefixes every system path: `""` on a box, a temporary directory in tests. */
  readonly prefix?: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function installLayout(mode: InstallMode, where: LayoutEnvironment): InstallLayout {
  if (mode === "system") {
    const at = (path: string) => `${where.prefix ?? ""}${path}`;
    const root = at("/opt/volli-hostd");
    const unitDir = at("/etc/systemd/system");
    return {
      mode,
      root,
      releasesDir: join(root, "releases"),
      currentLink: join(root, "current"),
      managedFile: join(root, "managed.json"),
      binLinkDir: at("/usr/local/bin"),
      dataDir: at("/var/lib/volli-hostd"),
      unitDir,
      dropInDir: join(unitDir, `${SERVICE_UNIT}.d`),
      keyFile: at("/etc/volli-hostd/session-secrets.key"),
      devicesFile: at(DEFAULT_DEVICES_FILE),
      socketPath: "/run/volli-hostd.sock",
      serviceUser: "volli",
    };
  }
  const xdg = (name: string, fallback: string) => {
    const value = where.env[name];
    return value !== undefined && value.startsWith("/") ? value : join(where.home, fallback);
  };
  const root = join(xdg("XDG_DATA_HOME", ".local/share"), "volli-hostd");
  const config = xdg("XDG_CONFIG_HOME", ".config");
  const dataDir = join(xdg("XDG_STATE_HOME", ".local/state"), "volli-hostd");
  const unitDir = join(config, "systemd/user");
  return {
    mode,
    root,
    releasesDir: join(root, "releases"),
    currentLink: join(root, "current"),
    managedFile: join(root, "managed.json"),
    binLinkDir: join(where.home, ".local/bin"),
    dataDir,
    unitDir,
    dropInDir: join(unitDir, `${SERVICE_UNIT}.d`),
    keyFile: join(config, "volli-hostd/session-secrets.key"),
    devicesFile: enrolledDevicesPath(dataDir),
    socketPath: join(dataDir, "volli.sock"),
    serviceUser: null,
  };
}

/**
 * The enrolled-devices store a layout's host reads: root's file for a
 * system install (believed only while owned by `trustedOwnerUid`, root in
 * production), the data directory's own for a user one.
 */
export function layoutDeviceStore(layout: InstallLayout, trustedOwnerUid = 0): DeviceStore {
  return layout.mode === "system"
    ? rootDeviceStore(layout.devicesFile, trustedOwnerUid)
    : { path: layout.devicesFile, trustedOwnerUid: null };
}
