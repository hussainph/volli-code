/**
 * The renderer's terminating tRPC link over the desktop's board bridge
 * (VC-565; main's `board-rpc-ipc.ts`), for the `cloud` flag on.
 *
 * A board client over this link and a board client over a host link
 * (`hostLinkTrpcLink`, `@volli/host-protocol/client-link`) are the same
 * `TRPCClient<BoardRouter>`: everything above the link — the board's sync
 * engine, its pending layer, the feed — is one code path for this Mac's
 * in-process host and for a remote one.
 *
 * Errors arrive as the router's own envelope on `data.hostError`, so one
 * `readHostError` reads both links. A bridge that rejects (main gone, a
 * channel missing) answers what a dropped host link answers:
 * `SERVICE_UNAVAILABLE` / `host-unreachable`, the outcome unknown. A board
 * write's `commandId` is what makes retrying it safe.
 */
import { createTRPCClient, TRPCClientError, type TRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { TRPC_ERROR_CODES_BY_KEY, type TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import { getStatusCodeFromKey } from "@trpc/server/unstable-core-do-not-import";
import type { BoardRouter } from "@volli/session-rpc";

import type {
  BoardRpcIpcError,
  BoardRpcIpcEvent,
  BoardRpcIpcRequest,
  BoardRpcIpcResponse,
} from "../../../ipc/contract";

/** The preload door this link speaks through: `window.api.boardRpc`. */
export interface BoardRpcBridge {
  request(request: BoardRpcIpcRequest): Promise<BoardRpcIpcResponse>;
  onEvent(listener: (event: BoardRpcIpcEvent) => void): () => void;
  cancel(subscriptionId: string): void;
}

/** A board client, whichever link it rides. */
export type BoardClient = TRPCClient<BoardRouter>;

/**
 * The link over one bridge. One event listener multiplexes every
 * subscription: main acknowledges with the id after it starts pumping, so a
 * frame can arrive before its subscriber knows its id, and is held until then.
 */
export function boardRpcIpcLink(bridge: BoardRpcBridge): TRPCLink<BoardRouter> {
  const consumers = new Map<string, (event: BoardRpcIpcEvent) => void>();
  const unclaimed = new Map<string, BoardRpcIpcEvent[]>();
  let awaitingAck = 0;

  bridge.onEvent((event) => {
    const consumer = consumers.get(event.subscriptionId);
    if (consumer) {
      consumer(event);
      return;
    }
    // A straggler nobody can claim any more.
    if (awaitingAck === 0) return;
    const buffered = unclaimed.get(event.subscriptionId);
    if (buffered) buffered.push(event);
    else unclaimed.set(event.subscriptionId, [event]);
  });

  return () =>
    ({ op }) =>
      observable((observer) => {
        const request: BoardRpcIpcRequest = { path: op.path, input: op.input };
        if (op.type !== "subscription") {
          void (async () => {
            try {
              const reply = await bridge.request(request);
              if (op.signal?.aborted === true) {
                observer.error(
                  failure("CLIENT_CLOSED_REQUEST", `${op.path} was abandoned`, op.path),
                );
                return;
              }
              if (!reply.ok) {
                observer.error(
                  failure(reply.error.code, reply.error.message, op.path, reply.error),
                );
                return;
              }
              if (!("data" in reply)) {
                observer.error(
                  failure("INTERNAL_SERVER_ERROR", `${op.path} answered a subscription`, op.path),
                );
                return;
              }
              observer.next({ result: { data: reply.data } });
              observer.complete();
            } catch (cause) {
              observer.error(unreachable(cause, op.path));
            }
          })();
          return;
        }

        let claimed: string | null = null;
        let left = false;
        const retire = (subscriptionId: string): void => {
          consumers.delete(subscriptionId);
          unclaimed.delete(subscriptionId);
        };
        const onFrame = (event: BoardRpcIpcEvent): void => {
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
          // Tracked: the id is the feed cursor a re-subscribe hands back.
          observer.next({
            result: { id: event.eventId, data: { id: event.eventId, data: event.data } },
          });
        };

        awaitingAck += 1;
        void (async () => {
          try {
            const reply = await bridge.request(request);
            if (!reply.ok) {
              observer.error(failure(reply.error.code, reply.error.message, op.path, reply.error));
              return;
            }
            if (!("subscriptionId" in reply)) {
              observer.error(
                failure("INTERNAL_SERVER_ERROR", `${op.path} answered a call`, op.path),
              );
              return;
            }
            if (left) {
              bridge.cancel(reply.subscriptionId);
              unclaimed.delete(reply.subscriptionId);
              return;
            }
            claimed = reply.subscriptionId;
            consumers.set(claimed, onFrame);
            observer.next({ result: { type: "started" } });
            const buffered = unclaimed.get(claimed) ?? [];
            unclaimed.delete(claimed);
            for (const event of buffered) onFrame(event);
          } catch (cause) {
            observer.error(unreachable(cause, op.path));
          } finally {
            awaitingAck -= 1;
            if (awaitingAck === 0) unclaimed.clear();
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

/** A board client over the desktop's own board bridge. */
export function createBoardIpcClient(bridge: BoardRpcBridge): BoardClient {
  return createTRPCClient<BoardRouter>({ links: [boardRpcIpcLink(bridge)] });
}

function failure(
  code: string,
  message: string,
  path: string,
  wire?: BoardRpcIpcError,
): TRPCClientError<BoardRouter> {
  const key: TRPC_ERROR_CODE_KEY =
    code in TRPC_ERROR_CODES_BY_KEY ? (code as TRPC_ERROR_CODE_KEY) : "INTERNAL_SERVER_ERROR";
  // Forwarded, not judged: `readHostError` checks a reason against its code.
  type RouterHostError = TRPCClientError<BoardRouter>["data"] extends infer Data
    ? Data extends { hostError: infer HostError }
      ? HostError
      : never
    : never;
  const hostError = (
    wire?.reason === undefined
      ? { code: key, message }
      : { code: key, message, reason: wire.reason }
  ) as RouterHostError;
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

/** The bridge itself failed: the outcome is unknown, exactly as a dropped host link's is. */
function unreachable(cause: unknown, path: string): TRPCClientError<BoardRouter> {
  return failure(
    "SERVICE_UNAVAILABLE",
    cause instanceof Error ? cause.message : "The board bridge is unreachable",
    path,
    { code: "SERVICE_UNAVAILABLE", message: "unreachable", reason: "host-unreachable" },
  );
}
