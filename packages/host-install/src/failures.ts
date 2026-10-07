/**
 * Every way adding a host can stop (VC-700), typed, each with the one line a
 * person sees and the one recovery the lab designed (`#host-add`,
 * docs/research/vc-615-remote-host-ux.md, "Every failure state"). A
 * **failure** is retried from the step that broke; a **question** waits for
 * the person's answer and then carries on.
 *
 * The copy lives here so a CLI and the desktop say the same thing; the
 * Checklist (PR 3) renders it. Details (stderr, a journal tail) go to the
 * log under Details, never into the line.
 */
import type { HostdFailureCode, InstallMode } from "./contract";
import type { HostKeyOffer } from "./ssh";

/**
 * The steps every provider answers. `deliver` is an upload over SSH, an image
 * for a provider that runs containers; `link` is an SSH tunnel, or a
 * provider's own route.
 */
export type StepId = "connect" | "probe" | "deliver" | "install" | "start" | "enroll" | "link";

export const STEP_ORDER: readonly StepId[] = [
  "connect",
  "probe",
  "deliver",
  "install",
  "start",
  "enroll",
  "link",
];

/** The lab's five checklist rows, and the steps behind each. */
export const CHECKLIST_ROWS = {
  connect: ["connect"],
  check: ["probe"],
  install: ["deliver", "install"],
  start: ["start"],
  pair: ["enroll", "link"],
} as const satisfies Record<string, readonly StepId[]>;

export type ProvisionFailure =
  // connect
  | { readonly code: "unreachable"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "unresolvable"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "host-key-changed"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "host-key-rejected"; readonly step: "connect" }
  /** The box showed keys whose fingerprints could not be computed: nothing to compare, so nothing to accept. */
  | { readonly code: "host-key-unverifiable"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "password-only"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "key-refused"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "ssh-missing"; readonly step: "connect"; readonly detail: string }
  | { readonly code: "ssh-failed"; readonly step: StepId; readonly detail: string }
  /** The connection dropped mid-step: retry that step. */
  | { readonly code: "connection-lost"; readonly step: StepId; readonly detail: string }
  // probe
  | { readonly code: "probe-failed"; readonly step: "probe"; readonly detail: string }
  | { readonly code: "unsupported-system"; readonly step: "probe"; readonly system: string }
  | { readonly code: "unsupported-arch"; readonly step: "probe"; readonly arch: string }
  /** A known target this build has no hostd for: `linux-arm64`, `darwin-arm64`… */
  | { readonly code: "target-unavailable"; readonly step: "probe"; readonly target: string }
  | { readonly code: "no-systemd"; readonly step: "probe" }
  | { readonly code: "no-user-manager"; readonly step: "probe" }
  | { readonly code: "glibc-too-old"; readonly step: "probe"; readonly glibc: string }
  | {
      readonly code: "disk-full";
      readonly step: "probe";
      readonly freeBytes: number;
      readonly needBytes: number;
    }
  | { readonly code: "host-newer"; readonly step: "probe"; readonly version: string }
  | { readonly code: "needs-sudo"; readonly step: "probe"; readonly version: string }
  // upload
  | {
      readonly code: "artifact-unavailable" | "artifact-checksum" | "artifact-fetch-failed";
      readonly step: "deliver";
      readonly detail: string;
    }
  | { readonly code: "upload-failed"; readonly step: "deliver"; readonly detail: string }
  | { readonly code: "remote-checksum"; readonly step: "deliver"; readonly detail: string }
  | { readonly code: "unpack-failed"; readonly step: "deliver"; readonly detail: string }
  // install, start, enroll: what hostd answered
  | {
      readonly code: "hostd-refused";
      readonly step: "install" | "start" | "enroll";
      readonly hostd: HostdFailureCode | "no-answer";
      readonly message: string;
      readonly detail: readonly string[];
    }
  /**
   * A user unit stops at logout unless the account lingers, and this login
   * has no sudo to turn that on: an administrator runs `command`.
   */
  | {
      readonly code: "linger-needs-admin";
      readonly step: "start";
      readonly user: string;
      readonly command: string;
    }
  // tunnel
  | { readonly code: "tunnel-failed"; readonly step: "link"; readonly detail: string }
  /**
   * Everything worked, and this Mac could not keep the host: its device key
   * or its hosts file would not save. Nothing was half kept; the link runs again.
   */
  | { readonly code: "save-failed"; readonly step: "link"; readonly detail: string }
  /**
   * A step found the state missing what it relies on (a result, a fact), or
   * threw: never an exception for the caller, always this, retried from the
   * probe so every fact and decision is gathered again.
   */
  | { readonly code: "unexpected-state"; readonly step: StepId; readonly detail: string };

export type ProvisionQuestion =
  /** An unknown host key: compare and accept, or go back. */
  | { readonly kind: "host-key"; readonly step: "connect"; readonly offer: HostKeyOffer }
  /** An older hostd runs here: update it, or use it as it is when it can be managed. */
  | {
      readonly kind: "existing-hostd";
      readonly step: "probe";
      readonly version: string;
      readonly mode: InstallMode;
      readonly adoptable: boolean;
    }
  /** This Mac is already enrolled with this host. */
  | { readonly kind: "already-paired"; readonly step: "probe"; readonly hostId: string }
  /**
   * sudo wants a password: for a system install (or settle for a user unit),
   * for lingering, or to enroll with a system install (its device store is root's).
   */
  | {
      readonly kind: "sudo-password";
      readonly step: "install" | "start" | "enroll";
      readonly reason: "install" | "linger" | "enroll";
      readonly command: string;
      /** The last password was wrong. */
      readonly retry: boolean;
    }
  /** The host id differs from the one this Mac pinned: it was restored or reinstalled. */
  | {
      readonly kind: "identity-changed";
      readonly step: "enroll";
      readonly pinned: string;
      readonly hostId: string;
    };

export type ProvisionAnswer =
  | { readonly kind: "accept-host-key" }
  | { readonly kind: "update" }
  | { readonly kind: "adopt" }
  | { readonly kind: "open" }
  /** Kept in memory by the caller for this flow only; never in state or a log. */
  | { readonly kind: "sudo-password"; readonly password: string }
  | { readonly kind: "user-install" }
  | { readonly kind: "repair" };

/** Recovery: retry from a step, or go back and choose another host. */
export type Recovery =
  | { readonly action: "retry"; readonly label: string; readonly from: StepId }
  | { readonly action: "back"; readonly label: string };

const TARGET_NAMES: Readonly<Record<string, string>> = {
  "linux-arm64": "arm64 Linux",
  "linux-x64": "x86-64 Linux",
  "darwin-arm64": "Apple silicon Mac",
  "darwin-x64": "Intel Mac",
};

function retry(label: string, from: StepId): Recovery {
  return { action: "retry", label, from };
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;

/** The one line and the one recovery for a failure. `host` is the name the person sees. */
export function describeFailure(
  failure: ProvisionFailure,
  host: string,
): { readonly line: string; readonly recovery: Recovery } {
  const { step } = failure;
  const back: Recovery = { action: "back", label: "Choose another host" };
  switch (failure.code) {
    case "unreachable":
      return { line: `Couldn’t reach ${host}`, recovery: retry("Try again", step) };
    case "unresolvable":
      return { line: `No host named ${host}`, recovery: back };
    case "host-key-changed":
      return {
        line: `${host}’s host key changed since you last connected. If you reinstalled it, remove the old key from known_hosts.`,
        recovery: retry("Try again", step),
      };
    case "host-key-rejected":
      return {
        line: `You didn’t accept ${host}’s host key`,
        recovery: retry("Check the key again", step),
      };
    case "host-key-unverifiable":
      return {
        line: `Couldn’t compute ${host}’s host key fingerprints to show you, so they can’t be checked`,
        recovery: retry("Try again", step),
      };
    case "password-only":
      return {
        line: `${host} asked for a password. Add this Mac’s key: ssh-copy-id ${host}`,
        recovery: retry("Try again", step),
      };
    case "key-refused":
      return {
        line: `${host} didn’t accept a key from this Mac. Load yours: ssh-add --apple-use-keychain`,
        recovery: retry("Try again", step),
      };
    case "ssh-missing":
      return { line: "This Mac has no ssh command", recovery: back };
    case "ssh-failed":
    case "connection-lost":
      return { line: `Lost the connection to ${host}`, recovery: retry("Try again", step) };
    case "probe-failed":
      return { line: `Couldn’t check ${host}`, recovery: retry("Check again", step) };
    case "unsupported-system":
      return { line: `Volli hosts run on Linux or a Mac, not ${failure.system}`, recovery: back };
    case "unsupported-arch":
      return { line: `${failure.arch} Linux isn’t supported yet`, recovery: back };
    case "target-unavailable":
      return {
        line: `${TARGET_NAMES[failure.target] ?? failure.target} hosts aren’t supported by this build yet`,
        recovery: back,
      };
    case "no-systemd":
      return { line: `${host} doesn’t run systemd`, recovery: back };
    case "no-user-manager":
      return {
        line: `${host} gives this login no systemd user session, and no sudo`,
        recovery: back,
      };
    case "glibc-too-old":
      return { line: `${host}’s glibc ${failure.glibc} is older than 2.36`, recovery: back };
    case "disk-full":
      return {
        line: `${mb(failure.freeBytes)} free · needs ${mb(failure.needBytes)}`,
        recovery: retry("Check again", step),
      };
    case "host-newer":
      return {
        line: `${host} runs Volli host ${failure.version}, newer than this app`,
        recovery: back,
      };
    case "needs-sudo":
      return {
        line: `Volli host ${failure.version} runs as a system service here; updating it needs sudo`,
        recovery: back,
      };
    case "artifact-unavailable":
      return {
        line: "This version’s host download isn’t published yet",
        recovery: retry("Try again", step),
      };
    case "artifact-checksum":
    case "remote-checksum":
      return {
        line: "The download didn’t match its checksum",
        recovery: retry("Try again", "deliver"),
      };
    case "artifact-fetch-failed":
      return { line: "Couldn’t download Volli host", recovery: retry("Try again", step) };
    case "upload-failed":
    case "unpack-failed":
      return { line: `Couldn’t copy Volli host to ${host}`, recovery: retry("Try again", step) };
    case "hostd-refused":
      return { line: failure.message, recovery: retry("Try again", step) };
    case "linger-needs-admin":
      return {
        line: `${host} stops Volli host when ${failure.user} logs out. Ask an administrator to run: ${failure.command}`,
        recovery: retry("Check again", step),
      };
    case "tunnel-failed":
      return { line: `Couldn’t open the tunnel to ${host}`, recovery: retry("Try again", step) };
    case "save-failed":
      return { line: `Couldn’t save ${host} on this Mac`, recovery: retry("Try again", step) };
    case "unexpected-state":
      return {
        line: `Adding ${host} lost track of where it was`,
        recovery: retry("Check again", "probe"),
      };
  }
}
