/**
 * The Session router's two contract links (`docs/plans/host-protocol.md` §
 * Contract harness). This is test support, imported only by
 * `session-rpc-contract.test.ts` and by any later contract test for this router.
 *
 * - `electron-ipc` is today's product path, end to end: main's real bridge
 *   (`registerSessionRpcIpcHandlers`) and the renderer's real terminating link
 *   (`createSessionRpcClient`), joined by a fake `ipcMain` and `WebContents`.
 *   The fake copies every value by structured clone, as Electron does.
 * - `websocket` is the same router behind tRPC's own WebSocket adapter, so every
 *   value crosses as JSON text.
 *
 * The file sits in the renderer project because only that project type-checks
 * both halves: main's bridge uses Node types, which this project also sees, and
 * the renderer link uses `window`, which main's project does not.
 */
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

import {
  registerSessionRpcIpcHandlers,
  type RegisterSessionRpcIpcOptions,
} from "../../../main/session-rpc-ipc";
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
          for (const listener of [...teardown]) listener();
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
