/**
 * The runner composition (VC-671), proved through its interface over a real
 * `createHostCore`: the quit hold is installed before anything can yield, the
 * host's edge binds only the recovered proof, a quit during recovery binds
 * nothing, and each stop policy drains exactly what it names: desktop's quit
 * leaves the shells, Automations and the database alone; a full drain closes
 * the shells, settles Automations and closes SQLite last.
 *
 * The executor is the one stand-in (no Pi process), and boot recovery's first
 * step is gated so a test can act while recovery is still open. Exhaustive
 * recovery ordering stays with `lifecycle.test.ts`; host stop steps with
 * host-core's `index.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ALWAYS_ONLINE, piOwnedModelAccess } from "@volli/agent-runtime";
import {
  createHostCore,
  isLiveHost,
  throwTransactionViolation,
  type HostCore,
  type HostCorePorts,
} from "../index";
import type { HostStopPolicy } from "../host-lifecycle";
import { HEADLESS_ATTENTION, NO_POWER_EVENTS } from "../ports";
import { SecretStore } from "../secrets";
import { SecretService } from "../secrets/service";
import type { HostHandlerMap } from "../handlers/handler-map";
import { testHostHandlers } from "../testing/host-handlers";
import * as boot from "./boot-recovery";
import { readRecoveredSessionServices, SessionRuntimeClosingError } from "./lifecycle";
import * as pi from "./pi-adapter";
import { createRunnerComposition, type RunnerHostEdge } from "./runner";

const roots: string[] = [];
const hosts: HostCore[] = [];
const gates: PromiseWithResolvers<void>[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.resolve();
  for (const host of hosts.splice(0)) {
    await host.stop("test teardown");
    if (isLiveHost(host) && host.database.db.open) host.database.db.close();
  }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-runner-"));
  roots.push(root);
  return root;
}

function hostPorts(): HostCorePorts {
  return {
    events: { publish: vi.fn() },
    attention: HEADLESS_ATTENTION,
    power: NO_POWER_EVENTS,
    connectivity: ALWAYS_ONLINE,
    log: { error: vi.fn(), warn: vi.fn() },
  };
}

const noKeys = {
  isEncryptionAvailable: () => false,
  encryptString: (): never => {
    throw new Error("no keys in this test");
  },
  decryptString: (): never => {
    throw new Error("no keys in this test");
  },
};

async function composedHost(policy: HostStopPolicy, options: { degraded?: boolean } = {}) {
  const root = tempRoot();
  const ports = hostPorts();
  const models = piOwnedModelAccess({ agentDir: join(root, "pi-agent") });
  await models.catalogReady;
  const databasePath = join(root, "volli.db");
  // A directory where the database file should be: the open fails.
  if (options.degraded === true) mkdirSync(databasePath);
  const host = createHostCore(ports, {
    dataDir: root,
    databasePath,
    stopPolicy: policy,
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
    modelAccess: () => models,
    secretKey: noKeys,
  });
  hosts.push(host);
  vi.spyOn(pi, "createPiRuntimeHost").mockReturnValue({
    adapter: {
      id: "pi",
      durableIdNamespace: "pi",
      adapterVersion: "1",
      runtime: { path: "test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("runner test does not attach");
      },
    },
    inspectModelAccess: async () => ({ observedAt: 0, models: [], providers: [] }),
    completeUtility: async () => {
      throw new Error("runner test does not complete");
    },
  } as unknown as ReturnType<typeof pi.createPiRuntimeHost>);
  return { host, ports, root };
}

/** Holds boot recovery's first step open until the returned gate resolves. */
function gateRecovery(calls: string[]): PromiseWithResolvers<void> {
  const gate = Promise.withResolvers<void>();
  gates.push(gate);
  const real = boot.closeStaleAttachments;
  vi.spyOn(boot, "closeStaleAttachments").mockImplementation(async (options) => {
    calls.push("recovery");
    await gate.promise;
    return real(options);
  });
  return gate;
}

function compose(
  { host, ports, root }: Awaited<ReturnType<typeof composedHost>>,
  policy: HostStopPolicy,
) {
  const calls: string[] = [];
  const transport = {
    close: vi.fn(async () => {
      calls.push("transport.close");
    }),
  };
  let map: HostHandlerMap | undefined;
  const installQuitHold = vi.fn(() => {
    calls.push("quit.hold");
  });
  const runner = createRunnerComposition({
    store: { kind: "local", host },
    ports,
    version: "0.0.0-test",
    venue: { id: "test-host", kind: "remote" },
    homeDir: root,
    binDir: join(root, "bin"),
    env: {},
    packaged: true,
    cloudEnabled: () => false,
    secrets: new SecretService(
      isLiveHost(host) ? host.secretStore : new SecretStore(join(root, "s.enc"), noKeys),
    ),
    capabilities: { askUser: false, requestSecret: false },
    beforeExecution: async () => {},
    stopPolicy: policy,
    // The tool door projects the host's one map; nothing here calls a verb.
    handlers: () => {
      if (!isLiveHost(host)) throw new Error("A degraded host has no tool door.");
      return (map ??= testHostHandlers({ db: host.database.db }));
    },
    transport: () => transport,
    stopProducers: () => {
      calls.push("host.producers.stop");
    },
    installQuitHold,
  });
  const automationsStop = vi.spyOn(runner.automations, "stop");
  const automationsSettled = vi.spyOn(runner.automations, "settled");
  const shellsClose = vi.spyOn(runner.shells, "close");
  return {
    calls,
    runner,
    transport,
    installQuitHold,
    automationsStop,
    automationsSettled,
    shellsClose,
  };
}

describe("runner composition", () => {
  it("installs the quit hold synchronously and binds the host edge only from recovered readiness", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const recoveryCalls: string[] = [];
    const held = gateRecovery(recoveryCalls);
    const f = compose(fixture, "desktop-quit");
    // Before anything could yield.
    expect(f.installQuitHold).toHaveBeenCalledOnce();
    expect(f.runner.runtime).not.toBeNull();
    const bind = vi.fn<NonNullable<RunnerHostEdge["bind"]>>(() => {
      f.calls.push("bind");
    });
    const started = host.start(
      f.runner.owner({
        bind,
        closeSocket: async () => {
          f.calls.push("socket.close");
        },
      }),
    );
    await vi.waitFor(() => expect(recoveryCalls).toEqual(["recovery"]));
    expect(bind).not.toHaveBeenCalled();
    held.resolve();
    await started;
    expect(bind).toHaveBeenCalledOnce();
    const proof = bind.mock.calls[0]![0];
    expect(() => readRecoveredSessionServices(proof)).not.toThrow();
    await expect(f.runner.ready()).resolves.toBe(proof);

    f.calls.length = 0;
    await expect(host.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    // The host's producers and the runner's stop first; the transport and the
    // runtime drain beside the socket. Desktop quit joins no shell close, no
    // Automation settlement, and leaves the database open for process exit.
    expect(f.calls[0]).toBe("host.producers.stop");
    expect(f.calls).toContain("transport.close");
    expect(f.calls).toContain("socket.close");
    expect(f.automationsStop).toHaveBeenCalled();
    expect(f.shellsClose).not.toHaveBeenCalled();
    expect(f.automationsSettled).not.toHaveBeenCalled();
    expect(host.database.db.open).toBe(true);
    await expect(f.runner.ready()).rejects.toBeInstanceOf(SessionRuntimeClosingError);
  });

  it("a quit during recovery never binds, joins the open sweep, and leaves desktop's database open", async () => {
    const fixture = await composedHost("desktop-quit");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const recoveryCalls: string[] = [];
    const held = gateRecovery(recoveryCalls);
    const f = compose(fixture, "desktop-quit");
    const bind = vi.fn();
    const started = host.start(f.runner.owner({ bind }));
    const refused = expect(started).rejects.toBeInstanceOf(SessionRuntimeClosingError);
    await vi.waitFor(() => expect(recoveryCalls).toEqual(["recovery"]));
    let stopped = false;
    const stopping = host.stop("quit").then((report) => {
      stopped = true;
      return report;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The Session drain joins the recovery still in flight.
    expect(stopped).toBe(false);
    held.resolve();
    await refused;
    await expect(stopping).resolves.toEqual({ reason: "quit", clean: true });
    expect(bind).not.toHaveBeenCalled();
    expect(host.database.db.open).toBe(true);
  });

  it("composes a degraded host with no runtime, through the same start and stop", async () => {
    const fixture = await composedHost("desktop-quit", { degraded: true });
    const { host } = fixture;
    expect(host.kind).toBe("degraded");
    const f = compose(fixture, "desktop-quit");
    expect(f.runner.runtime).toBeNull();
    expect(f.runner.concurrency).toBeNull();
    expect(f.runner.observability).toBeNull();
    expect(f.runner.automations.kind).toBe("degraded");
    const bind = vi.fn();
    await host.start(f.runner.owner({ bind }));
    expect(bind).toHaveBeenCalledOnce();
    await expect(host.stop("quit")).resolves.toEqual({ reason: "quit", clean: true });
    expect(f.calls).toContain("transport.close");
  });

  it("a full drain closes the edge first, then the shells, settles Automations and closes SQLite", async () => {
    const fixture = await composedHost("drain-and-close");
    const { host } = fixture;
    if (!isLiveHost(host)) throw new Error(host.database.error);
    const f = compose(fixture, "drain-and-close");
    f.shellsClose.mockImplementation(async () => {
      f.calls.push(`shells.close (database ${host.database.db.open ? "open" : "closed"})`);
    });
    f.automationsSettled.mockImplementation(async () => {
      f.calls.push("automations.settled");
    });
    await host.start(
      f.runner.owner({
        beforeClose: async () => {
          f.calls.push("edge.close");
        },
        drainRequests: async () => {
          f.calls.push("requests.drain");
          return true;
        },
      }),
    );
    f.calls.length = 0;
    await expect(host.stop("shutdown")).resolves.toEqual({ reason: "shutdown", clean: true });
    expect(f.calls).toEqual([
      "host.producers.stop",
      "edge.close",
      // The lifecycle's own producer stop joins the drain it starts.
      "host.producers.stop",
      "transport.close",
      "shells.close (database open)",
      "automations.settled",
      "requests.drain",
    ]);
    expect(host.database.db.open).toBe(false);
  });
});
