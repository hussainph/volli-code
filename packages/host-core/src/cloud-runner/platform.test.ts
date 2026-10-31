import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseRunnerCapabilityReport } from "@volli/shared/cloud";

const io = vi.hoisted(() => ({
  osRelease: null as string | null | undefined,
  git: undefined as { error: Error | null; stdout: string } | undefined,
  docker: undefined as boolean | undefined,
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (path === "/etc/os-release" && io.osRelease !== undefined) {
        if (io.osRelease === null) throw new Error("ENOENT");
        return io.osRelease;
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((
      file: string,
      args: string[],
      options: object,
      done: (e: Error | null, out: string) => void,
    ) => {
      if (file === "docker" && io.docker !== undefined) {
        expect(args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
        expect(options).toEqual({ timeout: 5_000 });
        done(io.docker ? null : new Error("unavailable"), "");
        return;
      }
      if (io.git !== undefined) {
        done(io.git.error, io.git.stdout);
        return;
      }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(
        file,
        args,
        options,
        done,
      );
    }) as unknown as typeof actual.execFile,
  };
});

const {
  NODE_PLATFORM_PROBE,
  distroOf,
  gitVersionOf,
  probeRunnerCapabilities,
  probeRunnerPlatform,
  readRunnerLoad,
  runnerHostFacts,
} = await import("./platform");
type PlatformProbe = import("./platform").PlatformProbe;

const MB = 1024 * 1024;

function fakeProbe(overrides: Partial<PlatformProbe> = {}): PlatformProbe {
  return {
    platform: () => "linux",
    arch: () => "x64",
    release: () => "6.1.0",
    hostname: () => "hetzner-1",
    cpus: () => 8,
    totalmem: () => 16_384 * MB,
    freemem: () => 2_048 * MB + 5,
    osRelease: () => 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
    glibc: () => "2.36",
    nodeVersion: () => "24.18.0",
    freeBytes: () => 10_000 * MB,
    gitVersion: async () => "git version 2.43.0",
    ...overrides,
  };
}

afterEach(() => {
  io.osRelease = undefined;
  io.git = undefined;
  io.docker = undefined;
  vi.restoreAllMocks();
});

describe("the runner's platform", () => {
  it("reads a Linux box's distro and glibc, and leaves them out on a Mac", () => {
    expect(probeRunnerPlatform(fakeProbe())).toEqual({
      os: "linux",
      distro: "Debian GNU/Linux 12 (bookworm)",
      kernel: "6.1.0",
      arch: "x64",
      glibc: "2.36",
    });
    expect(
      probeRunnerPlatform(fakeProbe({ platform: () => "darwin", arch: () => "arm64" })),
    ).toEqual({
      os: "darwin",
      distro: null,
      kernel: "6.1.0",
      arch: "arm64",
      glibc: null,
    });
    expect(runnerHostFacts("system", fakeProbe())).toMatchObject({
      hostname: "hetzner-1",
      installMode: "system",
    });
  });

  it("names a distro from os-release", () => {
    expect(distroOf(null)).toBeNull();
    expect(distroOf("NAME=Fedora\nVERSION_ID=41\n")).toBe("Fedora 41");
    expect(distroOf("ID=alpine\n")).toBeNull();
    expect(distroOf('# comment\n\nNAME="Arch Linux"\n')).toBe("Arch Linux");
  });

  it("reads git's version", () => {
    expect(gitVersionOf(null)).toBeNull();
    expect(gitVersionOf("git version 2.39.5 (Apple Git-154)")).toEqual({ version: "2.39.5" });
    expect(gitVersionOf("git version unknown")).toEqual({ version: "git version unknown" });
  });

  it("builds a capability report the backend accepts", async () => {
    const report = await probeRunnerCapabilities(
      {
        version: "0.3.0",
        installMode: "app",
        terminals: true,
        browser: { state: "available", backend: "electron" },
        docker: false,
        maxConcurrentSessions: 6,
        tools: ["xcode", "simulator"],
        localCredentials: [{ providerId: "anthropic", kind: "subscription", expiresAt: null }],
      },
      fakeProbe({ platform: () => "darwin" }),
    );
    expect(parseRunnerCapabilityReport(report)).toEqual({
      ...report,
      capabilities: {
        ...report.capabilities,
        power: { source: "unknown", alwaysOn: false },
      },
    });
    expect(report.capabilities).toMatchObject({
      cpuCount: 8,
      memTotalMb: 16_384,
      git: { version: "2.43.0" },
      terminals: "available",
      tools: ["simulator", "xcode"],
    });
    const headless = await probeRunnerCapabilities(
      {
        version: "0.3.0",
        installMode: "system",
        terminals: false,
        browser: { state: "unavailable", reason: "not composed" },
        docker: true,
        maxConcurrentSessions: 2,
        tools: [],
        localCredentials: [],
      },
      fakeProbe({ gitVersion: async () => null }),
    );
    expect(headless.capabilities).toMatchObject({ git: null, terminals: "unavailable" });
  });

  it("probes Docker unless overridden and carries explicit power", async () => {
    const host = {
      version: "0.3.0",
      installMode: "user" as const,
      terminals: false,
      browser: { state: "unavailable" as const, reason: "not composed" },
      maxConcurrentSessions: 2,
      tools: [],
      localCredentials: [],
      power: { source: "ac" as const, alwaysOn: true },
    };
    const dockerAvailable = vi.fn(async () => true);
    const probe = fakeProbe({ dockerAvailable });
    const report = await probeRunnerCapabilities(host, probe);
    expect(report.capabilities).toMatchObject({ docker: true, power: host.power });
    expect(parseRunnerCapabilityReport(report)).toEqual(report);
    expect(dockerAvailable).toHaveBeenCalledOnce();
    await probeRunnerCapabilities({ ...host, docker: false }, probe);
    expect(dockerAvailable).toHaveBeenCalledOnce();
    expect((await probeRunnerCapabilities(host, fakeProbe())).capabilities.docker).toBe(false);
  });

  it("measures load where the data lives", () => {
    const counts = { activeSessions: 2, activeTurns: 1, queueDepth: 0 };
    expect(readRunnerLoad(counts, "/data", fakeProbe())).toEqual({
      ...counts,
      freeDiskMb: 10_000,
      freeMemMb: 2_048,
    });
    expect(readRunnerLoad(counts, "/data", fakeProbe({ freeBytes: () => null })).freeDiskMb).toBe(
      0,
    );
  });
});

describe("the Node probe", () => {
  it("answers from this process and machine", async () => {
    expect(NODE_PLATFORM_PROBE.platform()).toBe(process.platform);
    expect(NODE_PLATFORM_PROBE.arch()).toBe(process.arch);
    expect(NODE_PLATFORM_PROBE.release()).toEqual(expect.any(String));
    expect(NODE_PLATFORM_PROBE.hostname()).toEqual(expect.any(String));
    expect(NODE_PLATFORM_PROBE.cpus()).toBeGreaterThan(0);
    expect(NODE_PLATFORM_PROBE.totalmem()).toBeGreaterThan(0);
    expect(NODE_PLATFORM_PROBE.freemem()).toBeGreaterThan(0);
    expect(NODE_PLATFORM_PROBE.nodeVersion()).toBe(process.versions.node);
    expect(NODE_PLATFORM_PROBE.freeBytes(tmpdir())).toBeGreaterThan(0);
    expect(NODE_PLATFORM_PROBE.freeBytes("/definitely/not/here")).toBeNull();
  });

  it("reads os-release, or nothing", () => {
    io.osRelease = "NAME=Test\n";
    expect(NODE_PLATFORM_PROBE.osRelease()).toBe("NAME=Test\n");
    io.osRelease = null;
    expect(NODE_PLATFORM_PROBE.osRelease()).toBeNull();
  });

  it("reads glibc from the process report, or nothing", () => {
    const report = process.report!;
    vi.spyOn(report, "getReport").mockReturnValue({
      header: { glibcVersionRuntime: "2.36" },
    } as never);
    expect(NODE_PLATFORM_PROBE.glibc()).toBe("2.36");
    vi.spyOn(report, "getReport").mockReturnValue({ header: {} } as never);
    expect(NODE_PLATFORM_PROBE.glibc()).toBeNull();
    vi.spyOn(report, "getReport").mockReturnValue({} as never);
    expect(NODE_PLATFORM_PROBE.glibc()).toBeNull();
  });

  it("checks Docker daemon access, including a missing or stopped daemon", async () => {
    io.docker = true;
    await expect(NODE_PLATFORM_PROBE.dockerAvailable!()).resolves.toBe(true);
    io.docker = false;
    await expect(NODE_PLATFORM_PROBE.dockerAvailable!()).resolves.toBe(false);
  });

  it("runs git, or reports it missing", async () => {
    io.git = { error: null, stdout: "git version 2.43.0\n" };
    await expect(NODE_PLATFORM_PROBE.gitVersion()).resolves.toBe("git version 2.43.0");
    io.git = { error: new Error("ENOENT"), stdout: "" };
    await expect(NODE_PLATFORM_PROBE.gitVersion()).resolves.toBeNull();
  });
});
