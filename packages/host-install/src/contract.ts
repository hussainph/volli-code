/**
 * The box-side contract (VC-700): what `volli-hostd install | start | enroll |
 * devices | status --json` print, one JSON object on stdout each.
 *
 * hostd writes these shapes and this package reads them, so both import them
 * from here: a field one side renames fails the other's typecheck. Pure
 * types and guards, no Node: hostd bundles it, and a future CLI or control
 * plane reads the same answers.
 *
 * Additive only. `management` is the level a hostd speaks; a hostd that
 * prints no `management` (anything before VC-700) cannot be managed over SSH
 * and is only ever replaced, never adopted as it stands.
 */

/** The management level this build speaks. Raise it only for a breaking change. */
export const HOSTD_MANAGEMENT_LEVEL = 1;

/** With sudo, a system unit under the `volli` account; without, a user unit. */
export type InstallMode = "system" | "user";

/** The loopback address hostd's host-protocol listener binds by default. */
export const DEFAULT_HOST_PROTOCOL_PORT = 7420;

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** Every refusal or failure a management command answers, typed. */
export type HostdFailureCode =
  | "usage"
  | "not-root"
  | "is-root"
  | "bad-release"
  | "other-mode-installed"
  | "not-installed"
  | "command-failed"
  | "linger-required"
  | "start-failed"
  | "start-timeout"
  | "refusing"
  | "not-serving"
  | "bad-key"
  | "store-unreadable"
  /** A system install's device store is not root's alone, so it is not believed. */
  | "store-untrusted"
  /** Another enroll or revoke held the device store too long. */
  | "busy"
  | "unknown-device"
  /**
   * The unit's effective configuration might already name a secret key that
   * install cannot see (an `EnvironmentFile=`, systemd unreadable): install
   * makes no new key rather than risk orphaning the old one.
   */
  | "secret-key-unclear"
  /** A Mac runs hostd as the person's launchd agent only: `install --user`. */
  | "system-unsupported"
  | "data-dir-owner";

export interface HostdFailure {
  readonly v: 1;
  readonly ok: false;
  readonly code: HostdFailureCode;
  /** One sentence for a person. Never carries a secret. */
  readonly message: string;
  /** Supporting lines (a journal tail, a command's stderr), for the log under Details. */
  readonly detail?: readonly string[];
}

export interface HostdInstallResult {
  readonly v: 1;
  readonly ok: true;
  readonly mode: InstallMode;
  readonly version: string;
  /** The version `current` pointed at before, or `null` on a first install. */
  readonly previous: string | null;
  /** `flat`: a hand-made install (docs/runbooks/hostd-box.md) brought under management. */
  readonly adopted: "flat" | null;
  /** Whether anything on disk or in systemd changed. A second run answers `false`. */
  readonly changed: boolean;
  /** What it did, in order, as short phrases: the log under Details. */
  readonly actions: readonly string[];
  readonly dataDir: string;
  /** `current`'s binary: what `start`, `enroll` and `status --json` run from now on. */
  readonly binary: string;
  readonly listen: ListenAddress;
  /** The account hostd and its Sessions run as; `null` for a user unit (yours). */
  readonly serviceUser: string | null;
}

export interface HostdStartResult {
  readonly v: 1;
  readonly ok: true;
  readonly mode: InstallMode;
  readonly version: string;
  /** Whether it (re)started the unit; `false` when the right version already served. */
  readonly restarted: boolean;
  readonly hostId: string | null;
  readonly listen: ListenAddress | null;
  /** systemd user units: whether they outlive logout. `null` for a system unit and on a Mac. */
  readonly linger: boolean | null;
}

export interface HostdEnrollResult {
  readonly v: 1;
  readonly ok: true;
  readonly hostId: string;
  readonly deviceId: string;
  /** `SHA256:…` of the enrolled key's SPKI. */
  readonly fingerprint: string;
  /** `false` when this key was already enrolled. */
  readonly created: boolean;
  readonly version: string;
  readonly listen: ListenAddress | null;
}

export interface HostdDeviceSummary {
  readonly deviceId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly enrolledAt: string;
  readonly via: string;
  readonly revokedAt: string | null;
}

/** `volli-hostd devices list`. */
export interface HostdDevicesResult {
  readonly v: 1;
  readonly ok: true;
  /** Revoked ones included, with `revokedAt`; never a key. */
  readonly devices: readonly HostdDeviceSummary[];
}

/** `volli-hostd devices revoke <deviceId>`. */
export interface HostdRevokeResult {
  readonly v: 1;
  readonly ok: true;
  readonly device: HostdDeviceSummary;
  /** `false` when it was already revoked. */
  readonly changed: boolean;
}

export interface HostdManagedStatus {
  readonly v: 1;
  readonly management: number;
  /** The binary answering, which may not be the one installed. */
  readonly binary: { readonly version: string };
  readonly mode: InstallMode | null;
  readonly install: {
    readonly root: string;
    /** The release `current` names, or `null` when there is none. */
    readonly current: string | null;
    readonly releases: readonly string[];
    /** A hand-made install sits at the root (the M1 runbook's layout). */
    readonly flat: boolean;
    /** The port `install` configured. */
    readonly port: number | null;
  } | null;
  readonly unit: {
    readonly name: string;
    /** systemd's ActiveState: `active`, `inactive`, `failed`, `activating`… */
    readonly active: string;
    /** systemd's UnitFileState: `enabled`, `disabled`, `not-found`… */
    readonly enabled: string;
  } | null;
  readonly linger: boolean | null;
  /**
   * When the host comes up on its own: `boot` (a system unit, or a user unit
   * that lingers), `login` (a Mac's launchd agent, or a user unit that does
   * not linger: it starts when its person logs in), `null` with nothing
   * installed. Additive: a hostd before it prints none.
   */
  readonly startsAt?: "boot" | "login" | null;
  readonly dataDir: string | null;
  readonly verdict: "serving" | "refusing" | "not-serving";
  readonly detail: string | null;
  readonly running: {
    readonly state: string;
    readonly version: string;
    readonly pid: number;
    readonly hostId: string | null;
    readonly listen: ListenAddress | null;
  } | null;
  /** `null` when the store could not be read (another account's data dir). */
  readonly devices: readonly HostdDeviceSummary[] | null;
}

export type HostdAnswer<T> = T | HostdFailure;

/**
 * The one JSON object a management command printed: its last non-empty line
 * that parses as `{ v: 1, … }`. `null` when there is none (an older hostd's
 * usage text, a shell error).
 */
export function readHostdJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not ours; keep looking above it.
    }
  }
  return null;
}

export function isHostdFailure(
  value: Record<string, unknown>,
): value is HostdFailure & Record<string, unknown> {
  return value.ok === false && typeof value.code === "string" && typeof value.message === "string";
}
