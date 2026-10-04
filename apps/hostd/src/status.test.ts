import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  checkStatus,
  LIVE_PROBES,
  processAlive,
  readStatus,
  socketAccepts,
  statusExitCode,
  statusFilePath,
  writeStatus,
  type HostdStatus,
  type StatusProbes,
} from "./status";

/** When set, `createConnection` hands back a socket that never connects. */
const faults = vi.hoisted(() => ({ hang: false }));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: (...args: Parameters<typeof actual.createConnection>) => {
      if (!faults.hang) return actual.createConnection(...args);
      const hung = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        // The timeout fires first; an error arriving after it must not answer twice.
        setTimeout: (_ms: number, onTimeout: () => void) =>
          setImmediate(() => {
            onTimeout();
            hung.emit("error", new Error("late"));
          }),
      });
      return hung;
    },
  };
});

let dataDir: string;
const servers: Server[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-status-"));
});

afterEach(async () => {
  faults.hang = false;
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  rmSync(dataDir, { recursive: true, force: true });
});

function status(overrides: Partial<HostdStatus> = {}): HostdStatus {
  return {
    v: 1,
    state: "serving",
    pid: 4242,
    version: "0.2.1",
    startedAt: "2026-10-04T12:00:00.000Z",
    updatedAt: "2026-10-04T12:00:01.000Z",
    dataDir,
    socketPath: join(dataDir, "volli.sock"),
    database: { ok: true, path: join(dataDir, "volli.db") },
    capabilities: {
      board: "available",
      sessions: "unavailable",
      terminals: "unavailable",
      browser: "unavailable",
      automations: "unavailable",
    },
    ...overrides,
  };
}

function listen(path: string): Promise<void> {
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  return new Promise((resolve) => server.listen(path, resolve));
}

describe("the status file", () => {
  it("round-trips, mode 0600, with no temporary file left behind", () => {
    writeStatus(dataDir, status());
    expect(readStatus(dataDir)).toEqual(status());
    expect(statSync(statusFilePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDir)).toEqual(["hostd-status.json"]);
  });

  it("leaves no temporary file when it cannot be replaced", () => {
    mkdirSync(join(statusFilePath(dataDir), "occupied"), { recursive: true });
    expect(() => writeStatus(dataDir, status())).toThrow();
    expect(readdirSync(dataDir)).toEqual(["hostd-status.json"]);
  });

  it("reads nothing, or unreadable, rather than throwing", () => {
    expect(readStatus(dataDir)).toBeNull();
    writeFileSync(statusFilePath(dataDir), "{ not json");
    expect(readStatus(dataDir)).toBe("unreadable");
    writeFileSync(statusFilePath(dataDir), JSON.stringify({ v: 2, pid: 1, socketPath: "/s" }));
    expect(readStatus(dataDir)).toBe("unreadable");
    writeFileSync(statusFilePath(dataDir), "null");
    expect(readStatus(dataDir)).toBe("unreadable");
    rmSync(statusFilePath(dataDir));
    mkdirSync(statusFilePath(dataDir));
    expect(readStatus(dataDir)).toBe("unreadable");
  });
});

describe("the live probes", () => {
  it("tells a listening socket from a missing one", async () => {
    const path = join(dataDir, "probe.sock");
    expect(await socketAccepts(path)).toBe(false);
    await listen(path);
    expect(await socketAccepts(path)).toBe(true);
    expect(await LIVE_PROBES.accepts(path)).toBe(true);
  });

  it("gives up on a socket that never answers the connect", async () => {
    faults.hang = true;
    expect(await socketAccepts(join(dataDir, "hung.sock"))).toBe(false);
  });

  it("tells a live process from a gone one", () => {
    expect(processAlive(process.pid)).toBe(true);
    // Far above any pid_max: no such process.
    expect(processAlive(2 ** 30)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("counts a process it may not signal as alive", () => {
    expect(processAlive(1)).toBe(true);
  });
});

const probes = (
  recorded: ReturnType<StatusProbes["read"]>,
  alive = true,
  accepts = true,
): StatusProbes => ({
  read: () => recorded,
  alive: () => alive,
  accepts: () => Promise.resolve(accepts),
});

describe("volli-hostd status", () => {
  it("reports serving and refusing from a live host", async () => {
    expect(await checkStatus(dataDir, probes(status()))).toEqual({
      verdict: "serving",
      status: status(),
    });
    const refusing = status({
      state: "refusing",
      database: {
        ok: false,
        path: join(dataDir, "volli.db"),
        error: "This database was created by a newer version of Volli.",
        failure: {
          kind: "newer-version",
          schemaVersion: 99,
          supportedVersion: 60,
          minReaderVersion: 99,
        },
      },
    });
    expect(await checkStatus(dataDir, probes(refusing))).toEqual({
      verdict: "refusing",
      status: refusing,
    });
  });

  it("reports not serving, and why, for everything else", async () => {
    const detail = async (probed: StatusProbes) => (await checkStatus(dataDir, probed)).detail;
    expect(await detail(probes(null))).toBe("no status file");
    expect(await detail(probes("unreadable"))).toBe("status file unreadable");
    expect(await detail(probes(status({ state: "stopped" })))).toBe("stopped");
    expect(await detail(probes(status(), false))).toBe("process 4242 is gone");
    expect(await detail(probes(status(), true, false))).toBe("socket does not accept connections");
    expect(await detail(probes(status({ state: "starting" })))).toBe("starting");
    expect(await detail(probes(status({ state: "stopping" })))).toBe("stopping");
  });

  it("maps verdicts to exit codes", () => {
    expect(statusExitCode("serving")).toBe(0);
    expect(statusExitCode("refusing")).toBe(1);
    expect(statusExitCode("not-serving")).toBe(3);
  });
});
