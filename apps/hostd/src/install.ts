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
 * it again: what the filesystem cannot show was finished converges anyway —
 * a managed key's ownership is set every run, and a unit change leaves
 * `.reload-pending` until systemd has reloaded it.
 *
 * **Upgrade.** A release goes into its own directory, named by its version
 * and the immutable revision it was built from (`1.1.0-<rev>`; a digest of
 * its files when it names none), never replaced once there; `current` is
 * renamed onto it in one step, and the release before stays as the rollback,
 * even when only the revision changed. The data directory is never touched;
 * hostd migrates it at boot and keeps its own safety copy (VC-633).
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
 * sealed under the old one. "Configured" is judged on the unit's effective
 * configuration — every drop-in, in order, and what systemd itself reports
 * — not on one file name; when that cannot be known (an
 * `EnvironmentFile=`, a systemd that will not say), install refuses
 * (`secret-key-unclear`) rather than make a key.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  LAUNCHD_LABEL,
  MANAGED_DROP_IN,
  SECRET_KEY_DROP_IN,
  SERVICE_UNIT,
  SOCKET_UNIT,
  type InstallLayout,
} from "./layout";
import { atomicWrite } from "./write-file";
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
  const launchd = layout.manager === "launchd";
  if (mode === "system" && launchd) {
    throw new ManagementError(
      "system-unsupported",
      "A Mac runs volli-hostd as your launchd agent: install --user (agents share your account).",
    );
  }
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
  // `useradd --create-home` makes the data directory as the account's home,
  // with whatever mode the system's useradd uses: still ours to make private.
  const freshDataDir = !existsSync(layout.dataDir);
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
  if (freshDataDir) {
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(layout.dataDir, 0o700);
    if (owner !== null) ports.chown(layout.dataDir, owner.uid, owner.gid);
    did(`made the data directory ${layout.dataDir}`);
  }

  // The release, beside the others, then `current` onto it (runbook step 2).
  const flat = layout.serviceUser !== null && existsSync(join(layout.root, "bin/volli-hostd"));
  const before = currentRelease(layout);
  const previous = before?.version ?? null;
  const name = releaseName(release, manifest);
  const target = join(layout.releasesDir, name);
  if (release !== target && !existsSync(target)) {
    // A release directory is never replaced: one name is one build.
    mkdirSync(layout.releasesDir, { recursive: true, mode: mode === "system" ? 0o755 : 0o700 });
    const staging = join(layout.releasesDir, `.${name}.${process.pid}.tmp`);
    rmSync(staging, { recursive: true, force: true });
    cpSync(release, staging, { recursive: true, verbatimSymlinks: true });
    renameSync(staging, target);
    did(`installed release ${name}`);
  }
  if (before?.name !== name) {
    replaceSymlink(join("releases", name), layout.currentLink);
    const sameVersion = before !== null && before.version === manifest.version;
    did(
      before === null
        ? `current is ${manifest.version}`
        : `current moved from ${sameVersion ? before.name : before.version} to ${sameVersion ? name : manifest.version}`,
    );
  }
  for (const program of ["volli-hostd", "volli"]) {
    const link = join(layout.binLinkDir, program);
    const to = join(layout.currentLink, "bin", program);
    if (linkTarget(link) === to) continue;
    // Someone's own file: not ours to replace.
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) continue;
    mkdirSync(layout.binLinkDir, { recursive: true });
    replaceSymlink(to, link);
    did(`linked ${link}`);
  }

  // The secret key, only where none is configured or made yet (runbook step 4).
  const keyDropIn = join(layout.dropInDir, SECRET_KEY_DROP_IN);
  const keyInDataDir = existsSync(join(layout.dataDir, SECRET_KEY_FILE_NAME));
  const configured = configuredKeys(layout);
  const theirs = configured.paths.filter((path) => path !== layout.keyFile);
  /** Whether the unit should name `layout.keyFile`; `null`: it names theirs, or none. */
  let keyFile: string | null = null;
  /** Whether this run may (re)write the key drop-in: never over one that exists. */
  const keyDropInFree = mode === "system" && !existsSync(keyDropIn);
  const mustKnow = (doing: string): void => {
    // Before writing anything that could supersede a key configured where
    // the files do not show (another directory, an EnvironmentFile=).
    // launchd has no drop-ins: the agent's plist, ours, is the whole configuration.
    const effective =
      configured.doubt ?? (launchd ? null : effectiveKeys(run, layout, configured.paths));
    if (effective !== null) {
      throw new ManagementError(
        "secret-key-unclear",
        `Not ${doing}: ${effective}. A new key would lock every secret sealed under the one already configured; set VOLLI_SECRET_KEY_FILE in a drop-in by hand, then install again.`,
      );
    }
  };
  if (theirs.length > 0) {
    // Configured by hand or by an earlier install: theirs, and the unit keeps naming it.
  } else if (existsSync(layout.keyFile)) {
    keyFile = layout.keyFile;
    if (keyDropInFree) mustKnow(`pointing the unit at ${layout.keyFile}`);
  } else if (configured.paths.length > 0) {
    throw new ManagementError(
      "secret-key-unclear",
      `The unit names ${layout.keyFile}, which is gone: not making another, since secrets sealed under it would stay locked. Restore it, then install again.`,
    );
  } else if (!keyInDataDir) {
    mustKnow("making a secret key");
    mkdirSync(dirname(layout.keyFile), { recursive: true, mode: 0o700 });
    atomicWrite(layout.keyFile, `${randomBytes(32).toString("base64")}\n`, 0o600);
    keyFile = layout.keyFile;
    did(`made the secret key ${layout.keyFile}`);
  }
  // A unit we rewrite whole (a user unit, a Mac's plist) keeps the key it
  // already names, if that is someone else's: rewriting it away would orphan it.
  const unitKey = keyFile ?? (mode === "user" ? (ownUnitKeys(layout).at(-1) ?? null) : null);
  // Ownership converges every run, without touching the bytes: an install
  // interrupted between making the key and handing it over is finished here.
  if (keyFile !== null && owner !== null) {
    for (const path of [dirname(keyFile), keyFile]) ports.chown(path, owner.uid, owner.gid);
  }

  // The units. A change is marked pending before it is written and cleared
  // only once systemd reloaded: a retry after an interrupted reload, which
  // finds every file already right, still reloads. launchd reads its plist
  // at bootstrap, which `start` does: there a change is `start`'s to apply.
  const pendingFile = join(layout.root, RELOAD_PENDING);
  let unitsChanged = existsSync(pendingFile);
  const unitWrite = (path: string, content: string, label: string): void => {
    if (readText(path) === content) return;
    if (!existsSync(pendingFile)) atomicWrite(pendingFile, "", 0o644);
    atomicWrite(path, content, 0o644);
    unitsChanged = true;
    did(`wrote ${label}`);
  };
  mkdirSync(layout.unitDir, { recursive: true });
  if (launchd) {
    mkdirSync(dirname(layout.logFile!), { recursive: true });
    unitWrite(
      layout.agentPlist!,
      launchdAgent(layout, command.port, unitKey),
      basename(layout.agentPlist!),
    );
    rmSync(pendingFile, { force: true });
  } else {
    const exec = execStart(layout, command.port);
    if (mode === "system") {
      for (const unit of [SERVICE_UNIT, SOCKET_UNIT]) {
        unitWrite(
          join(layout.unitDir, unit),
          readFileSync(join(target, "share/systemd", unit), "utf8"),
          unit,
        );
      }
      mkdirSync(layout.dropInDir, { recursive: true, mode: 0o755 });
      if (keyFile !== null && keyDropInFree) {
        // Only reached when no key drop-in exists: one that does is never rewritten.
        unitWrite(
          keyDropIn,
          `[Service]\nEnvironment=VOLLI_SECRET_KEY_FILE=${keyFile}\n`,
          SECRET_KEY_DROP_IN,
        );
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
      unitWrite(join(layout.dropInDir, MANAGED_DROP_IN), managed, MANAGED_DROP_IN);
    } else {
      unitWrite(join(layout.unitDir, SERVICE_UNIT), userUnit(exec, unitKey), SERVICE_UNIT);
    }
    if (unitsChanged) {
      must(run, "systemctl", systemctlArgs(mode, "daemon-reload"));
      rmSync(pendingFile, { force: true });
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
  }

  const record = readManaged(layout);
  // A unit that changed runs as it was until restarted: `start` restarts once.
  const restartOwed = unitsChanged && record?.started !== undefined;
  if (
    record?.version !== manifest.version ||
    record.port !== command.port ||
    record.release !== name ||
    restartOwed
  ) {
    writeManaged(layout, {
      v: 1,
      mode,
      version: manifest.version,
      release: name,
      port: command.port,
      installedAt: ports.now().toISOString(),
      // What `start` last brought up, kept: it restarts until that is `release`.
      ...(record?.started === undefined || restartOwed ? {} : { started: record.started }),
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

/** Where systemd's reload is owed (`runInstall`'s units). */
const RELOAD_PENDING = ".reload-pending";

/**
 * A release's directory name: its version and the immutable revision it was
 * built from, or a digest of its files when its manifest names none (a
 * build outside git says `unknown`). Two builds never share one.
 */
export function releaseName(release: string, manifest: ReleaseManifest): string {
  const revision =
    manifest.revision !== null &&
    manifest.revision !== "unknown" &&
    /^[0-9A-Za-z]{1,64}$/u.test(manifest.revision)
      ? manifest.revision.slice(0, 12)
      : `sha256-${treeDigest(release).slice(0, 12)}`;
  return `${manifest.version}-${revision}`;
}

/** SHA-256 over every path, link target and file's bytes below `root`, in order. */
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (relative: string): void => {
    const path = join(root, relative);
    let fd: number;
    try {
      // Never through a link: a link is hashed as its target's name.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      hash.update(`${relative}\0link\0${readlinkSync(path)}\0`);
      return;
    }
    try {
      const stat = fstatSync(fd);
      hash.update(`${relative}\0${stat.mode & 0o777}\0`);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path).toSorted()) walk(join(relative, entry));
      } else hash.update(readFileSync(fd));
    } finally {
      closeSync(fd);
    }
  };
  walk(".");
  return hash.digest("hex");
}

/** The release `current` names: its directory and version; `null` when there is none. */
export function currentRelease(layout: InstallLayout): { name: string; version: string } | null {
  const target = linkTarget(layout.currentLink);
  if (target === null) return null;
  const name = basename(target);
  let version = name;
  try {
    version = readManifest(join(layout.releasesDir, name)).version;
  } catch {
    // A release that lost its manifest still names something; its directory says which.
  }
  return { name, version };
}

/** The version of the release `current` names, or `null`. */
export function currentVersion(layout: InstallLayout): string | null {
  return currentRelease(layout)?.version ?? null;
}

/** The installed release directories (`<version>-<revision>`), by name. */
export function installedReleases(layout: InstallLayout): string[] {
  try {
    return readdirSync(layout.releasesDir)
      .filter((name) => !name.startsWith("."))
      .toSorted();
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const KEY_ASSIGNMENT = /(?:^|[\s"'])VOLLI_SECRET_KEY_FILE=([^\s"']*)/gu;

/** Every `VOLLI_SECRET_KEY_FILE=` an `Environment=` value assigns, in order. */
function keyAssignments(value: string): string[] {
  return [...value.matchAll(KEY_ASSIGNMENT)].map((match) => match[1]!);
}

/**
 * The secret keys the unit's files configure: the unit and every drop-in
 * of ours and the person's, in the order systemd applies them. `doubt`
 * names a setting no file can settle (an `EnvironmentFile=`, which can set
 * the variable and outranks `Environment=`; a key drop-in naming none).
 */
function configuredKeys(layout: InstallLayout): { paths: string[]; doubt: string | null } {
  if (layout.agentPlist !== null) return { paths: ownUnitKeys(layout), doubt: null };
  const paths: string[] = [];
  let doubt: string | null = null;
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(layout.dropInDir)
      .filter((name) => name.endsWith(".conf"))
      .toSorted();
  } catch {
    // No drop-ins.
  }
  const files = [
    join(layout.unitDir, SERVICE_UNIT),
    ...dropIns.map((name) => join(layout.dropInDir, name)),
  ];
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    const before = paths.length;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#") || line.startsWith(";")) continue;
      const [key, ...rest] = line.split("=");
      const value = rest.join("=").trim();
      if (key?.trim() === "Environment") paths.push(...keyAssignments(value));
      if (key?.trim() === "EnvironmentFile" && value !== "") {
        doubt ??= `${file} reads environment from ${value}, which may name a key`;
      }
    }
    if (file === join(layout.dropInDir, SECRET_KEY_DROP_IN) && paths.length === before) {
      doubt ??= `${file} names no VOLLI_SECRET_KEY_FILE`;
    }
  }
  return { paths: paths.filter((path) => path !== ""), doubt };
}

/** The keys the unit file install writes whole names: a user unit's, or a Mac's plist's. */
function ownUnitKeys(layout: InstallLayout): string[] {
  if (layout.agentPlist !== null) {
    const plist = readText(layout.agentPlist) ?? "";
    const named = /<key>VOLLI_SECRET_KEY_FILE<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1];
    return named === undefined || named === "" ? [] : [unescapeXml(named)];
  }
  const unit = readText(join(layout.unitDir, SERVICE_UNIT)) ?? "";
  return unit
    .split("\n")
    .filter((line) => line.trim().startsWith("Environment="))
    .flatMap((line) => keyAssignments(line.trim().slice("Environment=".length)))
    .filter((path) => path !== "");
}

/**
 * What systemd itself has loaded for the unit, beyond the files above (a
 * drop-in in another directory, a global `service.d`): why not to write a
 * key setting, or `null` when it names no key but `known` or ours.
 */
function effectiveKeys(
  run: RunTool,
  layout: InstallLayout,
  known: readonly string[],
): string | null {
  const shown = run(
    "systemctl",
    systemctlArgs(layout.mode, "show", SERVICE_UNIT, "-p", "Environment", "-p", "EnvironmentFiles"),
  );
  if (shown.code !== 0) {
    // With no unit of ours yet, systemd has nothing loaded to say.
    return existsSync(join(layout.unitDir, SERVICE_UNIT))
      ? `systemd would not show ${SERVICE_UNIT}'s environment`
      : null;
  }
  for (const line of shown.stdout.split("\n")) {
    if (line.startsWith("EnvironmentFiles=") && line.slice("EnvironmentFiles=".length).trim()) {
      return `${SERVICE_UNIT} reads environment from ${line.slice("EnvironmentFiles=".length).trim()}`;
    }
    if (line.startsWith("Environment=")) {
      const other = keyAssignments(line.slice("Environment=".length)).find(
        (path) => path !== "" && !known.includes(path) && path !== layout.keyFile,
      );
      if (other !== undefined) return `${SERVICE_UNIT} already names the key ${other}`;
    }
  }
  return null;
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
  // A system install's devices are root's (enrolled-devices.ts); a user one's are its data directory's.
  const system =
    layout.mode === "system"
      ? ` --socket ${layout.socketPath} --devices ${layout.devicesFile}`
      : "";
  return `${binary} --data-dir ${layout.dataDir}${system} --listen 127.0.0.1:${port}`;
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

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * A Mac's launchd agent: the shipped template's settings (VC-562), with this
 * install's paths. It runs as the person, and so does every agent on it.
 * `KeepAlive` restarts after a crash, not after a clean stop; a refusal to
 * boot (exit 78) retries every `ThrottleInterval`, which launchd cannot be
 * told apart, and `start` reports from the log.
 */
function launchdAgent(layout: InstallLayout, port: number, keyFile: string | null): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  const environment: [string, string][] = [
    ["VOLLI_HOSTD_LOG_LEVEL", "info"],
    ["VOLLI_EXPERIMENTAL", "cloud"],
    ...(keyFile === null ? [] : [["VOLLI_SECRET_KEY_FILE", keyFile] as [string, string]]),
  ];
  const program = [
    join(layout.currentLink, "bin/volli-hostd"),
    "--data-dir",
    layout.dataDir,
    "--listen",
    `127.0.0.1:${port}`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by the volli-hostd user installer (VC-700) and rewritten by every install. -->",
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>`,
    `  ${string(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((argument) => `    ${string(argument)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment.flatMap(([key, value]) => [`    <key>${key}</key>`, `    ${string(value)}`]),
    "  </dict>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    // An agent of the per-user Background session, which `start` bootstraps
    // over SSH (user/<uid>): never loaded a second time into a GUI login.
    "  <key>LimitLoadToSessionType</key>",
    `  ${string("Background")}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>45</integer>",
    "  <key>StandardOutPath</key>",
    `  ${string(layout.logFile!)}`,
    "  <key>StandardErrorPath</key>",
    `  ${string(layout.logFile!)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
