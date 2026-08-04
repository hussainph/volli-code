/**
 * The renderer's terminating tRPC link over the native Session IPC edge.
 *
 * Electron ships no tRPC link, so this is the counterpart to
 * `src/main/session-rpc-ipc.ts`: queries and mutations are one invoke each,
 * subscriptions acknowledge with an id and then arrive as ordered frames on a
 * single push channel.
 *
 * DELIBERATE DIVERGENCE FROM THE LAB. This link carries values by structured
 * clone; the lab's HTTP link carries them as JSON. Structured clone accepts
 * things JSON silently drops or mangles (Date, Map, undefined in a property
 * position), so a router payload that only ever rides this transport can pass
 * a test here and change shape in the lab. Keep router payloads JSON-safe by
 * convention — the transports are not interchangeable, and only one of them
 * will tell you.
 */
import { createTRPCClient, TRPCClientError, type TRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
// The same module tRPC's own first-party links read their status mapping from;
// a hand-copied table would be a second answer to a question that already has
// one.
import { getStatusCodeFromKey } from "@trpc/server/unstable-core-do-not-import";
import type { AppRouter } from "@volli/session-rpc";
import { SESSION_RPC_IPC_PROCEDURES } from "@volli/shared";
import type {
  SessionRpcIpcEvent,
  SessionRpcIpcProcedure,
  SessionRpcIpcRequest,
  SessionRpcIpcResponse,
} from "@volli/shared";

/** The preload door this link speaks through — `window.api.sessionRpc`. */
export interface SessionRpcBridge {
  request(request: SessionRpcIpcRequest): Promise<SessionRpcIpcResponse>;
  onEvent(listener: (event: SessionRpcIpcEvent) => void): () => void;
  cancel(subscriptionId: string): void;
}

export type SessionRpcClient = TRPCClient<AppRouter>;

/**
 * Builds the terminating link over one bridge.
 *
 * The event listener is registered here, once, and multiplexes every
 * subscription: main mints the id AFTER it starts pumping, so frames routinely
 * arrive before the renderer knows what to call them. A per-subscription
 * listener could not exist early enough to catch them.
 */
export function sessionRpcIpcLink(bridge: SessionRpcBridge): TRPCLink<AppRouter> {
  const consumers = new Map<string, (event: SessionRpcIpcEvent) => void>();
  const unclaimed = new Map<string, SessionRpcIpcEvent[]>();
  let awaitingAck = 0;

  bridge.onEvent((event) => {
    const consumer = consumers.get(event.subscriptionId);
    if (consumer) {
      consumer(event);
      return;
    }
    // A frame for an unknown id is either an in-flight subscription's head
    // start — hold it until the ack names it — or a straggler for one that
    // already ended, which nobody will ever claim. `awaitingAck` is exactly
    // that distinction, and draining to zero retires whatever is left over.
    if (awaitingAck === 0) return;
    const buffered = unclaimed.get(event.subscriptionId);
    if (buffered) buffered.push(event);
    else unclaimed.set(event.subscriptionId, [event]);
  });

  const settleAck = (): void => {
    awaitingAck -= 1;
    if (awaitingAck === 0) unclaimed.clear();
  };

  return () =>
    ({ op }) =>
      observable((observer) => {
        const request = routedRequest(op.path, op.input);
        if (request === null) {
          observer.error(
            failure("NOT_FOUND", `${op.path} is not routed over Session IPC`, op.path),
          );
          return;
        }

        if (op.type !== "subscription") {
          void (async () => {
            try {
              const reply = await bridge.request(request);
              // A caller's `signal` is the only handle it has on a call, so
              // this path honors it — after the fact. Main answers every
              // request it accepted, and there is nothing on the far side to
              // cut short, so an abandoned call is observed when the reply
              // lands rather than pre-empted.
              if (op.signal?.aborted === true) {
                observer.error(failure("CLIENT_CLOSED_REQUEST", abandoned(op.path), op.path));
                return;
              }
              if (!reply.ok) {
                observer.error(failure(reply.error.code, reply.error.message, op.path));
                return;
              }
              if ("subscriptionId" in reply) {
                observer.error(failure("INTERNAL_SERVER_ERROR", ackForACall(op.path), op.path));
                return;
              }
              observer.next({ result: { data: reply.data } });
              observer.complete();
            } catch (cause) {
              // A boot whose database failed registers no handler at all, so
              // the invoke REJECTS rather than answering `{ ok: false }`. It
              // reaches a caller as a plain TRPCClientError either way.
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
        const onFrame = (event: SessionRpcIpcEvent): void => {
          if (event.kind === "done") {
            retire(event.subscriptionId);
            observer.complete();
            return;
          }
          if (event.kind === "error") {
            retire(event.subscriptionId);
            observer.error(failure(event.error.code, event.error.message, op.path));
            return;
          }
          // The router mints these ids with `tracked()`. They ride out as the
          // result id so a consumer can hand the last one back as
          // `input.lastEventId` when it re-subscribes — this link deliberately
          // has no reconnect loop of its own. When to retry, how long to wait,
          // and whether to tell the user are product decisions that belong to
          // the chat controller above, not to a transport.
          observer.next({
            result: { id: event.eventId, data: { id: event.eventId, data: event.data } },
          });
        };

        awaitingAck += 1;
        void (async () => {
          try {
            const reply = await bridge.request(request);
            if (!reply.ok) {
              observer.error(failure(reply.error.code, reply.error.message, op.path));
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

/** Creates a Session RPC client over one bridge. */
export function createSessionRpcClient(bridge: SessionRpcBridge): SessionRpcClient {
  return createTRPCClient<AppRouter>({ links: [sessionRpcIpcLink(bridge)] });
}

let client: SessionRpcClient | null = null;

/**
 * The app's one Session RPC client, built on first use.
 *
 * Lazy so that importing this module has no transport effect, and a singleton
 * so a StrictMode double render — or a second surface asking — reuses the one
 * event listener rather than stacking another onto the bridge.
 */
export function sessionRpcClient(): SessionRpcClient {
  client ??= createSessionRpcClient(window.api.sessionRpc);
  return client;
}

/**
 * The request for `path`, or `null` when this transport has no route for it.
 *
 * The envelope is a union of one member per procedure — main narrows on it to
 * reach the right caller, and its `never` arm is what makes a forgotten
 * procedure a compile error. A union cannot be built from a variable
 * discriminant, so the assertion lands here, once, immediately after membership
 * has been checked.
 */
function routedRequest(path: string, input: unknown): SessionRpcIpcRequest | null {
  return (SESSION_RPC_IPC_PROCEDURES as readonly string[]).includes(path)
    ? ({ procedure: path as SessionRpcIpcProcedure, input } as SessionRpcIpcRequest)
    : null;
}

/**
 * Builds the client error for a code main reported.
 *
 * Directly, not through `TRPCClientError.from`: that helper only recognizes an
 * error response whose `code` is the NUMERIC JSON-RPC one, and this wire
 * carries the string key. A string falls to its generic branch, which drops
 * `data` — taking the code a caller branches on with it.
 */
function failure(code: string, message: string, path: string): TRPCClientError<AppRouter> {
  const key = isErrorCode(code) ? code : "INTERNAL_SERVER_ERROR";
  return new TRPCClientError(message, {
    result: {
      error: {
        code: TRPC_ERROR_CODES_BY_KEY[key],
        message,
        data: { code: key, httpStatus: getStatusCodeFromKey(key), path },
      },
    },
  });
}

/** The bridge itself failed — no handler is registered, or the door is gone. */
function unreachable(cause: unknown, path: string): TRPCClientError<AppRouter> {
  return failure(
    "INTERNAL_SERVER_ERROR",
    cause instanceof Error ? cause.message : "Session RPC is unreachable",
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
