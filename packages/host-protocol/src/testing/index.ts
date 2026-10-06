/** Test-only two-link contract harness; production never imports /testing. */
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from "@trpc/client";
import type { AnyRouter, inferRouterContext } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { afterEach, describe } from "vite-plus/test";
import { WebSocketServer } from "ws";

import { readHostError, type HostError } from "../errors";

/** One way a client reaches a router: Electron IPC, an in-process WebSocket, or a future transport. */
export interface ContractLink<Host, Router extends AnyRouter> {
  readonly name: string;
  open(host: Host): Promise<ContractConnection<Router>>;
}

export interface ContractConnection<Router extends AnyRouter> {
  readonly client: TRPCClient<Router>;
  close(): Promise<void>;
}

/** What a case body receives once per link. */
export interface ContractScope<Host, Router extends AnyRouter> {
  readonly link: string;
  connect(host: Host): Promise<TRPCClient<Router>>;
}

/** Run each case unchanged against every link; connections close after each test. */
export function describeContract<Host, Router extends AnyRouter>(
  title: string,
  links: readonly ContractLink<Host, Router>[],
  cases: (scope: ContractScope<Host, Router>) => void,
): void {
  for (const link of links) {
    describe(`${title} over ${link.name}`, () => {
      const connections: ContractConnection<Router>[] = [];
      afterEach(async () => {
        await Promise.all(connections.splice(0).map((connection) => connection.close()));
      });
      cases({
        link: link.name,
        connect: async (host) => {
          const connection = await link.open(host);
          connections.push(connection);
          return connection.client;
        },
      });
    });
  }
}

export interface WebSocketContractLinkOptions<Host, Router extends AnyRouter> {
  router: Router;
  createContext(
    host: Host,
    connection: { connectionParams: Readonly<Record<string, string | undefined>> | null },
  ): inferRouterContext<Router> | Promise<inferRouterContext<Router>>;
  connectionParams?: Record<string, string>;
}

/** Real loopback WS server/client; stock tRPC adapters carry JSON on the wire. */
export function webSocketContractLink<Host, Router extends AnyRouter>(
  options: WebSocketContractLinkOptions<Host, Router>,
): ContractLink<Host, Router> {
  return servedWebSocketContractLink<Host, Router>({
    async serve(host) {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      applyWSSHandler<Router>({
        wss: server,
        router: options.router,
        createContext: ({ info }) =>
          options.createContext(host, { connectionParams: info.connectionParams }),
      });
      const { port } = server.address() as AddressInfo;
      return {
        url: `ws://127.0.0.1:${port}`,
        async close() {
          for (const peer of server.clients) peer.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
    ...(options.connectionParams === undefined
      ? {}
      : { connectionParams: () => options.connectionParams! }),
  });
}

/** A server a host's own code started for one connection: where it listens, and its stop. */
export interface ServedWebSocket {
  readonly url: string;
  close(): Promise<void>;
}

export interface ServedWebSocketContractLinkOptions<Host> {
  /**
   * Starts the real server, the one production composes, for this host
   * fixture. The harness never builds a context itself: whatever the server's
   * handshake mints is what the cases are judged as.
   */
  serve(host: Host): Promise<ServedWebSocket>;
  /** This connection's `connectionParams`, built per connection (a hello carries a fresh nonce). */
  connectionParams?(host: Host): Record<string, string>;
}

/** The stock tRPC WebSocket client against a server the host's own code serves. */
export function servedWebSocketContractLink<Host, Router extends AnyRouter>(
  options: ServedWebSocketContractLinkOptions<Host>,
): ContractLink<Host, Router> {
  return {
    name: "websocket",
    async open(host) {
      const server = await options.serve(host);
      const connectionParams = options.connectionParams?.(host);
      const socket = createWSClient({
        url: server.url,
        ...(connectionParams === undefined ? {} : { connectionParams }),
      });
      return {
        client: createTRPCClient<Router>({
          // A router-generic call cannot see that the router has no transformer,
          // which is what makes `transformer` optional; the cast says so once.
          links: [wsLink({ client: socket } as Parameters<typeof wsLink<Router>>[0])],
        }),
        async close() {
          await socket.close();
          await server.close();
        },
      };
    },
  };
}

/** How a recorded subscription ended. */
export type SubscriptionEnd = { kind: "complete" } | { kind: "error"; error: HostError };

/** The handlers tRPC's `subscribe(input, handlers)` takes, typed loosely enough for any router. */
export interface SubscriptionHandlers<Data> {
  onStarted(): void;
  onData(data: Data): void;
  onError(error: unknown): void;
  onComplete(): void;
}

export interface RecordedSubscription<Data> {
  readonly frames: readonly Data[];
  readonly started: Promise<void>;
  readonly ended: Promise<SubscriptionEnd>;
  received(count: number): Promise<readonly Data[]>;
  unsubscribe(): void;
}

/** Await subscription start, received frames and terminal state identically on each link. */
export function recordSubscription<Data>(
  subscribe: (handlers: SubscriptionHandlers<Data>) => { unsubscribe(): void },
): RecordedSubscription<Data> {
  const frames: Data[] = [];
  const waiters: { count: number; resolve: (frames: readonly Data[]) => void }[] = [];
  let markStarted!: () => void;
  let markEnded!: (end: SubscriptionEnd) => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const ended = new Promise<SubscriptionEnd>((resolve) => (markEnded = resolve));
  const subscription = subscribe({
    onStarted: () => markStarted(),
    onData: (data) => {
      frames.push(data);
      for (const waiter of waiters.filter(({ count }) => frames.length >= count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve([...frames]);
      }
    },
    onError: (error) => markEnded({ kind: "error", error: readHostError(error) }),
    onComplete: () => markEnded({ kind: "complete" }),
  });
  return {
    frames,
    started,
    ended,
    received: (count) =>
      frames.length >= count
        ? Promise.resolve([...frames])
        : new Promise((resolve) => waiters.push({ count, resolve })),
    unsubscribe: () => subscription.unsubscribe(),
  };
}

/** Awaits a call that must fail and returns its error as the one envelope. */
export async function expectHostError(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("Expected the host to refuse this call, and it answered");
}
