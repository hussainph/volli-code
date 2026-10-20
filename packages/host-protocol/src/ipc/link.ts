/**
 * The terminating tRPC link over the router-generic IPC bridge (VC-608).
 *
 * Electron ships no tRPC link, so this is the client half of
 * `@volli/host-protocol/ipc-server`: queries and mutations are one request
 * each; subscriptions acknowledge with an id and then arrive as ordered
 * frames on a single push channel. It holds no procedure list: a path the
 * server does not serve answers `NOT_FOUND` from the server, exactly as
 * tRPC's own WebSocket adapter does.
 *
 * DELIBERATE STRUCTURED-CLONE DETAIL. This link carries values by structured
 * clone; the WebSocket carries JSON text. Structured clone accepts things
 * JSON silently drops or mangles (`Date`, `Map`, `undefined` in a property
 * position), so every router seam asserts `JsonUnsafeProcedures` is `never`
 * before either transport can expose it, which is also what makes
 * {@link IpcClientRouter}'s untransformed types honest.
 */
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AnyProcedure, AnyRouter } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
// The same module tRPC's own first-party links read their status mapping from;
// a hand-copied table would be a second answer to a question that already has
// one.
import {
  getStatusCodeFromKey,
  type Router as TRPCRouter,
  type RouterRecord,
} from "@trpc/server/unstable-core-do-not-import";

import { isHostErrorReason, type HostError } from "../errors";
import { isTraceIdShaped, mintHostTrace, nextHostSpan, type HostTrace } from "../trace";
import type { IpcBridge, IpcError, IpcEvent, IpcRequest, IpcResponse } from "./wire";

/** One payload-free observation from the client side of the bridge. */
export type IpcPerformanceSample =
  | {
      kind: "round-trip";
      procedure: string;
      durationMs: number;
      requestBytes: number;
      responseBytes: number;
      outcome: "ok" | "rpc-error" | "transport-error";
    }
  | {
      kind: "push";
      procedure: "subscription";
      eventKind: IpcEvent["kind"];
      durationMs: number;
      eventBytes: number;
      disposition: "delivered" | "buffered-before-ack" | "discarded";
      awaitingAck: number;
      bufferedFrames: number;
    };

/**
 * Optional benchmark tap. It receives only names, counts, sizes, and timings;
 * request and response values never enter it. A throwing tap is ignored so
 * diagnostics cannot alter the transport they are measuring.
 */
export interface IpcPerformanceObserver {
  now?(): number;
  record(sample: IpcPerformanceSample): void;
}

/** The part of a router record whose dotted paths are among `Served`. */
export type PickServed<Record, Served extends string, Prefix extends string = ""> = {
  [
    Key in keyof Record & string as Record[Key] extends AnyProcedure
      ? `${Prefix}${Key}` extends Served
        ? Key
        : never
      : Extract<Served, `${Prefix}${Key}.${string}`> extends never
        ? never
        : Key
  ]: Record[Key] extends AnyProcedure
    ? Record[Key]
    : PickServed<Record[Key], Served, `${Prefix}${Key}.`>;
};

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/**
 * The routers an IPC client reaches, as its tRPC client should type them:
 * only the `Served` paths, and the procedures' own input and output types.
 *
 * tRPC types a client of a router with no transformer by what JSON would do
 * to each output (`Serialize`). This bridge carries values by structured
 * clone, and every router seam proves its payloads JSON-safe
 * (`JsonUnsafeProcedures`), so the router's own types are the honest ones:
 * the view says so once (`transformer: true`), which is what the desktop's
 * Session client used to say with a cast.
 */
export type IpcClientRouter<Routers extends AnyRouter, Served extends string> = TRPCRouter<
  {
    ctx: object;
    meta: object;
    errorShape: Routers["_def"]["_config"]["$types"]["errorShape"];
    transformer: true;
  },
  PickServed<UnionToIntersection<Routers["_def"]["record"]>, Served> extends infer Record extends
    RouterRecord
    ? Record
    : never
>;

/**
 * Builds the terminating link over one bridge.
 *
 * The event listener is registered here, once, and multiplexes every
 * subscription: the server mints the id AFTER it starts pumping, so frames
 * routinely arrive before the client knows what to call them. A
 * per-subscription listener could not exist early enough to catch them.
 */
export function ipcLink<Router extends AnyRouter>(
  bridge: IpcBridge,
  performanceObserver?: IpcPerformanceObserver,
): TRPCLink<Router> {
  const consumers = new Map<string, (event: IpcEvent) => void>();
  const unclaimed = new Map<string, IpcEvent[]>();
  let awaitingAck = 0;

  const bufferedFrameCount = () => {
    let count = 0;
    for (const frames of unclaimed.values()) count += frames.length;
    return count;
  };
  const record = (sample: IpcPerformanceSample): void => {
    isolate(() => performanceObserver?.record(sample));
  };
  const measuredRequest = async (value: IpcRequest): Promise<IpcResponse> => {
    if (!performanceObserver) return bridge.request(value);
    const startedAt = readClock(performanceObserver);
    try {
      const response = await bridge.request(value);
      const endedAt = readClock(performanceObserver);
      if (startedAt !== null && endedAt !== null) {
        record({
          kind: "round-trip",
          procedure: value.path,
          durationMs: Math.max(0, endedAt - startedAt),
          requestBytes: jsonBytes(value),
          responseBytes: jsonBytes(response),
          outcome: response.ok ? "ok" : "rpc-error",
        });
      }
      return response;
    } catch (error) {
      const endedAt = readClock(performanceObserver);
      if (startedAt !== null && endedAt !== null) {
        record({
          kind: "round-trip",
          procedure: value.path,
          durationMs: Math.max(0, endedAt - startedAt),
          requestBytes: jsonBytes(value),
          responseBytes: 0,
          outcome: "transport-error",
        });
      }
      throw error;
    }
  };

  bridge.onEvent((event) => {
    const startedAt = readClock(performanceObserver);
    let disposition: Extract<IpcPerformanceSample, { kind: "push" }>["disposition"];
    const consumer = consumers.get(event.subscriptionId);
    if (consumer) {
      consumer(event);
      disposition = "delivered";
    } else if (awaitingAck === 0) {
      // No acknowledgement can claim this late frame.
      disposition = "discarded";
    } else {
      // A frame for an unknown id is either an in-flight subscription's head
      // start — hold it until the ack names it — or a straggler for one that
      // already ended, which nobody will ever claim. `awaitingAck` is exactly
      // that distinction, and draining to zero retires whatever is left over.
      const buffered = unclaimed.get(event.subscriptionId);
      if (buffered) buffered.push(event);
      else unclaimed.set(event.subscriptionId, [event]);
      disposition = "buffered-before-ack";
    }
    const endedAt = readClock(performanceObserver);
    if (performanceObserver && startedAt !== null && endedAt !== null) {
      record({
        kind: "push",
        procedure: "subscription",
        eventKind: event.kind,
        durationMs: Math.max(0, endedAt - startedAt),
        eventBytes: jsonBytes(event),
        disposition,
        awaitingAck,
        bufferedFrames: bufferedFrameCount(),
      });
    }
  });

  const settleAck = (): void => {
    awaitingAck -= 1;
    if (awaitingAck === 0) unclaimed.clear();
  };

  return () =>
    ({ op }) =>
      observable((observer) => {
        const request: IpcRequest = {
          path: op.path,
          type: op.type,
          input: op.input,
          trace: traceFor(op.context),
        };

        if (op.type !== "subscription") {
          void (async () => {
            try {
              const reply = await measuredRequest(request);
              // A caller's `signal` is the only handle it has on a call, so
              // this path honors it — after the fact. The server answers every
              // request it accepted, and there is nothing on the far side to
              // cut short, so an abandoned call is observed when the reply
              // lands rather than pre-empted.
              if (op.signal?.aborted === true) {
                observer.error(failure("CLIENT_CLOSED_REQUEST", abandoned(op.path), op.path));
                return;
              }
              if (!reply.ok) {
                observer.error(
                  failure(reply.error.code, reply.error.message, op.path, reply.error),
                );
                return;
              }
              if ("subscriptionId" in reply) {
                observer.error(failure("INTERNAL_SERVER_ERROR", ackForACall(op.path), op.path));
                return;
              }
              observer.next({ result: { data: reply.data } });
              observer.complete();
            } catch (cause) {
              // A server that cannot serve answers `{ ok: false }` naming its
              // reason; this rejection path is for a bridge that is genuinely
              // gone (a preload/main channel mismatch). It reaches a caller
              // as a plain TRPCClientError either way.
              observer.error(unreachable(cause, op.path));
            }
          })();
          return;
        }

        // A subscriber holds an `Unsubscribable`, so teardown — not the
        // operation signal — is how it says it has stopped listening; that is
        // also what a React effect's cleanup calls.
        let claimed: string | null = null;
        let left = false;
        const retire = (subscriptionId: string): void => {
          consumers.delete(subscriptionId);
          unclaimed.delete(subscriptionId);
        };
        const onFrame = (event: IpcEvent): void => {
          if (event.kind === "done") {
            retire(event.subscriptionId);
            observer.complete();
            return;
          }
          if (event.kind === "error") {
            retire(event.subscriptionId);
            observer.error(failure(event.error.code, event.error.message, op.path, event.error));
            return;
          }
          // A tracked id rides out as the result id, and inside the data the
          // way tRPC's own links deliver `tracked()` emissions, so a consumer
          // can hand the last one back as `input.lastEventId` when it
          // re-subscribes. This link deliberately has no reconnect loop of its
          // own: when to retry, how long to wait, and whether to tell the user
          // are product decisions that belong above a transport.
          observer.next(
            event.eventId === null
              ? { result: { data: event.data } }
              : { result: { id: event.eventId, data: { id: event.eventId, data: event.data } } },
          );
        };

        awaitingAck += 1;
        void (async () => {
          try {
            const reply = await measuredRequest(request);
            if (!reply.ok) {
              observer.error(failure(reply.error.code, reply.error.message, op.path, reply.error));
              return;
            }
            if (!("subscriptionId" in reply)) {
              observer.error(failure("INTERNAL_SERVER_ERROR", callForAnAck(op.path), op.path));
              return;
            }
            if (left) {
              bridge.cancel(reply.subscriptionId);
              unclaimed.delete(reply.subscriptionId);
              return;
            }
            claimed = reply.subscriptionId;
            consumers.set(claimed, onFrame);
            // `onStarted` never fires without this, and it has to precede the
            // frames the ack raced.
            observer.next({ result: { type: "started" } });
            const buffered = unclaimed.get(claimed) ?? [];
            unclaimed.delete(claimed);
            for (const event of buffered) onFrame(event);
          } catch (cause) {
            // Reaching an observer whose subscriber already tore down is safe
            // for a reason that lives outside this file: tRPC's client pipes
            // every operation through `share()`, which drops the observer on
            // unsubscribe, so a post-teardown error lands on nobody. If that
            // upstream property ever changes, this call needs a `left` guard.
            observer.error(unreachable(cause, op.path));
          } finally {
            settleAck();
          }
        })();

        return () => {
          left = true;
          if (claimed === null) return;
          bridge.cancel(claimed);
          retire(claimed);
        };
      });
}

/**
 * Builds the client error for a code the server reported.
 *
 * Directly, not through `TRPCClientError.from`: that helper only recognizes an
 * error response whose `code` is the NUMERIC JSON-RPC one, and this wire
 * carries the string key. A string falls to its generic branch, which drops
 * `data`, taking the code a caller branches on with it.
 *
 * `wire` is the server's envelope when it sent one. Its `reason` rides on
 * `data.hostError`, exactly where the WebSocket link's error formatter puts it,
 * so one `readHostError` reads both links alike (VC-564). A failure this link
 * raises itself has no reason, and carries the code alone.
 */
function failure<Router extends AnyRouter>(
  code: string,
  message: string,
  path: string,
  wire?: IpcError,
): TRPCClientError<Router> {
  const key = isErrorCode(code) ? code : "INTERNAL_SERVER_ERROR";
  // Forwarded only when it is a reason this build knows: `readHostError`
  // checks it against its code too, on this link as on the other.
  const hostError: HostError =
    wire?.reason !== undefined && isHostErrorReason(wire.reason)
      ? { code: key, message, reason: wire.reason }
      : { code: key, message };
  return new TRPCClientError(message, {
    result: {
      error: {
        code: TRPC_ERROR_CODES_BY_KEY[key],
        message,
        data: { code: key, httpStatus: getStatusCodeFromKey(key), path, hostError },
      },
    },
  });
}

/** The bridge itself failed: no handler is registered, or the door is gone. */
function unreachable<Router extends AnyRouter>(
  cause: unknown,
  path: string,
): TRPCClientError<Router> {
  return failure(
    "INTERNAL_SERVER_ERROR",
    cause instanceof Error ? cause.message : "The IPC bridge is unreachable",
    path,
  );
}

function isErrorCode(code: string): code is TRPC_ERROR_CODE_KEY {
  return code in TRPC_ERROR_CODES_BY_KEY;
}

function abandoned(path: string): string {
  return `${path} was abandoned before it answered`;
}

function ackForACall(path: string): string {
  return `${path} answered with a subscription id`;
}

function callForAnAck(path: string): string {
  return `${path} answered without a subscription id`;
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
  } catch {
    return 0;
  }
}

/** The observer's clock, or null when it has none it can read: no sample beats a made-up one. */
function readClock(observer: IpcPerformanceObserver | undefined): number | null {
  if (!observer) return null;
  try {
    return observer.now?.() ?? performance.now();
  } catch {
    return null;
  }
}

/** Measurement is optional and must not change what it measures. */
function isolate(record: () => void): void {
  try {
    record();
  } catch {
    // A throwing tap is ignored.
  }
}

/**
 * One request's trace (VC-699): the operation's when the caller names one in
 * tRPC's operation context (`{ context: { trace: { traceId } } }`), with a
 * fresh span; otherwise a fresh trace of its own.
 */
function traceFor(context: Readonly<Record<string, unknown>> | undefined): HostTrace {
  const named = context?.["trace"];
  const traceId =
    typeof named === "object" && named !== null
      ? (named as { traceId?: unknown }).traceId
      : undefined;
  return isTraceIdShaped(traceId) ? nextHostSpan({ traceId }) : mintHostTrace();
}
