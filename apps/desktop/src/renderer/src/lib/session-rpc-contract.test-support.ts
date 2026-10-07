/** Real Session IPC bridge/link (structured clone) and the real WS listener (JSON), for tests only. */
import {
  buildHostHello,
  encodeHostHello,
  HOST_V1_FEATURES,
  isLocalDeviceActor,
  type HostCredentialVerifier,
} from "@volli/host-protocol";
import type { IpcEvent, IpcPeer, IpcResponse } from "@volli/host-protocol/ipc";
import {
  servedIpcContractLink,
  servedWebSocketContractLink,
  type ContractLink,
} from "@volli/host-protocol/testing";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  type AppRouter,
  type RouterCaller,
  type SessionRouterContext,
  type BoardRouterHandlers,
  type DesktopRouterHandlers,
  type SessionRouterHandlers,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
} from "@volli/shared";

import { sessionHandlersFrom, type LegacySessionPorts } from "@volli/session-rpc/testing";
import {
  assertIdentityConsumed,
  judgeNextRegistrationAs,
} from "./session-rpc-harness-identity.test-support";

/**
 * Everything a contract case can hand the Session router: who is calling, the
 * runtime and its optional facades. The caller is required here because both
 * links must judge the same actor. Production IPC is always the desktop's own
 * window and takes no caller, so the IPC link applies this one through the
 * test's mocked router (`withHarnessIdentity`); the WebSocket link has the
 * listener's real handshake mint it from a credential.
 */
export type SessionRouterHost = Omit<LegacySessionPorts, "diagnostics" | "performanceObserver"> & {
  caller: RouterCaller;
  resourceWorkspace?: SessionRouterContext["resourceWorkspace"];
  diagnostics?: RpcDiagnosticLog;
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
  send(channel: string, event: IpcEvent): void;
  once(event: "destroyed", listener: () => void): void;
  /** A reload or crash never happens over this link: closing destroys the peer. */
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

/** The WebContents Electron would hand main's handlers for this peer. */
function senderFor(peer: IpcPeer): FakeSender {
  const detach = new Map<() => void, () => void>();
  return {
    id: peer.id,
    isDestroyed: () => peer.isDestroyed(),
    send: (channel, event) => {
      if (channel === SESSION_RPC_EVENT_CHANNEL) peer.send(event);
    },
    once: (_event, listener) => void detach.set(listener, peer.onDestroyed(listener)),
    on: () => {},
    removeListener: (_event, listener) => {
      detach.get(listener as () => void)?.();
      detach.delete(listener as () => void);
    },
  };
}

/**
 * Main's real bridge registration behind a fake `ipcMain`, and the generic
 * bridge's real client link, joined the way Electron joins them
 * (`servedIpcContractLink`: structured clone, later delivery, and the peer
 * destroyed on close).
 */
export function electronIpcSessionLink(): ContractLink<SessionRouterHost, AppRouter> {
  const link = servedIpcContractLink<SessionRouterHost, AppRouter>({
    async serve(host) {
      // Import after the test's Electron mock and this module's fake are initialized.
      const { registerSessionRpcIpcHandlers } = await import("../../../main/session-rpc-ipc");
      const { caller, resourceWorkspace, diagnostics, ...ports } = host;
      judgeNextRegistrationAs({ caller, resourceWorkspace });
      // One object, as main hands it: the map over the ports the case states.
      const registration = registerSessionRpcIpcHandlers({
        // The Session cases reach only the Session router's slice; the bridge
        // also serves the board router (VC-565) and the desktop-only tier
        // (VC-608), whose cases are their own.
        handlers: sessionHandlersFrom(ports) as unknown as SessionRouterHandlers &
          BoardRouterHandlers &
          DesktopRouterHandlers,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });
      assertIdentityConsumed();
      // Taken now: the next registration replaces the fake's map entries.
      const invoke = fakeElectron.handlers.get(SESSION_RPC_IPC_CHANNEL)!;
      const cancel = fakeElectron.listeners.get(SESSION_RPC_CANCEL_CHANNEL)!;
      const senders = new Map<IpcPeer, FakeSender>();
      const sender = (peer: IpcPeer): FakeSender => {
        const known = senders.get(peer) ?? senderFor(peer);
        senders.set(peer, known);
        return known;
      };
      return {
        request: async (peer, request) =>
          (await invoke({ sender: sender(peer) }, request)) as IpcResponse,
        cancel: (peer, subscriptionId) => void cancel({ sender: sender(peer) }, subscriptionId),
        close: () => registration.close(),
      };
    },
  });
  return { ...link, name: "electron-ipc" };
}

/** What the Session router alone serves: every v1 feature but the board's (VC-565). */
const SESSION_ROUTER_FEATURES = HOST_V1_FEATURES.filter(
  (feature) => !feature.startsWith("board.") && feature !== "host.workspaces",
);

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
        features: SESSION_ROUTER_FEATURES,
        workspace: (id) =>
          "workspaceId" in actor && id === actor.workspaceId ? { id, epoch: 1 } : null,
        verifier,
        // The map over the ports the case states, exactly as the IPC link hands it.
        context: () => ({
          handlers: sessionHandlersFrom(ports),
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
          features: SESSION_ROUTER_FEATURES,
          lastSeen: null,
        }),
      ),
  });
}

/** Both links, in the order the contract test runs them. */
export function sessionRouterContractLinks(): ContractLink<SessionRouterHost, AppRouter>[] {
  return [electronIpcSessionLink(), webSocketSessionLink()];
}
