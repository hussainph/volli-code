/**
 * `volli-runner run` through the shell: the real data-dir checks, instance
 * lock, sealed secrets, link file, status file and `runService`, over
 * host-core's real headless composition. The token exchange is the real
 * `/runner/*` client over a scripted fetch; the Convex WebSocket is an
 * in-memory connection playing the deployment; signals come from a stand-in
 * process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type {
  ConvexClientLike,
  ConvexClientModule,
  RunnerFetch,
} from "@volli/host-core/cloud-runner";
import { resetRetentionWatcherForTest } from "@volli/host-core/testing";
import type { RunnerId } from "@volli/shared/cloud";

import type { CommandInput, RunnerDaemonPorts } from "../commands";
import { fileRunnerLinkStore, LINK_FILE_NAME } from "../link/file-store";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import type { RunnerStatus } from "../shell/runner-status";
import { runnerRuntimePaths } from "../shell/runtime-paths";
import type { ServiceProcess } from "../shell/service";
import { readStatus } from "../shell/status";
import { testContext, type Route } from "../testing/context";
import { runRun } from "./run";

const RUNNER_ID = "11111111-1111-4111-8111-111111111111" as RunnerId;
const OWNER = "99999999-8888-4777-8666-555555555555";
const DEPLOYMENT = {
  url: "https://box-deployment.convex.cloud",
  siteUrl: "https://box-deployment.convex.site",
};

let root: string;
let configDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-run-"));
  configDir = join(root, "config");
  dataDir = join(root, "data");
});

afterEach(() => {
  resetRetentionWatcherForTest();
  rmSync(root, { recursive: true, force: true });
});

function input(): CommandInput {
  return { values: { "config-dir": configDir, "data-dir": dataDir }, positionals: [] };
}

/** A process the test signals: `emit` reaches what `runService` listens on. */
function standInProcess() {
  const listeners = new Map<string, ((value: unknown) => void)[]>();
  const exits: number[] = [];
  const process: ServiceProcess = {
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (value: unknown) => void]);
      return undefined;
    },
    exit: (code) => void exits.push(code),
  };
  return {
    process,
    exits,
    emit: (event: string, value?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
  };
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A runner token as the backend signs one: `run` reads only its `own` claim. */
function runnerToken(): string {
  return `${part({ alg: "ES256" })}.${part({ sub: RUNNER_ID, own: OWNER })}.signature`;
}

const exchanged: Route = (body) => ({
  body: {
    token: runnerToken(),
    expiresAt: Date.now() + 3_600_000,
    serverTime: Date.now(),
    credential: `${(body as { credential: string }).credential}+`,
    generation: 2,
  },
});

/**
 * The deployment a runner serves against: `/runner/token` over a scripted
 * fetch, and the Convex functions it calls, in memory behind the client the
 * lifecycle constructs.
 */
function deployment() {
  const states: string[] = [];
  const urls: string[] = [];
  const requests: { url: string; body: unknown }[] = [];
  const fetch: RunnerFetch = async (url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    requests.push({ url, body });
    const answer = await exchanged(body);
    return new Response(JSON.stringify(answer.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  class FakeConvexClient implements ConvexClientLike {
    constructor(url: string) {
      urls.push(url);
    }
    setAuth() {}
    async mutation(reference: never, args: never) {
      const name = reference as string;
      switch (name) {
        case "runners:heartbeat":
          return {
            serverTime: Date.now(),
            status: "online",
            targetVersion: "9.9.10",
            minVersion: null,
            autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
          };
        case "runners:reportState":
          states.push((args as { state: string }).state);
          return null;
        case "runnerJobs:claim":
          return [];
        default:
          return null;
      }
    }
    async query(reference: never) {
      throw new Error(`Unexpected query: ${reference as string}`);
    }
    onUpdate() {
      return () => {};
    }
    connectionState() {
      return { isWebSocketConnected: true };
    }
    subscribeToConnectionState() {
      return () => {};
    }
    async close() {}
  }
  const convex: ConvexClientModule = {
    ConvexClient: FakeConvexClient,
    makeFunctionReference: (name) => name,
  };
  return { states, urls, requests, fetch, convex: async () => convex };
}

function daemon(overrides: Partial<RunnerDaemonPorts> & { process: ServiceProcess }) {
  return {
    // The workspace's own runner bundle locates the dev `volli` and Code Mode's assets.
    runtimePaths: () => runnerRuntimePaths(resolve(import.meta.dirname, "../../dist")),
    ...overrides,
  };
}

async function linked(): Promise<void> {
  await fileRunnerLinkStore({ configDir, deployment: DEPLOYMENT }).save({
    runnerId: RUNNER_ID,
    name: "hetzner-1",
    credential: "vrc_first",
    generation: 1,
  });
}

function status(): RunnerStatus | null {
  const read = readStatus<RunnerStatus>(RUNNER, dataDir);
  return read === "unreadable" ? null : read;
}

async function until<T>(read: () => T | null | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

// Real boots on a shared machine: each case gets room beyond the default 5 s.
describe("volli-runner run", { timeout: 30_000 }, () => {
  it("unlinked: serves only its status, then stops cleanly on SIGTERM", async () => {
    const shell = standInProcess();
    const lines: string[] = [];
    const context = testContext({
      root,
      daemon: daemon({ process: shell.process, writeLog: (line) => void lines.push(line) }),
    });
    const exit = runRun(input(), context);
    const unlinked = await until(() => status()?.state === "unlinked" && status(), "unlinked");
    expect(unlinked).toMatchObject({
      v: 1,
      pid: process.pid,
      version: "9.9.9-test",
      dataDir,
      socketPath: join(dataDir, "volli.sock"),
      link: null,
      backend: null,
      update: null,
      credentials: { state: "empty" },
    });
    shell.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(status()?.state).toBe("stopped");
    // A second signal is the shell's "exit now".
    shell.emit("SIGTERM");
    expect(shell.exits).toEqual([1]);
    // The process log went to the sink, as JSON lines.
    expect(lines.some((line) => JSON.parse(line).msg?.includes("not linked"))).toBe(true);
    // The lock was given up: another runner may take the data directory now.
    acquireInstanceLock(RUNNER, dataDir).release();
  });

  it("linked: connects to the deployment its link names, reports online, and drains on SIGTERM", async () => {
    await linked();
    const shell = standInProcess();
    const backend = deployment();
    const context = testContext({
      root,
      env: { VOLLI_RUNNER_SERVICE: "1" },
      daemon: daemon({ process: shell.process, convex: backend.convex, fetch: backend.fetch }),
    });
    const exit = runRun(input(), context);
    const online = await until(
      () => status()?.state === "online" && status()?.update !== null && status(),
      "online",
    );
    expect(online).toMatchObject({
      link: { runnerId: RUNNER_ID, name: "hetzner-1", server: DEPLOYMENT.url },
      backend: { state: "online", detail: null, lastHeartbeatAt: expect.any(String) },
      update: { targetVersion: "9.9.10", minVersion: null, phase: "idle", detail: null },
    });
    expect(backend.urls).toEqual([DEPLOYMENT.url]);
    expect(backend.requests.map((request) => request.url)).toEqual([
      `${DEPLOYMENT.siteUrl}/runner/token`,
    ]);
    shell.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(backend.states).toEqual(expect.arrayContaining(["draining", "stopped"]));
    expect(status()?.state).toBe("stopped");
  });

  it("refuses (78) while another runner holds the data directory", async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const held = acquireInstanceLock(RUNNER, dataDir);
    try {
      const shell = standInProcess();
      expect(
        await runRun(input(), testContext({ root, daemon: daemon({ process: shell.process }) })),
      ).toBe(78);
    } finally {
      held.release();
    }
  });

  it("refuses (78) a link file it cannot read, and releases the lock", async () => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDir, LINK_FILE_NAME), "not a sealed link", { mode: 0o600 });
    const shell = standInProcess();
    expect(
      await runRun(input(), testContext({ root, daemon: daemon({ process: shell.process }) })),
    ).toBe(78);
    acquireInstanceLock(RUNNER, dataDir).release();
  });

  it("refuses (78) a database that will not open", async () => {
    await linked();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "volli.db"), "this is not a database, it is a sentence");
    const shell = standInProcess();
    expect(
      await runRun(input(), testContext({ root, daemon: daemon({ process: shell.process }) })),
    ).toBe(78);
  });

  it("refuses (78) a secret key path it cannot use, and releases the lock", async () => {
    const shell = standInProcess();
    const context = testContext({
      root,
      env: { VOLLI_SECRET_KEY_FILE: "relative/key" },
      daemon: daemon({ process: shell.process }),
    });
    expect(await runRun(input(), context)).toBe(78);
    acquireInstanceLock(RUNNER, dataDir).release();
  });

  it("fails (1) a boot that cannot find its bundle", async () => {
    const shell = standInProcess();
    // The test context's default daemon has no bundle.
    const context = testContext({ root, daemon: { process: shell.process } });
    expect(await runRun(input(), context)).toBe(1);
    acquireInstanceLock(RUNNER, dataDir).release();
  });

  it.each([
    ["an error", new Error("the backend client did not load")],
    ["a non-error", "the backend client did not load"],
  ])("stops and fails (1) when connecting fails after boot with %s", async (_, failure) => {
    await linked();
    const shell = standInProcess();
    const context = testContext({
      root,
      daemon: daemon({ process: shell.process, convex: () => Promise.reject(failure) }),
    });
    expect(await runRun(input(), context)).toBe(1);
    expect(status()?.state).toBe("stopped");
  });
});
