import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CommandContext, CommandInput } from "../commands";
import { LINK_FILE_NAME } from "../link/file-store";
import { stringOption } from "../shell/paths";
import { checkRunnerStatus } from "../shell/runner-status";
import { atomicWrite } from "../shell/write-file";
import { serviceUnit, UNIT, type InstallLayout } from "./layout";
import { mustRun, type RunTool } from "./tools";
import { normalizeReleaseModes } from "./release";

export interface InstallPorts {
  run: RunTool;
  platform: string;
  systemd: boolean;
  systemInstallPresent: boolean;
  ownRelease: string;
  confirmPurge(question: string): boolean;
}

export function systemctl(layout: InstallLayout, args: string[]): string[] {
  return layout.mode === "user" ? ["--user", ...args] : args;
}

/** No shell, and no token on a process command line. System linking runs as the service account. */
export function asRunner(
  layout: InstallLayout,
  context: CommandContext,
  run: RunTool,
  args: string[],
  inherit = false,
): void {
  const cli = join(layout.root, "current/bin/volli-runner");
  const env = {
    ...context.env,
    HOME: layout.mode === "system" ? layout.dataDir : context.home,
    VOLLI_RUNNER_INSTALL_MODE: layout.mode,
  };
  mustRun(
    run,
    layout.mode === "system" ? "runuser" : cli,
    layout.mode === "system" ? ["-u", "volli", "--", cli, ...args] : args,
    { env, inherit },
  );
}

function ensureDirectory(path: string, mode: number, managed = true): boolean {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory())
      throw new Error(`${path} must be a directory, not a symlink.`);
    if (!managed || (lstatSync(path).mode & 0o777) === mode) return false;
  }
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
  return true;
}

function replaceFile(path: string, text: string, mode: number): boolean {
  if (
    existsSync(path) &&
    lstatSync(path).isFile() &&
    readFileSync(path, "utf8") === text &&
    (lstatSync(path).mode & 0o777) === mode
  )
    return false;
  atomicWrite(path, text, mode);
  return true;
}

/** Refuse someone else's executable rather than silently replacing it. */
function replaceLink(path: string, target: string, allowedRoot: string): boolean {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    if (!lstatSync(path).isSymbolicLink())
      throw new Error(`${path} already exists and is not a managed symlink.`);
    const old = readlinkSync(path);
    if (old === target) return false;
    if (!resolve(dirname(path), old).startsWith(`${allowedRoot}/`)) {
      throw new Error(`${path} points outside this runner install; move it aside first.`);
    }
  }
  const temp = `${path}.${process.pid}.tmp`;
  try {
    symlinkSync(target, temp);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return true;
}

export async function installRunner(
  input: CommandInput,
  context: CommandContext,
  layout: InstallLayout,
  ports: InstallPorts,
): Promise<number> {
  if (ports.platform !== "linux")
    throw new Error("Managed runner installation requires Linux; use the Volli Mac app on macOS.");
  const channel = stringOption(input.values, "channel") ?? "stable";
  if (channel !== "stable" && channel !== "canary")
    throw new Error("--channel must be stable or canary.");
  const requested = stringOption(input.values, "version");
  if (requested !== undefined && requested !== context.version)
    throw new Error("Run install from the requested release's binary.");
  const source = realpathSync(
    resolve(context.cwd, stringOption(input.values, "from") ?? ports.ownRelease),
  );
  const manifest = JSON.parse(readFileSync(join(source, "MANIFEST.json"), "utf8")) as {
    name?: string;
    version?: string;
    revision?: string;
    target?: string;
  };
  if (
    manifest.name !== "volli-runner" ||
    manifest.version !== context.version ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version) ||
    !/^linux-(x64|arm64)$/u.test(manifest.target ?? "") ||
    !/^[a-zA-Z0-9._-]+$/u.test(manifest.revision ?? "")
  ) {
    throw new Error(
      "Not this runner's Linux release: check MANIFEST.json and run its bin/volli-runner install.",
    );
  }
  for (const file of ["bin/node", "bin/volli-runner"]) {
    if (!lstatSync(join(source, file)).isFile())
      throw new Error(`Release is missing a regular ${file}.`);
  }
  // Render before touching disk: even a bad proxy value must not leave a partial install.
  const unit = serviceUnit(layout, { ...context.env, HOME: context.home });
  let changed = false;
  if (layout.mode === "system") {
    if (ports.run("id", ["-u", "volli"]).status !== 0) {
      mustRun(ports.run, "useradd", [
        "--system",
        "--user-group",
        "--create-home",
        "--home-dir",
        layout.dataDir,
        "--shell",
        "/bin/bash",
        "volli",
      ]);
      changed = true;
    } else {
      const account = mustRun(ports.run, "getent", ["passwd", "volli"]).stdout.trim().split(":");
      if (account[5] !== layout.dataDir)
        throw new Error(
          "The volli account belongs to another installation. Use a separate login with --user; do not reuse hostd's account.",
        );
    }
  } else if (ports.systemInstallPresent) {
    throw new Error(
      "A system runner is already installed. Use that service instead of adding a second runner.",
    );
  }
  for (const path of [layout.dataDir, layout.configDir])
    changed = ensureDirectory(path, 0o700) || changed;
  if (layout.mode === "system") {
    // Only these directories, never recursive chown of working copies or operator files.
    mustRun(ports.run, "chown", ["volli:volli", layout.dataDir, layout.configDir]);
  }
  for (const path of [layout.root, join(layout.root, "releases")]) {
    changed = ensureDirectory(path, 0o755) || changed;
  }
  changed = ensureDirectory(layout.binDir, 0o755, false) || changed;
  const release = join(layout.root, "releases", `${manifest.version}-${manifest.revision}`);
  if (existsSync(release)) {
    if (
      readFileSync(join(release, "MANIFEST.json"), "utf8") !==
      readFileSync(join(source, "MANIFEST.json"), "utf8")
    ) {
      throw new Error(
        "An installed release has different metadata. Refusing to overwrite an immutable release.",
      );
    }
  } else {
    const stage = `${release}.${process.pid}.tmp`;
    try {
      cpSync(source, stage, { recursive: true, verbatimSymlinks: true });
      normalizeReleaseModes(stage);
      renameSync(stage, release);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    changed = true;
  }
  changed = normalizeReleaseModes(release) || changed;
  const activated = replaceLink(join(layout.root, "current"), release, layout.root);
  changed = activated || changed;
  changed =
    replaceLink(
      join(layout.binDir, "volli-runner"),
      join(layout.root, "current/bin/volli-runner"),
      layout.root,
    ) || changed;
  if (!(context.env["PATH"] ?? "").split(":").includes(layout.binDir))
    context.err(`Add ${layout.binDir} to PATH to run volli-runner.\n`);
  const managed = `${JSON.stringify({ version: context.version, release, channel, mode: layout.mode }, null, 2)}\n`;
  changed = replaceFile(join(layout.root, "managed.json"), managed, 0o644) || changed;
  let unitChanged = false;
  if (ports.systemd) {
    changed = ensureDirectory(layout.unitDir, 0o755, false) || changed;
    // Proxy URLs can contain a password; the unit is not world-readable.
    unitChanged = replaceFile(join(layout.unitDir, UNIT), unit, 0o600);
    changed = unitChanged || changed;
    // Always reload: a prior install may have died just after writing its unit.
    mustRun(ports.run, "systemctl", systemctl(layout, ["daemon-reload"]));
    if (ports.run("systemctl", systemctl(layout, ["is-enabled", UNIT])).status !== 0) {
      mustRun(ports.run, "systemctl", systemctl(layout, ["enable", UNIT]));
      changed = true;
    }
    if (
      layout.mode === "user" &&
      ports
        .run("loginctl", ["show-user", String(context.uid), "--property=Linger", "--value"])
        .stdout.trim() !== "yes"
    ) {
      const enabled = ports.run("loginctl", ["enable-linger", String(context.uid)]);
      if (enabled.status !== 0)
        context.err(
          `Runs only while logged in. For boot persistence run: sudo loginctl enable-linger ${context.uid}\n`,
        );
      else changed = true;
    }
  }
  const paths = ["--data-dir", layout.dataDir, "--config-dir", layout.configDir];
  let justLinked = false;
  if (!input.values["no-link"] && !existsSync(join(layout.configDir, LINK_FILE_NAME))) {
    const args = ["link", ...paths];
    for (const name of ["name", "server", "site"]) {
      const value = stringOption(input.values, name);
      if (value !== undefined) args.push(`--${name}`, value);
    }
    const token = stringOption(input.values, "token");
    const linkContext =
      token === undefined
        ? context
        : { ...context, env: { ...context.env, VOLLI_RUNNER_TOKEN: token } };
    asRunner(layout, linkContext, ports.run, args, true);
    justLinked = true;
    changed = true;
  }
  if (input.values["no-start"] || !ports.systemd) {
    context.out(`${JSON.stringify({ changed, started: false, mode: layout.mode })}\n`);
    const cli = join(layout.root, "current/bin/volli-runner");
    context.out(
      ports.systemd
        ? `Start with: systemctl ${layout.mode === "user" ? "--user " : ""}start ${UNIT}\n`
        : `Start with: ${layout.mode === "system" ? "sudo -u volli " : ""}env ${shellQuote(`HOME=${layout.mode === "system" ? layout.dataDir : context.home}`)} ${shellQuote(`VOLLI_RUNNER_INSTALL_MODE=${layout.mode}`)} ${shellQuote(`VOLLI_SECRET_KEY_FILE=${join(layout.configDir, "session-secrets.key")}`)} ${[cli, "run", ...paths].map(shellQuote).join(" ")}\n`,
    );
    return 0;
  }
  const before = await checkRunnerStatus(layout.dataDir, context.statusProbes);
  const alreadyOnline = before.verdict === "serving" && before.status?.version === context.version;
  const restart =
    activated ||
    unitChanged ||
    justLinked ||
    (before.status !== null && before.status.version !== context.version);
  const enabled = ports.run("systemctl", systemctl(layout, ["is-enabled", UNIT])).status === 0;
  if (!enabled) changed = true;
  mustRun(ports.run, "systemctl", systemctl(layout, ["enable", "--now", UNIT]));
  if (restart && before.status !== null) {
    mustRun(ports.run, "systemctl", systemctl(layout, ["restart", UNIT]));
  }
  if (!alreadyOnline || restart) changed = true;
  context.out(`${JSON.stringify({ changed, started: true, mode: layout.mode })}\n`);
  for (let attempt = 0; attempt < 60 && !context.signal.aborted; attempt++) {
    const report = await checkRunnerStatus(layout.dataDir, context.statusProbes);
    if (
      report.verdict === "serving" &&
      report.status?.version === context.version &&
      (!restart || before.status === null || report.status.pid !== before.status.pid)
    ) {
      context.out(`${report.status.link?.name ?? "Runner"} is online.\n`);
      return 0;
    }
    await context.sleep(1000);
  }
  const last = await checkRunnerStatus(layout.dataDir, context.statusProbes);
  const state = last.status?.state;
  context.err(
    `Runner did not come online at ${context.version}: ${last.detail ?? state}. Last 20 journal lines:\n`,
  );
  ports.run(
    "journalctl",
    [...(layout.mode === "user" ? ["--user"] : []), "-u", UNIT, "-n", "20", "--no-pager"],
    { inherit: true },
  );
  return 1;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
