import { hostLogger, withTrace } from "@volli/host-core/log";
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { createIpcServer } from "@volli/host-protocol/ipc-server";
import type { IpcPeer, IpcResponse } from "@volli/host-protocol/ipc";
import {
  createBoardRouter,
  createDesktopRouter,
  createSessionRouter,
  DESKTOP_IPC_PATHS,
  type DesktopRouterHandlers,
  LOCAL_DESKTOP_CALLER,
  logRpcDiagnostics,
  RpcDiagnosticLog,
  type BoardRouterHandlers,
  type RpcProcedurePerformanceObserver,
  type SessionRouterHandlers,
} from "@volli/session-rpc";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
} from "@volli/shared";

/**
 * What main wires into the bridge. There is deliberately no caller here: this
 * window is the desktop's own, `LOCAL_DESKTOP_CALLER`, in every Workspace
 * (VC-564 D7), and no option can make it anyone else. The contract harness
 * judges other actors over this link by wrapping the router in the test
 * (`session-rpc-contract.test-support.ts`), never through production options.
 */
export interface RegisterSessionRpcIpcOptions {
  /**
   * The host's one handler map (`@volli/host-core/handlers`, VC-668), both
   * tiers of it (VC-608), as the routers project it: production hands the router policy's view,
   * `admittedHandlers(map, ROUTER_POLICY)`, so each handler is admitted at the
   * map as well as by the router's middleware (a sealed map has no other
   * callable form). The bridge forwards this one object; it carries no
   * per-behaviour port of its own.
   */
  handlers: SessionRouterHandlers & BoardRouterHandlers & DesktopRouterHandlers;
  diagnostics?: RpcDiagnosticLog;
  /** Optional payload-free timing tap for benchmark runs. */
  performanceObserver?: RpcProcedurePerformanceObserver;
}

/**
 * Binds the router-generic IPC bridge (`@volli/host-protocol/ipc-server`,
 * VC-608) to Electron: one invoke channel for requests, one send channel for
 * cancels, and ordered pushes to the WebContents that opened a subscription.
 *
 * Which procedures cross is `DESKTOP_IPC_PATHS` (`@volli/session-rpc`), a
 * total table over the routers handed in here; dispatch, cancellation,
 * WebContents teardown and the failure envelope are the generic bridge's.
 * Every call runs under the same router context the WebSocket builds, less
 * what only a network connection has.
 */
export function registerSessionRpcIpcHandlers(options: RegisterSessionRpcIpcOptions): {
  diagnostics: RpcDiagnosticLog;
  close(): Promise<void>;
} {
  const diagnostics = options.diagnostics ?? new RpcDiagnosticLog();
  // Every call's start and outcome, in the renderer's trace for it (VC-699).
  logRpcDiagnostics(diagnostics, hostLogger("rpc"));
  const server = createIpcServer({
    // The board router too (VC-565): the renderer's board with `cloud` on;
    // and the desktop-only tier's (VC-608). An area router joins here, and in
    // `DesktopIpcRouters`, when its area moves.
    routers: [createSessionRouter(), createBoardRouter(), createDesktopRouter()],
    served: DESKTOP_IPC_PATHS,
    createContext: () => ({
      caller: LOCAL_DESKTOP_CALLER,
      handlers: options.handlers,
      diagnostics,
      transport: "electron-ipc" as const,
      performanceObserver: options.performanceObserver,
    }),
    onSubscriptionError: (procedure, error) =>
      diagnostics.record({ procedure, phase: "error", transport: "electron-ipc", ...error }),
    // Handled inside the renderer's trace for it (VC-699): every line main and
    // the in-process host write for this call, a subscription's frames
    // included, carry it. A malformed trace is ignored and one is minted.
    scope: (request, run) =>
      withTrace(request.trace, { door: "ipc", operation: request.path }, run),
  });

  ipcMain.handle(SESSION_RPC_IPC_CHANNEL, (event, request: unknown) =>
    server.request(peerOf(event.sender), request),
  );
  ipcMain.on(SESSION_RPC_CANCEL_CHANNEL, (event, subscriptionId: unknown) =>
    server.cancel(peerOf(event.sender), subscriptionId),
  );

  return { diagnostics, close: () => server.close() };
}

/**
 * A renderer as the bridge sees it: frames go out on the Session RPC event
 * channel, and it is gone, for the subscriptions its document opened, when
 * its WebContents is destroyed, when its main frame navigates to another
 * document (a reload included), or when its render process dies. The
 * WebContents outlives the last two, so waiting for `destroyed` alone would
 * keep those streams, and their runtime listeners, for as long as the window
 * lives, which with the menu-bar host is as long as main does.
 */
function peerOf(sender: WebContents): IpcPeer {
  return {
    id: sender.id,
    isDestroyed: () => sender.isDestroyed(),
    send: (event) => sender.send(SESSION_RPC_EVENT_CHANNEL, event),
    onDestroyed: (listener) => {
      const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) listener();
      };
      sender.once("destroyed", listener);
      sender.on("did-start-navigation", navigated);
      sender.on("render-process-gone", listener);
      return () => {
        sender.removeListener("destroyed", listener);
        sender.removeListener("did-start-navigation", navigated);
        sender.removeListener("render-process-gone", listener);
      };
    },
  };
}

/**
 * The degraded path (VC-76): when the Session runtime never came up — in
 * practice, when the database failed to open — the bridge's channels are
 * still claimed, and every request answers `{ ok: false }` carrying the
 * recorded reason. Left unregistered, the renderer's invoke rejects with
 * Electron's own "No handler registered for 'volli:session-rpc-request'" —
 * technically loud, but nameless: it says a channel is missing where the
 * actual problem is a dead database, quite possibly a Node-ABI mismatch
 * behind it. The Model Access settings page surfaces exactly this message in
 * its "Couldn't load models" toast, so the reason must be the real one.
 *
 * `INTERNAL_SERVER_ERROR` because that is also what the renderer link maps an
 * unrecognized failure to — the reason rides in the message either way.
 */
export function registerDegradedSessionRpcIpcHandlers(reason: string): void {
  ipcMain.handle(
    SESSION_RPC_IPC_CHANNEL,
    // Async like the live handler, so a caller sees one settled-promise shape
    // on this channel regardless of which registration claimed it.
    async (): Promise<IpcResponse> => ({
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: reason },
    }),
  );
  // Claimed for symmetry with the live registration: a cancel is fire-and-
  // forget (`ipcMain.on`), and with no subscriptions there is nothing to stop.
  ipcMain.on(SESSION_RPC_CANCEL_CHANNEL, () => {});
}
