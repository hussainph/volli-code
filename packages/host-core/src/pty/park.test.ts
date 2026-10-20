import type { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PARK_BREATHE_WINDOW_MS,
  PARK_CPU_BUSY_PERCENT,
  PARK_IDLE_THRESHOLD_MS,
  PARK_QUIET_SAMPLES_REQUIRED,
  PARK_SWEEP_INTERVAL_MS,
} from "@volli/shared";
import { INVENTORY_TIMEOUT_MS } from "../process/inventory";
import { createProcessInspector, parkConfigFromEnv } from "./park";

/**
 * One canned command response: stdout on success, a non-zero exit code, a
 * non-Error rejection value (models a spawn that rejects with a primitive), or
 * a call that never answers (models `lsof` blocked on a dead network mount).
 */
type CannedResponse =
  | { stdout: string }
  | { code: number }
  | { reject: unknown }
  | { hang: true }
  | { stdout: string; afterMs: number };

/** Signals the inspector sent to the children its stub spawned, in order. */
const childKills: Array<NodeJS.Signals | number | undefined> = [];

/**
 * A callback-style `execFile` stub that routes by the `file` argument. It
 * answers `(error, stdout, stderr)` exactly as the real one does with
 * `encoding: "utf8"`, rejecting with an `Error` carrying a numeric `code`, so
 * the inspector's exit-1 handling is exercised exactly as against the real
 * binaries. The child it returns records the signals it was sent.
 */
function stubExecFile(
  responder: (file: string, args: readonly string[]) => CannedResponse,
): typeof execFile {
  const impl = (
    file: string,
    args: string[],
    _options: unknown,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ): { kill(signal?: NodeJS.Signals | number): boolean } => {
    const res = responder(file, args);
    const child = {
      kill: (signal?: NodeJS.Signals | number) => {
        childKills.push(signal);
        // A killed child still closes, and execFile then reports it — after
        // the inspector has already given up on it.
        if ("hang" in res) cb(Object.assign(new Error(`${file} killed`), { killed: true, signal }));
        return true;
      },
    };
    if ("hang" in res) return child;
    if ("afterMs" in res) {
      // Answers later, as a real child does.
      setTimeout(() => cb(null, res.stdout, ""), res.afterMs);
      return child;
    }
    if ("reject" in res) {
      cb(res.reject as Error);
    } else if ("code" in res) {
      cb(Object.assign(new Error(`${file} exited ${res.code}`), { code: res.code }));
    } else {
      cb(null, res.stdout, "");
    }
    return child;
  };
  return impl as unknown as typeof execFile;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  childKills.length = 0;
});

describe("createProcessInspector.descendants", () => {
  it("walks pgrep -P recursively, parent-before-children, excluding the root", async () => {
    const inspector = createProcessInspector(
      stubExecFile((file, args) => {
        expect(file).toBe("pgrep");
        const parent = args[1];
        if (parent === "100") return { stdout: "200 300\n" };
        if (parent === "200") return { stdout: "400\n" };
        // 300 and 400 have no children: pgrep exits 1.
        return { code: 1 };
      }),
    );
    expect(await inspector.descendants(100)).toEqual([200, 400, 300]);
  });

  it("returns empty when the root has no children", async () => {
    const inspector = createProcessInspector(stubExecFile(() => ({ code: 1 })));
    expect(await inspector.descendants(1)).toEqual([]);
  });

  it("propagates a non-exit-1 failure", async () => {
    const inspector = createProcessInspector(stubExecFile(() => ({ code: 2 })));
    await expect(inspector.descendants(1)).rejects.toThrow("pgrep exited 2");
  });

  it("propagates a non-Error rejection (not an exit-1)", async () => {
    const inspector = createProcessInspector(stubExecFile(() => ({ reject: "spawn blew up" })));
    await expect(inspector.descendants(1)).rejects.toBe("spawn blew up");
  });

  it("skips non-numeric tokens in pgrep output", async () => {
    const inspector = createProcessInspector(
      stubExecFile((_file, args) =>
        args[1] === "1" ? { stdout: "200 notapid 300\n" } : { code: 1 },
      ),
    );
    expect(await inspector.descendants(1)).toEqual([200, 300]);
  });
});

describe("createProcessInspector.cpuPercents", () => {
  it("parses `ps` output tolerating leading spaces and float pcpu", async () => {
    const inspector = createProcessInspector(
      stubExecFile((file, args) => {
        expect(file).toBe("ps");
        expect(args).toEqual(["-o", "pid=,pcpu=", "-p", "512,513"]);
        return { stdout: "  512  0.3\n  513  12.5\n" };
      }),
    );
    const map = await inspector.cpuPercents([512, 513]);
    expect(map.get(512)).toBe(0.3);
    expect(map.get(513)).toBe(12.5);
  });

  it("skips blank and malformed lines", async () => {
    const inspector = createProcessInspector(
      stubExecFile(() => ({ stdout: "\nabc def\n512 xyz\n99 1.5\n" })),
    );
    const map = await inspector.cpuPercents([99]);
    // blank line (<2 fields), NaN pid, and NaN pcpu are all dropped.
    expect(map.size).toBe(1);
    expect(map.get(99)).toBe(1.5);
  });

  it("returns an empty map for no pids without spawning ps", async () => {
    const inspector = createProcessInspector(
      stubExecFile(() => {
        throw new Error("should not run");
      }),
    );
    expect((await inspector.cpuPercents([])).size).toBe(0);
  });

  it("returns an empty map when every pid is gone (ps exits 1)", async () => {
    const inspector = createProcessInspector(stubExecFile(() => ({ code: 1 })));
    expect((await inspector.cpuPercents([1, 2])).size).toBe(0);
  });
});

describe("createProcessInspector.listeningPids", () => {
  it("collects wanted pids holding a LISTEN socket, skipping the header", async () => {
    const inspector = createProcessInspector(
      stubExecFile((file, args) => {
        expect(file).toBe("lsof");
        expect(args).toEqual(["-a", "-nP", "-iTCP", "-sTCP:LISTEN", "-w", "-p", "512,513"]);
        return {
          stdout:
            "COMMAND   PID USER   FD   TYPE\n" +
            "node      512 dev    20u  IPv4\n" +
            "node      999 dev    21u  IPv4\n",
        };
      }),
    );
    const found = await inspector.listeningPids([512, 513]);
    // 512 is wanted and present; 999 is present but not wanted; 513 absent.
    expect([...found]).toEqual([512]);
  });

  it("returns an empty set for no pids without spawning lsof", async () => {
    const inspector = createProcessInspector(
      stubExecFile(() => {
        throw new Error("should not run");
      }),
    );
    expect((await inspector.listeningPids([])).size).toBe(0);
  });

  it("returns an empty set when lsof finds nothing (exits 1)", async () => {
    const inspector = createProcessInspector(stubExecFile(() => ({ code: 1 })));
    expect((await inspector.listeningPids([1])).size).toBe(0);
  });
});

describe("createProcessInspector's bound on each call (VC-833)", () => {
  it("kills an lsof that never answers and rejects at the inventory's bound", async () => {
    vi.useFakeTimers();
    const inspector = createProcessInspector(stubExecFile(() => ({ hang: true })));
    const pending = inspector.listeningPids([512]);
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );

    await vi.advanceTimersByTimeAsync(INVENTORY_TIMEOUT_MS - 1);
    expect(childKills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(`lsof did not finish within ${INVENTORY_TIMEOUT_MS} ms`);
    expect(childKills).toEqual(["SIGKILL"]);
  });

  it("bounds pgrep and ps the same way", async () => {
    vi.useFakeTimers();
    const inspector = createProcessInspector(stubExecFile(() => ({ hang: true })));
    const walk = inspector.descendants(1).catch((error: unknown) => (error as Error).message);
    const sample = inspector.cpuPercents([1]).catch((error: unknown) => (error as Error).message);
    await vi.advanceTimersByTimeAsync(INVENTORY_TIMEOUT_MS);
    expect(await walk).toMatch(/^pgrep did not finish/);
    expect(await sample).toMatch(/^ps did not finish/);
  });

  it("disarms the bound when the call answers in time", async () => {
    vi.useFakeTimers();
    const inspector = createProcessInspector(
      stubExecFile(() => ({ stdout: "7 0.0\n", afterMs: INVENTORY_TIMEOUT_MS - 1 })),
    );
    const sample = inspector.cpuPercents([7]);
    await vi.advanceTimersByTimeAsync(INVENTORY_TIMEOUT_MS - 1);
    expect((await sample).get(7)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(childKills).toEqual([]);
  });
});

describe("createProcessInspector.signal", () => {
  it("delivers the signal and reports success", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const inspector = createProcessInspector();
    expect(inspector.signal(4321, "SIGSTOP")).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, "SIGSTOP");
  });

  it("returns false when the pid is gone (kill throws)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const inspector = createProcessInspector();
    expect(inspector.signal(4321, "SIGCONT")).toBe(false);
  });

  it("defaults to the real execFile when none is injected", () => {
    // Construction alone must not spawn anything; smoke-test the default arg.
    expect(createProcessInspector()).toBeDefined();
  });
});

describe("parkConfigFromEnv", () => {
  it("enables parking on darwin with the shared defaults", () => {
    const config = parkConfigFromEnv({}, "darwin");
    expect(config).toEqual({
      idleThresholdMs: PARK_IDLE_THRESHOLD_MS,
      sweepIntervalMs: PARK_SWEEP_INTERVAL_MS,
      cpuBusyPercent: PARK_CPU_BUSY_PERCENT,
      quietSamplesRequired: PARK_QUIET_SAMPLES_REQUIRED,
      breatheWindowMs: PARK_BREATHE_WINDOW_MS,
      enabled: true,
    });
  });

  it("enables parking on linux", () => {
    expect(parkConfigFromEnv({}, "linux").enabled).toBe(true);
  });

  it("disables parking on an unsupported platform", () => {
    expect(parkConfigFromEnv({}, "win32").enabled).toBe(false);
  });

  it("honors VOLLI_PARK_DISABLE=1 even on a supported platform", () => {
    expect(parkConfigFromEnv({ VOLLI_PARK_DISABLE: "1" }, "darwin").enabled).toBe(false);
  });

  it("does not treat a non-1 VOLLI_PARK_DISABLE as disabling", () => {
    expect(parkConfigFromEnv({ VOLLI_PARK_DISABLE: "0" }, "darwin").enabled).toBe(true);
  });

  it("applies positive-int env overrides", () => {
    const config = parkConfigFromEnv(
      { VOLLI_PARK_IDLE_MS: "1000", VOLLI_PARK_SWEEP_MS: "2000", VOLLI_PARK_BREATHE_MS: "50" },
      "darwin",
    );
    expect(config.idleThresholdMs).toBe(1000);
    expect(config.sweepIntervalMs).toBe(2000);
    expect(config.breatheWindowMs).toBe(50);
  });

  it.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["float", "1.5"],
  ])("falls back to the default for a %s override", (_label, value) => {
    const config = parkConfigFromEnv(
      { VOLLI_PARK_IDLE_MS: value, VOLLI_PARK_SWEEP_MS: value, VOLLI_PARK_BREATHE_MS: value },
      "darwin",
    );
    expect(config.idleThresholdMs).toBe(PARK_IDLE_THRESHOLD_MS);
    expect(config.sweepIntervalMs).toBe(PARK_SWEEP_INTERVAL_MS);
    expect(config.breatheWindowMs).toBe(PARK_BREATHE_WINDOW_MS);
  });
});
