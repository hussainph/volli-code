/** Real Session IPC bridge/link (structured clone) and stock WS router (JSON), for tests only. */
import type { TRPCClient } from "@trpc/client";
import { webSocketContractLink, type ContractLink } from "@volli/host-protocol/testing";
import { createSessionRouter, RpcDiagnosticLog, type AppRouter } from "@volli/session-rpc";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type SessionRpcIpcEvent,
  type SessionRpcIpcRequest,
  type SessionRpcIpcResponse,
} from "@volli/shared";

import type { RegisterSessionRpcIpcOptions } from "../../../main/session-rpc-ipc";
import { createSessionRpcClient } from "./session-rpc-ipc-link";

/** Everything a contract case can hand the Session router: the runtime and its optional facades. */
export type SessionRouterHost = Omit<RegisterSessionRpcIpcOptions, "performanceObserver">;

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
      const registration = registerSessionRpcIpcHandlers({ ...host });
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

/** The same router behind tRPC's WebSocket adapter, as a host would serve it. */
export function webSocketSessionLink(): ContractLink<SessionRouterHost, AppRouter> {
  return webSocketContractLink({
    router: createSessionRouter(),
    createContext: (host) => ({
      ...host,
      diagnostics: host.diagnostics ?? new RpcDiagnosticLog(),
      transport: "unknown",
    }),
  });
}

/** Both links, in the order the contract test runs them. */
export function sessionRouterContractLinks(): ContractLink<SessionRouterHost, AppRouter>[] {
  return [electronIpcSessionLink(), webSocketSessionLink()];
}
