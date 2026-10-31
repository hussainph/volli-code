import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CommandInput } from "../commands";
import type { RunnerStatus } from "../shell/runner-status";
import { testContext } from "../testing/context";
import { installLayout, proxyEnvironment, serviceUnit, unitPath, unitQuote, UNIT } from "./layout";
import { asRunner, installRunner, systemctl, type InstallPorts } from "./manage";
import type { RunTool } from "./tools";
import { uninstallRunner } from "./uninstall";

vi.mock("node:fs", async (original) => {
  const real = await original<typeof fs>();
  return { ...real, openSync: vi.fn(real.openSync) };
});
const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;

let root: string;
let source: string;
let context: ReturnType<typeof testContext>;
let calls: { command: string; args: string[] }[];
let run: RunTool;
let ports: InstallPorts;
const input = (values: CommandInput["values"] = {}): CommandInput => ({ values, positionals: [] });

function status(pid = 10, version = "9.9.9-test"): RunnerStatus {
  return {
    v: 1,
    pid,
    version,
    state: "online",
    dataDir: root,
    socketPath: "/socket",
    startedAt: "2026-01-01",
    updatedAt: "2026-01-01",
    link: { runnerId: "runner-id" as never, name: "hetzner-1", server: "https://example.com" },
    backend: null,
    update: null,
    credentials: null,
  };
}

beforeEach(() => {
  vi.mocked(fs.openSync).mockImplementation(realOpen);
  root = mkdtempSync(join(tmpdir(), "runner-install-"));
  source = join(root, "unpacked");
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "bin/node"), "node", { mode: 0o755 });
  writeFileSync(join(source, "bin/volli-runner"), "runner", { mode: 0o755 });
  writeFileSync(
    join(source, "MANIFEST.json"),
    JSON.stringify({
      name: "volli-runner",
      version: "9.9.9-test",
      revision: "abc123",
      target: "linux-x64",
    }),
  );
  context = testContext({ root, env: { PATH: join(root, ".local/bin") } });
  calls = [];
  run = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "yes\n" };
  };
  ports = {
    run,
    platform: "linux",
    systemd: true,
    systemInstallPresent: false,
    ownRelease: source,
    confirmPurge: () => false,
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function layout() {
  return installLayout(input(), context);
}
async function install(values: CommandInput["values"] = {}) {
  return installRunner(
    input({ "no-link": true, "no-start": true, ...values }),
    context,
    layout(),
    ports,
  );
}

const directives = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replaceAll('"', ""));

describe("managed layout and units", () => {
  it("lays out system/default user/XDG modes without relative XDG paths", () => {
    expect(layout()).toMatchObject({
      mode: "user",
      root: join(root, ".local/share/volli-runner"),
      configDir: join(root, ".config/volli-runner"),
    });
    expect(
      installLayout(input(), {
        ...context,
        env: {
          XDG_DATA_HOME: "/xdg/data",
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_STATE_HOME: "relative",
        },
      }),
    ).toMatchObject({
      root: "/xdg/data/volli-runner",
      configDir: "/xdg/config/volli-runner",
      dataDir: join(root, ".local/state/volli-runner"),
    });
    expect(installLayout(input(), { ...context, uid: 0 }, root)).toMatchObject({
      mode: "system",
      root: join(root, "opt/volli-runner"),
      binDir: join(root, "usr/local/bin"),
    });
    expect(() => installLayout(input({ user: true, system: true }), context)).toThrow("not both");
    expect(() => installLayout(input({ user: true }), { ...context, uid: 0 })).toThrow("root");
    expect(() => installLayout(input({ system: true }), context)).toThrow("sudo");
    expect(installLayout(input({ user: true }), context).mode).toBe("user");
  });
  it("escapes systemd specifiers, quotes and backslashes; rejects injection", () => {
    expect(unitQuote('a%"\\b')).toBe('"a%%\\"\\\\b"');
    expect(() => unitQuote("x\nUser=root")).toThrow("control character");
    expect(() => unitQuote("\u007f")).toThrow("control character");
    const sys = installLayout(input(), { ...context, uid: 0 }, root);
    const unit = serviceUnit(sys, { HTTPS_PROXY: "http://proxy/p%20", NO_PROXY: "localhost" });
    for (const line of [
      "User=volli",
      "ProtectHome=yes",
      "Restart=always",
      "TimeoutStopSec=45",
      "CapabilityBoundingSet=",
      "NODE_USE_ENV_PROXY=1",
      "WantedBy=multi-user.target",
    ])
      expect(unit).toContain(line);
    expect(unit).not.toContain("Requires=");
    expect(unit).not.toContain("http://proxy");
    expect(proxyEnvironment({ HTTPS_PROXY: "http://proxy/p%20", NO_PROXY: "localhost" })).toBe(
      'HTTPS_PROXY="http://proxy/p%20"\nNO_PROXY="localhost"\n',
    );
    expect(unit).toContain("ExecStart=:");
    expect(unit.split("\n")).toContain(`WorkingDirectory=${sys.dataDir}`);
    expect(unit.split("\n")).toContain(`EnvironmentFile=-${sys.root}/proxy.env`);
    expect(unitPath("/with space/100%")).toBe("/with space/100%%");
    expect(() => unitPath("relative")).toThrow("must be absolute");
    expect(() => unitPath("/trailing ")).toThrow("must be absolute");
    expect(() => unitPath("/control\n")).toThrow("control character");
    for (const char of ['"', "'", "\\", "*", "?", "[", "]"])
      expect(() => unitPath(`/unsafe${char}path`)).toThrow("must be absolute");
    expect(unit).toContain("Environment=VOLLI_RUNNER_SERVICE=1");
    expect(serviceUnit(layout(), {})).toContain("Environment=VOLLI_RUNNER_SERVICE=1");
    const user = serviceUnit(layout(), {});
    expect(user).not.toContain("User=volli");
    expect(user).not.toContain("ProtectHome=yes");
    expect(user).not.toContain("PrivateTmp=yes");
    expect(user).not.toContain("ProtectSystem=");
    expect(user).not.toContain("network-online.target");
    expect(unit).toContain(`ReadWritePaths="${sys.configDir}"`);
    expect(user).toContain("WantedBy=default.target");
    expect(systemctl(sys, ["start"])).toEqual(["start"]);
    expect(systemctl(layout(), ["start"])).toEqual(["--user", "start"]);
    const shipped = readFileSync(
      join(import.meta.dirname, "../../packaging/volli-runner.service"),
      "utf8",
    );
    for (const line of [
      "Restart=always",
      "TimeoutStopSec=45",
      "NoNewPrivileges=yes",
      "ProtectHome=yes",
      "CapabilityBoundingSet=",
      "RestartPreventExitStatus=78",
    ])
      expect(shipped).toContain(line);
    expect(shipped).not.toContain("Requires=");
    const defaults = installLayout(input(), { ...context, uid: 0 });
    expect(directives(shipped)).toEqual(directives(serviceUnit(defaults, {})));
  });
});

describe("install", () => {
  it("converges with private data/config, an immutable release and managed links", async () => {
    expect(await install()).toBe(0);
    const at = layout();
    expect(lstatSync(at.dataDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(at.configDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(at.unitDir, UNIT)).mode & 0o777).toBe(0o600);
    expect(readlinkSync(join(at.root, "current"))).toBe(
      join(at.root, "releases/9.9.9-test-abc123"),
    );
    expect(readlinkSync(join(at.binDir, "volli-runner"))).toBe(
      join(at.root, "current/bin/volli-runner"),
    );
    expect(JSON.parse(readFileSync(join(at.root, "managed.json"), "utf8")).channel).toBe("stable");
    const second = testContext({ root, env: context.env as Record<string, string> });
    await installRunner(input({ "no-link": true, "no-start": true }), second, at, ports);
    expect(second.stdout()).toContain('"changed":false');
    chmodSync(at.configDir, 0o755);
    await install();
    expect(lstatSync(at.configDir).mode & 0o777).toBe(0o700);
  });
  it("makes release code readable despite umask077, without loosening shared directories or symlink targets", async () => {
    const at = layout();
    mkdirSync(at.binDir, { recursive: true, mode: 0o700 });
    mkdirSync(at.unitDir, { recursive: true, mode: 0o700 });
    const outside = join(root, "private-target");
    writeFileSync(outside, "untouched", { mode: 0o600 });
    symlinkSync(outside, join(source, "link"));
    chmodSync(join(source, "bin/node"), 0o700);
    const previous = process.umask(0o077);
    try {
      await install();
    } finally {
      process.umask(previous);
    }
    const release = readlinkSync(join(at.root, "current"));
    expect(lstatSync(release).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(release, "bin")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(release, "bin/node")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(release, "MANIFEST.json")).mode & 0o777).toBe(0o644);
    expect(lstatSync(outside).mode & 0o777).toBe(0o600);
    expect(lstatSync(at.binDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(at.unitDir).mode & 0o777).toBe(0o700);
    chmodSync(release, 0o700);
    await install();
    expect(lstatSync(release).mode & 0o777).toBe(0o755);
  });
  it("persists only a validated nondefault bootstrap release origin and preserves manual config", async () => {
    context = {
      ...context,
      env: { VOLLI_RUNNER_RELEASE_BASE: "http://127.0.0.1:8080/prefix/v9.9.9-test" },
    };
    await install();
    const file = join(layout().root, "update.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      releaseOrigin: "http://127.0.0.1:8080/prefix/",
    });
    await install();
    context = { ...context, env: {} };
    await install();
    expect(existsSync(file)).toBe(true);
    context = {
      ...context,
      env: {
        VOLLI_RUNNER_RELEASE_BASE:
          "https://github.com/hussainph/volli-code/releases/download/v9.9.9-test",
      },
    };
    await install();
    expect(existsSync(file)).toBe(false);
    await install();
  });
  it("compares managed bytes through a no-follow descriptor and refuses unexpected read errors", async () => {
    await install();
    const at = layout();
    const managed = join(at.root, "managed.json");
    const outside = join(root, "outside-managed");
    writeFileSync(outside, "not read or overwritten");
    rmSync(managed);
    symlinkSync(outside, managed);
    await install();
    expect(lstatSync(managed).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("not read or overwritten");
    chmodSync(join(at.root, "proxy.env"), 0o644);
    await install();
    expect(lstatSync(join(at.root, "proxy.env")).mode & 0o777).toBe(0o600);
    vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
      if (file === managed) throw Object.assign(new Error("read denied"), { code: "EACCES" });
      return realOpen(file, flags, mode);
    });
    await expect(install()).rejects.toMatchObject({ code: "EACCES" });
  });
  it("does not read a directory as a managed file", async () => {
    await install();
    const unit = join(layout().unitDir, UNIT);
    rmSync(unit);
    mkdirSync(unit);
    await expect(install()).rejects.toThrow();
  });
  it("copies proxy settings without exposing them in JSON; no-systemd prints an unprivileged foreground command", async () => {
    context = testContext({ root, env: { HTTPS_PROXY: "https://secret@proxy" } });
    ports.systemd = false;
    await install();
    expect(context.stdout()).toContain("Start with:");
    expect(context.stdout()).not.toContain("secret@proxy");
    expect(context.stderr()).toContain("PATH");
    expect(calls).toEqual([]);
    expect(existsSync(join(layout().unitDir, UNIT))).toBe(false);
  });
  it("keeps proxy passwords out of systemd properties and restarts on private proxy changes", async () => {
    await install();
    context = { ...context, env: { HTTPS_PROXY: "http://user:secret%20@proxy.test" } };
    let reads = 0;
    context = {
      ...context,
      statusProbes: {
        read: () => status(reads++ === 0 ? 10 : 11),
        alive: () => true,
        accepts: async () => true,
      },
    };
    calls.length = 0;
    expect(await install({ "no-start": false })).toBe(0);
    const at = layout();
    expect(readFileSync(join(at.root, "proxy.env"), "utf8")).toBe(
      'HTTPS_PROXY="http://user:secret%20@proxy.test"\n',
    );
    expect(lstatSync(join(at.root, "proxy.env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(at.unitDir, UNIT), "utf8")).not.toContain("user:secret");
    expect(calls.some((call) => call.args.includes("restart"))).toBe(true);
    expect(context.stdout() + context.stderr()).not.toContain("user:secret");
  });
  it("creates a system account, drops uid for linking, and never passes the token as argv", async () => {
    context = { ...context, uid: 0 };
    const at = installLayout(input(), context, root);
    ports.systemd = false;
    const child = vi.fn<RunTool>().mockReturnValue({ status: 0, stdout: "" });
    ports.run = (command, args, options) => {
      if (command === "id") return { status: 1, stdout: "" };
      return child(command, args, options);
    };
    await installRunner(
      input({
        "no-start": true,
        token: "vrt_secret",
        name: "box",
        server: "https://deployment.convex.cloud",
        site: "https://deployment.convex.site",
      }),
      context,
      at,
      ports,
    );
    expect(child.mock.calls.some(([cmd]) => cmd === "useradd")).toBe(true);
    const link = child.mock.calls.find(([cmd]) => cmd === "runuser")!;
    expect(link[1]).toContain("link");
    expect(link[1]).not.toContain("vrt_secret");
    expect(link[2]?.env).toMatchObject({
      VOLLI_RUNNER_TOKEN: "vrt_secret",
      HOME: at.dataDir,
      VOLLI_RUNNER_INSTALL_MODE: "system",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(context.stdout()).toContain("sudo -u volli");
    expect(context.stdout()).not.toContain("vrt_secret");
    asRunner(at, context, child, ["status"]);
    expect(child.mock.calls.at(-1)?.[2]?.inherit).toBe(false);
  });
  it("validates proxy configuration without exposing a credential before spawning link/revoke", () => {
    const child = vi.fn<RunTool>();
    expect(() =>
      asRunner(
        layout(),
        { ...context, env: { HTTPS_PROXY: "https://user:secret@not a host" } },
        child,
        ["link"],
      ),
    ).toThrow("Invalid HTTP_PROXY/HTTPS_PROXY");
    expect(child).not.toHaveBeenCalled();
  });
  it("refuses malformed proxies even for no-link installs before writing files", async () => {
    context = { ...context, env: { HTTPS_PROXY: "https://user:secret@not a host" } };
    await expect(install()).rejects.toThrow("Invalid HTTP_PROXY/HTTPS_PROXY");
    expect(existsSync(layout().root)).toBe(false);
    expect(existsSync(layout().dataDir)).toBe(false);
  });
  it("accepts only an existing service account with the dedicated home", async () => {
    const at = installLayout(input(), { ...context, uid: 0 }, root);
    ports.run = (cmd) => ({
      status: 0,
      stdout: cmd === "getent" ? `volli:x:123:123::${at.dataDir}:/bin/bash` : "",
    });
    await installRunner(input({ "no-link": true, "no-start": true }), context, at, ports);
    ports.run = () => ({ status: 0, stdout: "volli:x:123:123::/var/lib/volli-hostd:/bin/bash" });
    await expect(installRunner(input(), context, at, ports)).rejects.toThrow(
      "another installation",
    );
  });
  it("uses the env token for user linking and never re-links an existing credential", async () => {
    await install({ "no-link": false });
    expect(calls.some((c) => c.args[0] === "link")).toBe(true);
    writeFileSync(join(layout().configDir, "credential"), "sealed");
    calls.length = 0;
    await install({ "no-link": false });
    expect(calls.some((c) => c.args[0] === "link")).toBe(false);
  });
  it("enables linger or prints its one recovery command", async () => {
    ports.run = (cmd, args) => ({
      status: args[0] === "enable-linger" ? 1 : 0,
      stdout: cmd === "loginctl" ? "no" : "",
    });
    await install();
    expect(context.stderr()).toContain("sudo loginctl enable-linger 1000");
    ports.run = () => ({ status: 0, stdout: "no" });
    await install();
  });
  it("requires a live online status at this version and a new pid after restart", async () => {
    let reads = 0;
    context = {
      ...context,
      statusProbes: {
        read: () => status(reads++ === 0 ? 10 : 11),
        alive: () => true,
        accepts: async () => true,
      },
    };
    expect(await install({ "no-start": false })).toBe(0);
    expect(context.stdout()).toContain("hetzner-1 is online.\n");
    expect(calls.some((c) => c.args.includes("restart"))).toBe(true);
    calls.length = 0;
    const second = testContext({
      root,
      env: context.env as Record<string, string>,
      statusProbes: context.statusProbes,
    });
    await installRunner(input({ "no-link": true }), second, layout(), ports);
    expect(second.stdout()).toContain('"changed":false');
    expect(calls.some((c) => c.args.includes("restart"))).toBe(false);
  });
  it("restarts a previously unlinked process after linking even when the unit and release are unchanged", async () => {
    await install();
    let reads = 0;
    context = {
      ...context,
      statusProbes: {
        read: () => status(reads++ === 0 ? 10 : 11),
        alive: () => true,
        accepts: async () => true,
      },
    };
    calls.length = 0;
    expect(await install({ "no-link": false, "no-start": false })).toBe(0);
    expect(calls.some((call) => call.args.includes("restart"))).toBe(true);
  });
  it("recovers activation interrupted before restart and starts a stopped install", async () => {
    await install();
    let reads = 0;
    context = {
      ...context,
      statusProbes: {
        read: () => (reads++ === 0 ? status(10, "8.0.0") : { ...status(11), link: null }),
        alive: () => true,
        accepts: async () => true,
      },
    };
    expect(await install({ "no-start": false })).toBe(0);
    expect(context.stdout()).toContain("Runner is online.");
    ports.run = (cmd, args) => ({
      status: cmd === "systemctl" && args.includes("is-enabled") ? 1 : 0,
      stdout: "yes",
    });
    let count = 0;
    context = {
      ...context,
      statusProbes: {
        read: () => (count++ === 0 ? null : status()),
        alive: () => true,
        accepts: async () => true,
      },
    };
    expect(await install({ "no-start": false })).toBe(0);
  });
  it("times out rather than believing a stale/wrong-version status; aborts promptly", async () => {
    expect(await install({ "no-start": false })).toBe(1);
    expect(context.stderr()).toContain("no status file");
    context = {
      ...context,
      statusProbes: {
        read: () => status(10, "8.0.0"),
        alive: () => true,
        accepts: async () => true,
      },
    };
    expect(await install({ "no-start": false })).toBe(1);
    expect(context.stderr()).toContain("online");
    // Even at the requested version, an activation must not believe the old pid.
    const manifest = JSON.parse(readFileSync(join(source, "MANIFEST.json"), "utf8"));
    manifest.revision = "next-revision";
    writeFileSync(join(source, "MANIFEST.json"), JSON.stringify(manifest));
    context = {
      ...context,
      statusProbes: { read: () => status(), alive: () => true, accepts: async () => true },
    };
    expect(await install({ "no-start": false })).toBe(1);
    context = {
      ...context,
      signal: AbortSignal.abort(),
      statusProbes: { read: () => "unreadable", alive: () => true, accepts: async () => true },
    };
    expect(await install({ "no-start": false })).toBe(1);
  });
  it("refuses a different binary, platform, metadata or conflicting paths", async () => {
    await expect(install({ channel: "nightly" })).rejects.toThrow("channel");
    await expect(install({ version: "1.0.0" })).rejects.toThrow("requested release");
    ports.platform = "darwin";
    await expect(install()).rejects.toThrow("Linux");
    ports.platform = "linux";
    writeFileSync(join(source, "MANIFEST.json"), "{}");
    await expect(install()).rejects.toThrow("Not this runner");
  });
  it("checks manifest target, revision, semver and regular entrypoints", async () => {
    const manifest = {
      name: "volli-runner",
      version: "9.9.9-test",
      revision: "abc123",
      target: "linux-x64",
    };
    for (const bad of [
      { ...manifest, target: undefined },
      { ...manifest, revision: undefined },
      { ...manifest, version: "bad" },
      { ...manifest, name: "other" },
    ]) {
      writeFileSync(join(source, "MANIFEST.json"), JSON.stringify(bad));
      await expect(install()).rejects.toThrow("Not this runner");
    }
    writeFileSync(join(source, "MANIFEST.json"), JSON.stringify(manifest));
    rmSync(join(source, "bin/node"));
    mkdirSync(join(source, "bin/node"));
    await expect(install()).rejects.toThrow("regular bin/node");
  });
  it("refuses a user install beside a system service and reports a system journal on timeout", async () => {
    ports.systemInstallPresent = true;
    await expect(install()).rejects.toThrow("system runner is already installed");
    const sysContext = { ...context, uid: 0 };
    const at = installLayout(input(), sysContext, root);
    ports.run = (cmd, args) => {
      calls.push({ command: cmd, args });
      return { status: 0, stdout: cmd === "getent" ? `volli:x:1:1::${at.dataDir}:/bin/bash` : "" };
    };
    expect(await installRunner(input({ "no-link": true }), sysContext, at, ports)).toBe(1);
    expect(calls.find((c) => c.command === "journalctl")?.args).not.toContain("--user");
  });
  it("never overwrites an immutable release or an unrelated CLI", async () => {
    await install();
    writeFileSync(
      join(source, "MANIFEST.json"),
      readFileSync(join(source, "MANIFEST.json"), "utf8") + " ",
    );
    await expect(install()).rejects.toThrow("immutable release");
    writeFileSync(
      join(source, "MANIFEST.json"),
      readFileSync(join(source, "MANIFEST.json"), "utf8").trim(),
    );
    const cli = join(layout().binDir, "volli-runner");
    rmSync(cli);
    writeFileSync(cli, "other");
    await expect(install()).rejects.toThrow("not a managed symlink");
    rmSync(cli);
    symlinkSync("/other/missing", cli);
    await expect(install()).rejects.toThrow("outside");
  });
  it("updates managed current symlinks and refuses symlink directories", async () => {
    await install();
    const manifest = JSON.parse(readFileSync(join(source, "MANIFEST.json"), "utf8"));
    manifest.revision = "def456";
    writeFileSync(join(source, "MANIFEST.json"), JSON.stringify(manifest));
    await install({ from: source, channel: "canary" });
    expect(readlinkSync(join(layout().root, "current"))).toContain("def456");
    rmSync(layout().configDir, { recursive: true });
    symlinkSync(source, layout().configDir);
    await expect(install()).rejects.toThrow("not a symlink");
  });
});

describe("uninstall", () => {
  it("keeps data and encryption keys by default and is idempotent", async () => {
    await install();
    const at = layout();
    writeFileSync(join(at.dataDir, "work"), "unpushed commit");
    writeFileSync(join(at.configDir, "session-secrets.key"), "key");
    writeFileSync(join(at.configDir, "credential"), "sealed");
    writeFileSync(join(at.configDir, "credential.key"), "key");
    expect(await uninstallRunner(input(), context, at, ports)).toBe(0);
    expect(calls.some((c) => c.args.includes("--revoke-only"))).toBe(true);
    expect(readFileSync(join(at.dataDir, "work"), "utf8")).toBe("unpushed commit");
    expect(existsSync(join(at.configDir, "session-secrets.key"))).toBe(true);
    expect(existsSync(join(at.configDir, "credential"))).toBe(false);
    expect(existsSync(at.root)).toBe(false);
    const second = testContext({ root });
    await uninstallRunner(input(), second, at, ports);
    expect(second.stdout()).toContain('"changed":false');
  });
  it("cleans up an interrupted uninstall's dangling managed link and orphaned credential key", async () => {
    const at = layout();
    mkdirSync(at.binDir, { recursive: true });
    mkdirSync(at.configDir, { recursive: true });
    symlinkSync(join(at.root, "current/bin/volli-runner"), join(at.binDir, "volli-runner"));
    await uninstallRunner(input(), context, at, ports);
    expect(context.stdout()).toContain('"changed":true');
    writeFileSync(join(at.configDir, "credential.key"), "orphaned");
    const next = testContext({ root });
    await uninstallRunner(input(), next, at, ports);
    expect(next.stdout()).toContain('"changed":true');
  });
  it("requires explicit purge consent; then removes data and the dedicated account", async () => {
    await install();
    const at = layout();
    expect(await uninstallRunner(input({ purge: true }), context, at, ports)).toBe(2);
    expect(existsSync(at.dataDir)).toBe(true);
    await expect(
      uninstallRunner(input({ purge: true, "keep-data": true }), context, at, ports),
    ).rejects.toThrow("not both");
    const sys = { ...at, mode: "system" as const };
    ports.run = (cmd, args) => {
      calls.push({ command: cmd, args });
      return {
        status: cmd === "pgrep" ? 1 : 0,
        stdout: cmd === "getent" ? `volli:x:1:1::${at.dataDir}:/bin/bash` : "",
      };
    };
    expect(await uninstallRunner(input({ purge: true, yes: true }), context, sys, ports)).toBe(0);
    expect(existsSync(at.dataDir)).toBe(false);
    expect(calls.some((c) => c.command === "userdel")).toBe(true);
  });
  it("lists work at risk, accepts a tty confirmation, and keeps an account shared with another install", async () => {
    await install();
    const at = layout();
    mkdirSync(join(at.dataDir, "copy"));
    writeFileSync(join(at.dataDir, "copy/.git"), "gitdir: elsewhere");
    ports.confirmPurge = () => true;
    ports.run = (command, args) => {
      calls.push({ command, args });
      if (command === "runuser" && args.includes("--purge")) {
        for (const path of [at.dataDir, at.configDir])
          for (const name of readdirSync(path))
            rmSync(join(path, name), { recursive: true, force: true });
      }
      return { status: command === "pgrep" ? 1 : 0, stdout: "different-home" };
    };
    expect(
      await uninstallRunner(input({ purge: true }), context, { ...at, mode: "system" }, ports),
    ).toBe(0);
    expect(context.stderr()).toContain("Uncommitted, unpushed or unverifiable work");
    expect(context.stderr()).toContain("Kept the volli account");
    expect(calls.some((call) => call.command === "git")).toBe(false);
    expect(calls.some((call) => call.command === "runuser" && call.args.includes("git"))).toBe(
      true,
    );
  });
  it("refuses to purge data while another service-user process remains alive", async () => {
    await install();
    const at = layout();
    ports.run = (cmd) => ({
      status: 0,
      stdout: cmd === "getent" ? `volli:x:1:1::${at.dataDir}:/bin/bash` : "",
    });
    await expect(
      uninstallRunner(input({ purge: true, yes: true }), context, { ...at, mode: "system" }, ports),
    ).rejects.toThrow("remaining processes");
    expect(existsSync(at.dataDir)).toBe(true);
  });
  it("keeps the privileged parent away from an agent-controlled lock symlink and fails closed without pgrep", async () => {
    await install();
    const at = layout();
    const victim = join(root, "outside-lock");
    writeFileSync(victim, "not a database");
    symlinkSync(victim, join(at.dataDir, "runner.lock"));
    const sys = { ...at, mode: "system" as const };
    calls.length = 0;
    expect(await uninstallRunner(input(), context, sys, ports)).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("not a database");
    expect(calls.some((call) => call.command === "chown")).toBe(false);
    expect(
      calls.some((call) => call.command === "runuser" && call.args.includes("--revoke-only")),
    ).toBe(true);
    ports.run = (command) => ({ status: command === "id" ? 0 : 127, stdout: "" });
    await expect(
      uninstallRunner(input({ purge: true, yes: true }), context, sys, ports),
    ).rejects.toThrow("Install procps");
  });
  it("warns about user-owned working copies before a user purge", async () => {
    await install();
    const at = layout();
    mkdirSync(join(at.dataDir, "copy"));
    writeFileSync(join(at.dataDir, "copy/.git"), "gitdir: elsewhere");
    expect(await uninstallRunner(input({ purge: true, yes: true }), context, at, ports)).toBe(0);
    expect(calls.some((call) => call.command === "git")).toBe(true);
  });
  it("allows keep-data removal without a service account but refuses an unsafe purge", async () => {
    await install();
    const at = layout();
    writeFileSync(join(at.configDir, "credential"), "sealed");
    ports.run = (command, args) => {
      calls.push({ command, args });
      return { status: command === "id" ? 1 : 0, stdout: "" };
    };
    const sys = { ...at, mode: "system" as const };
    await expect(
      uninstallRunner(input({ purge: true, yes: true }), context, sys, ports),
    ).rejects.toThrow("account is missing");
    expect(existsSync(at.dataDir)).toBe(true);
    calls.length = 0;
    expect(await uninstallRunner(input(), context, sys, ports)).toBe(0);
    expect(context.stderr()).toContain("remote unlink was skipped");
    expect(calls.some((call) => call.command === "runuser")).toBe(false);
  });
  it("names managed directories left nonempty rather than recursively deleting them as root", async () => {
    await install();
    const at = layout();
    writeFileSync(join(at.dataDir, "unemptied"), "kept");
    ports.run = (command) => ({
      status: command === "pgrep" ? 1 : 0,
      stdout: "other-account-home",
    });
    await expect(
      uninstallRunner(input({ purge: true, yes: true }), context, { ...at, mode: "system" }, ports),
    ).rejects.toThrow("Managed directory was not emptied");
    expect(readFileSync(join(at.dataDir, "unemptied"), "utf8")).toBe("kept");
  });
  it("runs the owner helper for a config-only system installation", async () => {
    const at = { ...layout(), mode: "system" as const };
    mkdirSync(at.configDir, { recursive: true });
    expect(await uninstallRunner(input(), context, at, ports)).toBe(0);
    expect(
      calls.some((call) => call.command === "runuser" && call.args.includes("--revoke-only")),
    ).toBe(true);
  });
  it("does not remove an absent account or a user account", async () => {
    ports.systemd = false;
    ports.run = () => ({ status: 1, stdout: "" });
    await uninstallRunner(
      input({ purge: true, yes: true }),
      context,
      { ...layout(), mode: "system" },
      ports,
    );
    await uninstallRunner(input({ purge: true, yes: true }), context, layout(), ports);
  });
  it("refuses a different CLI, a directory where the unit should be, or an unsupported platform", async () => {
    await install();
    const at = layout();
    rmSync(join(at.binDir, "volli-runner"));
    writeFileSync(join(at.binDir, "volli-runner"), "other");
    await expect(uninstallRunner(input(), context, at, ports)).rejects.toThrow("not this install");
    rmSync(join(at.binDir, "volli-runner"));
    symlinkSync(source, join(at.binDir, "volli-runner"));
    await expect(uninstallRunner(input(), context, at, ports)).rejects.toThrow("not this install");
    rmSync(join(at.binDir, "volli-runner"));
    rmSync(join(at.unitDir, UNIT));
    mkdirSync(join(at.unitDir, UNIT));
    await expect(uninstallRunner(input(), context, at, ports)).rejects.toThrow("unexpectedly");
    ports.platform = "darwin";
    await expect(uninstallRunner(input(), context, at, ports)).rejects.toThrow("Linux");
  });
});
