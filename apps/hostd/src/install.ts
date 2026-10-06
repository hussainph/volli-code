/**
 * `volli-hostd install --system | --user` (VC-700): put this release in place
 * and under systemd, run on the box by the desktop over SSH, or by a person.
 * It automates docs/runbooks/hostd-box.md steps 2–4.
 *
 * Run from the release being installed (`<release>/bin/volli-hostd install`,
 * unpacked anywhere): `--from` defaults to that release.
 *
 * **Idempotent.** Every step looks before it acts, and a second run changes
 * nothing and says so (`changed: false`). It never starts or restarts the
 * host: `start` does, and converges whatever is running to what this left in
 * `managed.json`. So an install interrupted anywhere is finished by running
 * it again.
 *
 * **Upgrade.** A new release goes beside the old ones and `current` is
 * renamed onto it: the release before stays as the rollback. The data
 * directory is never touched; hostd migrates it at boot and keeps its own
 * safety copy (VC-633).
 *
 * **Adopt.** A box set up by hand (the runbook's flat `/opt/volli-hostd`,
 * its units, its `volli` account, its secret-key drop-in) is brought under
 * management in place: the account, the data directory, the key and every
 * drop-in of the person's stay as they are. The units are reinstalled from
 * this release, `current` is added beside the flat files (which stay, as the
 * rollback), and one drop-in of ours points `ExecStart` at `current`.
 *
 * **The secret key** is made only on a fresh box, outside the data directory
 * (runbook step 4). If one is already configured or hostd already made one
 * in the data directory, it is left alone: a new key would lock every secret
 * sealed under the old one.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { HostdInstallResult, InstallMode } from "@volli/host-install/contract";

import type { SystemUser } from "./operator-token";
import {
  ManagementError,
  must,
  readManaged,
  systemctlArgs,
  writeManaged,
  type RunTool,
} from "./management";
import {
  MANAGED_DROP_IN,
  SECRET_KEY_DROP_IN,
  SERVICE_UNIT,
  SOCKET_UNIT,
  type InstallLayout,
} from "./layout";
import { atomicWrite, writeIfChanged } from "./write-file";
import { SECRET_KEY_FILE_NAME } from "@volli/host-core/secrets";

export interface InstallCommand {
  readonly kind: "install";
  readonly mode: InstallMode;
  /** The unpacked release to install; `null`: the one this binary runs from. */
  readonly from: string | null;
  readonly port: number;
  /** A login to add to the `volli` group, so it reaches the agent socket. System only. */
  readonly operator: string | null;
}

export interface InstallPorts {
  readonly uid: () => number;
  readonly layout: InstallLayout;
  /** The release this binary runs from. */
  readonly ownRelease: string;
  readonly version: string;
  readonly run: RunTool;
  readonly lookupUser: (login: string) => SystemUser | null;
  readonly chown: (path: string, uid: number, gid: number) => void;
  /** Whether a system unit exists, so a user install would be a second host. */
  readonly systemInstallPresent: () => boolean;
  readonly now: () => Date;
}

/** Root's uid. Tests run as themselves and say so through `uid`. */
export const ROOT_UID = 0;

export function runInstall(command: InstallCommand, ports: InstallPorts): HostdInstallResult {
  const { layout, run } = ports;
  const { mode } = command;
  const actions: string[] = [];
  const did = (action: string): void => {
    actions.push(action);
  };
  if (mode === "system" && ports.uid() !== ROOT_UID) {
    throw new ManagementError("not-root", "install --system runs as root (sudo).", [], 77);
  }
  if (mode === "user" && ports.uid() === ROOT_UID) {
    throw new ManagementError(
      "is-root",
      "install --user runs as you, not root: the unit is yours and runs as you.",
    );
  }
  const release = resolve(command.from ?? ports.ownRelease);
  const manifest = readManifest(release);
  if (manifest.version !== ports.version) {
    throw new ManagementError(
      "bad-release",
      `${release} holds volli-hostd ${manifest.version}, not this binary's ${ports.version}: run the install from the release itself.`,
    );
  }
  if (mode === "user" && ports.systemInstallPresent()) {
    throw new ManagementError(
      "other-mode-installed",
      "This box already runs volli-hostd as a system service; a user unit beside it would be a second host.",
    );
  }

  // The service account (runbook step 3), and the operator's way to the socket.
  let owner: { uid: number; gid: number } | null = null;
  if (layout.serviceUser !== null) {
    const name = layout.serviceUser;
    let account = ports.lookupUser(name);
    if (account === null) {
      must(run, "useradd", [
        "--system",
        "--create-home",
        "--home-dir",
        layout.dataDir,
        "--shell",
        "/bin/bash",
        name,
      ]);
      did(`created the ${name} account`);
      account = ports.lookupUser(name);
      if (account === null) {
        throw new ManagementError("command-failed", `useradd ran, but there is still no ${name}.`);
      }
    }
    owner = account;
    if (command.operator !== null) {
      const groups = must(run, "id", ["-nG", command.operator]).stdout.trim().split(/\s+/u);
      if (!groups.includes(name)) {
        must(run, "usermod", ["-aG", name, command.operator]);
        did(`added ${command.operator} to the ${name} group`);
      }
    }
  }

  // The data directory: made private if new, never changed if not.
  if (!existsSync(layout.dataDir)) {
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(layout.dataDir, 0o700);
    if (owner !== null) ports.chown(layout.dataDir, owner.uid, owner.gid);
    did(`made the data directory ${layout.dataDir}`);
  }

  // The release, beside the others, then `current` onto it (runbook step 2).
  const flat = layout.serviceUser !== null && existsSync(join(layout.root, "bin/volli-hostd"));
  const previous = currentVersion(layout);
  const target = join(layout.releasesDir, manifest.version);
  if (release !== target) {
    const installed = existsSync(target) ? readManifest(target) : null;
    if (installed === null || installed.revision !== manifest.revision) {
      mkdirSync(layout.releasesDir, { recursive: true, mode: mode === "system" ? 0o755 : 0o700 });
      const staging = join(layout.releasesDir, `.${manifest.version}.${process.pid}.tmp`);
      rmSync(staging, { recursive: true, force: true });
      cpSync(release, staging, { recursive: true, verbatimSymlinks: true });
      if (installed !== null) {
        const aside = join(layout.releasesDir, `.${manifest.version}.replaced.${process.pid}`);
        renameSync(target, aside);
        renameSync(staging, target);
        rmSync(aside, { recursive: true, force: true });
      } else {
        renameSync(staging, target);
      }
      did(`installed release ${manifest.version}`);
    }
  }
  if (previous !== manifest.version) {
    replaceSymlink(join("releases", manifest.version), layout.currentLink);
    did(
      previous === null
        ? `current is ${manifest.version}`
        : `current moved from ${previous} to ${manifest.version}`,
    );
  }
  for (const name of ["volli-hostd", "volli"]) {
    const link = join(layout.binLinkDir, name);
    const to = join(layout.currentLink, "bin", name);
    if (linkTarget(link) === to) continue;
    // Someone's own file: not ours to replace.
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) continue;
    mkdirSync(layout.binLinkDir, { recursive: true });
    replaceSymlink(to, link);
    did(`linked ${link}`);
  }

  // The secret key, only where none is configured or made yet (runbook step 4).
  let keyFile: string | null = null;
  const keyDropIn = join(layout.dropInDir, SECRET_KEY_DROP_IN);
  const keyInDataDir = existsSync(join(layout.dataDir, SECRET_KEY_FILE_NAME));
  if (mode === "system" && existsSync(keyDropIn)) {
    // Configured by hand or by an earlier install: theirs.
  } else if (existsSync(layout.keyFile)) {
    keyFile = layout.keyFile;
  } else if (!keyInDataDir) {
    mkdirSync(dirname(layout.keyFile), { recursive: true, mode: 0o700 });
    atomicWrite(layout.keyFile, `${randomBytes(32).toString("base64")}\n`, 0o600);
    if (owner !== null) {
      ports.chown(dirname(layout.keyFile), owner.uid, owner.gid);
      ports.chown(layout.keyFile, owner.uid, owner.gid);
    }
    keyFile = layout.keyFile;
    did(`made the secret key ${layout.keyFile}`);
  }

  // The units.
  let unitsChanged = false;
  mkdirSync(layout.unitDir, { recursive: true });
  const exec = execStart(layout, command.port);
  if (mode === "system") {
    for (const unit of [SERVICE_UNIT, SOCKET_UNIT]) {
      const content = readFileSync(join(target, "share/systemd", unit), "utf8");
      if (writeIfChanged(join(layout.unitDir, unit), content, 0o644)) {
        unitsChanged = true;
        did(`wrote ${unit}`);
      }
    }
    mkdirSync(layout.dropInDir, { recursive: true, mode: 0o755 });
    if (keyFile !== null) {
      // Only reached when no key drop-in exists: one that does is never rewritten.
      atomicWrite(keyDropIn, `[Service]\nEnvironment=VOLLI_SECRET_KEY_FILE=${keyFile}\n`, 0o644);
      unitsChanged = true;
      did(`wrote ${SECRET_KEY_DROP_IN}`);
    }
    const managed = [
      "# Written by `volli-hostd install` (VC-700) and rewritten by every install:",
      "# put your own settings in another drop-in beside it.",
      "[Service]",
      "Environment=VOLLI_EXPERIMENTAL=cloud",
      "ExecStart=",
      `ExecStart=${exec}`,
      "",
    ].join("\n");
    if (writeIfChanged(join(layout.dropInDir, MANAGED_DROP_IN), managed, 0o644)) {
      unitsChanged = true;
      did(`wrote ${MANAGED_DROP_IN}`);
    }
  } else if (writeIfChanged(join(layout.unitDir, SERVICE_UNIT), userUnit(exec, keyFile), 0o644)) {
    unitsChanged = true;
    did(`wrote ${SERVICE_UNIT}`);
  }
  if (unitsChanged) {
    must(run, "systemctl", systemctlArgs(mode, "daemon-reload"));
    did("reloaded systemd");
  }
  const units = mode === "system" ? [SOCKET_UNIT, SERVICE_UNIT] : [SERVICE_UNIT];
  const enabled = run("systemctl", systemctlArgs(mode, "is-enabled", ...units));
  if (
    enabled.code !== 0 ||
    enabled.stdout.split("\n").some((line) => line.trim() !== "enabled" && line.trim() !== "")
  ) {
    must(run, "systemctl", systemctlArgs(mode, "enable", ...units));
    did("enabled the units");
  }

  const record = readManaged(layout);
  if (record?.version !== manifest.version || record.port !== command.port) {
    writeManaged(layout, {
      v: 1,
      mode,
      version: manifest.version,
      port: command.port,
      installedAt: ports.now().toISOString(),
    });
    did(`recorded ${manifest.version} on port ${command.port}`);
  }

  return {
    v: 1,
    ok: true,
    mode,
    version: manifest.version,
    previous,
    adopted: flat && previous === null ? "flat" : null,
    changed: actions.length > 0,
    actions,
    dataDir: layout.dataDir,
    binary: join(layout.currentLink, "bin/volli-hostd"),
    listen: { host: "127.0.0.1", port: command.port },
    serviceUser: layout.serviceUser,
  };
}

interface ReleaseManifest {
  readonly version: string;
  readonly revision: string | null;
}

/** The release's MANIFEST.json (scripts/package.mjs); refuses a directory that is not one. */
export function readManifest(release: string): ReleaseManifest {
  let parsed: { name?: unknown; version?: unknown; revision?: unknown };
  try {
    parsed = JSON.parse(readFileSync(join(release, "MANIFEST.json"), "utf8")) as typeof parsed;
  } catch {
    throw new ManagementError(
      "bad-release",
      `${release} is not a volli-hostd release: no MANIFEST.json.`,
    );
  }
  if (
    parsed.name !== "volli-hostd" ||
    typeof parsed.version !== "string" ||
    !existsSync(join(release, "bin/volli-hostd"))
  ) {
    throw new ManagementError("bad-release", `${release} is not a volli-hostd release.`);
  }
  return {
    version: parsed.version,
    revision: typeof parsed.revision === "string" ? parsed.revision : null,
  };
}

/** The release `current` names, or `null`. */
export function currentVersion(layout: InstallLayout): string | null {
  const target = linkTarget(layout.currentLink);
  return target === null ? null : basename(target);
}

/** The installed releases, oldest name first. */
export function installedReleases(layout: InstallLayout): string[] {
  try {
    return readdirSync(layout.releasesDir)
      .filter((name) => !name.startsWith("."))
      .toSorted();
  } catch {
    return [];
  }
}

function linkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** Points `link` at `to` in one rename, so nothing ever sees it missing. */
function replaceSymlink(to: string, link: string): void {
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(to, temporary);
  renameSync(temporary, link);
}

/** The command line the unit runs: `current`'s binary, this data directory, loopback `port`. */
function execStart(layout: InstallLayout, port: number): string {
  const binary = join(layout.currentLink, "bin/volli-hostd");
  const socket = layout.mode === "system" ? ` --socket ${layout.socketPath}` : "";
  return `${binary} --data-dir ${layout.dataDir}${socket} --listen 127.0.0.1:${port}`;
}

/**
 * The user unit. No sandboxing a user manager cannot apply, no `User=`: it
 * runs as the person, and so does every agent on it, which the desktop says.
 */
function userUnit(exec: string, keyFile: string | null): string {
  return [
    "# Written by `volli-hostd install --user` (VC-700) and rewritten by every install.",
    "[Unit]",
    "Description=Volli headless host (volli-hostd, user unit)",
    "",
    "[Service]",
    "Type=simple",
    "UMask=0077",
    "Environment=VOLLI_HOSTD_LOG_LEVEL=info",
    "Environment=VOLLI_EXPERIMENTAL=cloud",
    ...(keyFile === null ? [] : [`Environment=VOLLI_SECRET_KEY_FILE=${keyFile}`]),
    `ExecStart=${exec}`,
    "KillSignal=SIGTERM",
    "TimeoutStopSec=45",
    "Restart=on-failure",
    "RestartSec=5",
    "RestartPreventExitStatus=78",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
