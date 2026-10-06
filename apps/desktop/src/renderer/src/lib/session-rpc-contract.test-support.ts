/** Real Session IPC bridge/link (structured clone) and the real WS listener (JSON), for tests only. */
import type { TRPCClient } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  HOST_V1_FEATURES,
  isLocalDeviceActor,
  type HostCredentialVerifier,
} from "@volli/host-protocol";
import { servedWebSocketContractLink, type ContractLink } from "@volli/host-protocol/testing";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  type AppRouter,
  type RouterCaller,
  type SessionRouterContext,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type SessionRpcIpcEvent,
  type SessionRpcIpcRequest,
  type SessionRpcIpcResponse,
} from "@volli/shared";

import type { RegisterSessionRpcIpcOptions } from "../../../main/session-rpc-ipc";
import {
  assertIdentityConsumed,
  judgeNextRegistrationAs,
} from "./session-rpc-harness-identity.test-support";
import { createSessionRpcClient } from "./session-rpc-ipc-link";

/**
 * Everything a contract case can hand the Session router: who is calling, the
 * runtime and its optional facades. The caller is required here because both
 * links must judge the same actor. Production IPC is always the desktop's own
 * window and takes no caller, so the IPC link applies this one through the
 * test's mocked router (`withHarnessIdentity`); the WebSocket link has the
 * listener's real handshake mint it from a credential.
 */
export type SessionRouterHost = Omit<RegisterSessionRpcIpcOptions, "performanceObserver"> & {
  caller: RouterCaller;
  resourceWorkspace?: SessionRouterContext["resourceWorkspace"];
};

type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown;

/** What `vi.mock("electron", () => fakeElectron)` serves to main's bridge. */
export const fakeElectron = {
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
  ipcMain: {
    handle: (channel: string, handler: Handler) => fakeElectron.handlers.set(channel, handler),
    on: (channel: string, listener: Handler) => fakeElectron.listeners.set(channel, listener),
  },
};

interface FakeSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, event: SessionRpcIpcEvent): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

let nextSenderId = 1;

/** Main's real bridge and the renderer's real link, joined the way Electron joins them. */
export function electronIpcSessionLink(): ContractLink<SessionRouterHost, AppRouter> {
  return {
    name: "electron-ipc",
    async open(host) {
      // Import after the test's Electron mock and this module's fake are initialized.
      const { registerSessionRpcIpcHandlers } = await import("../../../main/session-rpc-ipc");
      const { caller, resourceWorkspace, ...options } = host;
      judgeNextRegistrationAs({ caller, resourceWorkspace });
      const registration = registerSessionRpcIpcHandlers(options);
      assertIdentityConsumed();
      // Taken now: the next registration replaces the fake's map entries.
      const invoke = fakeElectron.handlers.get(SESSION_RPC_IPC_CHANNEL)!;
      const cancel = fakeElectron.listeners.get(SESSION_RPC_CANCEL_CHANNEL)!;
      const pushes = new Set<(event: SessionRpcIpcEvent) => void>();
      const teardown = new Set<() => void>();
      let destroyed = false;
      const sender: FakeSender = {
        id: nextSenderId++,
        isDestroyed: () => destroyed,
        // Electron delivers a push later, as a copy. A microtask preserves order.
        send: (channel, event) => {
          if (channel !== SESSION_RPC_EVENT_CHANNEL) return;
          const copy = structuredClone(event);
          queueMicrotask(() => {
            for (const push of pushes) push(copy);
          });
        },
        once: (_event, listener) => void teardown.add(listener),
        removeListener: (_event, listener) => void teardown.delete(listener),
      };
      const client = createSessionRpcClient({
        request: async (request: SessionRpcIpcRequest) =>
          structuredClone(
            (await invoke({ sender }, structuredClone(request))) as SessionRpcIpcResponse,
          ),
        onEvent: (listener) => {
          pushes.add(listener);
          return () => pushes.delete(listener);
        },
        cancel: (subscriptionId) => void cancel({ sender }, subscriptionId),
      });
      return {
        // The renderer narrows the client's output types; the router is the same one.
        client: client as unknown as TRPCClient<AppRouter>,
        async close() {
          destroyed = true;
          for (const listener of teardown) listener();
          await registration.close();
        },
      };
    },
  };
}

/** The one credential the WebSocket link presents; its verifier answers the case's caller. */
const HARNESS_CREDENTIAL = "contract-harness-credential";
const HARNESS_HOST = "c0ffee00-0000-4000-8000-00000000c0de";

/**
 * The same router behind the host protocol's real WebSocket listener, as
 * hostd serves it (VC-663): every connection says a fresh hello, a test
 * verifier turns the harness credential into the case's caller, and the
 * listener's own handshake builds the context. Nothing here hands the router
 * a context directly. Only a network caller can cross it; the desktop's own
 * window never arrives over a handshake (D7).
 */
export function webSocketSessionLink(): ContractLink<SessionRouterHost, AppRouter> {
  return servedWebSocketContractLink<SessionRouterHost, AppRouter>({
    async serve(host) {
      const { caller, resourceWorkspace, diagnostics, ...ports } = host;
      if (isLocalDeviceActor(caller.actor)) {
        throw new Error("The desktop's own window never crosses the WebSocket link");
      }
      const actor = caller.actor;
      const verifier: HostCredentialVerifier = {
        verify: ({ credential }) =>
          credential === HARNESS_CREDENTIAL
            ? { actor, current: () => caller.current?.() === true }
            : null,
      };
      const listener = await startHostProtocolListener({
        router: createSessionRouter(),
        bind: { host: "127.0.0.1", port: 0 },
        host: { id: HARNESS_HOST, version: "contract" },
        workspace: (id) => (id === actor.workspaceId ? { id, epoch: 1 } : null),
        verifier,
        context: () => ({
          ...ports,
          diagnostics: diagnostics ?? new RpcDiagnosticLog(),
          ...(resourceWorkspace === undefined ? {} : { resourceWorkspace }),
        }),
      });
      return { url: listener.url, close: () => listener.close() };
    },
    connectionParams: (host) =>
      encodeHostHello(
        buildHostHello({
          client: { kind: "cli", version: "contract" },
          workspaceId: (host.caller.actor as { workspaceId: string }).workspaceId,
          credential: HARNESS_CREDENTIAL,
          features: HOST_V1_FEATURES,
          lastSeen: null,
        }),
      ),
  });
}

/** Both links, in the order the contract test runs them. */
export function sessionRouterContractLinks(): ContractLink<SessionRouterHost, AppRouter>[] {
  return [electronIpcSessionLink(), webSocketSessionLink()];
}
