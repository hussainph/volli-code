import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { createSessionRouter, RpcDiagnosticLog, sanitizeDiagnosticText } from "@volli/session-rpc";
import type { SessionRuntime } from "@volli/session-engine";

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
 */
export const SESSION_RPC_IPC_PROCEDURES = [
  "session.snapshot",
  "session.subscribe",
  "session.command",
  "session.refreshCapabilities",
  "session.reconcile",
] as const;

export type SessionRpcIpcProcedure = (typeof SESSION_RPC_IPC_PROCEDURES)[number];

export type SessionRpcIpcRequest = {
  [Procedure in SessionRpcIpcProcedure]: {
    procedure: Procedure;
    input: unknown;
  };
}[SessionRpcIpcProcedure];

export interface SessionRpcIpcEvent {
  subscriptionId: string;
  eventId: string;
  data: unknown;
}

export type SessionRpcIpcResponse =
  | { ok: true; data: unknown }
  | { ok: true; subscriptionId: string }
  | { ok: false; error: { code: string; message: string } };

export interface RegisterSessionRpcIpcOptions {
  runtime: SessionRuntime;
  diagnostics?: RpcDiagnosticLog;
}

interface ActiveSubscription {
  readonly owner: WebContents;
  readonly abort: AbortController;
  readonly iterator: AsyncIterator<readonly [string, unknown]>;
  readonly onDestroyed: () => void;
}

/**
 * Registers a narrow tRPC-to-Electron bridge for the native Session runtime.
 *
 * Electron has no stock tRPC link, so the bridge keeps its small wire protocol
 * here instead of adding a second general IPC framework. Queries and mutations
 * use invoke/reply; subscriptions acknowledge first and then arrive as ordered
 * main-to-renderer frames, with explicit cancellation and WebContents teardown.
 */
export function registerSessionRpcIpcHandlers(options: RegisterSessionRpcIpcOptions): {
  diagnostics: RpcDiagnosticLog;
  close(): Promise<void>;
} {
  const diagnostics = options.diagnostics ?? new RpcDiagnosticLog();
  const router = createSessionRouter();
  const active = new Map<string, ActiveSubscription>();

  const stop = async (subscriptionId: string): Promise<void> => {
    const subscription = active.get(subscriptionId);
    if (!subscription) return;
    active.delete(subscriptionId);
    subscription.owner.removeListener("destroyed", subscription.onDestroyed);
    subscription.abort.abort();
    await subscription.iterator.return?.();
  };

  ipcMain.handle(
    SESSION_RPC_IPC_CHANNEL,
    async (event, request: unknown): Promise<SessionRpcIpcResponse> => {
      if (!isRequest(request)) return invalidRequest();
      try {
        if (request.procedure === "session.subscribe") {
          return await startSubscription(request.input, event.sender);
        }
        const caller = router.createCaller({
          runtime: options.runtime,
          diagnostics,
          transport: "electron-ipc",
        });
        return { ok: true, data: await callProcedure(caller, request) };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.on(SESSION_RPC_CANCEL_CHANNEL, (event, subscriptionId: unknown) => {
    if (typeof subscriptionId !== "string") return;
    const subscription = active.get(subscriptionId);
    if (!subscription || subscription.owner.id !== event.sender.id) return;
    void stop(subscriptionId);
  });

  async function startSubscription(
    input: unknown,
    owner: WebContents,
  ): Promise<SessionRpcIpcResponse> {
    const abort = new AbortController();
    const caller = router.createCaller(
      { runtime: options.runtime, diagnostics, transport: "electron-ipc" },
      { signal: abort.signal },
    );
    const stream = await caller.session.subscribe(input as never);
    const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<readonly [string, unknown]>;
    const subscriptionId = randomUUID();
    if (owner.isDestroyed()) {
      abort.abort();
      await iterator.return?.();
      return { ok: false, error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" } };
    }
    const onDestroyed = () => void stop(subscriptionId);
    active.set(subscriptionId, { owner, abort, iterator, onDestroyed });
    owner.once("destroyed", onDestroyed);
    void pumpSubscription(subscriptionId);
    return { ok: true, subscriptionId };
  }

  async function pumpSubscription(subscriptionId: string): Promise<void> {
    const subscription = active.get(subscriptionId);
    if (!subscription) return;
    try {
      while (!subscription.abort.signal.aborted && !subscription.owner.isDestroyed()) {
        const next = await subscription.iterator.next();
        if (next.done) break;
        const [eventId, data] = next.value;
        if (subscription.owner.isDestroyed()) break;
        subscription.owner.send(SESSION_RPC_EVENT_CHANNEL, {
          subscriptionId,
          eventId,
          data,
        } satisfies SessionRpcIpcEvent);
      }
    } catch (error) {
      diagnostics.record({
        procedure: "session.subscribe",
        phase: "error",
        transport: "electron-ipc",
        code: "INTERNAL_SERVER_ERROR",
        message: error instanceof Error ? error.message : "Session subscription failed",
      });
    } finally {
      await stop(subscriptionId);
    }
  }

  return {
    diagnostics,
    close: async () => {
      await Promise.all([...active.keys()].map((subscriptionId) => stop(subscriptionId)));
    },
  };
}

async function callProcedure(
  caller: ReturnType<ReturnType<typeof createSessionRouter>["createCaller"]>,
  request: Exclude<SessionRpcIpcRequest, { procedure: "session.subscribe" }>,
): Promise<unknown> {
  switch (request.procedure) {
    case "session.snapshot":
      return caller.session.snapshot(request.input as never);
    case "session.command":
      return caller.session.command(request.input as never);
    case "session.refreshCapabilities":
      return caller.session.refreshCapabilities(request.input as never);
    case "session.reconcile":
      return caller.session.reconcile(request.input as never);
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

function isRequest(value: unknown): value is SessionRpcIpcRequest {
  if (!isRecord(value) || !("procedure" in value) || !("input" in value)) return false;
  return (
    typeof value.procedure === "string" &&
    (SESSION_RPC_IPC_PROCEDURES as readonly string[]).includes(value.procedure)
  );
}

function invalidRequest(): SessionRpcIpcResponse {
  return { ok: false, error: { code: "BAD_REQUEST", message: "Invalid Session RPC request" } };
}

function failure(error: unknown): SessionRpcIpcResponse {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "INTERNAL_SERVER_ERROR";
  const message =
    error instanceof Error ? sanitizeDiagnosticText(error.message) : "Session RPC request failed";
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
