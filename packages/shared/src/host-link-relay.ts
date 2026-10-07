/**
 * The Workspace link relay's wire types (VC-711; HP § The Workspace link
 * relay): the desktop-only `hostLink.query`, `hostLink.mutate` and
 * `hostLink.subscribe`, through which the desktop's window reaches a remote
 * project's public operations over the Workspace link desktop main holds.
 *
 * Main owns every link and its device key; the window names a Workspace, an
 * operation path and its input, and main sends it over that Workspace's link
 * if the link's welcome granted it. Nothing here is a new operation: what the
 * relay carries is the public tier's, answered by the host.
 */

/**
 * A relayed failure, as the host protocol's error envelope reads it
 * (`HostError`, `@volli/host-protocol`), structurally: `@volli/shared` cannot
 * import the protocol package (D2). `reason` is a `HostErrorReason`.
 */
export interface HostLinkRelayError {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
}

/** One relayed query or mutation: which remote Workspace, which public operation, its input. */
export interface HostLinkRelayCall {
  readonly workspaceId: string;
  /** A public operation's catalog key (its router path), e.g. `board.snapshot`. */
  readonly path: string;
  readonly input?: unknown;
}

/** One relayed subscription: a call, and the tracked id it resumes after, if any. */
export interface HostLinkRelaySubscribeCall extends HostLinkRelayCall {
  readonly lastEventId?: string;
}

/** One HOST-scoped call over desktop main's host link, before any Workspace is open. */
export interface HostScopeRelayCall {
  readonly hostId: string;
  /** A HOST operation's catalog key; main checks the host welcome's grant. */
  readonly path: string;
  readonly input?: unknown;
}

/** A HOST-scoped subscription, using the same events and errors as the Workspace relay. */
export interface HostScopeRelaySubscribeCall extends HostScopeRelayCall {
  readonly lastEventId?: string;
}

/**
 * What a relayed subscription says. Every kind but `started` and `data` is its
 * last: the stream ends after it, in main and in the window alike.
 */
export type HostLinkRelayEvent =
  /** The host started the stream. */
  | { readonly kind: "started" }
  /** One emission; `id` is a tracked one's, which a resubscribe resumes after. */
  | { readonly kind: "data"; readonly data: unknown; readonly id?: string }
  /**
   * The host cannot resume this cursor (`subscription-resnapshot-required`):
   * re-read the snapshot and subscribe from its cursor.
   */
  | { readonly kind: "resnapshot"; readonly error: HostLinkRelayError }
  /**
   * The Workspace's link has no connection now (`host-unreachable`): it was
   * lost mid-stream, or there was none to open on. Subscribe again, after the
   * last tracked id, once the project's link reads ready.
   */
  | { readonly kind: "lost"; readonly error: HostLinkRelayError }
  /** The host or the relay ended it on a failure a resubscribe would repeat. */
  | { readonly kind: "error"; readonly error: HostLinkRelayError }
  /** The host ended the stream cleanly. */
  | { readonly kind: "complete" };

export type HostLinkRelayEventKind = HostLinkRelayEvent["kind"];

/** Whether the stream ends with this event. */
export function hostLinkRelayEventEnds(event: HostLinkRelayEvent): boolean {
  return event.kind !== "started" && event.kind !== "data";
}

/** The longest operation path the relay accepts: catalog keys are dot-names far shorter. */
export const HOST_LINK_RELAY_PATH_MAX = 128;

/** The longest tracked id a relayed subscription resumes after. */
export const HOST_LINK_RELAY_EVENT_ID_MAX = 512;

/**
 * How many relayed streams main keeps on one Workspace link: hostd's
 * per-connection budget (`HOSTD_LISTENER_LIMITS.maxSubscriptions`), since one
 * link is one connection. Past it a background stream (a Session's queue, the
 * host's log) yields to a foreground one (the board's feed, a Session's
 * stream), and anything else waits (`subscription-limit`).
 */
export const HOST_LINK_RELAY_STREAMS_PER_LINK = 4;

/**
 * How many relayed subscriptions main holds open at once, across every
 * window and Workspace: past it, a new one ends at once with
 * `subscription-limit`. A remote board needs one per open project.
 */
export const HOST_LINK_RELAY_SUBSCRIPTION_CAP = 256;
