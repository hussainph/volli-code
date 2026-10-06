/**
 * A typed tRPC client over a host link: `createTRPCClient<Router>({ links:
 * [hostLinkTrpcLink(link)] })` gives an area store its router's types with
 * the link's policy underneath (fail fast, never queue, resume after the
 * welcome).
 *
 * tRPC's subscription observer has no slot for a resnapshot, so through this
 * client `onResnapshot` arrives as `onError` with an error
 * `isResnapshotRequired` recognizes; a store that wants the callback itself
 * calls {@link HostLink.subscribe}.
 */
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

import { readHostError, type HostError } from "../errors";
import { HostLinkError, type HostLink } from "./link";

export function hostLinkTrpcLink<Router extends AnyRouter>(link: HostLink): TRPCLink<Router> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === "subscription") {
          const subscription = link.subscribe(op.path, op.input, {
            onStarted: () => observer.next({ result: { type: "started" } }),
            onData: (data) => observer.next({ result: { type: "data", data } }),
            onResnapshot: (error) => observer.error(clientError(new HostLinkError(error))),
            onError: (error) => observer.error(clientError(error)),
            onComplete: () => observer.complete(),
          });
          return () => subscription.unsubscribe();
        }
        // An answer that lands after the caller let go reaches an observer
        // nobody holds; the call itself is never cancelled on the host.
        const call =
          op.type === "query" ? link.query(op.path, op.input) : link.mutate(op.path, op.input);
        call.then(
          (data) => {
            observer.next({ result: { type: "data", data } });
            observer.complete();
          },
          (error: unknown) => observer.error(clientError(error)),
        );
        return undefined;
      });
}

/** The host's own errors pass through; the link's become the same `data.hostError` shape. */
function clientError(error: unknown): TRPCClientError<AnyRouter> {
  if (error instanceof TRPCClientError) return error as TRPCClientError<AnyRouter>;
  const hostError: HostError = readHostError(error);
  return TRPCClientError.from<AnyRouter>({
    error: {
      code: TRPC_ERROR_CODES_BY_KEY[hostError.code],
      message: hostError.message,
      data: { code: hostError.code, hostError },
    },
  });
}
