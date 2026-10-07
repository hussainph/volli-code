/**
 * Fixture world for the remote-host scratches (VC-615). Nothing here talks to
 * anything: every host, key, device and sign-in is invented, chosen to be the
 * size and shape of the real thing so the layouts are judged against honest
 * content — a long tailnet name, a fingerprint, a provider with no account
 * label.
 */

/** The desktop build these prototypes pretend to be. */
export const APP_VERSION = "0.3.0";

export type HostOs = "linux" | "macos";

/** One `Host` block from `~/.ssh/config`, as the picker would read it. */
export interface SshConfigHost {
  alias: string;
  user: string;
  hostname: string;
  port?: number;
  /** Already paired with this Mac — the picker says so before you connect. */
  paired?: boolean;
  /** What connecting to this one does when the lab's outcome is "Natural". */
  natural: Outcome;
}

/**
 * Every ending the SSH install can reach. "success" is the main path; the rest
 * are the failure states the brief asks for, plus the two it implies
 * (unreachable, a restored host's changed identity).
 */
export type Outcome =
  | "success"
  | "success-mac"
  | "unreachable"
  | "password"
  | "passphrase"
  | "unsupported"
  | "no-linger"
  | "disk-full"
  | "older-hostd"
  | "already-paired"
  | "new-identity";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  success: "Succeeds · Linux",
  "success-mac": "Succeeds · Mac",
  unreachable: "Can’t reach it",
  password: "Asks for a password",
  passphrase: "SSH key is locked",
  unsupported: "Unsupported (arm64)",
  "no-linger": "No linger (stops on logout)",
  "disk-full": "Disk full",
  "older-hostd": "Older host already running",
  "already-paired": "Already paired",
  "new-identity": "Restored host (new identity)",
};

export const SSH_CONFIG: readonly SshConfigHost[] = [
  { alias: "hetzner-1", user: "hussain", hostname: "203.0.113.24", natural: "success" },
  { alias: "mac-mini", user: "hussain", hostname: "mac-mini.local", natural: "success-mac" },
  { alias: "build", user: "ci", hostname: "build.internal.volli.dev", natural: "older-hostd" },
  {
    alias: "studio",
    user: "hussain",
    hostname: "studio.local",
    paired: true,
    natural: "already-paired",
  },
  { alias: "pi", user: "pi", hostname: "raspberrypi.local", natural: "unsupported" },
  { alias: "staging", user: "deploy", hostname: "10.0.4.12", port: 2222, natural: "no-linger" },
];

/** The facts the install learns about a box, revealed one by one. */
export interface HostFacts {
  os: HostOs;
  /** "Ubuntu 24.04", "macOS 15.4". */
  system: string;
  arch: string;
  memory: string;
  free: string;
}

export const FACTS: Record<HostOs, HostFacts> = {
  linux: {
    os: "linux",
    system: "Ubuntu 24.04",
    arch: "x86-64",
    memory: "8 GB",
    free: "38 GB free",
  },
  macos: {
    os: "macos",
    system: "macOS 15.4",
    arch: "Apple silicon",
    memory: "16 GB",
    free: "212 GB free",
  },
};

export const HOST_KEY_FINGERPRINT = "SHA256:q3Zt9fK1x0mVbE7cRw2LhP8sNdYj4uGa6Tz5oIeQkXw";
export const SHORT_FINGERPRINT = "q3Zt 9fK1 x0mV";

/** Provider sign-ins this Mac holds today (Pi's auth plus `gh`). */
export interface SignIn {
  id: string;
  name: string;
  /** "Claude Max", "API key". */
  kind: string;
  account?: string;
  /** Forwarded by default in the "send" flows. */
  defaultOn: boolean;
  group: "model" | "git";
}

export const MAC_SIGN_INS: readonly SignIn[] = [
  {
    id: "anthropic",
    name: "Claude",
    kind: "Max",
    account: "hussain@volli.dev",
    defaultOn: true,
    group: "model",
  },
  {
    id: "openai",
    name: "ChatGPT",
    kind: "Plus",
    account: "hussain@volli.dev",
    defaultOn: true,
    group: "model",
  },
  { id: "openrouter", name: "OpenRouter", kind: "API key", defaultOn: false, group: "model" },
  {
    id: "github",
    name: "GitHub",
    kind: "git push",
    account: "hussainph",
    defaultOn: true,
    group: "git",
  },
];

/** A client paired to a host. `thisDevice` is the Mac you are sitting at. */
export interface PairedDevice {
  id: string;
  name: string;
  kind: "mac" | "phone" | "browser";
  thisDevice?: boolean;
  paired: string;
  lastSeen: string;
}

export const DEVICES: readonly PairedDevice[] = [
  {
    id: "d1",
    name: "Hussain's MacBook Pro",
    kind: "mac",
    thisDevice: true,
    paired: "Oct 4",
    lastSeen: "Now",
  },
  { id: "d2", name: "Hussain's iPhone", kind: "phone", paired: "Oct 4", lastSeen: "12 min ago" },
  { id: "d3", name: "Arc on studio", kind: "browser", paired: "Sep 30", lastSeen: "3 days ago" },
];

export const PAIRING_CODE = "RQ7K-4MXD-T9PH";
export const TAILNET_NAME = "hetzner-1.tail3f2a.ts.net";
