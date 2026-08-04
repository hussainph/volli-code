import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { createSessionRouter, RpcDiagnosticLog, sanitizeDiagnosticText } from "@volli/session-rpc";
import type { RuntimeCatalog, SessionRuntime } from "@volli/session-engine";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  SESSION_RPC_IPC_PROCEDURES,
} from "@volli/shared";
import type {
  SessionRpcIpcEvent,
  SessionRpcIpcProcedure,
  SessionRpcIpcRequest,
  SessionRpcIpcResponse,
} from "@volli/shared";

/**
 * Every procedure the shared router publishes, across every namespace.
 *
 * This read `session.${...}` alone, and that was the hole. The check below
 * subtracts the allow-list from this union, so a namespace the union cannot
 * name is a namespace the check cannot miss: `runtimeCatalog.*` and
 * `labDiagnostics.*` were never absent from the guard, they were invisible to
 * it. Which is how the app came to have no production route to the runtime
 * catalog at all — no model list, so no model id, so no message can be sent —
 * with a compile-time assertion sitting directly above the gap reporting
 * success. A guard scoped to one namespace only guards one namespace, and it
 * still reads like it guards the router.
 *
 * Widened, every namespace has to be spoken for below: routed, deliberately
 * withheld, or declared missing.
 */
type RouterProcedures = ReturnType<typeof createSessionRouter>["_def"]["procedures"];
type SessionRouterProcedure = {
  [Namespace in keyof RouterProcedures &
    string]: `${Namespace}.${keyof RouterProcedures[Namespace] & string}`;
}[keyof RouterProcedures & string];

/**
 * Pins the shared allow-list to procedures the router actually publishes.
 *
 * The list itself is a plain literal in `@volli/shared` because the renderer's
 * tRPC link needs the same names and cannot reach into `src/main`; that package
 * cannot import the router (a dependency cycle), so this is the one place the
 * two can be compared. Everything below — and the coverage check — reads the
 * shared array through this binding, so an entry the router does not publish
 * fails here rather than at the first call.
 */
const ROUTED_PROCEDURES = SESSION_RPC_IPC_PROCEDURES satisfies readonly SessionRouterProcedure[];

/**
 * Pins an exemption to a procedure the router actually publishes.
 *
 * The allow-list above is pinned by `satisfies`; the two exemptions below were
 * free string unions, which is the same hole one step further in. A procedure
 * that is renamed or deleted leaves its exemption behind, the subtraction still
 * cancels, and the check reports success while excusing a procedure that does
 * not exist — so the next procedure to inherit that name is exempt on arrival,
 * silently. Naming an exemption is only a decision written down if the name has
 * to be real.
 */
type PublishedProcedure<Procedure extends SessionRouterProcedure> = Procedure;

/**
 * Development-only, and staying that way. The lab bridge serves these over
 * HTTP; a production client has no debug pane to feed and no business reading
 * a diagnostic log over the same channel it runs Sessions on.
 */
type DeliberatelyMainOnlyProcedure = PublishedProcedure<
  "labDiagnostics.list" | "labDiagnostics.subscribe"
>;

/**
 * Adding a procedure to the router — in any namespace — without accounting for
 * it above fails here.
 *
 * The allow-list is what `isRequest` accepts, so an unlisted procedure exists
 * in the router and is rejected `BAD_REQUEST` on the only transport production
 * has — a failure that looks like a caller bug and is reported as one.
 * `callProcedure`'s `never` catches the opposite direction (a listed procedure
 * the switch forgot), and neither direction was checked before. A procedure
 * that should not cross IPC, or does not yet, is declared above rather than
 * omitted, so the decision is written down where the check can see it.
 */
type AssertNever<T extends never> = T;
export type SessionRpcIpcCoverage = AssertNever<
  Exclude<SessionRouterProcedure, SessionRpcIpcProcedure | DeliberatelyMainOnlyProcedure>
>;

export interface RegisterSessionRpcIpcOptions {
  runtime: SessionRuntime;
  resolveRuntimeCatalog?: (projectId?: string) => RuntimeCatalog | Promise<RuntimeCatalog>;
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
          resolveRuntimeCatalog: options.resolveRuntimeCatalog,
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
      {
        runtime: options.runtime,
        resolveRuntimeCatalog: options.resolveRuntimeCatalog,
        diagnostics,
        transport: "electron-ipc",
      },
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
        if (next.done) {
          sendTerminalEvent(subscription, { kind: "done", subscriptionId });
          break;
        }
        const [eventId, data] = next.value;
        if (subscription.owner.isDestroyed()) break;
        subscription.owner.send(SESSION_RPC_EVENT_CHANNEL, {
          kind: "data",
          subscriptionId,
          eventId,
          data,
        } satisfies SessionRpcIpcEvent);
      }
    } catch (error) {
      const terminalError = subscriptionError(error);
      diagnostics.record({
        procedure: "session.subscribe",
        phase: "error",
        transport: "electron-ipc",
        ...terminalError,
      });
      sendTerminalEvent(subscription, {
        kind: "error",
        subscriptionId,
        error: terminalError,
      });
    } finally {
      await stop(subscriptionId);
    }
  }

  function sendTerminalEvent(
    subscription: ActiveSubscription,
    event: Exclude<SessionRpcIpcEvent, { kind: "data" }>,
  ): void {
    // Cancellation removes the active entry before it aborts the iterator. The
    // iterator then normally resolves `done`; that is local teardown, not a
    // connection state the renderer needs to recover from.
    if (
      active.get(event.subscriptionId) !== subscription ||
      subscription.abort.signal.aborted ||
      subscription.owner.isDestroyed()
    ) {
      return;
    }
    try {
      subscription.owner.send(SESSION_RPC_EVENT_CHANNEL, event);
    } catch {
      // The renderer is already unable to receive its terminal state. The
      // original subscription error remains in the main-process diagnostics.
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
    case "session.projection":
      return caller.session.projection(request.input as never);
    case "session.command":
      return caller.session.command(request.input as never);
    case "session.cancelInteraction":
      return caller.session.cancelInteraction(request.input as never);
    case "session.refreshCapabilities":
      return caller.session.refreshCapabilities(request.input as never);
    case "session.reconcile":
      return caller.session.reconcile(request.input as never);
    case "runtimeCatalog.inspect":
      return caller.runtimeCatalog.inspect(request.input as never);
    case "runtimeCatalog.save":
      return caller.runtimeCatalog.save(request.input as never);
    case "runtimeCatalog.resolve":
      return caller.runtimeCatalog.resolve(request.input as never);
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
    (ROUTED_PROCEDURES as readonly string[]).includes(value.procedure)
  );
}

function invalidRequest(): SessionRpcIpcResponse {
  return { ok: false, error: { code: "BAD_REQUEST", message: "Invalid Session RPC request" } };
}

function failure(error: unknown): SessionRpcIpcResponse {
  return { ok: false, error: subscriptionError(error, "Session RPC request failed") };
}

function subscriptionError(
  error: unknown,
  fallback = "Session subscription failed",
): { code: string; message: string } {
  return {
    code: isRecord(error) && typeof error.code === "string" ? error.code : "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? sanitizeDiagnosticText(error.message) : fallback,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
