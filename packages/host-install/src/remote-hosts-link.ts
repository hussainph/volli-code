/**
 * A remote host's one link, as the renderer's `hostLinkView` reads it
 * (VC-576), from what this desktop holds for the host: its SSH tunnel and
 * one VC-670 client link per open Workspace.
 *
 * With Workspace links, the most informative of them speaks for the host:
 * `ready` if any is (the host serves), else `refused`, else `fenced` (the
 * host answered and will not serve until the person acts), else
 * `unreachable`, else `connecting`. A ready link's welcome is dropped. With
 * none, host-scoped status evidence answers; TCP alone stays connecting.
 */
import type { HostLinkState, HostScopeLinkState } from "@volli/host-protocol/client-link";

type LinkState = HostLinkState | HostScopeLinkState;

/** Only an attempted host handshake can establish N-1 compatibility. Never downgrade auth failures. */
export function isOlderHostScope(state: HostScopeLinkState): boolean {
  return state.status === "refused" && state.compatibility === "host-scope-unsupported";
}
import {
  remoteHostDiagnostic,
  REMOTE_HOST_HEALTH_LIMITS,
  type RemoteHostLink,
  type RemoteHostLinkError,
  type RemoteHostLinkState,
} from "@volli/shared";

import { compareVersions } from "./probe";
import type { TunnelState } from "./tunnel";

export interface LinkInputs {
  readonly tunnel: TunnelState;
  /** The tunnel's failures since it was last up. */
  readonly attempt: number;
  /** Epoch ms of the tunnel's next attempt, when it is down. */
  readonly retryAt: number;
  readonly links: readonly LinkState[];
  /** Validated hostd status, only for host health (never a Workspace's readiness). */
  readonly health?: RemoteHostLinkState;
}

function errorOf(error: { code: string; message: string; reason?: string }): RemoteHostLinkError {
  return {
    code: remoteHostDiagnostic(error.code, REMOTE_HOST_HEALTH_LIMITS.errorCode),
    reason: remoteHostDiagnostic(error.reason ?? "", REMOTE_HOST_HEALTH_LIMITS.errorReason),
    message: remoteHostDiagnostic(error.message),
  };
}

/** The first link in `status`, in the order links were opened. */
function first<S extends LinkState["status"]>(
  links: readonly LinkState[],
  status: S,
): Extract<LinkState, { status: S }> | undefined {
  return links.find((link): link is Extract<LinkState, { status: S }> => link.status === status);
}

export function remoteHostLinkState(inputs: LinkInputs): RemoteHostLinkState {
  const { links } = inputs;
  if (links.length > 0) {
    if (first(links, "ready") !== undefined) return { status: "ready" };
    const refused = first(links, "refused");
    if (refused !== undefined) {
      return { status: "refused", error: errorOf(refused.error), closeCode: refused.closeCode };
    }
    const fenced = first(links, "fenced");
    if (fenced !== undefined) return { status: "fenced", error: errorOf(fenced.error) };
    const unreachable = first(links, "unreachable");
    if (unreachable !== undefined) {
      return {
        status: "unreachable",
        attempt: unreachable.attempt,
        error: errorOf(unreachable.error),
        closeCode: unreachable.closeCode,
        retryAt: unreachable.retryAt,
      };
    }
    const connecting = first(links, "connecting");
    if (connecting !== undefined) return { status: "connecting", attempt: connecting.attempt };
    return { status: "closed" };
  }
  const { tunnel } = inputs;
  switch (tunnel.status) {
    case "starting":
      return { status: "connecting", attempt: inputs.attempt };
    case "up":
      return inputs.health ?? { status: "connecting", attempt: inputs.attempt };
    case "down":
      return {
        status: "unreachable",
        attempt: inputs.attempt,
        error: {
          code: "SERVICE_UNAVAILABLE",
          reason: "host-unreachable",
          message: remoteHostDiagnostic(tunnel.error),
        },
        closeCode: null,
        retryAt: inputs.retryAt,
      };
    case "closed":
      return { status: "closed" };
  }
}

/** `previous`, moved on to `state`: ready ever since launch, and the current outage's start. */
export function nextRemoteHostLink(
  previous: RemoteHostLink | null,
  state: RemoteHostLinkState,
  now: number,
): RemoteHostLink {
  const wasReady = previous?.state.status === "ready";
  const ready = state.status === "ready";
  return {
    state,
    everReady: (previous?.everReady ?? false) || ready,
    droppedAt: ready
      ? null
      : wasReady
        ? now
        : (previous?.droppedAt ?? (state.status === "connecting" ? null : now)),
  };
}

/** What this app can do about a host's version: offer an update, or say the host is newer. */
export function versionFacts(
  version: string | null,
  appVersion: string,
): { readonly availableUpdate: string | null; readonly hostIsNewer: boolean } {
  const order = version === null ? 0 : compareVersions(version, appVersion);
  return { availableUpdate: order < 0 ? appVersion : null, hostIsNewer: order > 0 };
}
