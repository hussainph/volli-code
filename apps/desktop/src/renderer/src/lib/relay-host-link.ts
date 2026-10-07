/**
 * A remote project's Workspace link, as the window reaches it (VC-711; HP §
 * The Workspace link relay).
 *
 * Desktop main holds every remote Workspace's link and its device key; the
 * window reaches one through the desktop-only relay (`hostLink.query`,
 * `hostLink.mutate`, `hostLink.subscribe` over the generic IPC bridge). This
 * wraps that relay in the surface the existing adapters take from a client
 * host link (`HostLinkCalls`, `@volli/host-protocol/client-link`), so
 * `createBoardClient(hostLinkTrpcLink(relayHostLink(id)))`, a remote log
 * source and the chat core's `"host-link"` recovery plug in unchanged:
 *
 * - **Calls never queue.** A query or mutation goes out at once; main answers
 *   `host-unreachable` when the Workspace's link is not ready, `verb-refused`
 *   when its welcome did not grant the operation, or the host's own answer.
 * - **A subscription is kept across outages, as a link keeps one.** Main ends
 *   the relayed stream the moment its link drops (`lost`); this resubscribes
 *   after the last tracked id once the project's link reads ready again
 *   (and after a short backoff while the store has not caught up), so a
 *   subscriber hears a resume, never the outage. `resnapshot`, a failure and a
 *   clean end reach the subscriber's own handlers, and end it. An overflow
 *   that made progress resumes from the last id, as the link's does.
 * - **A full link is waited out, never shown blank (AM1).** Main keeps each
 *   Workspace link inside hostd's stream budget, and a stream it refuses or
 *   asks to yield (`subscription-limit`) waits here for a slot, as a lost one
 *   waits for a connection: the subscriber keeps what it shows, and
 *   {@link RelayHostLinkOptions.onStreamLimited} lets the view say live
 *   updates are paused.
 * - **Its state is the host-connection store's** view of the project's own
 *   link (VC-576): the same one the Island and read-only read.
 *
 * Unsubscribing ends it at once, here and in main.
 */
import { readHostError, type HostError } from "@volli/host-protocol";
import {
  HostLinkError,
  type HostLinkCallOptions,
  type HostLinkCalls,
  type HostLinkSubscribeOptions,
  type HostLinkSubscription,
  type HostLinkSubscriptionHandlers,
} from "@volli/host-protocol/client-link";
import type { HostLinkRelayError, HostLinkRelayEvent } from "@volli/shared";

import {
  projectLinkOf,
  useHostConnectionStore,
  type HostLinkView,
} from "../stores/host-connection";
import { sessionRpcClient, type SessionRpcClient } from "./session-rpc-ipc-link";

/** The relay's slice of the window's client: no cast, the router's own types. */
export type RelayHostLinkRpc = Pick<SessionRpcClient, "hostLink">;

/** Where the project's link state comes from: the host-connection store, by default. */
export interface RelayLinkStateSource {
  getState(): HostLinkView;
  /** Called after every change (it may be no change to this project's link). */
  subscribe(listener: () => void): () => void;
}

/** A remote project's Workspace link, reached through main. */
export interface RelayedHostLink extends HostLinkCalls {
  readonly workspaceId: string;
  /** The project's own link, as the connection UI reads it. */
  getState(): HostLinkView;
  /** Called when the project's link changes, not with the current one. */
  subscribeState(listener: (state: HostLinkView) => void): () => void;
}

export interface RelayHostLinkOptions {
  readonly rpc?: RelayHostLinkRpc;
  readonly state?: RelayLinkStateSource;
  /** How long a lost stream waits before it tries again, by consecutive loss. */
  readonly resumeDelaysMs?: readonly number[];
  /**
   * A stream is waiting for a free slot on the project's link (it was
   * refused or yielded, `subscription-limit`): the view keeps what it shows
   * and may say live updates are paused. Called on each refusal.
   */
  readonly onStreamLimited?: (stream: { readonly path: string; readonly error: HostError }) => void;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** Whether a project's link serves calls now: open, or open with an update on offer. */
export function isLinkReady(view: HostLinkView): boolean {
  return view.status === "open" || view.status === "version-skewed";
}

/** The project's link in the host-connection store. */
export function hostConnectionLinkState(workspaceId: string): RelayLinkStateSource {
  return {
    getState: () => projectLinkOf(useHostConnectionStore.getState(), workspaceId),
    subscribe: (listener) => useHostConnectionStore.subscribe(() => listener()),
  };
}

const RESUME_DELAYS_MS = [250, 1_000, 5_000] as const;

/** A relayed failure as the host protocol reads it: a reason this build does not know is left out. */
function hostErrorOf(error: HostLinkRelayError): HostError {
  return readHostError(error);
}

function contextOf(options: HostLinkCallOptions | undefined) {
  return options?.trace === undefined ? {} : { context: { trace: options.trace } };
}

export function relayHostLink(
  workspaceId: string,
  options: RelayHostLinkOptions = {},
): RelayedHostLink {
  const rpc = (): RelayHostLinkRpc => options.rpc ?? sessionRpcClient();
  return {
    workspaceId,
    ...relayConnection(
      { ...options, state: options.state ?? hostConnectionLinkState(workspaceId) },
      {
        query: (path, input, callOptions) =>
          rpc().hostLink.query.query({ workspaceId, path, input }, contextOf(callOptions)),
        mutate: (path, input, callOptions) =>
          rpc().hostLink.mutate.mutate({ workspaceId, path, input }, contextOf(callOptions)),
        subscribe: (path, input, lastEventId, handlers, callOptions) =>
          rpc().hostLink.subscribe.subscribe(
            { workspaceId, path, input, ...(lastEventId === undefined ? {} : { lastEventId }) },
            { ...contextOf(callOptions), ...handlers },
          ),
      },
    ),
  };
}

/** Scope-specific IPC calls; the resume/ownership machinery has no identity field. */
export interface RelayConnectionDoor {
  query(path: string, input: unknown, options?: HostLinkCallOptions): Promise<unknown>;
  mutate(path: string, input: unknown, options?: HostLinkCallOptions): Promise<unknown>;
  subscribe(
    path: string,
    input: unknown,
    lastEventId: string | undefined,
    handlers: { onData(event: HostLinkRelayEvent): void; onError(error: unknown): void },
    options?: HostLinkCallOptions,
  ): { unsubscribe(): void };
}

/** Shared bounded resume mechanics, used by Workspace and HOST relays alike. */
export function relayConnection(
  options: Omit<RelayHostLinkOptions, "rpc"> & { readonly state: RelayLinkStateSource },
  door: RelayConnectionDoor,
): Omit<RelayedHostLink, "workspaceId"> {
  const state = options.state;
  const delays = options.resumeDelaysMs ?? RESUME_DELAYS_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number));

  function subscribe(
    path: string,
    input: unknown,
    handlers: HostLinkSubscriptionHandlers,
    subscribeOptions: HostLinkSubscribeOptions = {},
  ): HostLinkSubscription {
    let ended = false;
    let lastEventId = subscribeOptions.lastEventId;
    /** The relayed stream open now, if any: a callback from an older one is ignored. */
    let current: { unsubscribe(): void } | null = null;
    /** Whether the stream open now delivered anything (an overflow after progress resumes). */
    let delivered = false;
    let losses = 0;
    let timer: unknown;
    let stopWatching: (() => void) | null = null;

    const settle = (): void => {
      ended = true;
      current?.unsubscribe();
      current = null;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      stopWatching?.();
      stopWatching = null;
    };

    /**
     * Opens once the project's link reads ready; until then, waits for it to.
     * An ended subscription opens nothing, however it got here: `settle` may
     * run inside a handler this subscription called (VC-711 review B1).
     */
    const attempt = (): void => {
      timer = undefined;
      if (ended) return;
      if (isLinkReady(state.getState())) {
        open();
        return;
      }
      stopWatching ??= state.subscribe(() => {
        if (ended || !isLinkReady(state.getState())) return;
        stopWatching?.();
        stopWatching = null;
        open();
      });
    };

    /** The link went: try again after a pause that grows with each loss in a row. */
    const resumeLater = (): void => {
      current?.unsubscribe();
      current = null;
      if (ended) return;
      const delay = delays[Math.min(losses, delays.length - 1)]!;
      losses += 1;
      timer = setTimer(attempt, delay);
    };

    function open(): void {
      /* v8 ignore if -- every caller checks `ended` first; kept so no future caller can open an ended subscription on the host (VC-711 review B1). */
      if (ended) return;
      delivered = false;
      let self: { unsubscribe(): void } | null = null;
      const mine = (): boolean => !ended && current !== null && current === self;
      self = door.subscribe(
        path,
        input,
        lastEventId,
        {
          onData: (event: HostLinkRelayEvent) => {
            if (!mine()) return;
            switch (event.kind) {
              case "started":
                losses = 0;
                handlers.onStarted?.();
                return;
              case "data":
                delivered = true;
                losses = 0;
                if (event.id === undefined) {
                  handlers.onData(event.data);
                } else {
                  lastEventId = event.id;
                  handlers.onData(event.data, { id: event.id });
                }
                return;
              case "lost":
                resumeLater();
                return;
              case "resnapshot":
                settle();
                handlers.onResnapshot(hostErrorOf(event.error));
                return;
              case "error":
                if (event.error.reason === "subscription-limit") {
                  // Let go of the refused stream first: the view told of it may
                  // cancel this subscription from inside the callback, and then
                  // nothing waits for a slot (VC-711 review B1).
                  current?.unsubscribe();
                  current = null;
                  options.onStreamLimited?.({ path, error: hostErrorOf(event.error) });
                  resumeLater();
                  return;
                }
                settle();
                handlers.onError(new HostLinkError(hostErrorOf(event.error)));
                return;
              case "complete":
                settle();
                handlers.onComplete?.();
                return;
              default:
                // A kind a newer main says: the union is open, and this build skips it.
                return;
            }
          },
          onError: (error: unknown) => {
            if (!mine()) return;
            // Main's stream fell behind: resume from the last id, as a link
            // does, only after progress, so one that cannot keep up surfaces.
            if (readHostError(error).reason === "subscription-overflow" && delivered) {
              current?.unsubscribe();
              current = null;
              open();
              return;
            }
            settle();
            handlers.onError(error);
          },
        },
        subscribeOptions,
      );
      // The bridge answers a subscription later, never inside this call.
      current = self;
    }

    attempt();
    return { unsubscribe: settle };
  }

  return {
    getState: () => state.getState(),
    subscribeState(listener) {
      let last = state.getState();
      return state.subscribe(() => {
        const next = state.getState();
        if (next === last) return;
        last = next;
        listener(next);
      });
    },
    query: (path, input, callOptions) => door.query(path, input, callOptions),
    mutate: (path, input, callOptions) => door.mutate(path, input, callOptions),
    subscribe,
  };
}
