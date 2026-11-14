import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureHostLog, type CapturedHostLog } from "@volli/host-core/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createExitWatch,
  EXIT_WATCH_ENV,
  EXIT_WATCH_GRACE_MS,
  EXIT_WATCH_MAX_MS,
  EXIT_WATCH_RECORD_FILE_NAME,
  EXIT_WATCH_SCRIPT,
  EXIT_WATCH_SHELL,
  exitWatchArgv,
  exitWatchProbeArgv,
  nodeExitWatchPorts,
  parseExitWatchRecord,
  parseProbeOutput,
  type ExitWatchPorts,
} from "./exit-watch";

let log: CapturedHostLog | undefined;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  log?.restore();
  log = undefined;
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("exitWatchArgv", () => {
  const args = {
    pid: 4242,
    startedAt: 1_794_651_621,
    exitCallAtMs: 1_794_651_700_123,
    graceMs: 5000,
    maxMs: 120_000,
    pollMs: 50,
  };

  it("passes numbers only, in the script's order", () => {
    expect(exitWatchArgv(args)).toEqual([
      "volli-exit-watch",
      "watch",
      "4242",
      "1794651621",
      "1794651700123",
      "5000",
      "120000",
      "50",
    ]);
  });

  it("allows an unknown start (0): the watch then only measures", () => {
    expect(exitWatchArgv({ ...args, startedAt: 0 })?.[3]).toBe("0");
  });

  it.each([
    ["a zero pid", { pid: 0 }],
    ["a negative pid", { pid: -1 }],
    ["a fractional pid", { pid: 1.5 }],
    ["a negative start", { startedAt: -1 }],
    ["a NaN exit call", { exitCallAtMs: Number.NaN }],
    ["a zero grace", { graceMs: 0 }],
    ["an infinite bound", { maxMs: Number.POSITIVE_INFINITY }],
    ["a zero poll", { pollMs: 0 }],
  ])("refuses %s", (_label, override) => {
    expect(exitWatchArgv({ ...args, ...override })).toBeNull();
  });

  it("builds the probe's argv only for a real pid", () => {
    expect(exitWatchProbeArgv(7)).toEqual(["volli-exit-watch", "probe", "7"]);
    expect(exitWatchProbeArgv(0)).toBeNull();
    expect(exitWatchProbeArgv(2.5)).toBeNull();
  });
});

describe("parseProbeOutput", () => {
  it("reads epoch seconds, and anything else as unknown", () => {
    expect(parseProbeOutput("1794651621\n")).toBe(1_794_651_621);
    expect(parseProbeOutput("")).toBe(0);
    expect(parseProbeOutput("Sat Nov 14")).toBe(0);
    expect(parseProbeOutput("12 34")).toBe(0);
  });
});

describe("parseExitWatchRecord", () => {
  it("reads what the watch writes", () => {
    expect(
      parseExitWatchRecord(
        '{"v":1,"goneMs":5012,"killed":true,"killedAtMs":5001,"outcome":"killed","graceMs":5000}\n',
      ),
    ).toEqual({ goneMs: 5012, killed: true, killedAtMs: 5001, outcome: "killed", graceMs: 5000 });
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "3"],
    ["null", "null"],
    [
      "another version",
      '{"v":2,"goneMs":1,"killed":false,"killedAtMs":0,"outcome":"gone","graceMs":5000}',
    ],
    [
      "a negative duration",
      '{"v":1,"goneMs":-1,"killed":false,"killedAtMs":0,"outcome":"gone","graceMs":5000}',
    ],
    [
      "a text duration",
      '{"v":1,"goneMs":"1","killed":false,"killedAtMs":0,"outcome":"gone","graceMs":5000}',
    ],
    [
      "a text killed",
      '{"v":1,"goneMs":1,"killed":"no","killedAtMs":0,"outcome":"gone","graceMs":5000}',
    ],
    [
      "an unknown outcome",
      '{"v":1,"goneMs":1,"killed":false,"killedAtMs":0,"outcome":"other","graceMs":5000}',
    ],
    ["a missing grace", '{"v":1,"goneMs":1,"killed":false,"killedAtMs":0,"outcome":"gone"}'],
    ["a missing kill time", '{"v":1,"goneMs":1,"killed":false,"outcome":"gone","graceMs":5000}'],
  ])("refuses %s", (_label, text) => {
    expect(parseExitWatchRecord(text)).toBeNull();
  });
});

function fakePorts(overrides: Partial<ExitWatchPorts> = {}): ExitWatchPorts {
  return {
    platform: "darwin",
    pid: 4242,
    now: () => 1_000_000,
    directory: "/profile",
    probe: vi.fn(async () => "1794651621\n"),
    spawn: vi.fn(() => ({ signal: vi.fn() })),
    readRecord: vi.fn(async () => null),
    removeRecord: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("createExitWatch", () => {
  it("probes, then arms with the fixed script, the start it read, and a minimal environment", async () => {
    const ports = fakePorts();
    const watch = createExitWatch(ports);
    await watch.probe();
    expect(ports.probe).toHaveBeenCalledWith(
      EXIT_WATCH_SHELL,
      ["-f", "-c", EXIT_WATCH_SCRIPT, "volli-exit-watch", "probe", "4242"],
      { cwd: "/profile", env: EXIT_WATCH_ENV, timeoutMs: 5000 },
    );
    expect(watch.arm()).not.toBeNull();
    expect(ports.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      [
        "-f",
        "-c",
        EXIT_WATCH_SCRIPT,
        "volli-exit-watch",
        "watch",
        "4242",
        "1794651621",
        "1000000",
        String(EXIT_WATCH_GRACE_MS),
        String(EXIT_WATCH_MAX_MS),
        "50",
      ],
      { cwd: "/profile", env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
    );
  });

  it("arms a measure-only watch (start 0) when the probe failed, and says so", async () => {
    log = captureHostLog("info");
    const ports = fakePorts({ probe: vi.fn(async () => Promise.reject(new Error("no ps"))) });
    const watch = createExitWatch(ports);
    await watch.probe();
    watch.arm();
    expect(vi.mocked(ports.spawn).mock.calls[0]?.[1][6]).toBe("0");
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit watch start unknown", code: "probe-failed" }),
    );
  });

  it("disarms by signalling the watch, and a gone watch is no error", () => {
    const signal = vi.fn(() => {
      throw new Error("ESRCH");
    });
    const watch = createExitWatch(fakePorts({ spawn: () => ({ signal }) }));
    const handle = watch.arm();
    expect(() => handle?.disarm()).not.toThrow();
    expect(signal).toHaveBeenCalledOnce();
  });

  it("returns null when the spawn fails or throws", () => {
    expect(createExitWatch(fakePorts({ spawn: () => null })).arm()).toBeNull();
    expect(
      createExitWatch(
        fakePorts({
          spawn: () => {
            throw new Error("EAGAIN");
          },
        }),
      ).arm(),
    ).toBeNull();
  });

  it("does nothing at all off macOS", async () => {
    const ports = fakePorts({ platform: "linux", readRecord: vi.fn(async () => "{}") });
    const watch = createExitWatch(ports);
    await watch.probe();
    await watch.logPreviousExit();
    expect(watch.arm()).toBeNull();
    expect(ports.probe).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.readRecord).not.toHaveBeenCalled();
  });

  it("logs the previous exit with numbers and codes only, then removes the record", async () => {
    log = captureHostLog("info");
    const ports = fakePorts({
      readRecord: vi.fn(
        async () =>
          '{"v":1,"goneMs":5031,"killed":true,"killedAtMs":5004,"outcome":"killed","graceMs":5000}',
      ),
    });
    await createExitWatch(ports).logPreviousExit();
    expect(log.records).toContainEqual(
      expect.objectContaining({
        component: "quit",
        msg: "previous exit",
        goneMs: 5031,
        killed: true,
        killedAtMs: 5004,
        outcome: "killed",
        graceMs: 5000,
      }),
    );
    expect(ports.removeRecord).toHaveBeenCalledOnce();
  });

  it("removes a record it cannot read, logs a code, and is quiet when there is none", async () => {
    log = captureHostLog("info");
    const bad = fakePorts({ readRecord: vi.fn(async () => "garbage") });
    await createExitWatch(bad).logPreviousExit();
    expect(bad.removeRecord).toHaveBeenCalledOnce();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "previous exit unreadable", code: "bad-record" }),
    );
    const none = fakePorts();
    await createExitWatch(none).logPreviousExit();
    expect(none.removeRecord).not.toHaveBeenCalled();
    const failing = fakePorts({
      readRecord: vi.fn(async () => Promise.reject(new Error("EACCES"))),
    });
    await expect(createExitWatch(failing).logPreviousExit()).resolves.toBeUndefined();
  });
});

function exited(child: ChildProcess): Promise<{ at: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ at: Date.now(), signal: child.signalCode });
      return;
    }
    child.once("exit", (_code, signal) => resolve({ at: Date.now(), signal }));
  });
}

async function record(directory: string, timeoutMs = 8000): Promise<unknown> {
  const file = join(directory, EXIT_WATCH_RECORD_FILE_NAME);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no record");
}

/** Watches still running for `pid`. */
async function watchesRunning(pid: number): Promise<number> {
  const { execFileSync } = await import("node:child_process");
  const table = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return table.split("\n").filter((line) => line.includes(`volli-exit-watch watch ${pid} `)).length;
}

/**
 * The real script, through the real ports, against a real process standing
 * in for the app (`/bin/sleep`), in a profile directory whose path has a
 * space. Short bounds; the shipped ones are only longer.
 */
describe.runIf(process.platform === "darwin")("the exit watch, for real", () => {
  const BOUNDS = { graceMs: 600, maxMs: 4000, pollMs: 20 };

  async function profile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "volli exit watch "));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  function target(seconds = 30): ChildProcess {
    const child = spawn("/bin/sleep", [String(seconds)], { stdio: "ignore" });
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return child;
  }

  it("reads the start time of a live pid, and nothing for a dead one", async () => {
    const directory = await profile();
    const live = target();
    const ports = nodeExitWatchPorts({ platform: "darwin", pid: live.pid!, directory });
    const output = await ports.probe(
      EXIT_WATCH_SHELL,
      ["-f", "-c", EXIT_WATCH_SCRIPT, ...exitWatchProbeArgv(live.pid!)!],
      { cwd: directory, env: EXIT_WATCH_ENV, timeoutMs: 5000 },
    );
    const started = parseProbeOutput(output);
    expect(Math.abs(started - Math.floor(Date.now() / 1000))).toBeLessThan(10);
    live.kill("SIGKILL");
    await exited(live);
    const gone = await ports.probe(
      EXIT_WATCH_SHELL,
      ["-f", "-c", EXIT_WATCH_SCRIPT, ...exitWatchProbeArgv(live.pid!)!],
      { cwd: directory, env: EXIT_WATCH_ENV, timeoutMs: 5000 },
    );
    expect(parseProbeOutput(gone)).toBe(0);
  });

  it("ends the same process once the grace has passed, records it, and ends itself", async () => {
    const directory = await profile();
    const app = target();
    const watch = createExitWatch(
      nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory }),
      BOUNDS,
    );
    await watch.probe();
    const armedAt = Date.now();
    expect(watch.arm()).not.toBeNull();
    const end = await exited(app);
    expect(end.signal).toBe("SIGKILL");
    expect(end.at - armedAt).toBeGreaterThanOrEqual(BOUNDS.graceMs - 20);
    expect(end.at - armedAt).toBeLessThan(BOUNDS.graceMs + 1500);
    const written = (await record(directory)) as { killedAtMs: number };
    expect(written).toMatchObject({ v: 1, killed: true, outcome: "killed" });
    expect(written.killedAtMs).toBeGreaterThanOrEqual(BOUNDS.graceMs);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await watchesRunning(app.pid!)).toBe(0);
  });

  it("records an exit that came by itself, and kills nothing", async () => {
    const directory = await profile();
    const app = target(0.3);
    const watch = createExitWatch(
      nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory }),
      BOUNDS,
    );
    await watch.probe();
    watch.arm();
    const end = await exited(app);
    expect(end.signal).toBeNull();
    const written = (await record(directory)) as { goneMs: number };
    expect(written).toMatchObject({ killed: false, outcome: "gone" });
    expect(written.goneMs).toBeLessThan(BOUNDS.graceMs);
  });

  it("records an app that crashed (killed by someone else) before the grace", async () => {
    const directory = await profile();
    const app = target();
    const watch = createExitWatch(
      nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory }),
      BOUNDS,
    );
    await watch.probe();
    watch.arm();
    setTimeout(() => app.kill("SIGSEGV"), 100);
    await exited(app);
    expect(await record(directory)).toMatchObject({ killed: false, outcome: "gone" });
  });

  it("never touches a process whose start time is not the one it was given (a reused pid)", async () => {
    const directory = await profile();
    const other = target();
    const ports = nodeExitWatchPorts({ platform: "darwin", pid: other.pid!, directory });
    // A start time from long before this process existed: as if the app's pid were reused.
    const argv = exitWatchArgv({
      pid: other.pid!,
      startedAt: 1_000_000_000,
      exitCallAtMs: Date.now(),
      ...BOUNDS,
    })!;
    ports.spawn(EXIT_WATCH_SHELL, ["-f", "-c", EXIT_WATCH_SCRIPT, ...argv], {
      cwd: directory,
      env: EXIT_WATCH_ENV,
    });
    expect(await record(directory)).toMatchObject({ killed: false, outcome: "mismatch" });
    await new Promise((resolve) => setTimeout(resolve, BOUNDS.graceMs + 300));
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  });

  it("with an unknown start, only measures, and still ends itself at its own bound", async () => {
    const directory = await profile();
    const app = target();
    const ports = nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory });
    const watch = createExitWatch(ports, { ...BOUNDS, maxMs: 1200 });
    // No probe: the start is unknown.
    const armedAt = Date.now();
    watch.arm();
    const written = (await record(directory)) as { goneMs: number };
    expect(written).toMatchObject({ killed: false, outcome: "timeout" });
    expect(written.goneMs).toBeGreaterThanOrEqual(1200);
    expect(Date.now() - armedAt).toBeLessThan(4000);
    expect(app.exitCode).toBeNull();
    expect(app.signalCode).toBeNull();
  });

  it("once disarmed, only measures", async () => {
    const directory = await profile();
    const app = target(1.2);
    const watch = createExitWatch(
      nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory }),
      BOUNDS,
    );
    await watch.probe();
    const handle = watch.arm()!;
    await new Promise((resolve) => setTimeout(resolve, 200));
    handle.disarm();
    const end = await exited(app);
    expect(end.signal).toBeNull();
    expect(await record(directory)).toMatchObject({ killed: false, outcome: "disarmed" });
  });

  it.each([
    ["no arguments", []],
    ["an unknown mode", ["stay", "1"]],
    ["a pid that is not a number", ["watch", "1; rm -rf /", "0", "1", "1", "1", "1"]],
    ["a missing bound", ["watch", "1", "0", "1", "1", "1"]],
  ])("ends at once on %s, writing nothing", async (_label, args) => {
    const directory = await profile();
    const child = spawn(
      EXIT_WATCH_SHELL,
      ["-f", "-c", EXIT_WATCH_SCRIPT, "volli-exit-watch", ...args],
      { cwd: directory, env: { ...EXIT_WATCH_ENV }, stdio: "ignore" },
    );
    const started = Date.now();
    const end = await exited(child);
    expect(end.at - started).toBeLessThan(2000);
    expect(existsSync(join(directory, EXIT_WATCH_RECORD_FILE_NAME))).toBe(false);
  });

  it("starts the watch with exactly the environment and directory it is given", async () => {
    const directory = await profile();
    const ports = nodeExitWatchPorts({ platform: "darwin", pid: process.pid, directory });
    // The real spawn port, with a shell that only reports what it was started with.
    ports.spawn("/bin/sh", ["-c", "/usr/bin/env > env.txt; /bin/pwd -P > pwd.txt"], {
      cwd: directory,
      env: EXIT_WATCH_ENV,
    });
    const file = join(directory, "pwd.txt");
    for (let i = 0; i < 100 && !existsSync(file); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const env = (await readFile(join(directory, "env.txt"), "utf8")).trim().split("\n").toSorted();
    // `sh` adds PWD/SHLVL/_ itself; nothing of this process's environment comes along.
    const inherited = env.filter((line) => !/^(PWD|SHLVL|_|OLDPWD)=/.test(line));
    expect(inherited).toEqual(["LC_ALL=C", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"]);
    expect((await readFile(file, "utf8")).trim()).toBe(
      (await import("node:fs")).realpathSync(directory),
    );
  });

  it("holds no file of the profile open while it watches: only its working directory", async () => {
    const directory = await profile();
    const app = target();
    const watch = createExitWatch(
      nodeExitWatchPorts({ platform: "darwin", pid: app.pid!, directory }),
      { ...BOUNDS, graceMs: 3000 },
    );
    await watch.probe();
    watch.arm();
    const { execFileSync } = await import("node:child_process");
    let watcher = "";
    for (let i = 0; i < 50 && watcher === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        watcher = execFileSync("/usr/bin/pgrep", ["-f", `volli-exit-watch watch ${app.pid} `], {
          encoding: "utf8",
        }).trim();
      } catch {
        watcher = "";
      }
    }
    expect(watcher).toMatch(/^\d+$/);
    const open = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-F", "fn", "-p", watcher], {
      encoding: "utf8",
    });
    const real = (await import("node:fs")).realpathSync(directory);
    const entries = open.split("\n");
    const inProfile = entries.filter(
      (line) => line.startsWith("n") && line.slice(1).startsWith(real),
    );
    // Exactly one: its working directory. No file, no lock.
    expect(inProfile).toEqual([`n${real}`]);
    expect(entries[entries.indexOf(`n${real}`) - 1]).toBe("fcwd");
    app.kill("SIGKILL");
    await exited(app);
  });

  it("reads and removes the record through the real ports", async () => {
    const directory = await profile();
    const ports = nodeExitWatchPorts({ platform: "darwin", pid: process.pid, directory });
    expect(await ports.readRecord()).toBeNull();
    await writeFile(join(directory, EXIT_WATCH_RECORD_FILE_NAME), "x");
    expect(await ports.readRecord()).toBe("x");
    await ports.removeRecord();
    expect(await ports.readRecord()).toBeNull();
  });
});
