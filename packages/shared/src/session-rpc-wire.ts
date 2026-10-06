// The Electron channels of the desktop's router-generic IPC bridge (VC-608).
//
// The wire itself (requests, replies, frames) is `@volli/host-protocol/ipc`,
// and what crosses is `DESKTOP_IPC_PATHS` in `@volli/session-rpc`, beside the
// routers it classifies. Only the channel names live here, because main,
// preload and the contract all open them.

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
