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
 *
 * An operation's `AbortSignal` is honoured on this side of the wire only. One
 * already aborted sends nothing: a query or mutation rejects
 * `CLIENT_CLOSED_REQUEST`, a subscription never opens. Aborted mid-flight, a
 * query or mutation rejects the same way at once and whatever answer arrives
 * later is dropped; a subscription stops its stream and calls nothing more,
 * as tRPC's own `wsLink` does. It is not a rollback: a mutation
 * the host already received may have taken effect, exactly as when the link
 * drops mid-call, so a caller that must know re-reads, or retries with the
 * same `commandId`.
 *
 * A call's trace (VC-699) rides in tRPC's operation context:
 * `client.x.mutate(input, { context: { trace: { traceId } } })` sends it as
 * that operation's trace; without one the link's own applies.
 */
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

import { readHostError, type HostError } from "../errors";
import { isTraceIdShaped } from "../trace";
import { HostLinkError, type HostLinkCallOptions, type HostLinkCalls } from "./link";

/** The trace an operation's context names, when it names one. */
function callOptions(context: Readonly<Record<string, unknown>> | undefined): HostLinkCallOptions {
  const trace = context?.["trace"];
  if (typeof trace !== "object" || trace === null) return {};
  const { traceId } = trace as { traceId?: unknown };
  return isTraceIdShaped(traceId) ? { trace: { traceId } } : {};
}

export function hostLinkTrpcLink<Router extends AnyRouter>(link: HostLinkCalls): TRPCLink<Router> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const signal = op.signal ?? null;
        if (op.type === "subscription") {
          if (signal?.aborted === true) return undefined;
          const subscription = link.subscribe(
            op.path,
            op.input,
            {
              onStarted: () => observer.next({ result: { type: "started" } }),
              onData: (data) => observer.next({ result: { type: "data", data } }),
              onResnapshot: (error) => observer.error(clientError(new HostLinkError(error))),
              onError: (error) => observer.error(clientError(error)),
              onComplete: () => observer.complete(),
            },
            callOptions(op.context),
          );
          const stop = (): void => subscription.unsubscribe();
          signal?.addEventListener("abort", stop, { once: true });
          return () => {
            signal?.removeEventListener("abort", stop);
            subscription.unsubscribe();
          };
        }
        if (signal?.aborted === true) {
          observer.error(clientError(aborted()));
          return undefined;
        }
        // An answer that lands after the caller let go (or aborted) reaches
        // an observer that is done; the call itself is never cancelled on the host.
        const abort = (): void => observer.error(clientError(aborted()));
        signal?.addEventListener("abort", abort, { once: true });
        const options = callOptions(op.context);
        const call =
          op.type === "query"
            ? link.query(op.path, op.input, options)
            : link.mutate(op.path, op.input, options);
        call.then(
          (data) => {
            observer.next({ result: { type: "data", data } });
            observer.complete();
          },
          (error: unknown) => observer.error(clientError(error)),
        );
        return () => signal?.removeEventListener("abort", abort);
      });
}

/** The caller let go; the host is not told, and a mutation it already received may have run. */
function aborted(): HostError {
  return {
    code: "CLIENT_CLOSED_REQUEST",
    message:
      "The caller aborted the call; a mutation the host already received may have taken effect",
  };
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
