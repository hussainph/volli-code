/**
 * The desktop window's door to the board router (VC-565), with the `cloud`
 * flag on: the same router hostd serves on its WebSocket, over Electron IPC.
 *
 * It is a projection like every other door: it builds the board router over
 * the host's one handler map (the router policy's view, so each call is
 * admitted at the map as well as by the router's middleware) and calls the
 * procedure the request names, as `LOCAL_DESKTOP_CALLER`, the reserved local
 * device. It adds no behaviour: the router validates every input, the handler
 * owns every effect, and a refusal is the router's own `HostError` envelope.
 *
 * One invoke channel carries any board procedure by path (the router, not a
 * channel table, declares inputs and outputs), and the change feed's tracked
 * frames go to the window that subscribed, on `volli:board-rpc-event`, until
 * it cancels, the stream ends, or the window goes away. VC-608's generic
 * bridge generalizes this shape to every family.
 *
 * With the flag off the renderer never calls it: the board keeps its legacy
 * per-channel IPC (`data-ipc.ts`), whose channels project the same handlers.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import {
  createBoardRouter,
  hostErrorOf,
  LOCAL_DESKTOP_CALLER,
  RpcDiagnosticLog,
  type BoardRouterHandlers,
} from "@volli/session-rpc";

import type {
  BoardRpcIpcError,
  BoardRpcIpcEvent,
  BoardRpcIpcRequest,
  BoardRpcIpcResponse,
  VolliIpcChannel,
  VolliIpcEvent,
} from "../ipc/contract";

const BOARD_RPC_CHANNEL = "volli:board-rpc" satisfies VolliIpcChannel;
const BOARD_RPC_CANCEL_CHANNEL = "volli:board-rpc-cancel" satisfies VolliIpcChannel;
const BOARD_RPC_EVENT_CHANNEL = "volli:board-rpc-event" satisfies VolliIpcEvent;

export interface RegisterBoardRpcIpcOptions {
  /** The host's handler map as the router policy projects it: `admittedHandlers(map, ROUTER_POLICY)`. */
  readonly handlers: BoardRouterHandlers;
  readonly diagnostics?: RpcDiagnosticLog;
}

interface ActiveSubscription {
  readonly owner: WebContents;
  readonly abort: AbortController;
  readonly iterator: AsyncIterator<readonly [string, unknown]>;
  readonly onDestroyed: () => void;
}

type Procedure = (input: unknown) => Promise<unknown>;
type ProcedureType = "query" | "mutation" | "subscription";

/** Registers the board bridge's channels; `close` ends every live subscription. */
export function registerBoardRpcIpcHandlers(options: RegisterBoardRpcIpcOptions): {
  close(): Promise<void>;
} {
  const diagnostics = options.diagnostics ?? new RpcDiagnosticLog();
  const router = createBoardRouter();
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's procedure introspection door.
  const procedures = router._def.procedures as unknown as Readonly<
    Record<string, { _def: { type: ProcedureType } }>
  >;
  const active = new Map<string, ActiveSubscription>();

  const callerFor = (signal?: AbortSignal) =>
    router.createCaller(
      {
        caller: LOCAL_DESKTOP_CALLER,
        handlers: options.handlers,
        diagnostics,
        transport: "electron-ipc",
      },
      signal === undefined ? {} : { signal },
    );

  const stop = async (subscriptionId: string): Promise<void> => {
    const subscription = active.get(subscriptionId);
    if (!subscription) return;
    active.delete(subscriptionId);
    subscription.owner.removeListener("destroyed", subscription.onDestroyed);
    subscription.abort.abort();
    await subscription.iterator.return?.();
  };

  ipcMain.handle(
    BOARD_RPC_CHANNEL,
    async (event, request: unknown): Promise<BoardRpcIpcResponse> => {
      if (!isRequest(request)) return invalidRequest();
      const type = Object.hasOwn(procedures, request.path)
        ? // oxlint-disable-next-line no-underscore-dangle -- as above.
          procedures[request.path]!._def.type
        : null;
      if (type === null) return invalidRequest();
      try {
        if (type === "subscription") return await subscribe(request, event.sender);
        return { ok: true, data: await procedureAt(callerFor(), request.path)(request.input) };
      } catch (error) {
        return { ok: false, error: envelope(error, "Board request failed") };
      }
    },
  );

  ipcMain.on(BOARD_RPC_CANCEL_CHANNEL, (event, subscriptionId: unknown) => {
    if (typeof subscriptionId !== "string") return;
    const subscription = active.get(subscriptionId);
    if (!subscription || subscription.owner.id !== event.sender.id) return;
    void stop(subscriptionId);
  });

  async function subscribe(
    request: BoardRpcIpcRequest,
    owner: WebContents,
  ): Promise<BoardRpcIpcResponse> {
    const abort = new AbortController();
    const stream = (await procedureAt(
      callerFor(abort.signal),
      request.path,
    )(request.input)) as AsyncIterable<readonly [string, unknown]>;
    const iterator = stream[Symbol.asyncIterator]();
    const subscriptionId = randomUUID();
    if (owner.isDestroyed()) {
      abort.abort();
      await iterator.return?.();
      return { ok: false, error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" } };
    }
    const onDestroyed = () => void stop(subscriptionId);
    active.set(subscriptionId, { owner, abort, iterator, onDestroyed });
    owner.once("destroyed", onDestroyed);
    void pump(subscriptionId, request.path);
    return { ok: true, subscriptionId };
  }

  async function pump(subscriptionId: string, path: string): Promise<void> {
    const subscription = active.get(subscriptionId)!;
    try {
      while (!subscription.abort.signal.aborted && !subscription.owner.isDestroyed()) {
        const next = await subscription.iterator.next();
        if (next.done) {
          terminal(subscription, { kind: "done", subscriptionId });
          break;
        }
        const [eventId, data] = next.value;
        if (subscription.owner.isDestroyed()) break;
        subscription.owner.send(BOARD_RPC_EVENT_CHANNEL, {
          kind: "data",
          subscriptionId,
          eventId,
          data,
        } satisfies BoardRpcIpcEvent);
      }
    } catch (error) {
      const failure = envelope(error, "Board subscription failed");
      diagnostics.record({
        procedure: path,
        phase: "error",
        transport: "electron-ipc",
        code: failure.code,
        message: failure.message,
      });
      terminal(subscription, { kind: "error", subscriptionId, error: failure });
    } finally {
      await stop(subscriptionId);
    }
  }

  /** A stream's last word, unless it was cancelled here or its window is gone. */
  function terminal(
    subscription: ActiveSubscription,
    event: Exclude<BoardRpcIpcEvent, { kind: "data" }>,
  ): void {
    if (
      active.get(event.subscriptionId) !== subscription ||
      subscription.abort.signal.aborted ||
      subscription.owner.isDestroyed()
    ) {
      return;
    }
    try {
      subscription.owner.send(BOARD_RPC_EVENT_CHANNEL, event);
    } catch {
      // The window cannot receive its stream's end; the diagnostic keeps it.
    }
  }

  return {
    close: async () => {
      await Promise.all([...active.keys()].map((subscriptionId) => stop(subscriptionId)));
    },
  };
}

/** The procedure at a dotted path of a tRPC caller (`board.snapshot` → `caller.board.snapshot`). */
function procedureAt(caller: object, path: string): Procedure {
  let node: unknown = caller;
  for (const segment of path.split(".")) node = (node as Record<string, unknown>)[segment];
  return node as Procedure;
}

function isRequest(value: unknown): value is BoardRpcIpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string" &&
    "input" in value
  );
}

function invalidRequest(): BoardRpcIpcResponse {
  return { ok: false, error: { code: "BAD_REQUEST", message: "Invalid board request" } };
}

/** The router's own envelope: code, sanitized message and reason, nothing else of the error. */
function envelope(error: unknown, fallback: string): BoardRpcIpcError {
  const { code, message, reason } = hostErrorOf(error, fallback);
  return reason === undefined ? { code, message } : { code, message, reason };
}
