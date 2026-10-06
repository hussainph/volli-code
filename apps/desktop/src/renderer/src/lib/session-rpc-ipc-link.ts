/**
 * The renderer's Session RPC client: a tRPC client over the router-generic
 * IPC bridge's link (`@volli/host-protocol/ipc`, VC-608).
 *
 * The link is the bridge's client half, the same one the contract harness
 * runs every M2 area's cases over; this module only types it and owns the
 * app's one instance. The client's type is derived from the routers main
 * serves (`DesktopIpcRouter`, `@volli/session-rpc`): the paths
 * `DESKTOP_IPC_PATHS` lets cross, with each procedure's own input and output
 * types. Nothing is cast: structured clone carries the router's values
 * unchanged, and every router seam proves them JSON-safe, so the view's
 * untransformed types are the honest ones.
 */
import { createTRPCClient, type TRPCClient } from "@trpc/client";
import {
  ipcLink,
  type IpcBridge,
  type IpcPerformanceObserver,
  type IpcPerformanceSample,
} from "@volli/host-protocol/ipc";
import type { DesktopIpcRouter } from "@volli/session-rpc";

/** The preload door this client speaks through — `window.api.sessionRpc`. */
export type SessionRpcBridge = IpcBridge;

/** One payload-free observation from the renderer side of the Session RPC edge. */
export type SessionRpcPerformanceSample = IpcPerformanceSample;

/**
 * Optional benchmark tap. It receives only names, counts, sizes, and timings;
 * request and response values never enter it. A throwing tap is ignored so
 * diagnostics cannot alter the transport they are measuring.
 */
export type SessionRpcPerformanceObserver = IpcPerformanceObserver;

/** The renderer's Session RPC client, typed from the routers main serves over IPC. */
export type SessionRpcClient = TRPCClient<DesktopIpcRouter>;

/** Creates a Session RPC client over one bridge. */
export function createSessionRpcClient(
  bridge: SessionRpcBridge,
  performanceObserver?: SessionRpcPerformanceObserver,
): SessionRpcClient {
  return createTRPCClient<DesktopIpcRouter>({
    links: [ipcLink<DesktopIpcRouter>(bridge, performanceObserver)],
  });
}

let client: SessionRpcClient | null = null;

/**
 * The app's one Session RPC client, built on first use.
 *
 * Lazy so that importing this module has no transport effect, and a singleton
 * so a StrictMode double render — or a second surface asking — reuses the one
 * event listener rather than stacking another onto the bridge.
 *
 * The bridge listener is tracked so hot replacement can drop it: without the
 * dispose hook, every re-execution of this module would mint a fresh client
 * whose listener joins — not replaces — the orphaned one, and each live frame
 * would be handled once per surviving copy until a full reload.
 */
export function sessionRpcClient(): SessionRpcClient {
  if (client === null) {
    const bridge = window.api.sessionRpc;
    let detach: (() => void) | null = null;
    client = createSessionRpcClient(
      {
        ...bridge,
        onEvent: (listener) => {
          detach = bridge.onEvent(listener);
          return detach;
        },
      },
      windowPerformanceObserver(),
    );
    /* v8 ignore next 4 -- `import.meta.hot` exists only under the dev server;
       tests and production builds cannot take this branch. */
    import.meta.hot?.dispose(() => {
      detach?.();
      client = null;
    });
  }
  return client;
}

/**
 * E2E benchmarks install this object with an init script before app modules
 * execute. Ordinary windows have no such global and pay no measurement cost;
 * keeping the observer outside the preload API also avoids creating a new IPC
 * surface merely for diagnostics.
 */
function windowPerformanceObserver(): SessionRpcPerformanceObserver | undefined {
  const candidate = (window as unknown as Record<string, unknown>)[
    "__VOLLI_SESSION_RPC_PERFORMANCE__"
  ];
  if (!isRecord(candidate) || typeof candidate.record !== "function") return undefined;

  const record = candidate.record;
  const now = candidate.now;
  return {
    record: (sample) => record.call(candidate, sample),
    ...(typeof now === "function" ? { now: () => now.call(candidate) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
