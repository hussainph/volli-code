// The wire protocol for the native Session tRPC edge over Electron IPC.
//
// It lives here rather than beside its main-process handler because BOTH ends
// need it and neither can reach the other: `tsconfig.web.json` excludes
// `src/main`, so a renderer import of that file is TS6307 under composite, and
// this package cannot import `@volli/session-rpc` without a dependency cycle.
// So the procedure allow-list is written down here as a plain literal array and
// main re-asserts it `satisfies readonly SessionRouterProcedure[]` — the
// router-coverage check keeps working where the router is visible, and the
// renderer gets the same names without pulling the router in.

// The three channel names carry no `satisfies` because the Electron channel
// catalog is not visible from here — it is app knowledge, in
// apps/desktop/src/ipc/contract.ts, and a package may not import from its
// consumer. That file asserts the agreement instead, in the direction that is
// allowed: it checks each of these constants against the contract, so drifting
// one of them off the catalog still fails the desktop compile.

/** The single request/reply channel for the native Session tRPC edge. */
export const SESSION_RPC_IPC_CHANNEL = "volli:session-rpc";
/** Main-to-renderer frames for a Session RPC subscription. */
export const SESSION_RPC_EVENT_CHANNEL = "volli:session-rpc-event";
/** Ends one subscription previously started through {@link SESSION_RPC_IPC_CHANNEL}. */
export const SESSION_RPC_CANCEL_CHANNEL = "volli:session-rpc-cancel";

/**
 * Procedures intentionally exposed over Electron IPC. Lab diagnostics stay on
 * the development-only HTTP surface; production clients only receive Session
 * data and stream frames.
 *
 * Frozen because it is the request guard's allow-list: `isRequest` in main
 * decides what may reach the router by membership here, and a renderer holds a
 * live reference to it through `@volli/shared`.
 */
export const SESSION_RPC_IPC_PROCEDURES = Object.freeze([
  "modelAccess.inspect",
  "modelAccess.defaultSelection",
  "modelAccess.setDefault",
  "sessions.create",
  "sessions.attach",
  "session.snapshot",
  "session.projection",
  "session.subscribe",
  "session.command",
  "session.cancelInteraction",
  "session.reconcile",
] as const);

export type SessionRpcIpcProcedure = (typeof SESSION_RPC_IPC_PROCEDURES)[number];

export type SessionRpcIpcRequest = {
  [Procedure in SessionRpcIpcProcedure]: {
    procedure: Procedure;
    input: unknown;
  };
}[SessionRpcIpcProcedure];

/**
 * One main-to-renderer subscription frame. `data` carries the tracked event id
 * the router minted, so a consumer can resume from it after a re-subscribe.
 */
export type SessionRpcIpcEvent =
  | {
      kind: "data";
      subscriptionId: string;
      eventId: string;
      data: unknown;
    }
  | {
      kind: "done";
      subscriptionId: string;
    }
  | {
      kind: "error";
      subscriptionId: string;
      error: { code: string; message: string };
    };

/**
 * The reply to one request. A subscription acknowledges with the id its frames
 * will carry; everything else answers with its data. Failures cross as data —
 * an `ipcMain.handle` rejection serializes into a useless string.
 */
export type SessionRpcIpcResponse =
  | { ok: true; data: unknown }
  | { ok: true; subscriptionId: string }
  | { ok: false; error: { code: string; message: string } };
