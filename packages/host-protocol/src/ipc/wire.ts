/**
 * The wire of the router-generic IPC bridge (VC-608; HP § Command catalog):
 * how a tRPC operation crosses an in-process, structured-clone transport
 * (Electron IPC in the desktop) to a host's routers and back.
 *
 * Router-generic: a request names a procedure by its path and tRPC type, the
 * way tRPC's own links do, and carries its input untouched. The server half
 * (`@volli/host-protocol/ipc-server`) dispatches it through tRPC; the client
 * half ({@link ipcLink}) is a terminating tRPC link. Neither half holds a
 * list of procedures: what crosses is decided where the routers are composed.
 *
 * Traced (VC-699): a request carries the operation's `{ traceId, spanId }`
 * beside its input, never in it, as the WebSocket frame's `volliTrace` does.
 * The server hands it to its `scope`, which a host uses to log the call
 * under it; a server without one ignores it.
 *
 * Transport-free: no Electron, no Node. The desktop's preload carries these
 * values over its three channels (`SESSION_RPC_*_CHANNEL`, `@volli/shared`).
 */

import type { HostTrace } from "../trace";

/** A tRPC operation's type, as tRPC's links name it. */
export type IpcProcedureType = "query" | "mutation" | "subscription";

/** One operation: the procedure's dotted path, its tRPC type and its raw input. */
export interface IpcRequest {
  readonly path: string;
  readonly type: IpcProcedureType;
  readonly input: unknown;
  /**
   * The operation this request belongs to (VC-699): the caller's, named in
   * tRPC's operation context (`{ context: { trace: { traceId } } }`), with a
   * fresh span per request; otherwise a fresh trace. Optional: a server
   * judges it before it uses it.
   */
  readonly trace?: HostTrace;
}

/**
 * A failure as it crosses the wire: the host protocol's `HostError`,
 * restated as plain strings because a client must read an envelope from a
 * newer server whose code or reason it does not know. `reason` is present
 * exactly when the router named one, so a client reads the same
 * `{code, message, reason}` the WebSocket link puts on `data.hostError`.
 */
export interface IpcError {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
}

/**
 * One server-to-client subscription frame. A tracked emission carries the id
 * the router minted with `tracked()`, so a consumer can resume from it.
 */
export type IpcEvent =
  | {
      readonly kind: "data";
      readonly subscriptionId: string;
      /** The tracked id, or null for an emission the router did not track. */
      readonly eventId: string | null;
      readonly data: unknown;
    }
  | { readonly kind: "done"; readonly subscriptionId: string }
  | { readonly kind: "error"; readonly subscriptionId: string; readonly error: IpcError };

/**
 * The reply to one request. A subscription acknowledges with the id its
 * frames will carry; a query or mutation answers with its data. Failures
 * cross as data: an Electron `ipcMain.handle` rejection serializes into a
 * useless string.
 */
export type IpcResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: true; readonly subscriptionId: string }
  | { readonly ok: false; readonly error: IpcError };

/** The client's door to the server: the desktop's preload `window.api.sessionRpc`. */
export interface IpcBridge {
  request(request: IpcRequest): Promise<IpcResponse>;
  onEvent(listener: (event: IpcEvent) => void): () => void;
  cancel(subscriptionId: string): void;
}

/**
 * The server's view of one client (a renderer's WebContents in the desktop):
 * frames go to it, and it says when it is gone.
 */
export interface IpcPeer {
  /** Stable for the peer's life: a cancel is honoured only from the subscription's own peer. */
  readonly id: number;
  isDestroyed(): boolean;
  send(event: IpcEvent): void;
  /** Calls `listener` once when the peer goes away; the return removes it. */
  onDestroyed(listener: () => void): () => void;
}

const PROCEDURE_TYPES: ReadonlySet<string> = new Set(["query", "mutation", "subscription"]);

/** Whether a value received over the transport is a well-formed request. */
export function isIpcRequest(value: unknown): value is IpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "path") === "string" &&
    PROCEDURE_TYPES.has(Reflect.get(value, "type") as string)
  );
}
