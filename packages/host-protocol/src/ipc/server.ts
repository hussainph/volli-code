/**
 * The server half of the router-generic IPC bridge (VC-608; HP § Command
 * catalog, "Doors are projections").
 *
 * One dispatcher for every router a host serves over an in-process,
 * structured-clone transport. It holds no procedure inventory and no switch:
 * a request names a path, the routers' own tRPC metadata says whether that
 * path exists and what type it is, and tRPC's server-side caller runs it
 * through the procedure's whole middleware chain (the catalog's policy, the
 * input parser, the handler). Failures are the routers' own envelope: the
 * router's `errorFormatter` shapes them exactly as it does for the WebSocket,
 * and `data.hostError` is what crosses.
 *
 * What it adds is what a push transport owes a subscription, and nothing
 * else: an acknowledgement with an id, ordered frames to the peer that opened
 * it, a terminal `done` or `error` frame (never a clean end for a stream that
 * failed), cancellation only from that peer, teardown when the peer goes
 * away, and `close()` for the host's shutdown.
 *
 * Transport-free: the desktop binds it to `ipcMain` and a WebContents; the
 * contract harness binds it to a structured-clone fake
 * (`@volli/host-protocol/testing`). No Electron, no Node.
 */
import {
  getErrorShape,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
  type AnyProcedure,
  type AnyRouter,
  type inferRouterContext,
} from "@trpc/server";

import { isHostError } from "../errors";
import {
  isIpcRequest,
  type IpcError,
  type IpcEvent,
  type IpcPeer,
  type IpcProcedureType,
  type IpcRequest,
  type IpcResponse,
} from "./wire";

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/** The one context every served router accepts: each router's, together. */
export type IpcServerContext<Routers extends AnyRouter> = UnionToIntersection<
  inferRouterContext<Routers>
>;

export interface IpcServerOptions<Routers extends AnyRouter> {
  /** The routers this door serves. No path may be two routers'. */
  readonly routers: readonly Routers[];
  /**
   * The paths that cross this door. Anything else a router publishes is
   * deliberately withheld, and answers `NOT_FOUND` as an unknown path does.
   */
  readonly served: Iterable<string>;
  /**
   * The router context for one call: built per request, the same context the
   * WebSocket builds for its connection, less the keys only a connection has.
   */
  createContext(): IpcServerContext<Routers>;
  /** Sees every subscription that ended in failure, with the envelope its peer was sent. */
  onSubscriptionError?(path: string, error: IpcError): void;
  /**
   * Runs one well-formed request's handling (VC-699): a host opens its log
   * context here, under `request.trace`, so everything the call does (a
   * subscription's frames included) is logged under it. Absent: run as is.
   */
  scope?(request: IpcRequest, run: () => Promise<IpcResponse>): Promise<IpcResponse>;
}

/** The bridge as a transport binds it: one call per request and per cancel. */
export interface IpcServer {
  request(peer: IpcPeer, request: unknown): Promise<IpcResponse>;
  cancel(peer: IpcPeer, subscriptionId: unknown): void;
  /** Stops every live subscription: the host is shutting the door. */
  close(): Promise<void>;
}

interface Route {
  readonly router: AnyRouter;
  readonly type: IpcProcedureType;
}

interface ActiveSubscription {
  readonly owner: IpcPeer;
  readonly path: string;
  readonly abort: AbortController;
  readonly iterator: AsyncIterator<unknown>;
  readonly detach: () => void;
}

export function createIpcServer<Routers extends AnyRouter>(
  options: IpcServerOptions<Routers>,
): IpcServer {
  const routes = routeTable(options.routers, options.served);
  const active = new Map<string, ActiveSubscription>();

  const stop = async (subscriptionId: string): Promise<void> => {
    const subscription = active.get(subscriptionId);
    if (!subscription) return;
    active.delete(subscriptionId);
    subscription.detach();
    subscription.abort.abort();
    await subscription.iterator.return?.();
  };

  async function handle(peer: IpcPeer, request: unknown): Promise<IpcResponse> {
    if (!isIpcRequest(request)) {
      return { ok: false, error: { code: "BAD_REQUEST", message: "Invalid IPC request" } };
    }
    return options.scope === undefined
      ? dispatch(peer, request)
      : options.scope(request, () => dispatch(peer, request));
  }

  async function dispatch(peer: IpcPeer, request: IpcRequest): Promise<IpcResponse> {
    const { path, type, input } = request;
    const route = routes.get(path);
    // tRPC's own answer to a path or type it has no procedure for.
    if (route === undefined || route.type !== type) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `No "${type}"-procedure on path "${path}"` },
      };
    }
    const ctx = options.createContext();
    if (type === "subscription") return subscribe(peer, route.router, path, input, ctx);
    try {
      return { ok: true, data: await callAt(route.router.createCaller(ctx), path, input) };
    } catch (error) {
      return { ok: false, error: envelopeOf(route.router, error, { path, type, input, ctx }) };
    }
  }

  async function subscribe(
    owner: IpcPeer,
    router: AnyRouter,
    path: string,
    input: unknown,
    ctx: unknown,
  ): Promise<IpcResponse> {
    const abort = new AbortController();
    let iterator: AsyncIterator<unknown>;
    try {
      const stream = (await callAt(
        router.createCaller(ctx, { signal: abort.signal }),
        path,
        input,
      )) as AsyncIterable<unknown>;
      iterator = stream[Symbol.asyncIterator]();
    } catch (error) {
      const type = "subscription";
      return { ok: false, error: envelopeOf(router, error, { path, type, input, ctx }) };
    }
    const subscriptionId = crypto.randomUUID();
    if (owner.isDestroyed()) {
      abort.abort();
      await iterator.return?.();
      return { ok: false, error: { code: "CLIENT_CLOSED_REQUEST", message: "The peer closed" } };
    }
    const detach = owner.onDestroyed(() => void stop(subscriptionId));
    active.set(subscriptionId, { owner, path, abort, iterator, detach });
    void pump(subscriptionId, router, input, ctx);
    return { ok: true, subscriptionId };
  }

  async function pump(
    subscriptionId: string,
    router: AnyRouter,
    input: unknown,
    ctx: unknown,
  ): Promise<void> {
    const subscription = active.get(subscriptionId)!;
    const { owner, path, abort, iterator } = subscription;
    try {
      while (!abort.signal.aborted && !owner.isDestroyed()) {
        const next = await iterator.next();
        if (next.done === true) {
          sendTerminal(subscription, { kind: "done", subscriptionId });
          break;
        }
        if (owner.isDestroyed()) break;
        const value = next.value;
        owner.send(
          isTrackedEnvelope(value)
            ? { kind: "data", subscriptionId, eventId: value[0], data: value[1] }
            : { kind: "data", subscriptionId, eventId: null, data: value },
        );
      }
    } catch (cause) {
      const error = envelopeOf(router, cause, { path, type: "subscription", input, ctx });
      options.onSubscriptionError?.(path, error);
      sendTerminal(subscription, { kind: "error", subscriptionId, error });
    } finally {
      await stop(subscriptionId);
    }
  }

  function sendTerminal(
    subscription: ActiveSubscription,
    event: Exclude<IpcEvent, { kind: "data" }>,
  ): void {
    // Cancellation removes the active entry before it aborts the iterator. The
    // iterator then normally resolves `done`; that is local teardown, not a
    // connection state the peer needs to recover from.
    if (
      active.get(event.subscriptionId) !== subscription ||
      subscription.abort.signal.aborted ||
      subscription.owner.isDestroyed()
    ) {
      return;
    }
    try {
      subscription.owner.send(event);
    } catch {
      // The peer can no longer receive its terminal state. The failure itself
      // already reached `onSubscriptionError`.
    }
  }

  return {
    request: handle,
    cancel(peer, subscriptionId) {
      if (typeof subscriptionId !== "string") return;
      const subscription = active.get(subscriptionId);
      // Only the peer that opened a stream may stop it.
      if (!subscription || subscription.owner.id !== peer.id) return;
      void stop(subscriptionId);
    },
    close: async () => {
      await Promise.all([...active.keys()].map((subscriptionId) => stop(subscriptionId)));
    },
  };
}

/**
 * Every served path, to the router that publishes it and its tRPC type, read
 * once from the routers' own metadata. A path two routers publish is a
 * composition error, refused here; a served path no router publishes is
 * unrouted, and answers as any unknown path does (the composition root's
 * exposure table is total over its routers' paths at the type level).
 */
function routeTable(
  routers: readonly AnyRouter[],
  served: Iterable<string>,
): ReadonlyMap<string, Route> {
  const routes = new Map<string, Route>();
  for (const path of served) {
    const owners = routers.filter((router) => procedureAt(router, path) !== undefined);
    if (owners.length > 1)
      throw new Error(`IPC serves ${path}, which ${owners.length} routers publish`);
    const router = owners[0];
    if (router === undefined) continue;
    // oxlint-disable-next-line no-underscore-dangle -- tRPC's pinned procedure metadata.
    const { type } = procedureAt(router, path)!._def;
    routes.set(path, { router, type });
  }
  return routes;
}

function procedureAt(router: AnyRouter, path: string): AnyProcedure | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's only introspection door.
  const procedures = router._def.procedures as Readonly<Record<string, AnyProcedure>>;
  return Object.hasOwn(procedures, path) ? procedures[path] : undefined;
}

/**
 * Calls one procedure through tRPC's server-side caller: the caller's proxy
 * resolves a dotted path to its procedure, and runs its middleware chain
 * with the context the caller was built with.
 */
function callAt(caller: unknown, path: string, input: unknown): Promise<unknown> {
  let target = caller;
  for (const segment of path.split(".")) target = Reflect.get(target as object, segment);
  return (target as (input: unknown) => Promise<unknown>)(input);
}

/**
 * The router's own failure envelope: its `errorFormatter`'s shape, as the
 * WebSocket would send it. A catalog router attaches the host protocol's
 * envelope as `data.hostError`; a router that does not is read for its code
 * and message alone.
 */
function envelopeOf(
  router: AnyRouter,
  cause: unknown,
  call: { path: string; type: IpcProcedureType; input: unknown; ctx: unknown },
): IpcError {
  const error = getTRPCErrorFromUnknown(cause);
  const shape = getErrorShape({
    // oxlint-disable-next-line no-underscore-dangle -- the router's own formatter.
    config: router._def._config,
    error,
    ...call,
  }) as { message: string; data?: { hostError?: unknown } };
  const hostError = shape.data?.hostError;
  if (isHostError(hostError)) {
    const { code, message, reason } = hostError;
    return reason === undefined ? { code, message } : { code, message, reason };
  }
  return { code: error.code, message: shape.message };
}
