import { describe, expect, it } from "vite-plus/test";

import type { RunnerHostFacts } from "@volli/shared/cloud";

import type { CommandContext } from "../commands";
import type { RunnerDeployment } from "../link/deployment";
import type { RunnerPaths } from "../shell/paths";
import { testContext } from "../testing/context";
import {
  atLeast,
  doctorReport,
  formatBytes,
  gitInstallFix,
  gitUpgradeFix,
  installModeOf,
  isSet,
  loginOf,
  runChecks,
  type DoctorCheck,
  type DoctorInputs,
} from "./checks";
import type { DoctorPorts } from "./ports";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const GIB = 1024 ** 3;
const RUNNER_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT: RunnerDeployment = {
  url: "https://a.convex.cloud",
  siteUrl: "https://a.convex.site",
};
const PATHS: RunnerPaths = {
  mode: "user",
  dataDir: "/box/.local/state/volli-runner",
  configDir: "/box/.config/volli-runner",
};

interface Box {
  readonly ports?: Partial<DoctorPorts>;
  readonly env?: Record<string, string>;
  readonly host?: RunnerHostFacts;
  readonly buildDeployment?: RunnerDeployment | null;
  readonly uid?: number;
  readonly paths?: RunnerPaths;
}

/** A linked box that meets every requirement, with one thing replaced per test. */
function ports(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  return {
    configureProxy: () => () => {},
    run: (command) => {
      if (command === "git") return { status: 0, stdout: "git version 2.43.0\n" };
      if (command === "loginctl") return { status: 0, stdout: "yes\n" };
      return { status: 1, stdout: "" };
    },
    reach: async () => ({ reachable: true, status: 404, date: NOW }),
    freeBytes: () => 8 * GIB,
    exists: () => true,
    storedCredentials: async () => ({
      state: "listed",
      providers: [{ providerId: "anthropic", kind: "subscription" }],
    }),
    readLink: async () => ({
      state: "linked",
      name: "hetzner-1",
      runnerId: RUNNER_ID,
      deployment: DEPLOYMENT,
    }),
    ...overrides,
  };
}

function inputs(box: Box = {}): DoctorInputs {
  const base = testContext({
    root: "/box",
    env: box.env ?? { USER: "volli" },
    now: () => NOW,
    ...(box.buildDeployment === undefined ? {} : { buildDeployment: box.buildDeployment }),
  });
  const context: CommandContext = box.uid === undefined ? base : { ...base, uid: box.uid };
  const paths = box.paths ?? PATHS;
  return {
    host: box.host ?? context.hostFacts(paths.mode),
    context,
    paths,
    ports: ports(box.ports),
  };
}

async function checks(box: Box = {}): Promise<readonly DoctorCheck[]> {
  return runChecks(inputs(box));
}

function found(list: readonly DoctorCheck[], id: string): DoctorCheck {
  const check = list.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`no ${id} check`);
  return check;
}

const LINUX = (platform: Partial<RunnerHostFacts["platform"]>): RunnerHostFacts => ({
  hostname: "hetzner-1",
  platform: {
    os: "linux",
    distro: "debian 12",
    kernel: "6.1.0",
    arch: "x64",
    glibc: "2.36",
    ...platform,
  },
  installMode: "user",
});

describe("a box that meets every requirement", () => {
  it("reports each check once, in order, and none of them asks for a fix", async () => {
    const list = await checks();
    expect(list.map((check) => check.id)).toEqual([
      "link",
      "platform",
      "glibc",
      "git",
      "disk",
      "systemd",
      "linger",
      "network.backend",
      "network.deployment",
      "network.github.com",
      "network.anthropic",
      "network.google",
      "network.openai",
      "network.openrouter",
      "clock",
      "models",
      "browser",
    ]);
    expect(list.map((check) => check.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "info",
    ]);
    expect(list.filter((check) => check.fix !== undefined)).toEqual([]);
  });

  it("counts the report, and keeps the box's own facts on it", () => {
    const host = LINUX({});
    const report = doctorReport(host, [
      { id: "a", title: "a", status: "ok", detail: "" },
      { id: "b", title: "b", status: "warn", detail: "", fix: "x" },
      { id: "c", title: "c", status: "fail", detail: "", fix: "y" },
      { id: "d", title: "d", status: "unknown", detail: "", fix: "z" },
      { id: "e", title: "e", status: "info", detail: "" },
    ]);
    expect(report.v).toBe(1);
    expect(report.host).toBe(host);
    expect(report.counts).toEqual({ ok: 1, warn: 1, fail: 1, unknown: 1, info: 1 });
  });
});

describe("the deployment probed", () => {
  it("is the one the box is linked to", async () => {
    const seen: string[] = [];
    await checks({
      ports: {
        reach: async (url) => {
          seen.push(url);
          return { reachable: true, status: 200, date: NOW };
        },
      },
    });
    expect(seen).toContain(DEPLOYMENT.siteUrl);
    expect(seen).toContain(DEPLOYMENT.url);
    expect(seen).toContain("https://github.com");
    expect(seen).toContain("https://api.anthropic.com");
  });

  it("is the build's own deployment while the box is unlinked", async () => {
    const list = await checks({
      ports: { readLink: async () => ({ state: "unlinked" }) },
      buildDeployment: DEPLOYMENT,
    });
    expect(found(list, "link").status).toBe("warn");
    expect(found(list, "network.deployment").status).toBe("ok");
  });

  it("is unknown when the build names none and the box is unlinked", async () => {
    const list = await checks({
      ports: { readLink: async () => ({ state: "unlinked" }) },
      buildDeployment: null,
    });
    expect(found(list, "network.deployment")).toMatchObject({
      status: "unknown",
      fix: "NODE_USE_ENV_PROXY=1 volli-runner link --server <url>",
    });
    expect(found(list, "clock").status).toBe("unknown");
  });

  it("fails the box when it cannot be reached, naming the host", async () => {
    const list = await checks({
      ports: {
        reach: async (url) =>
          url === DEPLOYMENT.siteUrl
            ? { reachable: false, reason: "ENOTFOUND" }
            : { reachable: true, status: 200, date: NOW },
      },
    });
    const deployment = found(list, "network.deployment");
    expect(deployment.status).toBe("fail");
    expect(deployment.detail).toBe("no answer (ENOTFOUND)");
    expect(deployment.fix).toContain("a.convex.site");
  });

  it("warns for github.com and for each provider rather than failing the box", async () => {
    const list = await checks({
      ports: { reach: async () => ({ reachable: false, reason: "ECONNREFUSED" }) },
    });
    expect(found(list, "network.github.com").status).toBe("warn");
    expect(found(list, "network.github.com").title).toBe("github.com");
    expect(found(list, "network.anthropic").status).toBe("warn");
    expect(found(list, "network.openrouter").title).toBe("openrouter.ai");
    expect(found(list, "network.deployment").status).toBe("fail");
  });

  it("shows a host it cannot parse as the URL it was given, and still probes it", async () => {
    const list = await checks({
      ports: {
        readLink: async () => ({
          state: "linked",
          name: "hetzner-1",
          runnerId: RUNNER_ID,
          deployment: { url: "not a url", siteUrl: "not a url" },
        }),
      },
    });
    expect(found(list, "network.deployment").title).toBe("not a url");
  });
});

describe("the box's clock", () => {
  it("passes within a minute of the deployment", async () => {
    const list = await checks();
    expect(found(list, "clock")).toMatchObject({
      status: "ok",
      detail: "within a minute of the deployment's clock",
    });
  });

  it("fails a clock that is ahead, with the fix that sets NTP", async () => {
    const list = await checks({
      ports: { reach: async () => ({ reachable: true, status: 200, date: NOW - 600_000 }) },
    });
    const clock = found(list, "clock");
    expect(clock.status).toBe("fail");
    expect(clock.detail).toContain("10 min ahead of");
    expect(clock.fix).toBe("sudo timedatectl set-ntp true");
  });

  it("fails a clock that is behind", async () => {
    const list = await checks({
      ports: { reach: async () => ({ reachable: true, status: 200, date: NOW + 90_000 }) },
    });
    expect(found(list, "clock").detail).toContain("90 s behind");
  });

  it("is unknown without the deployment's reading", async () => {
    const list = await checks({
      ports: { reach: async () => ({ reachable: true, status: 200, date: null }) },
    });
    expect(found(list, "clock")).toMatchObject({ status: "unknown", fix: "timedatectl" });
  });

  it("reads the box's own clock when the context carries none", async () => {
    const context = testContext({ root: "/box", env: { USER: "volli" } });
    const list = await runChecks({
      host: context.hostFacts("user"),
      context,
      paths: PATHS,
      ports: ports(),
    });
    // The box's own clock against a fixed deployment reading: either side, never unknown.
    expect(["ok", "fail"]).toContain(found(list, "clock").status);
  });

  it("is unknown when the deployment did not answer", async () => {
    const list = await checks({
      ports: { reach: async () => ({ reachable: false, reason: "ENOTFOUND" }) },
    });
    expect(found(list, "clock").status).toBe("unknown");
  });
});

describe("the link", () => {
  it("names the runner it holds", async () => {
    expect(found(await checks(), "link")).toMatchObject({
      status: "ok",
      detail: `linked as hetzner-1 (${RUNNER_ID}) to https://a.convex.cloud`,
    });
  });

  it("warns an unlinked box, with the one command that links it", async () => {
    const list = await checks({ ports: { readLink: async () => ({ state: "unlinked" }) } });
    expect(found(list, "link")).toMatchObject({
      status: "warn",
      fix: "NODE_USE_ENV_PROXY=1 volli-runner link",
    });
  });

  it("never advises unlinking a link this run cannot open", async () => {
    const unreadable = { state: "unreadable", error: "the key is owned by volli" } as const;
    const list = await checks({ ports: { readLink: async () => unreadable } });
    const link = found(list, "link");
    expect(link.status).toBe("unknown");
    expect(link.detail).toContain("the key is owned by volli");
    expect(link.fix).toContain("credential.key");
    expect(link.fix).not.toContain("unlink");
  });

  it("sends a system install to the service account, never to unlink", async () => {
    const list = await checks({
      ports: { readLink: async () => ({ state: "unreadable", error: "wrong owner" }) },
      env: { VOLLI_RUNNER_INSTALL_MODE: "system" },
      paths: {
        mode: "system",
        dataDir: "/var/lib/volli-runner",
        configDir: "/etc/volli-runner",
      },
    });
    expect(found(list, "link").fix).toBe(
      "sudo -u volli env VOLLI_RUNNER_INSTALL_MODE=system volli-runner doctor --data-dir /var/lib/volli-runner --config-dir /etc/volli-runner",
    );
  });
});

describe("the platform", () => {
  it("names the distribution, architecture and kernel", async () => {
    expect(found(await checks(), "platform").detail).toBe("debian 12, x64, kernel 6.1.0");
  });

  it("reports a Linux box with no distro name by its kernel alone", async () => {
    const list = await checks({ host: LINUX({ distro: null }) });
    expect(found(list, "platform").detail).toBe("Linux, x64, kernel 6.1.0");
    expect(found(list, "glibc").status).toBe("ok");
  });

  it("fails a box that is not Linux, and asks nothing of its libc", async () => {
    const list = await checks({
      host: { ...LINUX({}), platform: { ...LINUX({}).platform, os: "darwin", glibc: null } },
    });
    expect(found(list, "platform")).toMatchObject({
      status: "fail",
      detail: "darwin x64 is not Linux",
    });
    expect(found(list, "glibc")).toMatchObject({ status: "info" });
  });
});

describe("glibc", () => {
  it("passes the floor and reports it", async () => {
    expect(found(await checks(), "glibc").detail).toBe("glibc 2.36");
  });

  it("fails a libc older than the floor", async () => {
    expect(found(await checks({ host: LINUX({ glibc: "2.28" }) }), "glibc")).toMatchObject({
      status: "fail",
      detail: "glibc 2.28 is older than 2.31",
    });
  });

  it("fails a libc it cannot identify as glibc at all", async () => {
    const glibc = found(await checks({ host: LINUX({ glibc: null }) }), "glibc");
    expect(glibc.status).toBe("fail");
    expect(glibc.fix).toContain("glibc 2.31");
  });
});

describe("git", () => {
  it("reports the version it found", async () => {
    expect(found(await checks(), "git").detail).toBe("git 2.43.0");
  });

  it("fails a box without git, with its distribution's install command", async () => {
    const list = await checks({
      ports: { run: () => ({ status: 1, stdout: "" }) },
    });
    expect(found(list, "git")).toMatchObject({
      status: "fail",
      detail: "git is not installed, or does not run",
      fix: "sudo apt-get install -y git",
    });
  });

  it("fails a git that answers with nothing usable", async () => {
    const list = await checks({
      ports: { run: () => ({ status: 0, stdout: "git: no version here" }) },
    });
    expect(found(list, "git").status).toBe("fail");
  });

  it("asks for a newer source, never a second install of the same package", async () => {
    const list = await checks({
      ports: { run: () => ({ status: 0, stdout: "git version 2.30.2" }) },
    });
    const git = found(list, "git");
    expect(git.status).toBe("fail");
    expect(git.detail).toBe("git 2.30.2 is older than 2.31");
    expect(git.fix).toContain("Debian backports or the git-core PPA");
    expect(git.fix).not.toContain("apt-get install");
  });

  it("names a newer source on a non-Debian distribution too", async () => {
    const list = await checks({
      host: LINUX({ distro: "Fedora Linux 40" }),
      ports: { run: () => ({ status: 0, stdout: "git version 2.20.0" }) },
    });
    expect(found(list, "git").fix).toContain("your distribution's backports");
  });
});

describe("disk", () => {
  it("reports the free space where the data lives", async () => {
    expect(found(await checks(), "disk")).toMatchObject({
      status: "ok",
      detail: "8.0 GB free on /box/.local/state/volli-runner",
    });
  });

  it("fails under a gigabyte, naming the directory to clear", async () => {
    const list = await checks({ ports: { freeBytes: () => 512 * 1024 ** 2 } });
    const disk = found(list, "disk");
    expect(disk.status).toBe("fail");
    expect(disk.detail).toBe("512 MB free on /box/.local/state/volli-runner; 1 GB is needed");
    expect(disk.fix).toContain("/box/.local/state/volli-runner");
  });

  it("measures the home when the data directory does not exist yet", async () => {
    const list = await checks({
      ports: {
        freeBytes: (path) => (path === PATHS.dataDir ? null : 2 * GIB),
      },
    });
    expect(found(list, "disk")).toMatchObject({
      status: "ok",
      detail: "2.0 GB free on /box",
    });
  });

  it("is unknown when neither can be measured", async () => {
    const list = await checks({ ports: { freeBytes: () => null } });
    expect(found(list, "disk")).toMatchObject({
      status: "unknown",
      fix: `df -h ${PATHS.dataDir}`,
    });
  });
});

describe("systemd", () => {
  it("passes a box running it", async () => {
    expect(found(await checks(), "systemd")).toMatchObject({
      status: "ok",
      detail: "systemd is running",
    });
  });

  it("warns a box without it, and names how to run the runner there", async () => {
    const list = await checks({ ports: { exists: () => false } });
    expect(found(list, "systemd")).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("volli-runner run"),
    });
  });
});

describe("linger", () => {
  it("passes when the login lingers", async () => {
    expect(found(await checks(), "linger").detail).toBe(
      "volli's user services stay up after logout",
    );
  });

  it("warns when it does not, with the one command that turns it on", async () => {
    const list = await checks({
      ports: {
        run: (command) =>
          command === "git"
            ? { status: 0, stdout: "git version 2.43.0" }
            : { status: 0, stdout: "no" },
      },
    });
    expect(found(list, "linger")).toMatchObject({
      status: "warn",
      fix: "sudo loginctl enable-linger volli",
    });
  });

  it("is unknown when logind will not say", async () => {
    const list = await checks({
      ports: {
        run: (command) =>
          command === "git"
            ? { status: 0, stdout: "git version 2.43.0" }
            : { status: 1, stdout: "" },
      },
    });
    expect(found(list, "linger")).toMatchObject({
      status: "unknown",
      fix: "loginctl show-user volli -p Linger --value",
    });
  });

  it("does not apply to a system install", async () => {
    const list = await checks({
      env: { VOLLI_RUNNER_INSTALL_MODE: "system" },
      paths: { mode: "system", dataDir: "/var/lib/volli-runner", configDir: "/etc/volli-runner" },
    });
    expect(found(list, "linger")).toMatchObject({ status: "info" });
  });
});

describe("model logins", () => {
  it("reports the providers the box holds, by kind", async () => {
    const list = await checks({
      ports: {
        storedCredentials: async () => ({
          state: "listed",
          providers: [
            { providerId: "anthropic", kind: "subscription" },
            { providerId: "openai", kind: "api-key" },
          ],
        }),
      },
    });
    expect(found(list, "models")).toMatchObject({
      status: "ok",
      detail: "signed in: anthropic (subscription), openai (API key)",
    });
  });

  it("counts an ambient key by name, and does not repeat a provider already stored", async () => {
    const list = await checks({
      env: { USER: "volli", ANTHROPIC_API_KEY: "sk-secret", OPENROUTER_API_KEY: "or-secret" },
    });
    const models = found(list, "models");
    expect(models.status).toBe("warn");
    expect(models.detail).toBe(
      "stored: anthropic (subscription); API keys in this shell only: openrouter. The service does not inherit them.",
    );
    expect(models.fix).toBe("volli-runner login openrouter");
    expect(JSON.stringify(list)).not.toContain("sk-secret");
    expect(JSON.stringify(list)).not.toContain("or-secret");
  });

  it("does not call a shell-only API key a service login", async () => {
    const list = await checks({
      env: { OPENAI_API_KEY: "shell-only-secret" },
      ports: { storedCredentials: async () => ({ state: "listed", providers: [] }) },
    });
    expect(found(list, "models")).toMatchObject({
      status: "warn",
      fix: "volli-runner login openai",
    });
    expect(found(list, "models").detail).toContain("this shell only");
    expect(JSON.stringify(list)).not.toContain("shell-only-secret");
  });
  it("warns a box signed in to nothing, and names the login command", async () => {
    const list = await checks({
      env: { USER: "volli", OPENAI_API_KEY: "" },
      ports: { storedCredentials: async () => ({ state: "listed", providers: [] }) },
    });
    expect(found(list, "models")).toMatchObject({
      status: "warn",
      detail: "no model provider is signed in on this box",
      fix: "volli-runner login <provider>",
    });
  });

  it("never claims readiness for a store it cannot read", async () => {
    const list = await checks({
      ports: { storedCredentials: async () => ({ state: "unreadable" }) },
    });
    expect(found(list, "models")).toMatchObject({
      status: "unknown",
      fix: "volli-runner login --status",
    });
  });
});

describe("Chromium", () => {
  it("is reported as absent by design, with nothing to do", async () => {
    const browser = found(await checks(), "browser");
    expect(browser).toMatchObject({ title: "Chromium", status: "info" });
    expect(browser.detail).toContain("by design");
    expect(browser.fix).toBeUndefined();
  });
});

describe("the helpers", () => {
  it("compares dotted versions", () => {
    expect(atLeast("2.31", "2.31")).toBe(true);
    expect(atLeast("2.36", "2.31")).toBe(true);
    expect(atLeast("2.30.2", "2.31")).toBe(false);
    expect(atLeast("2.31.1", "2.31")).toBe(true);
    expect(atLeast("2.31", "2.31.1")).toBe(false);
  });

  it("formats free space in the units a person reads", () => {
    expect(formatBytes(2 * GIB)).toBe("2.0 GB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
  });

  it("names the login from the shell, else from the home directory", () => {
    expect(loginOf({ USER: "volli" }, "/home/other")).toBe("volli");
    expect(loginOf({ LOGNAME: "deploy" }, "/home/other")).toBe("deploy");
    expect(loginOf({}, "/home/other")).toBe("other");
  });

  it("names an install command per distribution, and a generic one otherwise", () => {
    expect(gitInstallFix("Debian GNU/Linux 12 (bookworm)")).toBe("sudo apt-get install -y git");
    expect(gitInstallFix("Ubuntu 22.04.3 LTS")).toBe("sudo apt-get install -y git");
    expect(gitInstallFix("Fedora Linux 40")).toBe("sudo dnf install -y git");
    expect(gitInstallFix("Rocky Linux 9")).toBe("sudo dnf install -y git");
    expect(gitInstallFix("openSUSE Leap 15.5")).toBe("sudo zypper install -y git");
    expect(gitInstallFix("Arch Linux")).toBe("sudo pacman -S --noconfirm git");
    expect(gitInstallFix("Gentoo")).toContain("from your distribution's packages");
    expect(gitInstallFix(null)).toContain("from your distribution's packages");
  });

  it("asks for a newer source when the package is merely old", () => {
    expect(gitUpgradeFix("Debian GNU/Linux 12")).toContain("Debian backports or the git-core PPA");
    expect(gitUpgradeFix("Gentoo")).toContain("your distribution's backports");
    expect(gitUpgradeFix(null)).toContain("your distribution's backports");
  });

  it("reads an install mode from the unit, else from the paths", () => {
    expect(installModeOf({ VOLLI_RUNNER_INSTALL_MODE: "system" }, "user")).toBe("system");
    expect(installModeOf({ VOLLI_RUNNER_INSTALL_MODE: "user" }, "system")).toBe("user");
    expect(installModeOf({ VOLLI_RUNNER_INSTALL_MODE: "nonsense" }, "user")).toBe("user");
    expect(installModeOf({}, "system")).toBe("system");
  });

  it("tells a set environment entry from a blank one", () => {
    expect(isSet("sk-live")).toBe(true);
    expect(isSet("")).toBe(false);
    expect(isSet(undefined)).toBe(false);
  });
});
