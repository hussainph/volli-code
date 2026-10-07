import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { createHostLink, type HostLink } from "@volli/host-protocol/client-link";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createHostRouter } from "../../session-rpc/src/host-router";
import { RpcDiagnosticLog } from "../../session-rpc/src/index";
import { startHostProtocolListener } from "../../session-rpc/src/websocket-server";
import { generateDeviceKey } from "./remote-hosts-device-key";
import { createRemoteHosts } from "./remote-hosts";
import type { SshTunnel } from "./tunnel";
import {
  DEVICE_ID,
  HOST_ID,
  HOST_KEY,
  OTHER_ID,
  WS1,
  harness,
  hostEntry,
  registry,
  json,
} from "./testing/remote-hosts-harness";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("health did not settle within 4 s");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const identity = { id: HOST_ID, version: "1.2.0" };
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: identity,
    workspace: () => ({ id: WS1, epoch: 1 }),
    features: ["sessions"],
    verifier: {
      verify: async () => ({
        actor: { kind: "device", deviceId: DEVICE_ID, workspaceId: WS1 },
        current: () => true,
      }),
    },
    context: () => ({ handlers: {} as never, diagnostics: new RpcDiagnosticLog() }),
  });
  cleanups.push(() => listener.close());
  let serving = false;
  const sockets = new Set<Socket>();
  // This SSH-route stand-in keeps accepting even when hostd is unavailable.
  const route = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    if (!serving) {
      client.destroy();
      return;
    }
    const upstream = connect(listener.address);
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
  const port = (route.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => route.close(() => resolve()));
  });
  const state = { status: "up" as const, url: `ws://127.0.0.1:${port}`, localPort: port };
  const tunnel: SshTunnel = {
    state,
    start: async () => state.url,
    wake() {},
    close() {},
    onState: () => () => {},
  };
  const h = harness({
    enabled: () => false,
    registry: registry(hostEntry()),
    overrides: [
      (_script, options) =>
        options.label === "host-status"
          ? json({
              v: 1,
              management: 1,
              verdict: serving ? "serving" : "not-serving",
              running: serving
                ? { state: "serving", hostId: identity.id, version: identity.version }
                : null,
            })
          : undefined,
    ],
  });
  h.keys.keys.set(HOST_KEY, generateDeviceKey("test").privateKeyPem);
  const links: HostLink[] = [];
  const engine = createRemoteHosts({
    ...h.ports,
    enabled: () => true,
    tunnel: () => tunnel,
    wake: (onWake) => {
      h.wake.listeners.add(onWake);
      return () => h.wake.listeners.delete(onWake);
    },
    link: (options) => {
      const link = createHostLink({
        ...options,
        timing: {
          heartbeatIntervalMs: 100,
          heartbeatTimeoutMs: 100,
          backoffBaseMs: 50,
          backoffCapMs: 100,
        },
      });
      links.push(link);
      return link;
    },
  });
  cleanups.push(() => engine.close());
  return {
    h,
    engine,
    links,
    identity,
    route,
    setServing(value: boolean) {
      serving = value;
      if (!value) for (const socket of sockets) socket.destroy();
    },
  };
}

describe("engine health over a real loopback route and real createHostLink", () => {
  it("never calls a live route ready on a no-project host; Retry and wake recover within 5 s", async () => {
    const f = await fixture();
    const host = () => f.engine.snapshot().hosts[0]!;
    await until(() => host().reachability?.state.status === "unreachable");
    expect(f.route.listening).toBe(true);
    expect(host()).toMatchObject({
      lastWelcome: null,
      signInExpiry: null,
      lastSshFailure: null,
      reachability: { everReady: false, state: { error: { reason: "hostd-not-serving" } } },
    });
    expect(f.links).toHaveLength(0);
    const before = f.h.box.statusScripts.length;
    f.setServing(true);
    const retryAt = Date.now();
    f.engine.retry(HOST_ID);
    await until(() => host().reachability?.state.status === "ready");
    expect(Date.now() - retryAt).toBeLessThan(5_000);
    expect(f.h.box.statusScripts).toHaveLength(before + 1);
    expect(host()).toMatchObject({ version: "1.2.0", lastWelcome: null });
    f.setServing(false);
    f.h.wake.fire("power-resume");
    await until(() => host().reachability?.state.status === "unreachable");
    f.setServing(true);
    const wakeAt = Date.now();
    f.h.wake.fire("network-online");
    await until(() => host().reachability?.state.status === "ready");
    expect(Date.now() - wakeAt).toBeLessThan(5_000);
    expect(f.h.box.statusTransports.every((ssh) => ssh.closed)).toBe(true);

    f.engine.openWorkspace(HOST_ID, WS1);
    await until(() => f.engine.snapshot().projects[WS1]?.link.status === "ready");
    expect(host().lastWelcome).toEqual({
      at: f.h.clock.now,
      hostId: HOST_ID,
      version: "1.2.0",
      protocol: 1,
      features: [],
    });
    const welcome = host().lastWelcome;
    f.setServing(false);
    await until(() => f.engine.snapshot().projects[WS1]?.link.status !== "ready");
    expect(host().lastWelcome).toEqual(welcome);
    await f.engine.forget(HOST_ID);
    expect(f.links[0]!.getState().status).toBe("closed");
    expect(f.engine.snapshot().hosts).toEqual([]);
  });

  it("refuses another host's first welcome, and closes a real connecting link on quit", async () => {
    const f = await fixture();
    f.setServing(true);
    f.identity.id = OTHER_ID;
    f.engine.openWorkspace(HOST_ID, WS1);
    await until(() => f.links[0]!.getState().status === "fenced");
    expect(f.engine.snapshot().hosts[0]!.lastWelcome).toBeNull();
    f.engine.closeWorkspace(HOST_ID, WS1);
    expect(f.links[0]!.getState().status).toBe("closed");
    f.setServing(false);
    f.engine.openWorkspace(HOST_ID, WS1);
    await f.engine.close();
    expect(f.links[1]!.getState().status).toBe("closed");
    expect(f.h.wake.listeners.size).toBe(0);
  });
});
