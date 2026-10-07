import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SshExecResult } from "./ssh";
import type { HostLinkState } from "@volli/host-protocol/client-link";
import type { TunnelState } from "./tunnel";
import { createRemoteHosts } from "./remote-hosts";
import {
  HOST_ID,
  LISTEN,
  WS1,
  harness,
  hostEntry,
  registry,
  json,
  flush,
  ready,
} from "./testing/remote-hosts-harness";

const serving = () =>
  json({
    v: 1,
    verdict: "serving",
    running: { state: "serving", hostId: HOST_ID, version: "1.2.0", listen: LISTEN },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("bounded engine status ownership", () => {
  it("coalesces triggers, never polls, and does not grant Workspace readiness from host status", async () => {
    const held = deferred<Partial<SshExecResult>>();
    const h = harness({
      registry: registry(hostEntry()),
      wake: true,
      overrides: [
        (_script, options) => (options.label === "host-status" ? held.promise : undefined),
      ],
    });
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("connecting");
    h.engine.retry(HOST_ID);
    h.wake.fire("power-resume");
    expect(h.box.statusScripts).toHaveLength(1);
    held.resolve(serving());
    await flush();
    expect(h.engine.snapshot().hosts[0]).toMatchObject({
      version: "1.2.0",
      lastWelcome: null,
      reachability: { state: { status: "ready" } },
    });
    h.engine.openWorkspace(HOST_ID, WS1);
    expect(h.engine.snapshot().projects[WS1]?.link.status).toBe("connecting");
    expect(h.box.statusScripts).toHaveLength(1);
    h.links.made[0]!.set(ready());
    const summary = h.engine.snapshot().hosts[0]!.lastWelcome;
    expect(summary).toMatchObject({ protocol: 1, hostId: HOST_ID });
    h.links.made[0]!.set({
      status: "unreachable",
      attempt: 1,
      closeCode: 1006,
      retryAt: 0,
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Lost the host." },
    });
    h.engine.closeWorkspace(HOST_ID, WS1);
    expect(h.engine.snapshot().hosts[0]!.lastWelcome).toEqual(summary);
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("unreachable");
    h.engine.retry(HOST_ID);
    await flush();
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("ready");
    await h.engine.close();
    expect(h.box.statusTransports.every((transport) => transport.closed)).toBe(true);
  });

  it("bounds an uncooperative status command at 3 s, closes it, and Retry recovers", async () => {
    vi.useFakeTimers();
    let stuck = true;
    const h = harness({
      registry: registry(hostEntry()),
      overrides: [
        (_script, options) =>
          options.label === "host-status" && stuck ? new Promise(() => {}) : undefined,
      ],
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.engine.snapshot().hosts[0]!.reachability?.state).toMatchObject({
      status: "unreachable",
      error: { reason: "host-status-unavailable" },
    });
    expect(h.box.statusTransports[0]!.closed).toBe(true);
    stuck = false;
    h.engine.retry(HOST_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.box.statusScripts).toHaveLength(2);
    await h.engine.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports command exceptions and close failures without losing known status", async () => {
    let fail = true;
    const held = deferred<Partial<SshExecResult>>();
    const h = harness({
      registry: registry(hostEntry({ mode: "user" })),
      overrides: [
        (_script, options) => {
          if (options.label !== "host-status") return undefined;
          if (fail) throw new Error("fixture connection failed");
          return held.promise;
        },
      ],
    });
    await flush();
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("unreachable");
    fail = false;
    h.engine.retry(HOST_ID);
    h.box.statusCloseFails = 1;
    held.resolve(serving());
    await flush();
    expect(h.engine.snapshot().hosts[0]!.reachability?.state.status).toBe("ready");
    expect(h.box.statusScripts[0]!.script).not.toContain("sudo");
    expect(h.log.lines.some((line) => line.msg === "host status ssh did not close cleanly")).toBe(
      true,
    );
    await h.engine.close();
  });

  it("discards a late probe across route replacement, Forget and quit", async () => {
    for (const stop of ["route", "forget", "quit"] as const) {
      const held = deferred<Partial<SshExecResult>>();
      let hold = true;
      const h = harness({
        registry: registry(hostEntry()),
        overrides: [
          (_script, options) =>
            options.label === "host-status" && hold ? held.promise : undefined,
        ],
      });
      if (stop === "route") {
        h.tunnels.made[0]!.set({ status: "starting" });
        hold = false;
        h.tunnels.made[0]!.set({ status: "up", url: "ws://127.0.0.1:2", localPort: 2 });
        await flush();
      } else if (stop === "forget") await h.engine.forget(HOST_ID);
      else await h.engine.close();
      const before = stop === "quit" ? null : h.engine.snapshot();
      held.resolve(json({ v: 1, verdict: "not-serving" }));
      await flush();
      if (before !== null) expect(h.engine.snapshot()).toBe(before);
      expect(h.box.statusTransports.every((transport) => transport.closed)).toBe(true);
      await h.engine.close();
    }
  });

  it("ignores queued link and tunnel notifications after their identity was replaced or stopped", async () => {
    const h = harness({
      enabled: () => false,
      registry: registry(hostEntry({ workspaceIds: [WS1] })),
    });
    const links: ((state: HostLinkState) => void)[] = [];
    let tunnelNotification!: (state: TunnelState) => void;
    const engine = createRemoteHosts({
      ...h.ports,
      enabled: () => true,
      link: (options) => {
        const link = h.ports.link(options);
        return {
          ...link,
          subscribeState(listener) {
            links.push(listener);
            return link.subscribeState(listener);
          },
        };
      },
      tunnel: (options) => {
        const tunnel = h.ports.tunnel(options);
        const subscribe = tunnel.onState.bind(tunnel);
        tunnel.onState = (listener) => {
          tunnelNotification = listener;
          return subscribe(listener);
        };
        return tunnel;
      },
    });
    await flush();
    engine.closeWorkspace(HOST_ID, WS1);
    const before = engine.snapshot();
    links[0]!(ready("9.0.0"));
    expect(engine.snapshot()).toBe(before);
    engine.openWorkspace(HOST_ID, WS1);
    await engine.close();
    links[1]!(ready("9.0.0"));
    tunnelNotification({ status: "up", url: "ws://127.0.0.1:1", localPort: 1 });
    expect(h.box.statusScripts).toHaveLength(1);
  });

  it("wakes a starting tunnel without starting status against a route that is not up", async () => {
    const h = harness({ registry: registry(hostEntry()), tunnelMode: "hold", wake: true });
    h.wake.fire("power-resume");
    expect(h.box.statusScripts).toHaveLength(0);
    await h.engine.close();
  });

  it("publishes classified SSH failure copy for a tunnel and clears it after validated status", async () => {
    const h = harness({ registry: registry(hostEntry()), tunnelMode: "hold" });
    const tunnel = h.tunnels.made[0]!;
    tunnel.set({
      status: "down",
      error: "raw stderr",
      retryInMs: 1_000,
      sshFailure: { kind: "unresolvable", detail: "Could not resolve hostname box" },
    });
    const host = h.engine.snapshot().hosts[0]!;
    expect(host.lastSshFailure).toEqual({ code: "unresolvable", line: "No host named box" });
    expect(host.reachability?.state).toMatchObject({ error: { message: "No host named box" } });
    tunnel.set({ status: "up", url: tunnel.url, localPort: 1 });
    await flush();
    expect(h.engine.snapshot().hosts[0]!.lastSshFailure).toBeNull();
    await h.engine.close();
  });
});
