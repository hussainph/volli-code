// @vitest-environment node
/**
 * A sign-in on a host, end to end over a real link (VC-702 PR 2, review B2
 * and B3): today's production `HostSignIns` behind the production listener,
 * VC-670's `createHostLink` reaching it through a loopback TCP relay this
 * test can cut, and desktop main's port, service and runner over that link.
 *
 * - **Link loss is the sign-in's end.** A flow is its connection's and
 *   cannot resume; VC-670 keeps a stream across an outage and ends it
 *   silently on `close()`, so the run watches the link itself: one `lost`,
 *   the relay's listener closed, and the old flow never subscribed again.
 * - **Replacement waits for the old flow.** The host answers a repeat start
 *   from the same connection with the flow it already runs, so a new run
 *   starts only once the old one's cancel reached the host and its flow
 *   ended, and a stale sheet's cancel cannot end the new run.
 *
 * Nothing real signs in: Pi is scripted, the stores are fakes, the browser
 * is a spy, and the relay binds a free loopback port.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { HostSignIns } from "@volli/host-core/session-runtime";
import {
  createHostLink,
  type HostLink,
  type HostLinkLogEvent,
} from "@volli/host-protocol/client-link";
import { createHostRouter, RpcDiagnosticLog } from "@volli/session-rpc";
import { startHostProtocolListener, type HostProtocolListener } from "@volli/session-rpc/websocket";
import type { HostSignInRunEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Main-test cleanup imports broadcast; never load a real Electron binary.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { hostLinkSignIns, remoteSignInsPort } from "./port";
import { createHostSignInService, type HostSignInHostLink } from "./service";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST_ID = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const DEVICE = {
  kind: "device" as const,
  deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
  workspaceId: WORKSPACE,
};
const FEATURES = ["sign-ins", "auth.callback"] as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A free loopback port: bound, read, released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Today's host: production `HostSignIns` behind the production listener.
 * Each provider's Pi flow says its page and waits for an abort; it unwinds
 * `unwindMs` later, as a real flow does, so a cancelled flow stays the
 * host's for a while.
 */
async function todaysHost(options: { relayPort: number; unwindMs: number }) {
  let ids = 0;
  const logins: string[] = [];
  const flow = async (steps: PiSignInSteps, signal: AbortSignal): Promise<void> => {
    // Each login's page is its own (its own state), so a test can tell whose page opened.
    steps.say({
      kind: "auth-url",
      url:
        `https://claude.ai/oauth/authorize?code=true&state=login-${logins.length}&redirect_uri=` +
        encodeURIComponent(`http://localhost:${options.relayPort}/callback`),
      instructions: null,
    });
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => setTimeout(() => reject(new Error("aborted")), options.unwindMs),
        { once: true },
      );
    });
  };
  const pi: PiSignIn = {
    offers: (providerId, type) => type === "oauth" && providerId === "anthropic",
    login: (providerId, _type, signal, steps) => {
      logins.push(providerId);
      return flow(steps, signal);
    },
    logout: async () => {},
  };
  const signIns = new HostSignIns({
    pi,
    inspect: async () => ({ observedAt: 0, providers: [], models: [] }),
    keys: {
      models: { setApiKey: async () => {}, stored: async () => [] },
      git: {
        hosts: async () => [],
        get: async () => null,
        set: async () => {},
        clear: async () => {},
      },
    },
    replay: async () => 200,
    newId: () => `flow-${++ids}`,
  });
  const handlers = admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      signIns,
    }),
    ROUTER_POLICY,
  );
  const listener: HostProtocolListener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST_ID, version: "real-link-test" },
    workspace: () => ({ id: WORKSPACE, epoch: 1 }),
    verifier: { verify: async () => ({ actor: DEVICE, current: () => true }) },
    features: ["sessions", ...FEATURES],
    context: () => ({ handlers, diagnostics: new RpcDiagnosticLog() }),
  });
  cleanups.push(() => listener.close());
  return { listener, signIns, logins };
}

/** A loopback TCP relay in front of the host that this test can cut and block. */
async function cuttableRoute(target: { host: string; port: number }) {
  const sockets = new Set<Socket>();
  let blocked = false;
  const server: Server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** Drops every connection now; new ones are refused until {@link unblock}. */
    cut(): void {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    unblock(): void {
      blocked = false;
    },
  };
}

function hostLink(url: string, log: HostLinkLogEvent[]): HostLink {
  const link = createHostLink({
    url,
    workspaceId: WORKSPACE,
    client: { kind: "desktop", version: "real-link-test" },
    features: [...FEATURES],
    credential: () => "test-only-credential",
    timing: { backoffBaseMs: 20, backoffCapMs: 40 },
    log: (event) => void log.push(event),
  });
  cleanups.push(() => link.close());
  return link;
}

/** Desktop main over one link: the service and the handler map's port, with a browser spy. */
function desktopMain(link: HostLink, record: { starts: string[]; cancels: string[] }) {
  const signIns = hostLinkSignIns(link);
  const recorded: HostSignInHostLink = {
    ...signIns,
    start: async (input) => {
      const flow = await signIns.start(input);
      record.starts.push(flow.flowId);
      return flow;
    },
    cancel: async (flow) => {
      record.cancels.push(flow.flowId);
      return signIns.cancel(flow);
    },
  };
  const openExternal = vi.fn();
  const service = createHostSignInService({
    sendConfirmation: { resolve: () => null, confirm: async () => null },
    links: { linkFor: () => recorded },
    mac: { list: async () => [], read: async () => undefined },
    openExternal,
  });
  return { port: remoteSignInsPort(service), openExternal };
}

async function relayClosed(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/callback?code=late`).then(
    () => false,
    () => true,
  );
}

describe("a sign-in over a real host link", () => {
  it("ends lost, once, when the socket drops: the relay closes and the old flow is never resubscribed", async () => {
    const relayPort = await freePort();
    const host = await todaysHost({ relayPort, unwindMs: 0 });
    const route = await cuttableRoute(host.listener.address);
    const log: HostLinkLogEvent[] = [];
    const link = hostLink(route.url, log);
    await until(() => link.getState().status === "ready", "the link");
    const main = desktopMain(link, { starts: [], cancels: [] });
    const events: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void events.push(event));
    await until(() => main.openExternal.mock.calls.length === 1, "the browser");
    expect(events).toEqual([
      { kind: "relay", state: "listening" },
      expect.objectContaining({ kind: "auth-url" }),
    ]);

    route.cut();
    await until(() => link.getState().status !== "ready", "the drop");
    await until(() => events.some((event) => event.kind === "lost"), "lost");
    expect(link.getState().status).not.toBe("ready");
    expect(await relayClosed(relayPort)).toBe(true);

    // The link comes back; the flow was its old connection's and stays gone.
    route.unblock();
    await until(() => link.getState().status === "ready", "the link again");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((event) => event.kind === "lost")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "lost" });
    expect(
      log.filter((event) => event.kind === "resubscribe" && event.path === "signIns.subscribe"),
    ).toEqual([]);
    await expect(main.port.answer(HOST_ID, "anthropic", "p", "x")).rejects.toThrow(
      "no longer running",
    );
  });

  it("ends lost when the engine closes the link it lent", async () => {
    const relayPort = await freePort();
    const host = await todaysHost({ relayPort, unwindMs: 0 });
    const log: HostLinkLogEvent[] = [];
    const link = hostLink(host.listener.url, log);
    await until(() => link.getState().status === "ready", "the link");
    const main = desktopMain(link, { starts: [], cancels: [] });
    const events: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void events.push(event));
    await until(() => main.openExternal.mock.calls.length === 1, "the browser");

    link.close();
    await until(() => events.some((event) => event.kind === "lost"), "lost");
    expect(events.filter((event) => event.kind === "lost")).toHaveLength(1);
    expect(await relayClosed(relayPort)).toBe(true);
  });

  it("replaces a run with a fresh flow, even when start and cancel are slow: start, cleanup, start", async () => {
    const relayPort = await freePort();
    // The cancelled flow takes a while to unwind on the host, as a real one does.
    const host = await todaysHost({ relayPort, unwindMs: 150 });
    const link = hostLink(host.listener.url, []);
    await until(() => link.getState().status === "ready", "the link");
    const record = { starts: [] as string[], cancels: [] as string[] };
    const main = desktopMain(link, record);

    // React StrictMode in dev: the sheet starts, cleans up, and starts again
    // at once; the stale sheet's own cancel arrives after the new run began.
    const first: HostSignInRunEvent[] = [];
    const stopFirst = await main.port.run(
      HOST_ID,
      "anthropic",
      (event) => void first.push(event),
      "run-1",
    );
    stopFirst();
    const second: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void second.push(event), "run-2");
    await main.port.cancel(HOST_ID, "anthropic", "run-1");

    await until(() => main.openExternal.mock.calls.length === 1, "the new run's browser");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(record.starts.at(-1)).toBe("flow-2");
    expect(record.cancels).toEqual(["flow-1"]);
    expect(first).toEqual([{ kind: "cancelled" }]);
    expect(second).toEqual([
      { kind: "relay", state: "listening" },
      expect.objectContaining({ kind: "auth-url" }),
    ]);
    // The replacement is still running, here and on the host.
    await main.port.cancel(HOST_ID, "anthropic", "run-2");
    expect(second.at(-1)).toEqual({ kind: "cancelled" });
    expect(record.cancels).toEqual(["flow-1", "flow-2"]);
  });

  it("keeps a still-unwinding flow the host's through a chain of replacements: A, then B, then C before A ends", async () => {
    const relayPort = await freePort();
    const host = await todaysHost({ relayPort, unwindMs: 600 });
    const link = hostLink(host.listener.url, []);
    await until(() => link.getState().status === "ready", "the link");
    const record = { starts: [] as string[], cancels: [] as string[] };
    const main = desktopMain(link, record);

    // A owns flow-1, and its page opens.
    const first: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void first.push(event), "run-a");
    await until(() => main.openExternal.mock.calls.length === 1, "A's page");
    // B replaces A: A is cancelled, and B's start answers A's unwinding flow-1.
    const second: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void second.push(event), "run-b");
    await until(() => record.starts.length >= 2, "B's start");
    expect(record.starts).toEqual(["flow-1", "flow-1"]);
    // C replaces B while A still unwinds: B never had a flow of its own.
    const third: HostSignInRunEvent[] = [];
    await main.port.run(HOST_ID, "anthropic", (event) => void third.push(event), "run-c");

    await until(() => main.openExternal.mock.calls.length === 2, "C's page");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(record.starts.at(-1)).toBe("flow-2");
    expect(record.cancels).toEqual(["flow-1"]);
    expect(
      main.openExternal.mock.calls.map(([url]) => new URL(url).searchParams.get("state")),
    ).toEqual(["login-1", "login-2"]);
    expect(first).toEqual([
      { kind: "relay", state: "listening" },
      expect.objectContaining({ kind: "auth-url" }),
      { kind: "cancelled" },
    ]);
    expect(second).toEqual([{ kind: "cancelled" }]);
    // C runs on: it never heard A's end.
    expect(third).toEqual([
      { kind: "relay", state: "listening" },
      expect.objectContaining({ kind: "auth-url" }),
    ]);
    await main.port.cancel(HOST_ID, "anthropic", "run-c");
    expect(record.cancels).toEqual(["flow-1", "flow-2"]);
  });
});
