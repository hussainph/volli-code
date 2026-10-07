/**
 * Desktop main's remote hosts (VC-700 PR 2): `@volli/host-install`'s engine
 * (`createRemoteHosts`) composed with this app's ports, behind `cloud`.
 *
 * - **Registry:** `<userData>/remote-hosts.json`, plain JSON, no secret.
 * - **Device keys:** one P-256 key per host, in the host's sealed credential
 *   inventory (`host-credentials.enc`, the `host-private` family, purpose
 *   `remote-host-device:<name>`), sealed by the same keychain-wrapped key the
 *   web search keys use. Never logged, never in a snapshot.
 * - **The hostd it installs** is the pinned one: the app's signed
 *   `hostd-release-manifest.json` is the only trust root for release assets.
 *   With no pinned assets (a local or CI build), an unpackaged build may name
 *   local tarballs in `VOLLI_HOSTD_DEV_TARBALLS`; a packaged build never does.
 * - **Transport:** the person's own `ssh` (their config, agent and
 *   known_hosts), a tunnel per host, VC-670 links on its local end.
 *
 * The engine refuses everything while `cloud` is off; host-core's handlers
 * answer that as unavailable, so flag off is unchanged.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { RemoteHostsPort } from "@volli/host-core/handlers";
import type { HostFeature } from "@volli/host-protocol";
import { createHostLink } from "@volli/host-protocol/client-link";
import {
  acceptHostKeys,
  createRemoteHosts,
  createSshTunnel,
  discoverHostKeys,
  parseHostdReleasePin,
  resolveArtifact,
  supportedTargets,
  systemSsh,
  type DeviceKeyStore,
  type HostdReleasePin,
  type InstallLogger,
  type RemoteHosts,
  type RemoteHostsStore,
  type RemoteHostsWakeCause,
} from "@volli/host-install";

/** What the sealed credential inventory offers this module: one family's records. */
export interface DeviceKeyInventory {
  get(
    family: "host-private",
    selector: { readonly purpose: string },
  ): { readonly value: unknown } | null;
  put(family: "host-private", selector: { readonly purpose: string }, value: string): unknown;
  remove(family: "host-private", selector: { readonly purpose: string }): boolean;
}

/** The selector purpose a device key is kept under. */
export function deviceKeyPurpose(name: string): string {
  return `remote-host-device:${name}`;
}

/**
 * Device keys in the sealed inventory. A keychain-backed keyring fetches its
 * key asynchronously, so each call unlocks first (a no-op once unlocked).
 */
export function inventoryDeviceKeys(
  inventory: DeviceKeyInventory,
  unlock: () => Promise<void>,
): DeviceKeyStore {
  return {
    async get(name) {
      await unlock();
      const value = inventory.get("host-private", { purpose: deviceKeyPurpose(name) })?.value;
      return typeof value === "string" ? value : null;
    },
    async put(name, pkcs8Pem) {
      await unlock();
      inventory.put("host-private", { purpose: deviceKeyPurpose(name) }, pkcs8Pem);
    },
    async remove(name) {
      await unlock();
      inventory.remove("host-private", { purpose: deviceKeyPurpose(name) });
    },
  };
}

/**
 * The registry file: replaced whole, through a temporary file, so it is never
 * half written. A missing file is none yet; one that cannot be read or parsed
 * throws, and the engine then leaves it exactly as it is (read-only).
 */
export function fileRegistryStore(path: string): RemoteHostsStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return JSON.parse(text) as unknown;
    },
    save(file) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

/** The app's signed pin, or `null` when this build carries none (it is not an error). */
export function readHostdPin(manifestPath: string): HostdReleasePin | null {
  try {
    return parseHostdReleasePin(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Local tarballs a development build may install from: never a packaged one's. */
export function devTarballsFrom(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean,
): readonly string[] {
  if (packaged) return [];
  const list = env["VOLLI_HOSTD_DEV_TARBALLS"];
  return list === undefined || list === "" ? [] : list.split(delimiter).filter(Boolean);
}

/** What the wake source reads of Electron: `powerMonitor` and `net` satisfy it. */
export interface WakePlatform {
  readonly powerMonitor: {
    on(event: "resume" | "unlock-screen", listener: () => void): unknown;
    removeListener(event: "resume" | "unlock-screen", listener: () => void): unknown;
  };
  readonly net: { isOnline(): boolean };
}

/** How often the network is read for coming back online: Electron main has no event for it. */
export const ONLINE_POLL_MS = 2_000;

/**
 * The engine's wake source: the Mac woke or its screen unlocked
 * (`power-resume`), or the network came back (`network-online`, read every
 * {@link ONLINE_POLL_MS}). Attached while the engine listens, and not after.
 */
export function desktopWakeSource(
  platform: WakePlatform,
  pollMs: number = ONLINE_POLL_MS,
): (listener: (cause: RemoteHostsWakeCause) => void) => () => void {
  return (listener) => {
    const resumed = (): void => listener("power-resume");
    platform.powerMonitor.on("resume", resumed);
    platform.powerMonitor.on("unlock-screen", resumed);
    let online = platform.net.isOnline();
    const poll = setInterval(() => {
      const now = platform.net.isOnline();
      if (now && !online) listener("network-online");
      online = now;
    }, pollMs);
    poll.unref?.();
    return () => {
      clearInterval(poll);
      platform.powerMonitor.removeListener("resume", resumed);
      platform.powerMonitor.removeListener("unlock-screen", resumed);
    };
  };
}

export interface DesktopRemoteHostsOptions {
  readonly userData: string;
  readonly appVersion: string;
  readonly packaged: boolean;
  /** The app's `hostd-release-manifest.json`, beside the main bundle. */
  readonly manifestPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly inventory: DeviceKeyInventory;
  readonly unlockInventory: () => Promise<void>;
  /** The `cloud` flag, read on every call. */
  readonly enabled: () => boolean;
  readonly logger: InstallLogger;
  /** Sleep, unlock and the network: tunnels and links try at once (exit criterion 4). */
  readonly wake?: WakePlatform;
}

/**
/**
 * A remote project's Sessions (VC-713): create, attach and command them, follow
 * the one on screen, page its history, and list the Workspace's rows. Hosts
 * that predate a feature simply do not grant it, and the relay refuses its
 * operations typed (N−1).
 */
export const REMOTE_SESSION_LINK_FEATURES = [
  "sessions",
  "sessions.subscribe",
  "sessions.queue",
  "sessions.history",
  "sessions.listing",
] as const;

/**
 * What every Workspace link to a remote host asks for: sign-ins (VC-702), the
 * host's log for the one log viewer (`host.logs`, VC-712), its board and its
 * Session reads (VC-710, for the board relay), and its Sessions (VC-713).
 * Granted is asked ∩ offered, so a host from before any of them grants less.
 */
export const REMOTE_HOST_LINK_FEATURES = [
  "sign-ins",
  "auth.callback",
  "host.logs",
  "board.read",
  "board.write",
  "session.read",
  ...REMOTE_SESSION_LINK_FEATURES,
] as const satisfies readonly HostFeature[];

/** The engine, composed with this app's ports. */
export function createDesktopRemoteHosts(options: DesktopRemoteHostsOptions): RemoteHosts {
  const { logger, appVersion } = options;
  const pin = readHostdPin(options.manifestPath);
  const devTarballs = devTarballsFrom(options.env, options.packaged);
  const cacheDir = join(options.userData, "hostd-cache");
  return createRemoteHosts({
    store: fileRegistryStore(join(options.userData, "remote-hosts.json")),
    deviceKeys: inventoryDeviceKeys(options.inventory, options.unlockInventory),
    ssh: (target) => systemSsh({ target, logger }),
    hostKeys: (target) => ({
      discover: () => discoverHostKeys({ target, logger }),
      accept: async (offer) => {
        await acceptHostKeys({ target, offer, home: homedir(), logger });
      },
    }),
    artifact: (target) =>
      resolveArtifact({ version: appVersion, target, cacheDir, pin, devTarballs, logger }),
    // The pin's targets (linux and darwin, x64 and arm64), else the dev tarballs' own.
    supportedTargets: supportedTargets(pin, devTarballs),
    appVersion,
    deviceName: hostname().replace(/\.local$/u, ""),
    tunnel: (tunnel) => createSshTunnel({ ...tunnel }),
    link: (link) => createHostLink(link),
    linkFeatures: REMOTE_HOST_LINK_FEATURES,
    ...(options.wake === undefined ? {} : { wake: desktopWakeSource(options.wake) }),
    now: Date.now,
    newId: randomUUID,
    logger,
    enabled: options.enabled,
  });
}

/**
 * The engine as the handler map's `remoteHosts` port: its `subscribe` hears
 * changes only, and the port's opens with the current snapshot.
 */
export function remoteHostsPort(
  hosts: RemoteHosts,
  /**
   * `hosts.signIn` (the host chip's "Sign in again", VC-702): answers once
   * the host can take a sign-in; the window then runs it. Absent, the
   * engine's own refusal.
   */
  signIn?: (hostId: string, providerId: string) => Promise<void>,
): RemoteHostsPort {
  return {
    snapshot: () => hosts.snapshot(),
    subscribe(listener) {
      const current = hosts.snapshot();
      const unsubscribe = hosts.subscribe((snapshot) => void listener(snapshot));
      void listener(current);
      return unsubscribe;
    },
    retry: (hostId) => hosts.retry(hostId),
    updateHost: (hostId, when) => hosts.updateHost(hostId, when),
    cancelScheduledUpdate: (hostId) => hosts.cancelScheduledUpdate(hostId),
    signIn: (hostId, providerId) =>
      signIn === undefined ? hosts.signIn(hostId, providerId) : signIn(hostId, providerId),
    forget: (hostId) => hosts.forget(hostId),
    rename: (hostId, name) => hosts.rename(hostId, name),
    devices: (hostId) => hosts.devices(hostId),
    startAdd: (input) => hosts.startAdd(input),
    subscribeAdd: (flowId, listener) => hosts.subscribeAdd(flowId, (event) => void listener(event)),
    answerAdd: (flowId, questionId, answer) => hosts.answerAdd(flowId, questionId, answer),
    sudoPassword: (flowId, questionId, password) =>
      hosts.sudoPassword(flowId, questionId, password),
    retryAdd: (flowId, from) => hosts.retryAdd(flowId, from),
    cancelAdd: (flowId) => hosts.cancelAdd(flowId),
    addFacts: (flowId) => hosts.addFacts(flowId),
    // The add flows main still owns (VC-720): a reopened window's discovery read.
    activeAdds: () => hosts.activeAdds(),
    // A host's projects (VC-710).
    projects: (hostId) => hosts.projects(hostId),
    createProject: (input) => hosts.createProject(input),
    openWorkspace: (hostId, workspaceId) => hosts.openWorkspace(hostId, workspaceId),
    closeWorkspace: (hostId, workspaceId) => hosts.closeWorkspace(hostId, workspaceId),
  };
}
