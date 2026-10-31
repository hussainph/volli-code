import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getFunctionName, makeFunctionReference } from "convex/server";
import type { RunnerCapabilityReport, RunnerHeartbeatReply, RunnerId } from "@volli/shared/cloud";

import { createHeadlessRunner, type HeadlessRunnerOptions } from "./headless-runner";
import type { ConvexClientLike } from "./convex-connection";
import type { RunnerLink, RunnerLinkStore } from "./link";

const runnerId = "00000000-0000-4000-8000-000000000001" as RunnerId;
const reply: RunnerHeartbeatReply = {
  serverTime: 1_000,
  status: "online",
  targetVersion: "0.3.1",
  minVersion: "0.3.0",
  autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
};
const load = { activeSessions: 0, activeTurns: 0, queueDepth: 0, freeMemMb: 1, freeDiskMb: 1 };
const report: RunnerCapabilityReport = {
  version: "0.3.0",
  installMode: "user",
  platform: { os: "linux", arch: "x64", distro: "Debian 12", glibc: "2.36", kernel: "6.1" },
  capabilities: {
    v: 1,
    nodeVersion: "24",
    cpuCount: 2,
    memTotalMb: 4_096,
    git: { version: "2.43.0" },
    docker: false,
    terminals: "unavailable",
    browser: { state: "unavailable", reason: "not installed" },
    maxConcurrentSessions: 2,
    tools: ["session.start"],
  },
  localCredentials: [],
};

function fakeSync() {
  return {
    start: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    waiting: () => 0,
  };
}

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function harness(overrides: Partial<HeadlessRunnerOptions> = {}) {
  let identity: RunnerLink | null = {
    runnerId,
    name: "box",
    credential: "refresh-1",
    generation: 1,
  };
  const store: RunnerLinkStore = {
    load: vi.fn(async () => identity),
    save: vi.fn(async (next) => {
      identity = next;
    }),
    clear: vi.fn(async () => {
      identity = null;
    }),
  };
  const order: string[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    order.push("exchange");
    return new Response(
      JSON.stringify({
        token: "runner.jwt",
        serverTime: 1_000,
        expiresAt: 901_000,
        credential: "refresh-2",
        generation: 2,
      }),
    );
  });
  const backend = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    order.push(name);
    return name === "runners:heartbeat" ? reply : null;
  });
  const clients: FakeClient[] = [];
  let newConnectionsOnline = true;
  class FakeClient implements ConvexClientLike {
    connected = newConnectionsOnline;
    auth!: Parameters<ConvexClientLike["setAuth"]>[0];
    listener: ((state: { isWebSocketConnected: boolean }) => void) | null = null;
    close = vi.fn(async () => {
      this.listener = null;
    });
    constructor() {
      order.push("connect");
      clients.push(this);
    }
    setAuth(auth: FakeClient["auth"]) {
      this.auth = auth;
    }
    mutation(ref: never, args: never) {
      return backend(getFunctionName(ref), args);
    }
    query(ref: never, args: never) {
      return backend(getFunctionName(ref), args);
    }
    onUpdate() {
      return () => {};
    }
    connectionState() {
      return { isWebSocketConnected: this.connected };
    }
    subscribeToConnectionState(listener: NonNullable<FakeClient["listener"]>) {
      this.listener = listener;
      return () => {
        this.listener = null;
      };
    }
    setConnected(connected: boolean) {
      this.connected = connected;
      this.listener?.({ isWebSocketConnected: connected });
    }
  }
  let currentReport = structuredClone(report);
  let changed: (() => void) | undefined;
  const onTarget = vi.fn();
  const onLost = vi.fn();
  const onChange = vi.fn();
  const options: HeadlessRunnerOptions = {
    linkStore: store,
    convex: {
      url: "https://dep.convex.cloud",
      siteUrl: "https://dep.convex.site",
      ConvexClient: FakeClient,
      makeFunctionReference,
      fetch,
    },
    platform: {
      service: true,
      readLoad: () => load,
      readCapabilities: () => currentReport,
      onCapabilitiesChange: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    },
    log: { warn: vi.fn() },
    random: () => 1,
    bootId: "boot",
    onTarget,
    onLost,
    onChange,
    ...overrides,
  };
  const runner = createHeadlessRunner(options);
  return {
    runner,
    store,
    options,
    clients,
    fetch,
    backend,
    onTarget,
    onLost,
    onChange,
    order,
    setIdentity: (next: RunnerLink | null) => {
      identity = next;
    },
    setNewConnectionsOnline: (online: boolean) => {
      newConnectionsOnline = online;
    },
    setReport: (next: RunnerCapabilityReport) => {
      currentReport = next;
    },
    change: () => changed?.(),
    reports: () => backend.mock.calls.filter(([name]) => name === "runners:reportCapabilities"),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("headless runner lifecycle", () => {
  it("loads and rotates the link durably before connecting, reports online, and surfaces the update policy", async () => {
    const h = harness();
    await h.runner.start();
    expect(h.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2, credential: "refresh-2" }),
    );
    expect(h.order).toEqual([
      "exchange",
      "connect",
      "runners:reportCapabilities",
      "runners:reportState",
      "runners:heartbeat",
    ]);
    expect(h.runner.snapshot()).toEqual({ state: "online", runnerId, name: "box", canClaim: true });
    expect(h.onTarget).toHaveBeenCalledWith({
      targetVersion: "0.3.1",
      minVersion: "0.3.0",
      autoUpdate: reply.autoUpdate,
    });
    await h.clients[0]!.auth({ forceRefreshToken: false });
    expect(h.fetch).toHaveBeenCalledOnce();
    await h.runner.start();
    expect(h.clients).toHaveLength(1);
    await h.runner.stop();
  });

  it("stays up without a link and never connects or exchanges a credential", async () => {
    const h = harness();
    h.setIdentity(null);
    await h.runner.start();
    expect(h.runner.snapshot().state).toBe("unlinked");
    expect(h.clients).toHaveLength(0);
    expect(h.fetch).not.toHaveBeenCalled();
    await h.runner.stop();
  });

  it("can expose the same cached token before start so composition can read the owner", async () => {
    const h = harness();
    await expect(h.runner.token()).resolves.toBe("runner.jwt");
    await h.runner.start();
    expect(h.fetch).toHaveBeenCalledOnce();
    await h.runner.stop();
  });

  it("reconnects after heartbeat loss and fences claims until another heartbeat succeeds", async () => {
    const h = harness();
    await h.runner.start();
    h.backend.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.runner.snapshot()).toMatchObject({ state: "offline", canClaim: false });
    const before = h.backend.mock.calls.length;
    await expect(h.runner.connection!.link.call("runnerJobs:claim", {})).resolves.toEqual([]);
    expect(h.backend.mock.calls).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    expect(h.clients).toHaveLength(2);
    expect(h.runner.snapshot()).toMatchObject({ state: "online", canClaim: true });
    await h.runner.stop();
  });

  it("times out a half-open heartbeat, reconnects, and ignores the abandoned result", async () => {
    const h = harness();
    await h.runner.start();
    h.backend.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(h.runner.snapshot().state).toBe("offline");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runner.snapshot().state).toBe("online");
    expect(h.clients).toHaveLength(2);
    await h.runner.stop();
  });

  it("refreshes capabilities once per diff, including change events and model logins", async () => {
    const h = harness();
    await h.runner.start();
    await Promise.all([h.runner.refreshCapabilities(), h.runner.refreshCapabilities()]);
    expect(h.reports()).toHaveLength(1);
    h.setReport({
      ...report,
      localCredentials: [{ providerId: "anthropic", kind: "api_key", expiresAt: null }],
    });
    h.change();
    h.change();
    await flush();
    expect(h.reports()).toHaveLength(2);
    await h.runner.stop();
    h.change();
    await h.runner.refreshCapabilities();
    expect(h.reports()).toHaveLength(2);
  });

  it.each([true, false])(
    "reports Linux AC power; alwaysOn follows service=%s, not installMode",
    async (service) => {
      const h = harness();
      h.options.platform.service = service;
      await h.runner.start();
      expect(h.reports()[0]![1]).toMatchObject({
        report: { capabilities: { power: { source: "ac", alwaysOn: service } } },
      });
      await h.runner.stop();
    },
  );

  it.each(["draining", "updating", "degraded", "stopped"] as const)(
    "reports %s and stops new claims",
    async (state) => {
      const h = harness();
      await h.runner.start();
      await h.runner.reportState(state, "maintenance");
      expect(h.runner.snapshot().canClaim).toBe(false);
      expect(h.backend).toHaveBeenCalledWith("runners:reportState", {
        state,
        reason: "maintenance",
      });
      await h.runner.stop();
    },
  );

  it("drains, resumes after online is acknowledged, then reports stopped only once", async () => {
    const h = harness();
    await h.runner.start();
    await h.runner.drain();
    expect(h.runner.snapshot().canClaim).toBe(false);
    await h.runner.reportState("online");
    expect(h.runner.snapshot().canClaim).toBe(true);
    await Promise.all([h.runner.stop(), h.runner.stop()]);
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    expect(
      h.backend.mock.calls.filter(
        ([name, args]) => name === "runners:reportState" && args.state === "stopped",
      ),
    ).toHaveLength(1);
    expect(h.runner.snapshot()).toMatchObject({ state: "stopped", canClaim: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.clients).toHaveLength(1);
  });

  it("does not allow claims below the floor", async () => {
    const h = harness();
    h.backend.mockImplementation(async (name) =>
      name === "runners:heartbeat" ? { ...reply, status: "upgrade_required" } : null,
    );
    await h.runner.start();
    expect(h.runner.snapshot()).toMatchObject({ state: "online", canClaim: false });
    await expect(h.runner.connection!.link.call("runnerJobs:claim", {})).resolves.toEqual([]);
    expect(h.onTarget).toHaveBeenCalled();
    await h.runner.stop();
  });

  it.each(["revoked"])(
    "goes idle on a %s heartbeat reply without erasing credentials",
    async (status) => {
      const h = harness();
      h.backend.mockImplementation(async (name) =>
        name === "runners:heartbeat" ? { ...reply, status } : null,
      );
      await h.runner.start();
      await flush();
      expect(h.runner.snapshot()).toMatchObject({ state: "revoked", canClaim: false });
      expect(h.onLost).toHaveBeenCalledExactlyOnceWith("revoked");
      expect(h.store.clear).not.toHaveBeenCalled();
      const before = h.backend.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.backend.mock.calls).toHaveLength(before);
      await expect(h.runner.token()).resolves.toBeNull();
      await h.runner.stop();
    },
  );

  it.each([
    { status: 401 },
    { data: { code: "revoked" } },
    { code: "revoked", data: {} },
    { code: "invalid_credential" },
  ])("goes idle on an auth refusal %j", async (error) => {
    const h = harness();
    h.backend.mockRejectedValueOnce(error);
    await h.runner.start();
    await flush();
    expect(h.runner.snapshot().state).toBe("revoked");
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.clients).toHaveLength(1);
    await h.runner.stop();
  });

  it("treats even an unstructured HTTP 401 during token exchange as revoked", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await h.runner.start();
    expect(h.runner.snapshot().state).toBe("revoked");
    expect(h.clients).toHaveLength(0);
    await h.runner.stop();
  });

  it("retries a failed initial exchange with jittered exponential backoff capped at 60s", async () => {
    const h = harness();
    h.fetch.mockRejectedValue(new Error("network"));
    await h.runner.start();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const before = h.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.fetch).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.fetch).toHaveBeenCalledTimes(before + 1);
    }
    await h.runner.stop();
  });

  it("composes sync on the same connection and pauses claims for maintenance and revocation", async () => {
    const sync = fakeSync();
    const factory = vi.fn(() => sync);
    const h = harness({ sync: factory });
    await h.runner.start();
    expect(factory).toHaveBeenCalledWith(h.runner.connection);
    expect(sync.start).toHaveBeenCalledOnce();
    await expect(h.runner.connection!.runnerToken()).resolves.toBe("runner.jwt");
    await h.runner.drain();
    expect(sync.suspend).toHaveBeenCalled();
    await h.runner.reportState("online");
    expect(sync.resume).toHaveBeenCalled();
    h.backend.mockRejectedValueOnce({ status: 401 });
    await expect(h.runner.connection!.link.call("test:write", {})).rejects.toEqual({ status: 401 });
    await h.runner.stop();
    expect(sync.close).toHaveBeenCalledOnce();
    expect(sync.stop).not.toHaveBeenCalled();
  });

  it("delegates clean shutdown to sync and leaves a below-floor sync suspended", async () => {
    const sync = fakeSync();
    const h = harness({ sync: () => sync });
    h.backend.mockImplementation(async (name) =>
      name === "runners:heartbeat" ? { ...reply, status: "upgrade_required" } : null,
    );
    await h.runner.start();
    expect(sync.start).toHaveBeenCalledOnce();
    expect(sync.suspend).toHaveBeenCalled();
    await h.runner.stop();
    expect(sync.stop).toHaveBeenCalledOnce();
  });

  it("handles rejected sync recovery and revoked cleanup without an unhandled rejection", async () => {
    const sync = fakeSync();
    sync.resume.mockRejectedValue(new Error("resume"));
    sync.close.mockRejectedValue(new Error("close"));
    const h = harness({ sync: () => sync });
    await h.runner.start();
    await flush();
    expect(h.options.log.warn).toHaveBeenCalledWith("Headless runner claim recovery failed.");
    h.backend.mockRejectedValueOnce({ status: 401 });
    await expect(h.runner.connection!.link.call("test:write", {})).rejects.toEqual({ status: 401 });
    await h.runner.stop();
    expect(h.options.log.warn).toHaveBeenCalledWith(
      "Headless runner revoked-connection cleanup failed.",
    );
  });

  it("uses one idempotent connection close even when sync also closes it", async () => {
    const h = harness({
      sync: (parts) => ({
        ...fakeSync(),
        close: async () => {
          await parts.link.close();
          await parts.presence.stop();
        },
      }),
    });
    await h.runner.start();
    h.backend.mockRejectedValueOnce({ data: { code: "revoked" } });
    await expect(h.runner.connection!.link.call("test:write", {})).rejects.toEqual({
      data: { code: "revoked" },
    });
    await h.runner.stop();
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
  });

  it("keeps non-Linux power explicit, or conservatively unknown when absent", async () => {
    for (const power of [undefined, { source: "battery" as const, alwaysOn: true }]) {
      const h = harness();
      h.setReport({
        ...report,
        platform: { ...report.platform, os: "darwin" },
        capabilities: { ...report.capabilities, power },
      });
      await h.runner.start();
      expect(h.reports()[0]![1]).toMatchObject({
        report: { capabilities: { power: power ?? { source: "unknown", alwaysOn: false } } },
      });
      await h.runner.stop();
    }
  });

  it("canonicalizes tools and credential order, retaining distinct expiry/kind metadata", async () => {
    const h = harness();
    const credentials: RunnerCapabilityReport["localCredentials"] = [
      { providerId: "z", kind: "api_key", expiresAt: null },
      { providerId: "a", kind: "subscription", expiresAt: 4 },
      { providerId: "a", kind: "api_key", expiresAt: 3 },
      { providerId: "a", kind: "api_key", expiresAt: null },
      { providerId: "a", kind: "api_key", expiresAt: 3 },
    ];
    h.setReport({
      ...report,
      localCredentials: credentials,
      capabilities: { ...report.capabilities, tools: ["b", "a"] },
    });
    await h.runner.start();
    h.setReport({
      ...report,
      localCredentials: credentials.toReversed(),
      capabilities: { ...report.capabilities, tools: ["a", "b"] },
    });
    await h.runner.refreshCapabilities();
    expect(h.reports()).toHaveLength(1);
    await h.runner.stop();
  });

  it("generates a boot id and keeps jitter at or above the one-second floor", async () => {
    const h = harness({
      bootId: undefined,
      random: undefined,
      onTarget: undefined,
      onChange: undefined,
      onLost: undefined,
    });
    h.options.platform.onCapabilitiesChange = undefined;
    vi.spyOn(Math, "random").mockReturnValue(0);
    // The default random function was captured at construction; a second runner captures the spy.
    const runner = createHeadlessRunner({ ...h.options, random: () => 0 });
    h.fetch.mockRejectedValueOnce(new Error("network"));
    await runner.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.clients).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.clients).toHaveLength(1);
    expect(runner.connection!.bootId).toMatch(/^[0-9a-f-]{36}$/);
    await runner.stop();
    vi.restoreAllMocks();
  });

  it("continues presence when optional callbacks throw or reject", async () => {
    const h = harness({
      onTarget: () => {
        throw new Error("callback");
      },
      onChange: () => {
        throw new Error("callback");
      },
      onLost: () => {
        throw new Error("callback");
      },
    });
    await h.runner.start();
    expect(h.runner.snapshot().state).toBe("online");
    h.backend.mockRejectedValueOnce({ status: 401 });
    await expect(h.runner.connection!.link.call("test:write", {})).rejects.toEqual({ status: 401 });
    await h.runner.stop();
    expect(h.options.log.warn).toHaveBeenCalledWith("Headless runner link-loss callback failed.");
    const asyncTarget = harness({
      onTarget: async () => {
        throw new Error("callback");
      },
    });
    await asyncTarget.runner.start();
    await flush();
    expect(asyncTarget.options.log.warn).toHaveBeenCalledWith(
      "Headless runner update-target callback failed.",
    );
    await asyncTarget.runner.stop();
  });

  it("retains capabilities and reconnects if a probe fails, without logging its sensitive exception", async () => {
    const h = harness();
    await h.runner.start();
    h.options.platform.readCapabilities = () => {
      throw new Error("sensitive local path");
    };
    await h.runner.refreshCapabilities();
    expect(h.runner.snapshot().state).toBe("offline");
    expect(JSON.stringify(vi.mocked(h.options.log.warn).mock.calls)).not.toContain(
      "sensitive local path",
    );
    await h.runner.stop();
  });

  it("retries a sealed-store read failure and tolerates non-object transport errors", async () => {
    const h = harness();
    vi.mocked(h.store.load).mockRejectedValueOnce(null).mockRejectedValueOnce("offline");
    await h.runner.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.runner.snapshot().state).toBe("online");
    await h.runner.stop();
  });

  it("halts when a pre-start token load finds no link or the exchange invalidates it", async () => {
    const missing = harness();
    missing.setIdentity(null);
    await expect(missing.runner.token()).resolves.toBeNull();
    expect(missing.runner.snapshot().state).toBe("unlinked");
    await missing.runner.start();
    await missing.runner.stop();
    const invalid = harness();
    invalid.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "invalid_credential", message: "relink" } }), {
        status: 401,
      }),
    );
    await invalid.runner.start();
    expect(invalid.runner.snapshot().state).toBe("revoked");
    await invalid.runner.stop();
  });

  it("does not accept late heartbeat success after shutdown", async () => {
    const h = harness();
    await h.runner.start();
    let finish!: (value: unknown) => void;
    h.backend.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = h.runner.stop();
    finish(reply);
    await stopped;
    expect(h.runner.snapshot()).toMatchObject({ state: "stopped", canClaim: false });
  });

  it("re-publishes live capabilities/state after even a brief socket outage", async () => {
    const h = harness();
    await h.runner.start();
    h.clients[0]!.setConnected(false);
    expect(h.runner.snapshot()).toMatchObject({ state: "offline", canClaim: false });
    h.setReport({
      ...report,
      localCredentials: [{ providerId: "anthropic", kind: "api_key", expiresAt: null }],
    });
    h.clients[0]!.setConnected(true);
    await flush();
    expect(h.runner.snapshot()).toMatchObject({ state: "online", canClaim: true });
    expect(h.reports()).toHaveLength(2);
    await h.runner.refreshCapabilities();
    expect(h.reports()).toHaveLength(2);
    await h.runner.stop();
  });

  it("checks claims again at gate admission after a drain overtakes queued work", async () => {
    const h = harness();
    await h.runner.start();
    const releases: ((value: unknown) => void)[] = [];
    h.backend.mockImplementation(async (name) => {
      if (name === "test:block")
        return new Promise((done) => {
          releases.push(done);
        });
      return name === "runners:heartbeat" ? reply : null;
    });
    const pending = Promise.allSettled(
      Array.from({ length: 32 }, () => h.runner.connection!.link.call("test:block", {})),
    );
    await flush();
    const claim = h.runner.connection!.link.call("runnerJobs:claim", {});
    const draining = h.runner.drain();
    releases[0]!(null);
    await expect(claim).resolves.toEqual([]);
    await draining;
    expect(h.backend.mock.calls.some(([name]) => name === "runnerJobs:claim")).toBe(false);
    await h.runner.stop();
    await pending;
    await h.runner.reportState("online");
    expect(h.runner.snapshot().state).toBe("stopped");
  });

  it("forwards eligible claims and query reads, and reacts to query authentication failures", async () => {
    const h = harness();
    await h.runner.start();
    await h.runner.connection!.link.call("runnerJobs:claim", {});
    expect(h.backend).toHaveBeenCalledWith("runnerJobs:claim", {});
    await h.runner.connection!.link.query!("test:read", {});
    expect(h.backend).toHaveBeenCalledWith("test:read", {});
    h.backend.mockRejectedValueOnce(new Error("temporary"));
    await expect(h.runner.connection!.link.query!("test:read", {})).rejects.toThrow("temporary");
    h.backend.mockRejectedValueOnce({ status: 401 });
    await expect(h.runner.connection!.link.query!("test:read", {})).rejects.toEqual({
      status: 401,
    });
    expect(h.runner.snapshot().state).toBe("revoked");
    await h.runner.stop();
  });

  it("cleans up even if the underlying socket close rejects on revocation", async () => {
    const h = harness();
    await h.runner.start();
    h.clients[0]!.close.mockRejectedValueOnce(new Error("close"));
    h.backend.mockRejectedValueOnce({ status: 401 });
    await expect(h.runner.connection!.link.call("test:write", {})).rejects.toEqual({ status: 401 });
    await h.runner.stop();
    expect(h.runner.snapshot().state).toBe("revoked");
  });

  it("does not connect if stop wins a token exchange and never resurrects after start", async () => {
    const h = harness();
    let finish!: (value: Response) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const started = h.runner.start();
    await flush();
    await h.runner.stop();
    finish(
      new Response(
        JSON.stringify({
          token: "late.jwt",
          serverTime: 1_000,
          expiresAt: 901_000,
          credential: "refresh-2",
          generation: 2,
        }),
      ),
    );
    await started;
    expect(h.clients).toHaveLength(0);
    expect(h.runner.snapshot().state).toBe("stopped");
  });

  it("cleans up subscriptions installed by a synchronously cancelled composition", async () => {
    const sync = fakeSync();
    const h = harness({
      sync: () => {
        void h.runner.stop();
        return sync;
      },
    });
    await h.runner.start();
    expect(sync.close).toHaveBeenCalledOnce();
    expect(h.clients[0]!.listener).toBeNull();
    await h.runner.stop();
  });

  it("does not start the lifecycle as a side effect of a failed pre-start token read", async () => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error("network"));
    await expect(h.runner.token()).rejects.toThrow();
    expect(h.runner.snapshot()).toEqual({
      state: "unlinked",
      runnerId: null,
      name: null,
      canClaim: false,
    });
    expect(h.onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.clients).toHaveLength(0);
    await h.runner.start();
    expect(h.clients).toHaveLength(1);
    await h.runner.stop();
  });

  it("serializes retry opens with an initial link load still in flight", async () => {
    const h = harness();
    let finish!: (value: RunnerLink) => void;
    vi.mocked(h.store.load).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const starting = h.runner.start();
    h.fetch.mockRejectedValueOnce(new Error("network"));
    await expect(h.runner.token()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.store.load).toHaveBeenCalledTimes(2);
    finish({ runnerId, name: "box", credential: "refresh-1", generation: 1 });
    await starting;
    await flush();
    expect(h.clients).toHaveLength(1);
    await h.runner.stop();
  });

  it("publishes a state chosen before connection instead of silently reverting to online", async () => {
    const h = harness();
    await h.runner.reportState("degraded", "no model login");
    await h.runner.start();
    expect(h.backend).toHaveBeenCalledWith("runners:reportState", {
      state: "degraded",
      reason: "no model login",
    });
    expect(h.runner.snapshot().canClaim).toBe(false);
    await h.runner.stop();
  });

  it("carries a drain set while the first token is connecting into the initial presence", async () => {
    const h = harness();
    let finish!: (value: Response) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const starting = h.runner.start();
    await flush();
    await h.runner.drain();
    finish(
      new Response(
        JSON.stringify({
          token: "runner.jwt",
          serverTime: 1_000,
          expiresAt: 901_000,
          credential: "refresh-2",
          generation: 2,
        }),
      ),
    );
    await starting;
    expect(h.backend).toHaveBeenCalledWith("runners:reportState", {
      state: "draining",
      reason: null,
    });
    expect(h.runner.snapshot().canClaim).toBe(false);
    await h.runner.stop();
  });

  it("starts presence only once when sync.start also starts it", async () => {
    const h = harness({
      sync: (parts) => ({
        ...fakeSync(),
        start: () => {
          void parts.presence.start();
        },
      }),
    });
    await h.runner.start();
    await flush();
    expect(h.backend.mock.calls.filter(([name]) => name === "runners:heartbeat")).toHaveLength(1);
    await h.runner.stop();
  });

  it("publishes a drain that arrives while the first heartbeat is in flight", async () => {
    const h = harness();
    let finish!: (value: unknown) => void;
    h.backend.mockImplementation(async (name) =>
      name === "runners:heartbeat"
        ? new Promise((done) => {
            finish = done;
          })
        : null,
    );
    const starting = h.runner.start();
    await flush();
    await h.runner.drain();
    finish(reply);
    await starting;
    expect(h.backend).toHaveBeenLastCalledWith("runners:reportState", {
      state: "draining",
      reason: null,
    });
    expect(h.runner.snapshot().canClaim).toBe(false);
    await h.runner.stop();
  });

  it("owns teardown when stop arrives before sync.start has run", async () => {
    const sync = fakeSync();
    const h = harness({ sync: () => sync });
    let finish!: (value: unknown) => void;
    h.backend
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      );
    const starting = h.runner.start();
    await flush();
    const stopping = h.runner.stop();
    finish(reply);
    await stopping;
    await starting;
    expect(sync.start).not.toHaveBeenCalled();
    expect(sync.stop).toHaveBeenCalledOnce();
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes presence and the socket even when sync.stop rejects", async () => {
    const sync = fakeSync();
    sync.stop.mockRejectedValueOnce(new Error("sync stop"));
    const h = harness({ sync: () => sync });
    await h.runner.start();
    await expect(h.runner.stop()).rejects.toThrow("sync stop");
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves slow claims pending rather than abandoning their eventual lease reply", async () => {
    const h = harness();
    await h.runner.start();
    let finish!: (value: unknown) => void;
    h.backend.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const claim = h.runner.connection!.link.call("runnerJobs:claim", {});
    await vi.advanceTimersByTimeAsync(6_000);
    finish([{ id: "claimed" }]);
    await expect(claim).resolves.toEqual([{ id: "claimed" }]);
    expect(h.runner.snapshot().state).toBe("online");
    await h.runner.stop();
  });

  it("cancels logical retry once socket reconnects belong to the transport", async () => {
    const h = harness();
    await h.runner.start();
    const logicalReconnect = vi.spyOn(h.runner.connection!.link, "reconnectNow");
    h.backend.mockRejectedValueOnce(new Error("heartbeat lost"));
    await vi.advanceTimersByTimeAsync(30_000);
    h.clients[0]!.setConnected(false);
    h.backend.mockRejectedValueOnce(new Error("still offline"));
    await h.runner.connection!.presence.beatNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.clients).toHaveLength(2);
    expect(logicalReconnect).not.toHaveBeenCalled();
    await flush();
    expect(h.runner.snapshot().state).toBe("online");
    await h.runner.stop();
  });

  it("does not restart presence if composition stops it in the pre-start microtask", async () => {
    const h = harness({
      sync: (parts) => {
        const setState = parts.presence.setState.bind(parts.presence);
        parts.presence.setState = async (...args) => {
          await setState(...args);
          void h.runner.stop();
        };
        return fakeSync();
      },
    });
    await h.runner.start();
    await h.runner.stop();
    expect(h.backend).not.toHaveBeenCalled();
    expect(h.clients[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart a stopped presence even before the lifecycle itself stops", async () => {
    const h = harness();
    await h.runner.start();
    await h.runner.connection!.presence.stop();
    const before = h.backend.mock.calls.length;
    await h.runner.connection!.presence.start();
    expect(h.backend.mock.calls).toHaveLength(before);
    await h.runner.stop();
  });

  it("opts the real connection supervisor into one-to-sixty-second retries while offline", async () => {
    const h = harness();
    await h.runner.start();
    h.setNewConnectionsOnline(false);
    h.backend.mockImplementation(async (name) => {
      if (!h.clients.at(-1)!.connected) return new Promise(() => {});
      return name === "runners:heartbeat" ? reply : null;
    });
    h.clients[0]!.setConnected(false);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const before = h.clients.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.clients).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.clients).toHaveLength(before + 1);
      expect(h.runner.snapshot().canClaim).toBe(false);
    }
    h.clients.at(-1)!.setConnected(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.runner.snapshot()).toMatchObject({ state: "online", canClaim: true });
    await h.runner.stop();
  });

  it("does not connect after stop wins an in-flight link load", async () => {
    const h = harness();
    let finish!: (identity: RunnerLink | null) => void;
    vi.mocked(h.store.load).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const started = h.runner.start();
    await h.runner.stop();
    finish(null);
    await started;
    expect(h.runner.snapshot().state).toBe("stopped");
    expect(h.clients).toHaveLength(0);
  });
});
