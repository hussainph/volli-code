/**
 * What a runner says about the machine it runs on: the platform (sent when it
 * links and with every capability report), its capabilities, and its load
 * (with every heartbeat).
 *
 * The probes read Node's own view of the machine. What only the host knows —
 * whether it composes terminals and a browser backend, how many Sessions it
 * admits, which model credentials are signed in, which platform tools a
 * Session may use — comes in from the caller.
 */
import { execFile } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import * as os from "node:os";

import {
  RUNNER_CAPABILITIES_VERSION,
  type RunnerBrowserCapability,
  type RunnerCapabilityReport,
  type RunnerHostFacts,
  type RunnerInstallMode,
  type RunnerLoad,
  type RunnerLocalCredential,
  type RunnerPlatform,
} from "@volli/shared/cloud";

export interface PlatformProbe {
  platform(): string;
  arch(): string;
  release(): string;
  hostname(): string;
  cpus(): number;
  totalmem(): number;
  freemem(): number;
  /** `/etc/os-release`, or `null` where there is none. */
  osRelease(): string | null;
  /** The glibc a Linux build runs against, or `null` (musl, macOS). */
  glibc(): string | null;
  nodeVersion(): string;
  /** Free bytes on the filesystem holding `path`, or `null` when unmeasurable. */
  freeBytes(path: string): number | null;
  /** `git --version`'s output, or `null` when git does not run. */
  gitVersion(): Promise<string | null>;
}

const MB = 1024 * 1024;

function readOsRelease(): string | null {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return null;
  }
}

function runtimeGlibc(): string | null {
  const header = (
    process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined
  )?.header;
  return typeof header?.glibcVersionRuntime === "string" ? header.glibcVersionRuntime : null;
}

export const NODE_PLATFORM_PROBE: PlatformProbe = {
  platform: () => process.platform,
  arch: () => process.arch,
  release: () => os.release(),
  hostname: () => os.hostname(),
  cpus: () => os.availableParallelism(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  osRelease: readOsRelease,
  glibc: runtimeGlibc,
  nodeVersion: () => process.versions.node,
  freeBytes: (path) => {
    try {
      const stats = statfsSync(path);
      return stats.bavail * stats.bsize;
    } catch {
      return null;
    }
  },
  gitVersion: () =>
    new Promise((done) => {
      execFile("git", ["--version"], { timeout: 5_000 }, (error, stdout) => {
        done(error ? null : stdout.trim());
      });
    }),
};

/** `PRETTY_NAME`, else `NAME VERSION_ID`, from an os-release file. */
export function distroOf(osRelease: string | null): string | null {
  if (osRelease === null) return null;
  const fields = new Map<string, string>();
  for (const line of osRelease.split("\n")) {
    const match = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
    if (match) fields.set(match[1]!, match[3]!);
  }
  const pretty = fields.get("PRETTY_NAME");
  if (pretty) return pretty;
  const name = [fields.get("NAME"), fields.get("VERSION_ID")].filter(Boolean).join(" ");
  return name === "" ? null : name;
}

export function probeRunnerPlatform(probe: PlatformProbe = NODE_PLATFORM_PROBE): RunnerPlatform {
  const linux = probe.platform() === "linux";
  return {
    os: probe.platform(),
    distro: linux ? distroOf(probe.osRelease()) : null,
    kernel: probe.release(),
    arch: probe.arch(),
    glibc: linux ? probe.glibc() : null,
  };
}

/** What a box sends when it links. */
export function runnerHostFacts(
  installMode: RunnerInstallMode,
  probe: PlatformProbe = NODE_PLATFORM_PROBE,
): RunnerHostFacts {
  return { hostname: probe.hostname(), platform: probeRunnerPlatform(probe), installMode };
}

/** `git version 2.43.0` → `2.43.0`. */
export function gitVersionOf(output: string | null): { version: string } | null {
  if (output === null) return null;
  // Token by token, each matched from its start: linear on any input.
  const version = output
    .split(/\s/)
    .map((token) => /^\d+\.\d+(?:\.\d+)?/.exec(token)?.[0])
    .find((match) => match !== undefined);
  return { version: version ?? output.slice(0, 200) };
}

/** What the host knows about itself and Node cannot see. */
export interface RunnerHostCapabilities {
  version: string;
  installMode: RunnerInstallMode;
  terminals: boolean;
  browser: RunnerBrowserCapability;
  docker: boolean;
  maxConcurrentSessions: number;
  /** Platform tools a Session may use (`xcode`, `simulator`, … on a Mac). */
  tools: string[];
  localCredentials: RunnerLocalCredential[];
}

export async function probeRunnerCapabilities(
  host: RunnerHostCapabilities,
  probe: PlatformProbe = NODE_PLATFORM_PROBE,
): Promise<RunnerCapabilityReport> {
  return {
    version: host.version,
    platform: probeRunnerPlatform(probe),
    installMode: host.installMode,
    capabilities: {
      v: RUNNER_CAPABILITIES_VERSION,
      nodeVersion: probe.nodeVersion(),
      cpuCount: probe.cpus(),
      memTotalMb: Math.floor(probe.totalmem() / MB),
      git: gitVersionOf(await probe.gitVersion()),
      docker: host.docker,
      terminals: host.terminals ? "available" : "unavailable",
      browser: host.browser,
      maxConcurrentSessions: host.maxConcurrentSessions,
      // Sorted, so the same tools in another order is not a change.
      tools: host.tools.toSorted(),
    },
    localCredentials: host.localCredentials,
  };
}

/** The heartbeat's load: the host's counts, and free memory and disk where its data lives. */
export function readRunnerLoad(
  counts: Pick<RunnerLoad, "activeSessions" | "activeTurns" | "queueDepth">,
  dataDir: string,
  probe: PlatformProbe = NODE_PLATFORM_PROBE,
): RunnerLoad {
  const freeDisk = probe.freeBytes(dataDir);
  return {
    ...counts,
    freeDiskMb: freeDisk === null ? 0 : Math.floor(freeDisk / MB),
    freeMemMb: Math.floor(probe.freemem() / MB),
  };
}
