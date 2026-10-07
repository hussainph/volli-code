/**
 * What Settings → Hosts says about each host (VC-700 PR 3; VC-615 flow 7):
 * pure, so every word is tested without the pane.
 *
 * A host's health comes from the engine-projected HostRecord link, independent
 * of whether any projects are open here. Its facts come from the registry:
 * how it was installed (a user install's agents share the person's account),
 * how it is reached, when it starts on its own.
 */
import type { RemoteHost, RemoteHostDevice } from "@volli/shared";

import { agentsShareAccountLine } from "@renderer/components/hosts/add-host-model";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import type { HostRecord } from "@renderer/stores/host-connection";

export interface HostHealth {
  readonly state: StatusDotState;
  readonly label: string;
}

/** The Health pill beside every remote host, including one with no projects. */
export function hostHealth(host: HostRecord): HostHealth {
  if (host.update?.status === "running") return { state: "working", label: "Updating" };
  switch (host.link.status) {
    case "open":
      return { state: "ready", label: "Online" };
    case "connecting":
    case "reconnecting":
      return { state: "working", label: "Connecting" };
    case "offline":
      return { state: "exited", label: "Offline" };
    case "version-skewed":
      return { state: "waiting", label: "Update available" };
    case "incompatible":
      return { state: "error", label: "Can’t serve" };
  }
}

const OS_NAMES = { linux: "Linux", macos: "macOS" } as const;

/** The list row's quiet second line: "SSH · deploy@box · 1.1.0". */
export function hostRowMeta(host: RemoteHost, projects: number): string {
  const parts = ["SSH", host.target];
  if (host.version !== null) parts.push(host.version);
  if (projects === 0) parts.push("No projects yet");
  return parts.join(" · ");
}

export interface HostFact {
  readonly label: string;
  readonly value: string;
  /** The row's `(i)`. */
  readonly hint?: string;
  /** The whole value, to copy, when `value` shows a short form of it (a host key). */
  readonly full?: string;
}

/** A host key fingerprint's short form, as the lab shows it: "q3Zt 9fK1 x0mV". */
export function shortFingerprint(fingerprint: string): string {
  const body = fingerprint.replace(/^SHA256:/u, "");
  return (body.slice(0, 12).match(/.{1,4}/gu) ?? []).join(" ");
}

/** "Ubuntu 24.04.1 LTS · x86-64", from what its check found; its OS where it found nothing. */
export function systemLine(host: RemoteHost): string {
  const os = host.system ?? (host.os === null ? null : OS_NAMES[host.os]);
  const parts = [os, host.arch].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Unknown" : parts.join(" · ");
}

/** A remote host's page rows under "Host", in order (the name row is its own). */
export function hostFacts(host: RemoteHost): HostFact[] {
  const facts: HostFact[] = [
    { label: "System", value: systemLine(host) },
    { label: "Version", value: host.version === null ? "Unknown" : `Volli host ${host.version}` },
    {
      label: "Connection",
      value: `SSH · ${host.target}`,
      hint: "An SSH tunnel through this Mac’s own ssh: your keys, agent and ~/.ssh/config.",
    },
    host.agentsShareAccount
      ? {
          label: "Runs as",
          value: "Your account",
          hint: `${agentsShareAccountLine(host.name)}: they can do whatever you can there. Installing with sudo gives them an account of their own.`,
        }
      : {
          label: "Runs as",
          value: "Its own account",
          hint: "Volli host and its agents run as the volli account, apart from yours.",
        },
    host.os === "macos"
      ? {
          label: "Starts",
          value: `When you log in to ${host.name}`,
          hint: "A Mac’s host is your login’s agent: after a restart it waits for you to log in.",
        }
      : { label: "Starts", value: "When it boots" },
  ];
  const [key] = host.hostKeys;
  if (key !== undefined) {
    // Only a key the person compared while adding it: an already-known key stays in their ssh.
    facts.push({
      label: "Host key",
      value: shortFingerprint(key),
      hint: "The key you compared and trusted when you added it.",
      full: host.hostKeys.join("\n"),
    });
  }
  return facts;
}

/** "Paired 3 Oct 2026", or when it was revoked. */
export function deviceMeta(device: RemoteHostDevice, locale?: string): string {
  const day = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  };
  return device.revokedAt === null
    ? `Paired ${day(device.enrolledAt)}`
    : `Revoked ${day(device.revokedAt)}`;
}

const deviceRank = (device: RemoteHostDevice): number =>
  device.thisMac ? 0 : device.revokedAt === null ? 1 : 2;

/** This Mac's own enrollment first, then the rest as the host listed them; revoked ones last. */
export function orderDevices(devices: readonly RemoteHostDevice[]): RemoteHostDevice[] {
  return devices
    .map((device, index) => ({ device, index }))
    .toSorted((a, b) => deviceRank(a.device) - deviceRank(b.device) || a.index - b.index)
    .map(({ device }) => device);
}
