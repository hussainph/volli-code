import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  currentVersion,
  installedReleases,
  runInstall,
  type InstallCommand,
  type InstallPorts,
} from "./install";
import { installLayout, type InstallLayout } from "./layout";
import { ManagementError, readManaged, type CommandResult } from "./management";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-install-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An unpacked release, as scripts/package.mjs lays one out. */
function release(
  version: string,
  revision = "abc",
  at = join(root, `unpacked-${version}-${revision}`),
): string {
  mkdirSync(join(at, "bin"), { recursive: true });
  mkdirSync(join(at, "share/systemd"), { recursive: true });
  writeFileSync(
    join(at, "MANIFEST.json"),
    JSON.stringify({ name: "volli-hostd", version, revision }),
  );
  writeFileSync(join(at, "bin/volli-hostd"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(at, "share/systemd/volli-hostd.service"), `[Service]\n# ${version}\n`);
  writeFileSync(join(at, "share/systemd/volli-hostd.socket"), "[Socket]\n");
  return at;
}

/** A fake box: every tool answers from `answers`, or succeeds silently. */
function box(answers: Record<string, (args: readonly string[]) => Partial<CommandResult>> = {}) {
  const calls: string[] = [];
  const run = (tool: string, args: readonly string[]): CommandResult => {
    calls.push([tool, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", ...answers[tool]?.(args) };
  };
  return { calls, run };
}

const VOLLI = { login: "volli", uid: 990, gid: 990 };

function ports(
  layout: InstallLayout,
  overrides: Partial<InstallPorts> = {},
): InstallPorts & { chowned: string[] } {
  const chowned: string[] = [];
  return {
    uid: () => 0,
    layout,
    ownRelease: release("1.0.0"),
    version: "1.0.0",
    run: box({
      systemctl: (args) => (args.includes("is-enabled") ? { stdout: "enabled\nenabled\n" } : {}),
    }).run,
    lookupUser: () => VOLLI,
    chown: (path) => {
      chowned.push(path);
    },
    systemInstallPresent: () => false,
    now: () => new Date("2026-10-07T00:00:00Z"),
    ...overrides,
    chowned,
  };
}

const SYSTEM: InstallCommand = {
  kind: "install",
  mode: "system",
  from: null,
  port: 7420,
  operator: null,
};
const USER: InstallCommand = { ...SYSTEM, mode: "user" };

function systemLayout(): InstallLayout {
  return installLayout("system", { prefix: root, home: join(root, "home"), env: {} });
}

function userLayoutOf(at: string): InstallLayout {
  return installLayout("user", { home: join(at, "nobody"), env: {} });
}

function refusal(work: () => unknown): ManagementError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ManagementError);
    return error as ManagementError;
  }
  throw new Error("expected a refusal");
}

describe("install --system", () => {
  it("sets up a fresh box: the account, the release, the units and a key outside the data directory", () => {
    const layout = systemLayout();
    let account: typeof VOLLI | null = null;
    const fake = box({
      useradd: () => {
        account = VOLLI;
        return {};
      },
      id: () => ({ stdout: "alice sudo\n" }),
      systemctl: (args) => (args.includes("is-enabled") ? { code: 1, stdout: "disabled\n" } : {}),
    });
    const p = ports(layout, { run: fake.run, lookupUser: () => account });
    const result = runInstall({ ...SYSTEM, operator: "alice" }, p);

    expect(result).toMatchObject({
      ok: true,
      mode: "system",
      version: "1.0.0",
      previous: null,
      adopted: null,
      changed: true,
      dataDir: join(root, "var/lib/volli-hostd"),
      binary: join(root, "opt/volli-hostd/current/bin/volli-hostd"),
      listen: { host: "127.0.0.1", port: 7420 },
      serviceUser: "volli",
    });
    expect(result.actions).toEqual([
      "created the volli account",
      "added alice to the volli group",
      `made the data directory ${layout.dataDir}`,
      "installed release 1.0.0",
      "current is 1.0.0",
      `linked ${join(layout.binLinkDir, "volli-hostd")}`,
      `linked ${join(layout.binLinkDir, "volli")}`,
      `made the secret key ${layout.keyFile}`,
      "wrote volli-hostd.service",
      "wrote volli-hostd.socket",
      "wrote secret-key.conf",
      "wrote 50-volli-managed.conf",
      "reloaded systemd",
      "enabled the units",
      "recorded 1.0.0 on port 7420",
    ]);
    expect(fake.calls).toEqual([
      `useradd --system --create-home --home-dir ${layout.dataDir} --shell /bin/bash volli`,
      "id -nG alice",
      "usermod -aG volli alice",
      "systemctl daemon-reload",
      "systemctl is-enabled volli-hostd.socket volli-hostd.service",
      "systemctl enable volli-hostd.socket volli-hostd.service",
    ]);
    expect(statSync(layout.dataDir).mode & 0o777).toBe(0o700);
    expect(p.chowned).toEqual([layout.dataDir, join(root, "etc/volli-hostd"), layout.keyFile]);
    expect(readlinkSync(layout.currentLink)).toBe("releases/1.0.0");
    expect(readlinkSync(join(layout.binLinkDir, "volli"))).toBe(
      join(layout.currentLink, "bin/volli"),
    );
    expect(readFileSync(layout.keyFile, "utf8")).toMatch(/^[A-Za-z0-9+/]{43}=\n$/u);
    expect(statSync(layout.keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(layout.dropInDir, "secret-key.conf"), "utf8")).toBe(
      `[Service]\nEnvironment=VOLLI_SECRET_KEY_FILE=${layout.keyFile}\n`,
    );
    const managed = readFileSync(join(layout.dropInDir, "50-volli-managed.conf"), "utf8");
    expect(managed).toContain("Environment=VOLLI_EXPERIMENTAL=cloud\nExecStart=\n");
    expect(managed).toContain(
      `ExecStart=${layout.currentLink}/bin/volli-hostd --data-dir ${layout.dataDir} --socket /run/volli-hostd.sock --listen 127.0.0.1:7420`,
    );
    expect(statSync(join(layout.unitDir, "volli-hostd.service")).mode & 0o777).toBe(0o644);
    expect(readManaged(layout)).toEqual({
      v: 1,
      mode: "system",
      version: "1.0.0",
      port: 7420,
      installedAt: "2026-10-07T00:00:00.000Z",
    });
    expect(currentVersion(layout)).toBe("1.0.0");
    expect(installedReleases(layout)).toEqual(["1.0.0"]);
    expect(installedReleases(userLayoutOf(root))).toEqual([]);
  });

  it("takes a release whose manifest names no revision", () => {
    const layout = systemLayout();
    const bare = release("1.0.0", "x", join(root, "bare"));
    writeFileSync(
      join(bare, "MANIFEST.json"),
      JSON.stringify({ name: "volli-hostd", version: "1.0.0" }),
    );
    expect(runInstall(SYSTEM, ports(layout, { ownRelease: bare })).version).toBe("1.0.0");
  });

  it("changes nothing the second time, and says so", () => {
    const layout = systemLayout();
    const p = ports(layout);
    runInstall(SYSTEM, p);
    const fake = box({
      id: () => ({ stdout: "alice volli\n" }),
      systemctl: () => ({ stdout: "enabled\nenabled\n" }),
    });
    const again = runInstall({ ...SYSTEM, operator: "alice" }, { ...p, run: fake.run });
    expect(again).toMatchObject({ changed: false, actions: [], previous: "1.0.0" });
    expect(fake.calls).toEqual([
      "id -nG alice",
      "systemctl is-enabled volli-hostd.socket volli-hostd.service",
    ]);
  });

  it("upgrades beside the release before, which stays as the rollback, and moves the port", () => {
    const layout = systemLayout();
    runInstall(SYSTEM, ports(layout));
    const next = runInstall(
      { ...SYSTEM, port: 7500 },
      ports(layout, { ownRelease: release("1.1.0"), version: "1.1.0" }),
    );
    expect(next).toMatchObject({ previous: "1.0.0", version: "1.1.0", changed: true });
    expect(next.actions).toEqual([
      "installed release 1.1.0",
      "current moved from 1.0.0 to 1.1.0",
      "wrote volli-hostd.service",
      "wrote 50-volli-managed.conf",
      "reloaded systemd",
      "recorded 1.1.0 on port 7500",
    ]);
    expect(installedReleases(layout)).toEqual(["1.0.0", "1.1.0"]);
  });

  it("replaces a release of the same version built from another revision", () => {
    const layout = systemLayout();
    runInstall(SYSTEM, ports(layout));
    const rebuilt = runInstall(SYSTEM, ports(layout, { ownRelease: release("1.0.0", "def") }));
    expect(rebuilt.actions).toEqual(["installed release 1.0.0"]);
    expect(
      JSON.parse(readFileSync(join(layout.releasesDir, "1.0.0/MANIFEST.json"), "utf8")),
    ).toMatchObject({
      revision: "def",
    });
    expect(installedReleases(layout)).toEqual(["1.0.0"]);
  });

  it("copies nothing when run from the installed release itself", () => {
    const layout = systemLayout();
    runInstall(SYSTEM, ports(layout));
    const own = join(layout.releasesDir, "1.0.0");
    expect(
      runInstall({ ...SYSTEM, from: own }, ports(layout, { ownRelease: "/nowhere" })).changed,
    ).toBe(false);
  });

  it("adopts the runbook's hand-made box in place: its account, data, key and drop-ins stay", () => {
    const layout = systemLayout();
    mkdirSync(join(layout.root, "bin"), { recursive: true });
    writeFileSync(join(layout.root, "bin/volli-hostd"), "flat");
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o750 });
    writeFileSync(join(layout.dataDir, "session-secrets.key"), "theirs");
    mkdirSync(layout.dropInDir, { recursive: true });
    writeFileSync(
      join(layout.dropInDir, "secret-key.conf"),
      "[Service]\nEnvironment=VOLLI_SECRET_KEY_FILE=/x\n",
    );
    mkdirSync(layout.binLinkDir, { recursive: true });
    symlinkSync(join(layout.root, "bin/volli-hostd"), join(layout.binLinkDir, "volli-hostd"));
    writeFileSync(join(layout.binLinkDir, "volli"), "someone's own script");

    const result = runInstall(SYSTEM, ports(layout));
    expect(result.adopted).toBe("flat");
    expect(result.actions).not.toContain(
      expect.stringMatching(/secret key|data directory|account/u),
    );
    expect(statSync(layout.dataDir).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(layout.dropInDir, "secret-key.conf"), "utf8")).toContain("=/x");
    expect(existsSync(layout.keyFile)).toBe(false);
    expect(readFileSync(join(layout.root, "bin/volli-hostd"), "utf8")).toBe("flat");
    expect(readlinkSync(join(layout.binLinkDir, "volli-hostd"))).toBe(
      join(layout.currentLink, "bin/volli-hostd"),
    );
    expect(readFileSync(join(layout.binLinkDir, "volli"), "utf8")).toBe("someone's own script");
  });

  it("points at a key file already in place rather than making another", () => {
    const layout = systemLayout();
    mkdirSync(join(root, "etc/volli-hostd"), { recursive: true });
    writeFileSync(layout.keyFile, "kept");
    const result = runInstall(SYSTEM, ports(layout));
    expect(result.actions).toContain("wrote secret-key.conf");
    expect(readFileSync(layout.keyFile, "utf8")).toBe("kept");
  });

  it("refuses without root, and refuses a directory that is not this release", () => {
    const layout = systemLayout();
    expect(refusal(() => runInstall(SYSTEM, ports(layout, { uid: () => 1000 })))).toMatchObject({
      code: "not-root",
      exitCode: 77,
    });
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(refusal(() => runInstall({ ...SYSTEM, from: empty }, ports(layout))).code).toBe(
      "bad-release",
    );
    writeFileSync(
      join(empty, "MANIFEST.json"),
      JSON.stringify({ name: "other", version: "1.0.0" }),
    );
    expect(refusal(() => runInstall({ ...SYSTEM, from: empty }, ports(layout))).message).toBe(
      `${empty} is not a volli-hostd release.`,
    );
    expect(
      refusal(() => runInstall(SYSTEM, ports(layout, { ownRelease: release("0.9.0") }))).message,
    ).toMatch(/holds volli-hostd 0\.9\.0, not this binary's 1\.0\.0/u);
  });

  it("names the tool that failed, with its stderr", () => {
    const layout = systemLayout();
    const failing = box({
      id: () => ({ stdout: "alice\n" }),
      usermod: () => ({ code: 6, stderr: "usermod: no group\n" }),
    });
    expect(
      refusal(() =>
        runInstall({ ...SYSTEM, operator: "alice" }, ports(layout, { run: failing.run })),
      ),
    ).toMatchObject({
      code: "command-failed",
      message: "usermod -aG volli alice failed (exit 6).",
      detail: ["usermod: no group"],
    });
    expect(
      refusal(() => runInstall(SYSTEM, ports(layout, { lookupUser: () => null }))).message,
    ).toBe("useradd ran, but there is still no volli.");
  });
});

describe("install --user", () => {
  function userLayout(env: Record<string, string> = {}): InstallLayout {
    return installLayout("user", { home: join(root, "home"), env });
  }

  it("installs a user unit that runs as you, with lingering left to start", () => {
    const layout = userLayout({ XDG_STATE_HOME: join(root, "state") });
    const fake = box({ systemctl: (args) => (args.includes("is-enabled") ? { code: 1 } : {}) });
    const result = runInstall(USER, ports(layout, { uid: () => 1000, run: fake.run }));
    expect(result).toMatchObject({
      mode: "user",
      serviceUser: null,
      dataDir: join(root, "state/volli-hostd"),
    });
    expect(fake.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user is-enabled volli-hostd.service",
      "systemctl --user enable volli-hostd.service",
    ]);
    const unit = readFileSync(join(layout.unitDir, "volli-hostd.service"), "utf8");
    expect(unit).toContain(`Environment=VOLLI_SECRET_KEY_FILE=${layout.keyFile}\n`);
    expect(unit).toContain(
      `ExecStart=${layout.currentLink}/bin/volli-hostd --data-dir ${layout.dataDir} --listen 127.0.0.1:7420\n`,
    );
    expect(unit).not.toContain("User=");
    expect(statSync(layout.releasesDir).mode & 0o777).toBe(0o700);
  });

  it("changes nothing the second time", () => {
    const layout = userLayout();
    runInstall(USER, ports(layout, { uid: () => 1000 }));
    expect(runInstall(USER, ports(layout, { uid: () => 1000 })).changed).toBe(false);
  });

  it("leaves the key hostd already made in the data directory to hostd", () => {
    const layout = userLayout();
    mkdirSync(layout.dataDir, { recursive: true });
    writeFileSync(join(layout.dataDir, "session-secrets.key"), "theirs");
    runInstall(USER, ports(layout, { uid: () => 1000 }));
    expect(readFileSync(join(layout.unitDir, "volli-hostd.service"), "utf8")).not.toContain(
      "VOLLI_SECRET_KEY_FILE",
    );
    expect(existsSync(layout.keyFile)).toBe(false);
  });

  it("refuses root, and refuses to become a second host beside a system unit", () => {
    const layout = userLayout();
    expect(refusal(() => runInstall(USER, ports(layout))).code).toBe("is-root");
    expect(
      refusal(() =>
        runInstall(USER, ports(layout, { uid: () => 1000, systemInstallPresent: () => true })),
      ).code,
    ).toBe("other-mode-installed");
  });
});
