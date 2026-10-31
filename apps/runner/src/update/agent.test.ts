import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { RunnerUpdateReport } from "@volli/shared/cloud";

import type { RunnerStatus } from "../shell/runner-status";
import {
  ACTIVATION_STALE_MS,
  createUpdateAgent,
  NOW_REQUEST_TTL_MS,
  REQUEST_STALE_MS,
  TICK_MS,
  type UpdateAgentPorts,
} from "./agent";
import { applyUpdate, currentRelease, pointCurrentAt, type ApplyPorts } from "./apply";
import { manifestUrlFor, type UpdateConfig } from "./config";
import {
  readReported,
  readUpdateRequest,
  readUpdaterState,
  writeNowRequest,
  writeUpdaterState,
  EMPTY_STATE,
  type UpdateOutcome,
  type UpdateRequest,
} from "./files";
import { updateLayout, type UpdateLayout } from "./layout";
import { MANIFEST_ASSET, tarballName } from "./manifest";
import {
  IDLE_WINDOW_MS,
  RETRY_AFTER_MS,
  TARGET_DRAIN_MS,
  URGENT_DRAIN_MS,
  type UpdateTarget,
} from "./policy";

const ORIGIN = "https://releases.test/";
const CONFIG: UpdateConfig = { releaseOrigin: ORIGIN, provenance: "sha-only" };

let root: string;
let layout: UpdateLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-agent-"));
  layout = updateLayout("user", join(root, "share"), join(root, "state"));
  mkdirSync(layout.installRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const target = (
  version: string | null = "0.4.0",
  patch: Partial<UpdateTarget["autoUpdate"]> & { minVersion?: string | null } = {},
): UpdateTarget => ({
  targetVersion: version,
  minVersion: patch.minVersion === undefined ? "0.3.0" : patch.minVersion,
  autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null, ...patch },
});

interface Harness {
  clock: number;
  inFlight: number;
  calls: string[];
  reported: RunnerUpdateReport[];
  reportError: Error | null;
  drainError: Error | null;
  logs: string[];
  statuses: string[];
  timers: (() => void)[];
  ports: UpdateAgentPorts;
}

function harness(): Harness {
  const h: Harness = {
    clock: Date.parse("2026-11-01T00:00:00Z"),
    inFlight: 0,
    calls: [],
    reported: [],
    reportError: null,
    drainError: null,
    logs: [],
    statuses: [],
    timers: [],
    ports: undefined as unknown as UpdateAgentPorts,
  };
  h.ports = {
    drain: async () => {
      if (h.drainError !== null) throw h.drainError;
      h.calls.push("drain");
    },
    resume: async () => {
      h.calls.push("resume");
    },
    inFlight: () => h.inFlight,
    report: async (outcome) => {
      if (h.reportError !== null) throw h.reportError;
      h.reported.push(outcome);
    },
    now: () => h.clock,
    log: (message) => h.logs.push(message),
    setInterval: (callback) => {
      h.timers.push(callback);
      return () => {
        h.timers = h.timers.filter((entry) => entry !== callback);
      };
    },
  };
  return h;
}

function agent(h: Harness, options: { running?: string; supervised?: boolean } = {}) {
  return createUpdateAgent({
    layout,
    config: CONFIG,
    running: options.running ?? "0.3.5",
    supervised: options.supervised ?? true,
    ports: h.ports,
    onStatus: (status) =>
      h.statuses.push(`${status.phase}${status.detail === null ? "" : `: ${status.detail}`}`),
  });
}

const request = (): UpdateRequest | null => readUpdateRequest(layout.requestFile);

const stagedRef = (version: string | null) =>
  version === null ? null : { version, name: version };

/** What the applier would have left after answering the current request. */
function answer(patch: { staged?: string | null; failed?: string; bad?: string[] } = {}): void {
  const current = readUpdaterState(layout.stateFile);
  const handled = request()!.id;
  const outcomes: UpdateOutcome[] =
    patch.failed === undefined
      ? []
      : [
          {
            id: `failed-${handled}`,
            kind: "update_failed",
            version: request()!.version,
            fromVersion: "0.3.5",
            reason: patch.failed,
            at: new Date(Date.parse("2026-11-01T00:00:00Z")).toISOString(),
          },
        ];
  writeUpdaterState(layout.stateFile, {
    ...current,
    staged: patch.staged === undefined ? current.staged : stagedRef(patch.staged),
    bad: patch.bad ?? current.bad,
    handled: [...current.handled, handled],
    outcomes: [...current.outcomes, ...outcomes],
  });
}

const staged = (id: string): UpdateOutcome => ({
  id,
  kind: "update_staged",
  version: "0.4.0",
  fromVersion: "0.3.5",
  reason: null,
  at: "2026-11-01T00:00:00.000Z",
});

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("deciding", () => {
  it("does nothing for a runner nothing supervises", async () => {
    const h = harness();
    await agent(h, { supervised: false }).onTarget(target());
    expect(request()).toBeNull();
    expect(h.statuses).toEqual(["idle: unsupervised"]);
  });

  it("asks the applier to stage the target, from the install's release origin", async () => {
    const h = harness();
    const a = agent(h);
    await a.onTarget(target());
    expect(request()).toMatchObject({
      phase: "stage",
      version: "0.4.0",
      manifestUrl: manifestUrlFor(ORIGIN, "0.4.0"),
      urgent: false,
    });
    expect(a.status()).toEqual({
      targetVersion: "0.4.0",
      minVersion: "0.3.0",
      phase: "staging",
      detail: "target: 0.4.0",
    });
    const first = request()!.id;
    await a.tick();
    expect(request()!.id).toBe(first);
    h.clock += REQUEST_STALE_MS;
    await a.tick();
    expect(request()!.id).not.toBe(first);
  });

  it("follows a new target mid-stage, and lets go when there is none", async () => {
    const h = harness();
    const a = agent(h);
    await a.onTarget(target());
    await a.onTarget(target("0.4.1"));
    expect(request()).toMatchObject({ version: "0.4.1" });
    await a.onTarget(target("0.3.5"));
    expect(a.status()).toMatchObject({ phase: "idle", detail: "up to date" });
  });
});

describe("draining and activating", () => {
  async function stagedAgent(h: Harness, t = target()) {
    const a = agent(h);
    await a.onTarget(t);
    answer({ staged: t.targetVersion });
    await a.tick();
    return a;
  }

  it("drains once staged and activates after an idle minute", async () => {
    const h = harness();
    h.inFlight = 1;
    const a = await stagedAgent(h);
    expect(h.calls).toEqual(["drain"]);
    expect(a.status().phase).toBe("staged");
    h.clock += IDLE_WINDOW_MS * 5;
    await a.tick();
    expect(request()!.phase).toBe("stage");
    h.inFlight = 0;
    await a.tick();
    h.clock += IDLE_WINDOW_MS - 1;
    await a.tick();
    expect(request()!.phase).toBe("stage");
    h.clock += 1;
    await a.tick();
    expect(request()).toMatchObject({ phase: "activate", version: "0.4.0", urgent: false });
    expect(a.status().phase).toBe("activating");
    expect(h.calls).toEqual(["drain"]);
  });

  it("gives a target update up after six busy hours, and tries again later", async () => {
    const h = harness();
    h.inFlight = 1;
    const a = await stagedAgent(h);
    h.clock += TARGET_DRAIN_MS;
    await a.tick();
    expect(h.calls).toEqual(["drain", "resume"]);
    expect(a.status()).toMatchObject({ phase: "failed" });
    h.clock += RETRY_AFTER_MS - 1;
    await a.tick();
    expect(h.calls).toEqual(["drain", "resume"]);
    h.clock += 1;
    await a.tick();
    expect(h.calls).toEqual(["drain", "resume", "drain"]);
  });

  it("activates an urgent update as soon as nothing runs, or after 30 minutes regardless", async () => {
    const h = harness();
    const a = await stagedAgent(h, target("0.4.0", { minVersion: "0.4.0" }));
    expect(request()).toMatchObject({ phase: "activate", urgent: true });
    expect(a.status().phase).toBe("activating");

    rmSync(layout.stateFile);
    const busy = harness();
    busy.inFlight = 2;
    const b = await stagedAgent(busy, target("0.4.0", { minVersion: "0.4.0" }));
    expect(request()!.phase).toBe("stage");
    busy.clock += URGENT_DRAIN_MS;
    await b.tick();
    expect(request()).toMatchObject({ phase: "activate", urgent: true });
  });

  it("resumes when the applier refuses to activate, or never answers", async () => {
    const h = harness();
    const a = await stagedAgent(h, target("0.4.0", { pinnedVersion: "0.4.0" }));
    expect(request()!.phase).toBe("activate");
    await a.tick();
    expect(h.calls).toEqual(["drain"]);
    answer({ failed: "not_draining" });
    await a.tick();
    expect(h.calls).toEqual(["drain", "resume"]);
    expect(a.status()).toMatchObject({
      phase: "failed",
      detail: "activating 0.4.0 failed: not_draining",
    });

    const quiet = harness();
    rmSync(layout.stateFile);
    const b = await stagedAgent(quiet, target("0.4.0", { pinnedVersion: "0.4.0" }));
    quiet.clock += REQUEST_STALE_MS;
    await b.tick();
    expect(b.status()).toMatchObject({
      phase: "failed",
      detail: "activating 0.4.0 failed: no answer",
    });
  });

  it("resumes claiming when the update it drained for is no longer wanted", async () => {
    const h = harness();
    h.inFlight = 1;
    const a = await stagedAgent(h);
    await a.onTarget(target("0.4.0", { enabled: false }));
    expect(h.calls).toEqual(["drain", "resume"]);
    expect(a.status()).toMatchObject({ phase: "idle", detail: "auto-update is off" });
    await a.onTarget(target("0.4.0", { enabled: false }));
    expect(h.calls).toEqual(["drain", "resume"]);
  });

  it("starts over when the target moves while draining", async () => {
    const h = harness();
    h.inFlight = 1;
    const a = await stagedAgent(h);
    await a.onTarget(target("0.4.1"));
    expect(h.calls).toEqual(["drain", "resume"]);
    expect(request()).toMatchObject({ phase: "stage", version: "0.4.1" });
  });
});

describe("failures", () => {
  it("waits an hour after a failed stage, in this process and the next", async () => {
    const h = harness();
    const a = agent(h);
    await a.onTarget(target());
    answer({ failed: "checksum" });
    await a.tick();
    expect(a.status()).toMatchObject({ phase: "failed", detail: "staging 0.4.0 failed: checksum" });
    const id = request()!.id;
    await a.tick();
    expect(request()!.id).toBe(id);

    const next = harness();
    const b = agent(next);
    await b.onTarget(target());
    expect(b.status()).toMatchObject({
      phase: "failed",
      detail: "0.4.0 failed here recently; trying again later",
    });
    expect(request()!.id).toBe(id);
    next.clock += RETRY_AFTER_MS;
    await b.tick();
    expect(request()!.id).not.toBe(id);
  });

  it("names an unknown failure", async () => {
    const h = harness();
    const a = agent(h);
    await a.onTarget(target());
    answer();
    await a.tick();
    expect(a.status()).toMatchObject({ detail: "staging 0.4.0 failed: unknown" });
  });

  it("says when the updater state is unreadable", async () => {
    const h = harness();
    writeFileSync(layout.stateFile, "{");
    await agent(h).onTarget(target());
    expect(h.statuses).toEqual(["failed: updater state unreadable"]);
  });

  it("logs a pass that throws and keeps going", async () => {
    const h = harness();
    h.drainError = new Error("socket closed");
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      staged: { version: "0.4.0", name: "0.4.0" },
    });
    const a = agent(h);
    await a.onTarget(target());
    expect(h.logs).toContain("update pass failed");
  });
});

describe("an activation in flight", () => {
  it("waits for the applier to settle it, without draining or resuming", async () => {
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      activating: {
        version: "0.4.0",
        name: "0.4.0",
        fromTarget: "x",
        fromVersion: "0.3.5",
        at: "2026-11-01T00:00:00.000Z",
      },
    });
    const h = harness();
    const a = agent(h);
    await a.onTarget(target());
    expect(a.status()).toMatchObject({ phase: "activating", detail: "0.4.0" });
    expect(request()).toBeNull();
    expect(h.calls).toEqual([]);
  });
});

describe("an activation the applier left open", () => {
  it("wakes the applier to settle it, once per stale period", async () => {
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      activating: {
        version: "0.4.0",
        name: "0.4.0",
        fromTarget: "x",
        fromVersion: "0.3.5",
        at: "2026-11-01T00:00:00.000Z",
      },
    });
    const h = harness();
    const a = agent(h);
    h.clock += ACTIVATION_STALE_MS - 1;
    await a.tick();
    expect(request()).toBeNull();
    h.clock += 1;
    await a.tick();
    const first = request();
    expect(first).toMatchObject({ phase: "settle", version: "0.4.0", urgent: true });
    await a.tick();
    expect(request()!.id).toBe(first!.id);
    h.clock += ACTIVATION_STALE_MS;
    await a.tick();
    expect(request()!.id).not.toBe(first!.id);
    expect(h.calls).toEqual([]);
  });

  it("treats an unreadable start time as long ago", async () => {
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      activating: {
        version: "0.4.0",
        name: "0.4.0",
        fromTarget: "x",
        fromVersion: "0.3.5",
        at: "?",
      },
    });
    await agent(harness()).tick();
    expect(request()).toMatchObject({ phase: "settle" });
  });
});

describe("reporting", () => {
  it("reports each outcome once, and retries one Volli did not take", async () => {
    writeUpdaterState(layout.stateFile, { ...EMPTY_STATE, outcomes: [staged("a"), staged("b")] });
    const h = harness();
    h.reportError = new Error("offline");
    const a = agent(h);
    await a.tick();
    expect(h.reported).toEqual([]);
    expect(h.logs).toContain("update outcome not reported yet");
    h.reportError = null;
    await a.tick();
    await a.tick();
    expect(h.reported).toEqual([
      {
        outcomeId: "a",
        kind: "update_staged",
        version: "0.4.0",
        fromVersion: "0.3.5",
        reason: null,
        at: Date.parse("2026-11-01T00:00:00.000Z"),
      },
      expect.objectContaining({ outcomeId: "b" }),
    ]);
    expect([...readReported(layout.reportedFile)]).toEqual(["a", "b"]);
  });
});

describe("update --now", () => {
  it("makes the target urgent, and expires after a day", async () => {
    const h = harness();
    writeNowRequest(layout.nowFile, null, new Date(h.clock));
    const a = agent(h);
    await a.onTarget(target("0.4.0", { enabled: false }));
    expect(request()).toMatchObject({ version: "0.4.0", urgent: true });
    expect(a.status().detail).toBe("now: 0.4.0");

    rmSync(layout.requestFile);
    writeNowRequest(layout.nowFile, "0.5.0", new Date(h.clock - NOW_REQUEST_TTL_MS));
    const b = agent(harness());
    await b.onTarget(target("0.4.0", { enabled: false }));
    expect(request()).toBeNull();
  });

  it("ignores a damaged one", async () => {
    writeFileSync(layout.nowFile, "{");
    const h = harness();
    await agent(h).onTarget(target("0.4.0", { enabled: false }));
    expect(h.logs).toContain("ignoring the update-now request");
    writeFileSync(layout.nowFile, JSON.stringify({ v: 1, version: null, at: "not a date" }));
    await agent(h).onTarget(target("0.4.0", { enabled: false }));
    expect(request()).toBeNull();
  });
});

describe("the agent's schedule", () => {
  it("ticks on a timer, once, until stopped", async () => {
    const h = harness();
    const a = agent(h);
    a.start();
    a.start();
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    await a.tick();
    a.stop();
    a.stop();
    expect(h.timers).toHaveLength(0);
    expect(TICK_MS).toBeGreaterThan(0);
  });

  it("never overlaps passes, and runs one more when asked meanwhile", async () => {
    const h = harness();
    let reads = 0;
    const report = h.ports.report;
    h.ports = {
      ...h.ports,
      report: async (outcome) => {
        reads += 1;
        await report(outcome);
      },
    };
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      outcomes: [
        {
          id: "x",
          kind: "update_applied",
          version: "0.3.5",
          fromVersion: null,
          reason: null,
          at: "",
        },
      ],
    });
    const a = agent(h);
    await Promise.all([a.tick(), a.tick(), a.tick()]);
    expect(reads).toBe(1);
    expect(h.statuses).toEqual(["idle: no target yet"]);
  });
});

/** A release directory as the packager makes it. */
function release(dir: string, version: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), "");
  writeFileSync(join(dir, "bin", "volli-runner"), "");
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ version }));
}

/**
 * The whole loop: the daemon's agent writes requests, "systemd" runs the
 * applier on each, and "a restart" is a new agent on the new `current`.
 */
describe("updating end to end", () => {
  function publish(documents: Map<string, string>, version: string): void {
    const base = `${ORIGIN}v${version}/`;
    const tarball = `tarball-${version}`;
    documents.set(`${base}${tarballName(version, "x64")}`, tarball);
    documents.set(
      `${base}${MANIFEST_ASSET}`,
      JSON.stringify({
        schemaVersion: 1,
        version,
        releaseTag: `v${version}`,
        minRunnerVersion: "0.3.0",
        minGlibc: "2.31",
        targets: [
          {
            platform: "linux",
            arch: "x64",
            url: `${base}${tarballName(version, "x64")}`,
            size: tarball.length,
            sha256: sha(tarball),
          },
        ],
        provenance: { bundleUrl: `${base}bundle.json` },
      }),
    );
  }

  it("goes v → v+1, then rolls a broken v+2 back to v+1 and reports it", async () => {
    const documents = new Map<string, string>();
    publish(documents, "0.4.0");
    publish(documents, "0.5.0");
    const broken = new Set(["0.5.0"]);
    release(join(layout.releasesDir, "0.3.5"), "0.3.5");
    pointCurrentAt(layout, join("releases", "0.3.5"));
    const version = () => currentRelease(layout)!.version;
    let daemon: { version: string; pid: number; state: RunnerStatus["state"] } = {
      version: "0.3.5",
      pid: 1,
      state: "online",
    };
    let clock = Date.parse("2026-11-01T00:00:00Z");
    const ports: ApplyPorts = {
      arch: "x64",
      fetchText: async (url) => documents.get(url)!,
      download: async (url, path) => {
        const body = documents.get(url)!;
        writeFileSync(path, body);
        return { sha256: sha(body), size: body.length };
      },
      provenance: null,
      extract: async (tarball, into) => {
        const named = basename(tarball).replace(/^volli-runner-|-linux-x64\.tar\.gz$/gu, "");
        release(join(into, `volli-runner-${named}-linux-x64`), named);
      },
      probe: async () => {},
      restart: async () => {
        daemon = {
          version: version(),
          pid: daemon.pid + 1,
          state: broken.has(version()) ? "starting" : "online",
        };
      },
      service: async () => ({ mainPid: daemon.pid, restarts: 0 }),
      readStatus: () => ({
        v: 1,
        state: daemon.state,
        pid: daemon.pid,
        version: daemon.version,
        startedAt: "",
        updatedAt: "",
        dataDir: "",
        socketPath: "",
        link: null,
        backend: null,
        update: null,
        credentials: null,
      }),
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      log: () => {},
    };
    const systemd = () => applyUpdate(ports, { layout, origins: [ORIGIN] });
    const reported: RunnerUpdateReport[] = [];
    const boot = () => {
      const h = harness();
      h.ports = {
        ...h.ports,
        drain: async () => {
          daemon = { ...daemon, state: "draining" };
        },
        report: async (outcome) => {
          reported.push(outcome);
        },
        now: () => clock,
      };
      return createUpdateAgent({
        layout,
        config: CONFIG,
        running: version(),
        supervised: true,
        ports: h.ports,
      });
    };

    let a = boot();
    await a.onTarget(target("0.4.0"));
    await systemd(); // staged
    await a.tick(); // drains
    clock += IDLE_WINDOW_MS;
    await a.tick(); // asks to activate
    expect(await systemd()).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.5" });

    a = boot();
    await a.onTarget(target("0.5.0", { minVersion: "0.5.0" }));
    await systemd();
    await a.tick(); // urgent and idle: activates at once
    expect(await systemd()).toMatchObject({ kind: "rolled_back", version: "0.5.0", to: "0.4.0" });
    expect(version()).toBe("0.4.0");

    a = boot();
    await a.onTarget(target("0.5.0", { minVersion: "0.5.0" }));
    expect(a.status().detail).toBe("release 0.5.0 failed here before");
    expect(reported.map((outcome) => [outcome.kind, outcome.version])).toEqual([
      ["update_staged", "0.4.0"],
      ["update_applied", "0.4.0"],
      ["update_staged", "0.5.0"],
      ["update_failed", "0.5.0"],
      ["rolled_back", "0.4.0"],
    ]);
  });
});
