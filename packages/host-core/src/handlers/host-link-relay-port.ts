/**
 * The Workspace link relay (VC-711): what the handler map's desktop-only
 * `hostLink.query`, `hostLink.mutate` and `hostLink.subscribe` call.
 *
 * Desktop main implements it over the Workspace links its remote hosts
 * registry holds (VC-700): it sends a public operation over the named
 * Workspace's link, only if that link's welcome granted it. Every other host
 * supplies none, and each entry answers `OperationUnavailableError`.
 * Structural, so host-core imports nothing of the desktop's.
 *
 * A query or mutation that fails throws an error whose `data.hostError` (or
 * which itself) is the host protocol's error envelope, so the router passes
 * the typed reason on: `host-unreachable` (no ready link), `verb-refused`
 * (not granted), or whatever the host answered.
 *
 * A subscription's failures are events, never a throw: it ends with `lost`,
 * `resnapshot`, `error` or `complete` (`HostLinkRelayEvent`, `@volli/shared`).
 */
import type { HostLinkRelayEvent } from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface HostLinkRelayPort {
  query(workspaceId: string, path: string, input: unknown): Promise<unknown>;
  /** Sent once over the link that is ready now; never queued, never resent. */
  mutate(workspaceId: string, path: string, input: unknown): Promise<unknown>;
  /**
   * Opens the subscription and calls `listener` with what it says until its
   * last event. The answer ends it early (the window cancelled or went), and
   * is safe to call after the last event too.
   */
  subscribe(
    workspaceId: string,
    path: string,
    input: unknown,
    listener: (event: HostLinkRelayEvent) => void | Promise<void>,
    options?: { readonly lastEventId?: string },
  ): Answer<() => void>;
}
