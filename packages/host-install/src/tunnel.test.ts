import { createServer } from "node:net";
import { describe, expect, it } from "vite-plus/test";

import { recordingLogger, scriptedSpawn, type FakeChild } from "./testing/fake-process";
import {
  createSshTunnel,
  freeLoopbackPort,
  loopbackAccepts,
  tunnelArgs,
  type SshTunnelOptions,
  type TunnelState,
} from "./tunnel";

const TARGET = { destination: "deploy@box", port: null, label: "box" };
const REMOTE = { host: "127.0.0.1", port: 7420 };
const FAST = { readyTimeoutMs: 60, pollMs: 2, backoffMinMs: 5, backoffMaxMs: 20 };
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tunnel over scripted ssh processes; `open` says which local ports carry. */
function harness(
  act: (child: FakeChild, index: number) => void = () => {},
  overrides: Partial<SshTunnelOptions> = {},
) {
  const open = new Set<number>();
  let next = 41000;
  let index = 0;
  const { spawn, children } = scriptedSpawn((child) => act(child, index++));
  const states: TunnelState[] = [];
  const log = recordingLogger();
  const remotes: number[] = [];
  const tunnel = createSshTunnel({
    target: TARGET,
    logger: log.logger,
    resolveRemote: async () => {
      remotes.push(REMOTE.port);
      return REMOTE;
    },
    spawn,
    freePort: async () => next++,
    accepts: async (port) => open.has(port),
    timing: FAST,
    ...overrides,
  });
  tunnel.onState((state) => states.push(state));
  return { tunnel, children, open, states, log, remotes };
}

/** The local port a child forwards. */
const portOf = (child: FakeChild) =>
  Number(/^127\.0\.0\.1:(\d+):/u.exec(child.args[child.args.indexOf("-L") + 1]!)![1]);

describe("the ssh tunnel", () => {
  it("forwards a fixed loopback port to the host's listener, with no prompt and no multiplexing", () => {
    const args = tunnelArgs(TARGET, 41000, REMOTE);
    expect(args).toEqual(
      expect.arrayContaining([
        "-N",
        "BatchMode=yes",
        "ExitOnForwardFailure=yes",
        "ControlPath=none",
      ]),
    );
    expect(args.slice(-4)).toEqual(["-L", "127.0.0.1:41000:127.0.0.1:7420", "--", "deploy@box"]);
    expect(tunnelArgs(TARGET, 1, { host: "::1", port: 2 })).toContain("127.0.0.1:1:[::1]:2");
  });

  it("opens once the local end carries, and says up", async () => {
    const h = harness((child) => setTimeout(() => h.open.add(portOf(child)), 5));
    expect(await h.tunnel.start()).toBe("ws://127.0.0.1:41000");
    expect(h.tunnel.state).toEqual({ status: "up", url: "ws://127.0.0.1:41000", localPort: 41000 });
    expect(h.states.map((state) => state.status)).toEqual(["starting", "up"]);
    expect(h.log.lines.at(-1)).toMatchObject({
      msg: "tunnel up",
      fields: { localPort: 41000, remotePort: 7420 },
    });
  });

  it("fails to open when ssh exits first, with ssh's reason, and when it never carries", async () => {
    const refused = harness((child) => {
      child.err("Permission denied (publickey).");
      child.exit(255);
    });
    await expect(refused.tunnel.start()).rejects.toThrow("Permission denied (publickey).");
    expect(refused.tunnel.state).toMatchObject({ status: "down", retryInMs: 0 });
    const silent = harness((child) => child.exit(1));
    await expect(silent.tunnel.start()).rejects.toThrow("ssh exited 1");
    const missing = harness((child) =>
      child.fail(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })),
    );
    await expect(missing.tunnel.start()).rejects.toThrow("spawn ssh ENOENT");
    const stuck = harness();
    await expect(stuck.tunnel.start()).rejects.toThrow("The tunnel did not open within 0.06 s");
    expect(stuck.children[0]!.killed).toEqual(["SIGTERM"]);
  });

  it("reconnects on the same port after a drop, backing off while it cannot", async () => {
    const h = harness((child, index) => {
      if (index === 1 || index === 2) {
        child.err("ssh: connect to host box port 22: Network is unreachable");
        child.exit(255);
        return;
      }
      h.open.add(portOf(child));
    });
    await h.tunnel.start();
    h.open.clear();
    h.children[0]!.exit(null);
    await tick(80);
    expect(h.tunnel.state).toMatchObject({ status: "up", localPort: 41000 });
    const downs = h.states.filter((state) => state.status === "down");
    expect(downs.map((state) => state.status === "down" && state.retryInMs)).toEqual([5, 10, 20]);
    expect(h.children.map(portOf)).toEqual([41000, 41000, 41000, 41000]);
    expect(h.remotes).toHaveLength(4);
    h.tunnel.close();
  });

  it("takes a new port only when another program took its own", async () => {
    const h = harness((child, index) => {
      if (index === 1) {
        child.err(
          "bind [127.0.0.1]:41000: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 41000",
        );
        child.exit(255);
        return;
      }
      h.open.add(portOf(child));
    });
    await h.tunnel.start();
    h.open.clear();
    h.children[0]!.exit(255);
    await tick(60);
    expect(h.tunnel.state).toMatchObject({ status: "up", url: "ws://127.0.0.1:41001" });
    h.tunnel.close();
  });

  it("reconnects at once when woken after sleep, and not while it is already starting", async () => {
    const h = harness((child) => h.open.add(portOf(child)));
    h.tunnel.wake();
    expect(h.children).toHaveLength(0);
    await h.tunnel.start();
    h.tunnel.wake();
    await tick(20);
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.killed).toEqual(["SIGTERM"]);
    // The old process closing late is not a drop.
    h.children[0]!.exit(0);
    await tick(20);
    expect(h.tunnel.state.status).toBe("up");
    expect(h.log.lines.map((line) => line.msg)).toContain("tunnel woken");
    h.tunnel.close();
  });

  it("can be woken after a first open that never reached ssh", async () => {
    let fail = true;
    const h = harness((child) => h.open.add(portOf(child)), {
      resolveRemote: async () => {
        if (fail) throw new Error("status --json failed");
        return REMOTE;
      },
    });
    await expect(h.tunnel.start()).rejects.toThrow("status --json failed");
    fail = false;
    h.tunnel.wake();
    await tick(20);
    expect(h.tunnel.state.status).toBe("up");
    h.tunnel.close();
  });

  it("stays closed: no reconnect, no state after it", async () => {
    const h = harness((child) => h.open.add(portOf(child)));
    await h.tunnel.start();
    h.tunnel.close();
    expect(h.children[0]!.killed).toEqual(["SIGTERM"]);
    h.children[0]!.exit(255);
    h.tunnel.wake();
    await tick(20);
    expect(h.children).toHaveLength(1);
    expect(h.tunnel.state).toEqual({ status: "closed" });
    h.tunnel.close();
  });

  it("stops retrying once closed mid-reconnect", async () => {
    let failing = false;
    const h = harness((child) => {
      if (failing) {
        setTimeout(() => {
          h.tunnel.close();
          child.exit(255);
        }, 2);
        return;
      }
      h.open.add(portOf(child));
    });
    await h.tunnel.start();
    failing = true;
    h.open.clear();
    h.tunnel.wake();
    await tick(40);
    expect(h.tunnel.state).toEqual({ status: "closed" });
    const unsubscribe = h.tunnel.onState(() => {});
    unsubscribe();
  });

  it("uses the system's ssh, a free port and a real connect by default", async () => {
    const port = await freeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(await loopbackAccepts(port)).toBe(false);
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    expect(await loopbackAccepts((server.address() as { port: number }).port)).toBe(true);
    server.close();
    const real = createSshTunnel({
      target: TARGET,
      logger: recordingLogger().logger,
      resolveRemote: async () => REMOTE,
      sshPath: "/nonexistent/ssh",
      timing: FAST,
    });
    await expect(real.start()).rejects.toThrow(/ENOENT/u);
    real.close();
  });
});
