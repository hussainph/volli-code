/**
 * The host protocol contract harness (`docs/plans/host-protocol.md` § Contract
 * harness). It is test-only: nothing outside a test file imports
 * `@volli/host-protocol/testing`, and its transport dependencies are dev ones.
 *
 * A contract case is written once against a tRPC client. `describeContract`
 * runs it over every link it is handed, so a router that behaves differently
 * on Electron IPC (structured clone) and over a WebSocket (JSON text) fails
 * the case on the link that differs. That covers a dropped `undefined`, a
 * `Date` that turned into a string, an error that lost its code, and a
 * subscription that ends where the other one errors.
 */
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
  /** Shown in the test name, as `<title> over <name>`. */
  readonly name: string;
  /** Serves the router for `host` and returns a client connected to it. */
  open(host: Host): Promise<ContractConnection<Router>>;
}

export interface ContractConnection<Router extends AnyRouter> {
  readonly client: TRPCClient<Router>;
  /** Tears down the client, the served router and every subscription between them. */
  close(): Promise<void>;
}

/** What a case body receives once per link. */
export interface ContractScope<Host, Router extends AnyRouter> {
  /** The link this pass runs over, for the rare case that must say why a link differs. */
  readonly link: string;
  /** Opens a connection for this test. It is closed after the test, pass or fail. */
  connect(host: Host): Promise<TRPCClient<Router>>;
}

/**
 * The harness's one entry point. It registers `cases` once per link, under
 * `describe("<title> over <link>")`. Each case calls `connect(host)` with the
 * fixture it needs and talks to the returned client. Connections close after
 * every test, so a case can leave a subscription open without leaking it into
 * the next one.
 */
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
  /**
   * The router context for one connection. `connectionParams` is what the client
   * sent before its first operation, which is where the host hello rides
   * (§ Handshake). It is `null` when the link sent none.
   */
  createContext(
    host: Host,
    connection: { connectionParams: Readonly<Record<string, string | undefined>> | null },
  ): inferRouterContext<Router> | Promise<inferRouterContext<Router>>;
  /** Sent as tRPC `connectionParams`. Absent sends none. */
  connectionParams?: Record<string, string>;
}

/**
 * A tRPC WebSocket server on an ephemeral loopback port, with a stock `wsLink`
 * client. It runs in-process, but the wire is real: every payload crosses as
 * JSON text over a real socket, and every subscription runs through tRPC's own
 * WebSocket adapter. That is the shape the host transport (VC-564) serves
 * across a network.
 */
export function webSocketContractLink<Host, Router extends AnyRouter>(
  options: WebSocketContractLinkOptions<Host, Router>,
): ContractLink<Host, Router> {
  return {
    name: "websocket",
    async open(host) {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      applyWSSHandler<Router>({
        wss: server,
        router: options.router,
        createContext: ({ info }) =>
          options.createContext(host, { connectionParams: info.connectionParams }),
      });
      const { port } = server.address() as AddressInfo;
      const socket = createWSClient({
        url: `ws://127.0.0.1:${port}`,
        ...(options.connectionParams === undefined
          ? {}
          : { connectionParams: options.connectionParams }),
      });
      return {
        client: createTRPCClient<Router>({
          // A router-generic call cannot see that the router has no transformer,
          // which is what makes `transformer` optional; the cast says so once.
          links: [wsLink({ client: socket } as Parameters<typeof wsLink<Router>>[0])],
        }),
        async close() {
          await socket.close();
          for (const peer of server.clients) peer.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
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
  /** Every `onData` payload so far, in arrival order. */
  readonly frames: readonly Data[];
  /** Settles once the server acknowledged the subscription. */
  readonly started: Promise<void>;
  /** Settles on the first terminal event, with the error read as a {@link HostError}. */
  readonly ended: Promise<SubscriptionEnd>;
  /** Resolves with the frames once at least `count` have arrived. */
  received(count: number): Promise<readonly Data[]>;
  unsubscribe(): void;
}

/**
 * Turns tRPC's callback subscription into something a case can await,
 * identically on every link: `await stream.started`, make the host emit, then
 * `await stream.received(n)` or `await stream.ended`.
 */
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
