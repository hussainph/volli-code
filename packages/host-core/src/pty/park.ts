// Process inspection + config for the warm-park tier (issue #51). The pure
// eligibility logic lives in @volli/shared's park.ts; this module is the
// Node-side seam the PtyManager sweep drives: walk a session's process tree,
// sample its CPU, check for LISTEN sockets, and deliver SIGSTOP/SIGCONT.
//
// The inspection is factored behind ProcessInspector so pty.test.ts can run
// under plain-Node vitest with a fake — no `ps`/`pgrep`/`lsof` spawning, no
// real signals. createProcessInspector wires the real implementation over an
// injectable execFile (so its own tests inject a stub too).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PARK_BREATHE_WINDOW_MS,
  PARK_CPU_BUSY_PERCENT,
  PARK_IDLE_THRESHOLD_MS,
  PARK_QUIET_SAMPLES_REQUIRED,
  PARK_SWEEP_INTERVAL_MS,
} from "@volli/shared";

export interface ProcessInspector {
  /**
   * All live descendant pids of `pid` (recursive `pgrep -P` walk),
   * depth-first parent-before-children order, NOT including `pid` itself.
   */
  descendants(pid: number): Promise<number[]>;
  /** pcpu by pid via one `ps -o pid=,pcpu= -p <list>` call. Missing pids omitted. */
  cpuPercents(pids: readonly number[]): Promise<Map<number, number>>;
  /**
   * Subset of `pids` holding a TCP LISTEN socket, via one
   * `lsof -a -nP -iTCP -sTCP:LISTEN -p <comma-list>` call.
   */
  listeningPids(pids: readonly number[]): Promise<Set<number>>;
  /** ESRCH-safe `process.kill` wrapper; returns false if the pid was gone. */
  signal(pid: number, signal: "SIGSTOP" | "SIGCONT"): boolean;
}

/** True when a rejected execFile carries a plain exit code of 1. */
function isExitCode1(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 1;
}

/** ESRCH/EPERM-safe `process.kill`; false when the pid was already gone. */
function signalPid(pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    // ESRCH (pid gone) or EPERM (not ours) — either way it isn't parked/woken.
    return false;
  }
}

/** Parses whitespace/newline-separated pids from command output. */
function parsePids(out: string): number[] {
  const pids: number[] = [];
  for (const token of out.split(/\s+/)) {
    if (token.length === 0) continue;
    const pid = Number.parseInt(token, 10);
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}

/**
 * The real inspector, over an injectable `execFile` (defaulting to the Node
 * one). `pgrep`/`ps`/`lsof` all exit 1 to mean "no matches" — that is an empty
 * result here, never an error; any other failure propagates.
 */
export function createProcessInspector(execFileImpl: typeof execFile = execFile): ProcessInspector {
  const run = promisify(execFileImpl);

  /** Runs a command, mapping an exit-1 ("no matches") into empty stdout. */
  async function capture(file: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await run(file, args);
      return stdout;
    } catch (error) {
      if (isExitCode1(error)) return "";
      throw error;
    }
  }

  async function descendants(pid: number): Promise<number[]> {
    const out = await capture("pgrep", ["-P", String(pid)]);
    const children = parsePids(out);
    const result: number[] = [];
    for (const child of children) {
      result.push(child);
      result.push(...(await descendants(child)));
    }
    return result;
  }

  async function cpuPercents(pids: readonly number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (pids.length === 0) return map;
    const out = await capture("ps", ["-o", "pid=,pcpu=", "-p", pids.join(",")]);
    for (const line of out.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 2) continue;
      const pid = Number.parseInt(fields[0], 10);
      const pcpu = Number.parseFloat(fields[1]);
      if (Number.isInteger(pid) && !Number.isNaN(pcpu)) map.set(pid, pcpu);
    }
    return map;
  }

  async function listeningPids(pids: readonly number[]): Promise<Set<number>> {
    const found = new Set<number>();
    if (pids.length === 0) return found;
    const out = await capture("lsof", ["-a", "-nP", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")]);
    const wanted = new Set(pids);
    for (const line of out.split("\n")) {
      const fields = line.trim().split(/\s+/);
      const pid = Number.parseInt(fields[1] ?? "", 10);
      if (Number.isInteger(pid) && wanted.has(pid)) found.add(pid);
    }
    return found;
  }

  return { descendants, cpuPercents, listeningPids, signal: signalPid };
}

/** Tunables the PtyManager sweep reads; derived once at construction. */
export interface ParkConfig {
  idleThresholdMs: number;
  sweepIntervalMs: number;
  cpuBusyPercent: number;
  quietSamplesRequired: number;
  /** How long each parked session runs per sweep before the re-freeze verdict. */
  breatheWindowMs: number;
  enabled: boolean;
}

/** Parses a positive-int env string, falling back on absent/invalid/non-positive values. */
function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Builds the park config from the environment. `VOLLI_PARK_IDLE_MS` /
 * `VOLLI_PARK_SWEEP_MS` / `VOLLI_PARK_BREATHE_MS` override the timings (positive-int strings only);
 * `VOLLI_PARK_DISABLE=1` force-disables it. Parking is enabled only on
 * darwin/linux (SIGSTOP/SIGCONT semantics) and never when disabled. Pure.
 */
export function parkConfigFromEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ParkConfig {
  const platformSupports = platform === "darwin" || platform === "linux";
  return {
    idleThresholdMs: positiveIntFromEnv(env["VOLLI_PARK_IDLE_MS"], PARK_IDLE_THRESHOLD_MS),
    sweepIntervalMs: positiveIntFromEnv(env["VOLLI_PARK_SWEEP_MS"], PARK_SWEEP_INTERVAL_MS),
    breatheWindowMs: positiveIntFromEnv(env["VOLLI_PARK_BREATHE_MS"], PARK_BREATHE_WINDOW_MS),
    cpuBusyPercent: PARK_CPU_BUSY_PERCENT,
    quietSamplesRequired: PARK_QUIET_SAMPLES_REQUIRED,
    enabled: platformSupports && env["VOLLI_PARK_DISABLE"] !== "1",
  };
}
