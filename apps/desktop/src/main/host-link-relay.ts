/**
 * The Workspace link relay (VC-711; HP § The Workspace link relay): how the
 * desktop's window reaches a remote project's public operations over the
 * Workspace link desktop main holds (VC-700's engine owns every link and its
 * device key; the window never holds either).
 *
 * The handler map's desktop-only `hostLink.query`, `hostLink.mutate` and
 * `hostLink.subscribe` call this. Each names a Workspace, a public operation
 * and its input; the relay sends it over that Workspace's link, as is, if:
 *
 * - **a remote host here serves the Workspace** (else `workspace-unknown`);
 * - **its link is `ready` now** (else `host-unreachable`): nothing queues,
 *   exactly as the link itself never queues (Ruling 1);
 * - **the link's welcome granted the operation** (`operationsGrantedBy`;
 *   else `verb-refused`, as the host's own door words it), and it is not one
 *   main keeps for itself: the `sign-ins` and `auth.callback` operations are
 *   the sign-in service's (VC-702), whose flows are the link's connection's.
 *
 * **Every relayed subscription has one owner and a bounded life.** It is its
 * window's stream (the bridge aborts it when the window goes, navigates or
 * cancels), and it ends, with what ended it, the moment its link leaves
 * `ready`: the relay watches the link's state (`subscribeState`) rather than
 * waiting for a completion that never comes (the link keeps a stream across
 * an outage and ends it silently on close). Its last event is `lost`
 * (resubscribe after the last tracked id once the project's link reads ready
 * again), `resnapshot`, `error` or `complete`; nothing is called after it, and
 * the host-side subscription is let go at once. At most
 * {@link HOST_LINK_RELAY_SUBSCRIPTION_CAP} are open at a time; the window's
 * stream holds at most `DESKTOP_STREAM_CAPACITY` unsent frames before it ends
 * with `subscription-overflow`.
 *
 * **A stream budget per Workspace link (AM1).** hostd admits
 * `HOST_LINK_RELAY_STREAMS_PER_LINK` (4) streams per connection
 * (`HOSTD_LISTENER_LIMITS.maxSubscriptions`), and one link is one connection.
 * The relay keeps its streams on each link inside that budget itself, by
 * class, so the views a person is looking at win:
 *
 * - **foreground**: the board's change feed (`board.changes`) and each open
 *   Session's stream (`session.subscribe`): admitted while the link has a
 *   free slot, or by taking the newest background stream's;
 * - **background**: a Session's queue (`session.subscribeQueue`) and the
 *   host's log (`logs.follow`): admitted only into a free slot, and the first
 *   to yield.
 *
 * So the board, one chat and the logs fill a link; a second chat's stream
 * takes the logs' slot, and its queue waits. A stream refused or yielded
 * ends with `error` / `subscription-limit` (typed): the window keeps what it
 * shows and asks again later (`relayHostLink` waits for a slot as it waits
 * for a connection), so nothing goes blank. A stream main itself opens on
 * the link (a sign-in's `signIns.subscribe`) is outside this count; the host
 * refuses it typed if the relay filled the link.
 *
 * A relayed call carries the trace of the window's request (VC-699), so the
 * remote host's log lines for it carry the window's trace.
 */
import type { HostLinkRelayPort, HostScopeRelayPort } from "@volli/host-core/handlers";
import { currentTrace } from "@volli/host-core/log";
import {
  HOST_FEATURE_OPERATIONS,
  hostError,
  operationsGrantedBy,
  readHostError,
  type HostError,
} from "@volli/host-protocol";
import {
  HostLinkError,
  type HostLink,
  type HostLinkCallOptions,
  type HostLinkState,
  type HostScopeLink,
  type HostScopeLinkState,
} from "@volli/host-protocol/client-link";
import {
  HOST_LINK_RELAY_STREAMS_PER_LINK,
  HOST_LINK_RELAY_SUBSCRIPTION_CAP,
  type HostLinkRelayError,
  type HostLinkRelayEvent,
} from "@volli/shared";

/** What the relay reads of the engine: its Workspace links and which Workspaces it serves. */
export interface WorkspaceLinkSource {
  /** The Workspace's link while it is `ready`, else null (`RemoteHosts.workspaceLink`). */
  workspaceLink(workspaceId: string): HostLink | null;
  /** Whether a remote host here serves the Workspace at all. */
  serves(workspaceId: string): boolean;
}

/** The engine as the relay's source: its links, and its snapshot's remote projects. */
export function engineWorkspaceLinks(engine: {
  workspaceLink(workspaceId: string): HostLink | null;
  snapshot(): { readonly projects: Readonly<Record<string, unknown>> };
}): WorkspaceLinkSource {
  return {
    workspaceLink: (workspaceId) => engine.workspaceLink(workspaceId),
    serves: (workspaceId) => Object.hasOwn(engine.snapshot().projects, workspaceId),
  };
}

export interface HostScopeLinkSource {
  hostScopeLink(hostId: string): HostScopeLink | null;
  serves(hostId: string): boolean;
}

/** The engine's dedicated HOST link and enrolled host identities, not its projects. */
export function engineHostScopeLinks(engine: {
  hostScopeLink(hostId: string): HostScopeLink | null;
  snapshot(): { readonly hosts: readonly { readonly id: string }[] };
}): HostScopeLinkSource {
  return {
    hostScopeLink: (hostId) => engine.hostScopeLink(hostId),
    serves: (hostId) => engine.snapshot().hosts.some((host) => host.id === hostId),
  };
}

/**
 * The features whose operations stay main's own on every Workspace link:
 * sign-ins run through the sign-in service, which owns their flows (a flow is
 * its connection's), and only main binds the auth-callback loopback.
 */
export const MAIN_OWNED_FEATURES = ["sign-ins", "auth.callback"] as const;

const MAIN_OWNED_OPERATIONS: ReadonlySet<string> = new Set(
  MAIN_OWNED_FEATURES.flatMap((feature) => HOST_FEATURE_OPERATIONS[feature]),
);

export const RELAY_UNKNOWN_WORKSPACE = "No remote host on this Mac serves that project.";
export const RELAY_UNREACHABLE = "The project’s host can’t be reached right now.";
export const RELAY_SUBSCRIPTION_LIMIT = "Too many remote subscriptions are open on this Mac.";
export const RELAY_LINK_FULL =
  "This project’s link carries as many live views as it can; this one waits for a free one.";
export const RELAY_YIELDED =
  "A live view this project needs more took this stream; it waits for a free one.";

/**
 * The streams that yield on a full link: a Session's queue and the host's
 * log. Every other relayed stream (the board's feed, a Session's own stream)
 * is foreground.
 */
export const BACKGROUND_STREAMS: ReadonlySet<string> = new Set([
  "session.subscribeQueue",
  "logs.follow",
]);

export interface HostLinkRelayOptions {
  /** The trace of the window's request now (VC-699); absent, none is sent. */
  readonly trace?: () => { readonly traceId: string } | null;
  /** Hears why a relayed listener threw; it never ends the relay. */
  readonly onListenerError?: (error: unknown) => void;
  readonly subscriptionCap?: number;
  /** The streams the relay keeps on one Workspace link; hostd's per-connection budget. */
  readonly streamsPerLink?: number;
}

export interface HostLinkRelay extends HostLinkRelayPort {
  /** Opens synchronously: the answer stops it. */
  subscribe(...args: Parameters<HostLinkRelayPort["subscribe"]>): () => void;
  /** How many relayed subscriptions are open now, on every link or on one Workspace's. */
  open(workspaceId?: string): number;
}

/** A failure as the window's event carries it: the host protocol's envelope, nothing else. */
function wire(error: HostError): HostLinkRelayError {
  return error.reason === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, reason: error.reason };
}

/** Why a link that left `ready` has no connection now: its own words, where it has some. */
function lossOf(state: HostLinkState | HostScopeLinkState, unreachable: string): HostError {
  const said = "error" in state ? state.error.message : unreachable;
  return hostError("host-unreachable", said);
}

/** Main's own refusal, shaped so `readHostError` reads it on either side of the bridge. */
function refusal(error: HostError): HostLinkError {
  return new HostLinkError(error);
}

export function createHostLinkRelay(
  source: WorkspaceLinkSource,
  options: HostLinkRelayOptions = {},
): HostLinkRelay {
  return createRelay(
    { serves: (id) => source.serves(id), link: (id) => source.workspaceLink(id) },
    "workspace",
    options,
  );
}

export interface HostScopeRelay extends HostScopeRelayPort {
  subscribe(...args: Parameters<HostScopeRelayPort["subscribe"]>): () => void;
  open(hostId?: string): number;
}

/** The same bounded, traced stream mechanics on a host-identity link. */
export function createHostScopeRelay(
  source: HostScopeLinkSource,
  options: HostLinkRelayOptions = {},
): HostScopeRelay {
  const relay = createRelay(
    { serves: (id) => source.serves(id), link: (id) => source.hostScopeLink(id) },
    "host",
    options,
  );
  return {
    query: relay.query,
    mutate: relay.mutate,
    open: relay.open,
    subscribe: (hostId, path, input, lastEventId, listener) =>
      relay.subscribe(
        hostId,
        path,
        input,
        listener,
        lastEventId === undefined ? {} : { lastEventId },
      ),
  };
}

type RelayLink = HostLink | HostScopeLink;
function createRelay(
  source: { serves(id: string): boolean; link(id: string): RelayLink | null },
  scope: "host" | "workspace",
  options: HostLinkRelayOptions,
): HostLinkRelay {
  const unreachable = scope === "host" ? "The host can’t be reached right now." : RELAY_UNREACHABLE;
  const description = scope === "host" ? "this host’s connection" : "this project’s link";
  const trace = options.trace ?? (() => currentTrace());
  const cap = options.subscriptionCap ?? HOST_LINK_RELAY_SUBSCRIPTION_CAP;
  const perLink = options.streamsPerLink ?? HOST_LINK_RELAY_STREAMS_PER_LINK;
  /** Every relayed subscription not yet ended: each one's stop. */
  const open = new Set<() => void>();
  /** The streams on each link, in the order they opened. */
  const onLink = new Map<RelayLink, Stream[]>();

  interface Stream {
    readonly workspaceId: string;
    readonly background: boolean;
    /** Ends it with the yield, when a foreground stream needs its slot. */
    readonly yieldSlot: () => void;
  }

  /** Takes a slot on the link for a stream, or answers why it cannot have one. */
  function admit(link: RelayLink, stream: Stream): HostError | null {
    const held = onLink.get(link) ?? [];
    if (held.length >= perLink) {
      const newest = stream.background ? undefined : held.findLast((other) => other.background);
      if (newest === undefined) return hostError("subscription-limit", RELAY_LINK_FULL);
      newest.yieldSlot();
    }
    onLink.set(link, [...(onLink.get(link) ?? []), stream]);
    return null;
  }

  function release(link: RelayLink, stream: Stream): void {
    const held = onLink.get(link)!.filter((other) => other !== stream);
    if (held.length === 0) onLink.delete(link);
    else onLink.set(link, held);
  }

  function callOptions(): HostLinkCallOptions {
    const current = trace();
    return current === null ? {} : { trace: { traceId: current.traceId } };
  }

  /** The Workspace's ready link, if it may send `path`; otherwise the typed refusal, thrown. */
  function linkFor(workspaceId: string, path: string): RelayLink {
    if (!source.serves(workspaceId)) {
      throw refusal(
        hostError(
          scope === "host" ? "host-unreachable" : "workspace-unknown",
          scope === "host"
            ? "No enrolled host on this Mac has that identity."
            : RELAY_UNKNOWN_WORKSPACE,
        ),
      );
    }
    const link = source.link(workspaceId);
    const state = link?.getState();
    if (link === null || state?.status !== "ready") {
      throw refusal(hostError("host-unreachable", unreachable));
    }
    if (
      MAIN_OWNED_OPERATIONS.has(path) ||
      !operationsGrantedBy(state.welcome.features, scope).has(path)
    ) {
      throw refusal(
        hostError("verb-refused", `${path} is not among the operations ${description} may send.`),
      );
    }
    return link;
  }

  return {
    open: (workspaceId) =>
      workspaceId === undefined
        ? open.size
        : [...onLink.values()].flat().filter((stream) => stream.workspaceId === workspaceId).length,
    query: async (workspaceId, path, input) =>
      linkFor(workspaceId, path).query(path, input, callOptions()),
    mutate: async (workspaceId, path, input) =>
      linkFor(workspaceId, path).mutate(path, input, callOptions()),
    subscribe(workspaceId, path, input, listener, subscribeOptions = {}) {
      let ended = false;
      let slot: { link: RelayLink; stream: Stream } | null = null;
      let stopWatching: (() => void) | null = null;
      let subscription: { unsubscribe(): void } | null = null;
      const say = (event: HostLinkRelayEvent): void => {
        try {
          const answered = listener(event);
          if (answered instanceof Promise)
            answered.catch((error) => options.onListenerError?.(error));
        } catch (error) {
          options.onListenerError?.(error);
        }
      };
      /** Ends it once: lets go of the host's stream and the state watch, then says why. */
      const end = (last: HostLinkRelayEvent | null): void => {
        if (ended) return;
        ended = true;
        open.delete(stop);
        // Only a stream that took a slot can end: every earlier answer is a no-op.
        release(slot!.link, slot!.stream);
        stopWatching?.();
        subscription?.unsubscribe();
        if (last !== null) say(last);
      };
      const stop = (): void => end(null);

      if (open.size >= cap) {
        say({
          kind: "error",
          error: wire(hostError("subscription-limit", RELAY_SUBSCRIPTION_LIMIT)),
        });
        return () => {};
      }
      let link: RelayLink;
      try {
        link = linkFor(workspaceId, path);
      } catch (error) {
        // Main's own typed refusals end the stream as events; anything else
        // (the engine off: unavailable) is the router's to say.
        if (!(error instanceof HostLinkError)) throw error;
        const failure = error.hostError;
        say(
          failure.reason === "host-unreachable"
            ? { kind: "lost", error: wire(failure) }
            : { kind: "error", error: wire(failure) },
        );
        return () => {};
      }
      const stream: Stream = {
        workspaceId,
        background: BACKGROUND_STREAMS.has(path),
        yieldSlot: () =>
          end({ kind: "error", error: wire(hostError("subscription-limit", RELAY_YIELDED)) }),
      };
      const full = admit(link, stream);
      if (full !== null) {
        say({ kind: "error", error: wire(full) });
        return () => {};
      }
      slot = { link, stream };
      open.add(stop);
      // The link keeps a stream across an outage, and ends it silently on
      // close: its state is the only word that the connection went.
      stopWatching = link.subscribeState((state) => {
        if (state.status !== "ready")
          end({ kind: "lost", error: wire(lossOf(state, unreachable)) });
      });
      subscription = link.subscribe(
        path,
        input,
        {
          onStarted: () => {
            if (!ended) say({ kind: "started" });
          },
          onData: (data, tracked) => {
            if (ended) return;
            say(
              tracked === undefined
                ? { kind: "data", data }
                : { kind: "data", data, id: tracked.id },
            );
          },
          onResnapshot: (error) => end({ kind: "resnapshot", error: wire(error) }),
          onError: (error) => {
            const failure = readHostError(error);
            end(
              failure.reason === "host-unreachable"
                ? { kind: "lost", error: wire(failure) }
                : { kind: "error", error: wire(failure) },
            );
          },
          onComplete: () => end({ kind: "complete" }),
        },
        {
          ...callOptions(),
          ...(subscribeOptions.lastEventId === undefined
            ? {}
            : { lastEventId: subscribeOptions.lastEventId }),
        },
      );
      // A stream that ended while it was being opened lets go of what it opened.
      if (ended) subscription.unsubscribe();
      return stop;
    },
  };
}
