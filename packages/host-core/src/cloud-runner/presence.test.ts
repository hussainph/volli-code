import { describe, expect, it, vi } from "vite-plus/test";

import type { RunnerCapabilityReport, RunnerHeartbeatReply } from "@volli/shared/cloud";

import {
  createRunnerPresence,
  isRevokedError,
  runnerPresenceBackend,
  type RunnerPresenceBackend,
  type RunnerPresenceTimers,
} from "./presence";

const LOAD = { activeSessions: 1, activeTurns: 0, queueDepth: 0, freeDiskMb: 1, freeMemMb: 1 };
const REPLY: RunnerHeartbeatReply = {
  serverTime: 1,
  status: "online",
  targetVersion: null,
  minVersion: null,
  autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
};

function report(version = "0.3.0"): RunnerCapabilityReport {
  return {
    version,
    platform: { os: "linux", distro: null, kernel: null, arch: "x64", glibc: null },
    installMode: "user",
    capabilities: {
      v: 1,
      nodeVersion: "24",
      cpuCount: 1,
      memTotalMb: 1,
      git: null,
      docker: false,
      terminals: "unavailable",
      browser: { state: "unavailable", reason: "none" },
      maxConcurrentSessions: 1,
      tools: [],
    },
    localCredentials: [],
  };
}

/** A backend call that never answers, as a WebSocket client's does through an outage. */
const never = () => new Promise<never>(() => {});

const revoked = Object.assign(new Error("revoked"), { data: { code: "revoked" } });

function harness() {
  const calls: string[] = [];
  const failures: Partial<Record<keyof RunnerPresenceBackend, unknown[]>> = {};
  const failNext = (name: keyof RunnerPresenceBackend, error: unknown) => {
    (failures[name] ??= []).push(error);
  };
  const take = (name: keyof RunnerPresenceBackend) => {
    const error = failures[name]?.shift();
    if (error !== undefined) throw error;
  };
  const backend: RunnerPresenceBackend = {
    heartbeat: async (args) => {
      calls.push(`heartbeat ${args.bootId}`);
      take("heartbeat");
      return REPLY;
    },
    reportState: async (args) => {
      calls.push(`state ${args.state}${args.reason ? `(${args.reason})` : ""}`);
      take("reportState");
    },
    reportCapabilities: async (args) => {
      calls.push(`capabilities ${args.report.version}`);
      take("reportCapabilities");
    },
  };
  let tick: (() => void) | null = null;
  const timers: RunnerPresenceTimers = {
    setInterval: (run, ms) => {
      expect(ms).toBe(30_000);
      tick = run;
      return "handle";
    },
    clearInterval: (handle) => {
      expect(handle).toBe("handle");
      tick = null;
    },
  };
  let version = "0.3.0";
  const events = { replies: 0, revoked: 0, errors: [] as unknown[] };
  const presence = createRunnerPresence({
    backend,
    bootId: "boot",
    readLoad: () => LOAD,
    readCapabilities: () => report(version),
    timers,
    onReply: () => (events.replies += 1),
    onRevoked: () => (events.revoked += 1),
    onError: (error) => events.errors.push(error),
  });
  return {
    presence,
    calls,
    events,
    failNext,
    setVersion: (next: string) => (version = next),
    tick: async () => {
      tick?.();
      await new Promise((done) => setImmediate(done));
    },
    ticking: () => tick !== null,
  };
}

describe("runner presence", () => {
  it("publishes capabilities and state on connect, then only beats", async () => {
    const h = harness();
    await h.presence.start();
    expect(h.calls).toEqual(["capabilities 0.3.0", "state online", "heartbeat boot"]);
    expect(h.presence.connected).toBe(true);
    await h.tick();
    expect(h.calls.slice(3)).toEqual(["heartbeat boot"]);
    expect(h.events.replies).toBe(2);
  });

  it("re-publishes live state after any failure, never buffering it", async () => {
    const h = harness();
    await h.presence.start();
    h.failNext("heartbeat", new Error("socket closed"));
    await h.tick();
    expect(h.presence.connected).toBe(false);
    expect(h.events.errors).toHaveLength(1);
    await h.presence.setState("draining");
    await h.tick();
    expect(h.calls.slice(4)).toEqual(["capabilities 0.3.0", "state draining", "heartbeat boot"]);
  });

  it("stops for good, and says so once, when the backend refuses it as revoked", async () => {
    const h = harness();
    h.failNext("reportCapabilities", revoked);
    await h.presence.start();
    expect(h.presence.revoked).toBe(true);
    expect(h.ticking()).toBe(false);
    expect(h.events.revoked).toBe(1);
    await h.presence.start();
    await h.presence.setState("degraded", "disk-low");
    await h.presence.refreshCapabilities();
    await h.presence.stop();
    expect(h.calls).toEqual(["capabilities 0.3.0"]);
  });

  it("a revocation seen twice is reported once", async () => {
    const h = harness();
    await h.presence.start();
    h.failNext("reportState", revoked);
    await h.presence.setState("draining");
    expect(h.events.revoked).toBe(1);
    h.failNext("heartbeat", revoked);
    await h.tick();
    expect(h.events.revoked).toBe(1);
  });

  it("two calls refused as revoked at once still report it once", async () => {
    const h = harness();
    await h.presence.start();
    h.failNext("heartbeat", revoked);
    h.failNext("reportState", revoked);
    await Promise.all([h.tick(), h.presence.setState("draining")]);
    expect(h.events.revoked).toBe(1);
  });

  it("reports states at once while connected, and survives a failed report", async () => {
    const h = harness();
    await h.presence.setState("degraded", "disk-low");
    expect(h.calls).toEqual([]);
    await h.presence.start();
    expect(h.calls).toContain("state degraded(disk-low)");
    h.failNext("reportState", new Error("blip"));
    await h.presence.setState("online");
    expect(h.presence.connected).toBe(false);
  });

  it("sends capabilities again only when they changed", async () => {
    const h = harness();
    await h.presence.refreshCapabilities();
    expect(h.calls).toEqual([]);
    await h.presence.start();
    await h.presence.refreshCapabilities();
    expect(h.calls.filter((call) => call.startsWith("capabilities"))).toHaveLength(1);
    h.setVersion("0.3.1");
    await h.presence.refreshCapabilities();
    expect(h.calls.at(-1)).toBe("capabilities 0.3.1");
    h.setVersion("0.3.2");
    h.failNext("reportCapabilities", new Error("blip"));
    await h.presence.refreshCapabilities();
    expect(h.presence.connected).toBe(false);
  });

  it("a clean stop says stopped, waits for a beat in flight, and is quiet when offline", async () => {
    const h = harness();
    await h.presence.start();
    await h.presence.stop();
    expect(h.calls.at(-1)).toBe("state stopped");
    expect(h.ticking()).toBe(false);
    expect(h.presence.connected).toBe(false);
    await h.presence.stop();
    expect(h.calls.filter((call) => call === "state stopped")).toHaveLength(1);

    const failing = harness();
    await failing.presence.start();
    failing.failNext("reportState", new Error("blip"));
    await failing.presence.stop();
    expect(failing.events.errors).toHaveLength(1);
  });

  it("a stop never hangs on a backend that does not answer", async () => {
    vi.useFakeTimers();
    try {
      let beats = 0;
      const presence = createRunnerPresence({
        backend: {
          heartbeat: async () => {
            beats += 1;
            if (beats > 1) return never();
            return REPLY;
          },
          reportState: async (args) => (args.state === "stopped" ? never() : undefined),
          reportCapabilities: async () => {},
        },
        bootId: "b",
        readLoad: () => LOAD,
        readCapabilities: () => report(),
        intervalMs: 1_000,
        stopTimeoutMs: 100,
      });
      await presence.start();
      await vi.advanceTimersByTimeAsync(1_000);
      const stopping = presence.stop();
      await vi.advanceTimersByTimeAsync(250);
      await stopping;
      expect(presence.connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stop waits for a beat in flight that does answer", async () => {
    let release!: () => void;
    let calls = 0;
    const states: string[] = [];
    const presence = createRunnerPresence({
      backend: {
        heartbeat: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(REPLY)
            : new Promise((done) => (release = () => done(REPLY)));
        },
        reportState: async (args) => void states.push(args.state),
        reportCapabilities: async () => {},
      },
      bootId: "b",
      readLoad: () => LOAD,
      readCapabilities: () => report(),
      timers: { setInterval: () => 1, clearInterval: () => {} },
    });
    await presence.start();
    void presence.start();
    await new Promise((done) => setImmediate(done));
    const stopping = presence.stop();
    release();
    await stopping;
    expect(states).toEqual(["online", "stopped"]);
  });

  it("never stacks beats on a slow backend", async () => {
    let release!: () => void;
    const heartbeat = vi.fn(
      () => new Promise<RunnerHeartbeatReply>((done) => (release = () => done(REPLY))),
    );
    const presence = createRunnerPresence({
      backend: { heartbeat, reportState: async () => {}, reportCapabilities: async () => {} },
      bootId: "b",
      readLoad: async () => LOAD,
      readCapabilities: async () => report(),
      timers: { setInterval: () => 1, clearInterval: () => {} },
    });
    const first = presence.start();
    const second = presence.start();
    await new Promise((done) => setImmediate(done));
    release();
    await Promise.all([first, second]);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("runs on real, unref'd timers by default", async () => {
    vi.useFakeTimers();
    try {
      const heartbeat = vi.fn(async () => REPLY);
      const presence = createRunnerPresence({
        backend: { heartbeat, reportState: async () => {}, reportCapabilities: async () => {} },
        bootId: "b",
        readLoad: () => LOAD,
        readCapabilities: () => report(),
        intervalMs: 1_000,
      });
      await presence.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      await presence.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the backend's revoked refusal", () => {
  it("is read from a ConvexError's data or a plain code", () => {
    expect(isRevokedError(revoked)).toBe(true);
    expect(isRevokedError({ code: "revoked" })).toBe(true);
    expect(isRevokedError({ data: { code: "unauthenticated" } })).toBe(false);
    expect(isRevokedError(new Error("x"))).toBe(false);
    expect(isRevokedError(null)).toBe(false);
    expect(isRevokedError("revoked")).toBe(false);
  });

  it("beatNow waits out a beat in flight, then beats once more", async () => {
    const h = harness();
    await h.presence.start();
    await h.presence.beatNow();
    expect(h.calls.slice(3)).toEqual(["heartbeat boot"]);
    h.failNext("heartbeat", new Error("socket slept"));
    const stale = h.tick();
    const now = h.presence.beatNow();
    await stale;
    await now;
    // The stale beat failed; the next one re-publishes and beats.
    expect(h.calls.slice(4)).toEqual([
      "heartbeat boot",
      "capabilities 0.3.0",
      "state online",
      "heartbeat boot",
    ]);
    expect(h.presence.connected).toBe(true);
  });

  it("the backend port calls the runner mutations by name", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => REPLY);
    const backend = runnerPresenceBackend(call);
    await expect(backend.heartbeat({ bootId: "b", load: LOAD })).resolves.toBe(REPLY);
    await backend.reportState({ state: "online", reason: null });
    await backend.reportCapabilities({ report: report() });
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "runners:heartbeat",
      "runners:reportState",
      "runners:reportCapabilities",
    ]);
  });
});
