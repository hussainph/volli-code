/**
 * What `volli-runner doctor` checks, and the one fix each unmet check names.
 *
 * Every check answers the same question — can this box be a runner, and what
 * is the single thing standing in the way? — in one of five states:
 *
 * | state     | meaning                                                              | exit |
 * | --------- | -------------------------------------------------------------------- | ---- |
 * | `ok`      | as it should be                                                      | —    |
 * | `warn`    | this box still serves, but a person should act                       | —    |
 * | `fail`    | the runner cannot do its job until this is fixed                     | 1    |
 * | `unknown` | the box would not say; the fix names the command that asks it        | —    |
 * | `info`    | nothing to do, and the reason why (Chromium)                         | —    |
 *
 * A failed, warned or unknown check carries exactly one `fix`: the command or
 * action that resolves it, never a menu. `unknown` is never read as `ok` — a
 * doctor that cannot see something says so and names how to look.
 *
 * Nothing here reads a secret. Model readiness is "a credential exists for
 * these providers", from a port that lists Pi's store by id and kind; a store
 * that will not list is `unknown` with `volli-runner login --status` as its
 * fix, never a claim that the box is ready.
 */
import { basename, join } from "node:path";

import type { RunnerHostFacts } from "@volli/shared/cloud";

import type { CommandContext } from "../commands";
import type { RunnerDeployment } from "../link/deployment";
import { LINK_KEY_FILE_NAME } from "../link/file-store";
import type { RunnerPaths } from "../shell/paths";
import {
  piAgentDir,
  type CredentialListing,
  type DoctorPorts,
  type LinkFacts,
  type ReachAnswer,
} from "./ports";

export const DOCTOR_STATUSES = ["ok", "warn", "fail", "unknown", "info"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export interface DoctorCheck {
  /** Stable across releases: what a script reads, and what a test names. */
  readonly id: string;
  /** The column a person reads: a program, a host, or the thing being checked. */
  readonly title: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** The one thing to do about it. Present exactly when there is something to do. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly v: 1;
  readonly host: RunnerHostFacts;
  readonly checks: readonly DoctorCheck[];
  readonly counts: Readonly<Record<DoctorStatus, number>>;
}

/** The install mode the unit states, else the one the paths were resolved for. */
export function installModeOf(
  env: Readonly<Record<string, string | undefined>>,
  fallback: RunnerPaths["mode"],
): RunnerPaths["mode"] {
  const configured = env["VOLLI_RUNNER_INSTALL_MODE"];
  return configured === "system" || configured === "user" ? configured : fallback;
}

/** The oldest git a Session's working copies are built with. */
export const GIT_FLOOR = "2.31";

/** The oldest glibc this release runs against (the bullseye build's floor). */
export const GLIBC_FLOOR = "2.31";

/** Room for a clone, a working copy and the history a Session writes. */
export const MIN_FREE_BYTES = 1024 ** 3;

/** HTTP `Date` is second-granular; past a minute the difference is the clock, not rounding. */
export const CLOCK_SKEW_LIMIT_MS = 60_000;

/** systemd's own runtime directory: present exactly when systemd is the init system. */
export const SYSTEMD_RUNTIME_DIR = "/run/systemd/system";

export const DEPLOYMENT_TARGET_ID = "network.deployment";

/** Where git pushes to, unless a project names another remote. */
export const GITHUB_URL = "https://github.com";

/**
 * The model providers a runner signs into, and the host each call leaves
 * through. Reachability is per host: a box behind an allow-list proxy usually
 * fails one and answers the rest, and the fix names the host rather than a
 * provider list.
 */
export const MODEL_ENDPOINTS = [
  { providerId: "anthropic", url: "https://api.anthropic.com" },
  { providerId: "google", url: "https://generativelanguage.googleapis.com" },
  { providerId: "openai", url: "https://api.openai.com" },
  { providerId: "openrouter", url: "https://openrouter.ai" },
] as const;

/** Provider ids Pi resolves from the environment, by variable name — never its value. */
const AMBIENT_KEY_PROVIDERS: readonly (readonly [string, string])[] = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["GEMINI_API_KEY", "google"],
  ["GOOGLE_GENERATIVE_AI_API_KEY", "google"],
  ["OPENAI_API_KEY", "openai"],
  ["OPENROUTER_API_KEY", "openrouter"],
];

export interface DoctorInputs {
  /** This box, as `link` sends it: hostname, platform, glibc, install mode. */
  readonly host: RunnerHostFacts;
  readonly context: CommandContext;
  readonly paths: RunnerPaths;
  readonly ports: DoctorPorts;
}

/**
 * Every check, in the order the report reads: the link, the box's platform and
 * tools, then what it must reach, then what it can run a model with.
 */
export async function runChecks({
  host,
  context,
  paths,
  ports,
}: DoctorInputs): Promise<readonly DoctorCheck[]> {
  const link = await ports.readLink(paths.configDir);
  const deployment = link.state === "linked" ? link.deployment : context.buildDeployment;
  const mode = installModeOf(context.env, paths.mode);
  const targets = networkTargets(deployment);
  const [answers, credentials] = await Promise.all([
    Promise.all(targets.map(async (target) => ({ target, answer: await ports.reach(target.url) }))),
    ports.storedCredentials(piAgentDir(context.env, paths.dataDir)),
  ]);
  const deploymentAnswer = answers.find(({ target }) => target.id === DEPLOYMENT_TARGET_ID)?.answer;
  return [
    linkCheck(link, mode, paths),
    platformCheck(host),
    glibcCheck(host),
    gitCheck(host, ports),
    diskCheck(paths, context.home, ports),
    systemdCheck(ports),
    lingerCheck(mode, context, ports),
    ...(deployment === null ? [deploymentUnknownCheck()] : []),
    ...answers.map(({ target, answer }) => networkCheck(target, answer)),
    clockCheck(deploymentAnswer, context.now?.() ?? Date.now()),
    modelsCheck(credentials, context.env),
    browserCheck(),
  ];
}

/** The counts a report carries, and the exit code `fail` decides. */
export function doctorReport(host: RunnerHostFacts, checks: readonly DoctorCheck[]): DoctorReport {
  const counts: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, unknown: 0, info: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { v: 1, host, checks, counts };
}

/** `2.31.1` against `2.31`: dotted numbers, the missing parts read as zero. */
export function atLeast(version: string, floor: string): boolean {
  const left = version.split(".").map((part) => Number.parseInt(part, 10));
  const right = floor.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** `1.2 GB`, `512 MB`: how much room a person has, in the units they think in. */
export function formatBytes(bytes: number): string {
  const gb = 1024 ** 3;
  if (bytes >= gb) return `${(bytes / gb).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** The login a user unit runs under: the shell's, else the home directory's own name. */
export function loginOf(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env["USER"] ?? env["LOGNAME"] ?? basename(home);
}

/** The install command for this distribution's git, when the distribution is known. */
export function gitInstallFix(distro: string | null): string {
  if (distro === null) return "Install git 2.31 or newer from your distribution's packages.";
  const known: readonly (readonly [RegExp, string])[] = [
    [/debian|ubuntu/i, "sudo apt-get install -y git"],
    [/fedora|rhel|red hat|centos|rocky|alma/i, "sudo dnf install -y git"],
    [/suse|sles/i, "sudo zypper install -y git"],
    [/arch/i, "sudo pacman -S --noconfirm git"],
  ];
  const command = known.find(([pattern]) => pattern.test(distro))?.[1];
  return command ?? "Install git 2.31 or newer from your distribution's packages.";
}

/**
 * The fix for a git that is installed and too old. Re-running the
 * distribution's install command cannot help: its own package is what is
 * below the floor (Ubuntu 20.04 ships 2.25, Debian 11 ships 2.30), so the fix
 * has to name a newer source rather than repeat the install.
 */
export function gitUpgradeFix(distro: string | null): string {
  const source =
    distro !== null && /debian|ubuntu/i.test(distro)
      ? "Debian backports or the git-core PPA"
      : "your distribution's backports or the git project's packages";
  return `Install git ${GIT_FLOOR} or newer from ${source}: this distribution's own package is older.`;
}

/** Whether an environment entry names something: set, and not blank. */
export function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function linkCheck(link: LinkFacts, mode: RunnerPaths["mode"], paths: RunnerPaths): DoctorCheck {
  const id = "link";
  const title = "link";
  if (link.state === "linked") {
    return {
      id,
      title,
      status: "ok",
      detail: `linked as ${link.name} (${link.runnerId}) to ${link.deployment.url}`,
    };
  }
  if (link.state === "unlinked") {
    return {
      id,
      title,
      status: "warn",
      detail: "this box is not linked to a Volli account",
      fix: "volli-runner link",
    };
  }
  // A link this run cannot open is usually a key the service account owns and
  // this login does not. Never `unlink`: that would orphan a healthy runner.
  return {
    id,
    title,
    status: "unknown",
    detail: `this box's link could not be opened: ${link.error}`,
    fix:
      mode === "system"
        ? `sudo -u volli env VOLLI_RUNNER_INSTALL_MODE=system volli-runner doctor --data-dir ${paths.dataDir} --config-dir ${paths.configDir}`
        : `Restore ${join(paths.configDir, LINK_KEY_FILE_NAME)} to this login's ownership, mode 0600, then run \`volli-runner doctor\` again`,
  };
}

function platformCheck(host: RunnerHostFacts): DoctorCheck {
  const platform = host.platform;
  if (platform.os !== "linux") {
    return {
      id: "platform",
      title: "platform",
      status: "fail",
      detail: `${platform.os} ${platform.arch} is not Linux`,
      fix: "Install volli-runner on a Debian 11+, Ubuntu 20.04+ or RHEL 9+ box; a Mac runs the Volli app's own runner.",
    };
  }
  return {
    id: "platform",
    title: "platform",
    status: "ok",
    detail: [platform.distro ?? "Linux", platform.arch, `kernel ${platform.kernel}`].join(", "),
  };
}

function glibcCheck(host: RunnerHostFacts): DoctorCheck {
  const platform = host.platform;
  if (platform.os !== "linux") {
    return {
      id: "glibc",
      title: "glibc",
      status: "info",
      detail: "not a Linux box; nothing to check",
    };
  }
  if (platform.glibc === null) {
    return {
      id: "glibc",
      title: "glibc",
      status: "fail",
      detail: "this box's C library is not glibc, or would not report itself",
      fix: `Use a glibc box (Debian 11+, Ubuntu 20.04+, RHEL 9+): this release needs glibc ${GLIBC_FLOOR}.`,
    };
  }
  if (!atLeast(platform.glibc, GLIBC_FLOOR)) {
    return {
      id: "glibc",
      title: "glibc",
      status: "fail",
      detail: `glibc ${platform.glibc} is older than ${GLIBC_FLOOR}`,
      fix: `Upgrade to Debian 11+, Ubuntu 20.04+ or RHEL 9+ (glibc ${GLIBC_FLOOR} or newer).`,
    };
  }
  return { id: "glibc", title: "glibc", status: "ok", detail: `glibc ${platform.glibc}` };
}

function gitCheck(host: RunnerHostFacts, ports: DoctorPorts): DoctorCheck {
  const answer = ports.run("git", ["--version"]);
  const version = answer.status === 0 ? versionOf(answer.stdout) : null;
  if (version === null) {
    return {
      id: "git",
      title: "git",
      status: "fail",
      detail: "git is not installed, or does not run",
      fix: gitInstallFix(host.platform.distro),
    };
  }
  if (!atLeast(version, GIT_FLOOR)) {
    return {
      id: "git",
      title: "git",
      status: "fail",
      detail: `git ${version} is older than ${GIT_FLOOR}`,
      fix: gitUpgradeFix(host.platform.distro),
    };
  }
  return { id: "git", title: "git", status: "ok", detail: `git ${version}` };
}

/** `git version 2.43.0` → `2.43.0`. */
function versionOf(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null;
}

interface FreeSpace {
  readonly bytes: number;
  readonly where: string;
}

function diskCheck(paths: RunnerPaths, home: string, ports: DoctorPorts): DoctorCheck {
  const free = freeSpace(paths.dataDir, home, ports);
  if (free === null) {
    return {
      id: "disk",
      title: "disk",
      status: "unknown",
      detail: `could not measure the free space under ${paths.dataDir}`,
      fix: `df -h ${paths.dataDir}`,
    };
  }
  if (free.bytes < MIN_FREE_BYTES) {
    return {
      id: "disk",
      title: "disk",
      status: "fail",
      detail: `${formatBytes(free.bytes)} free on ${free.where}; 1 GB is needed`,
      fix: `Remove old working copies under ${paths.dataDir} until \`df -h ${paths.dataDir}\` shows 1 GB free`,
    };
  }
  return {
    id: "disk",
    title: "disk",
    status: "ok",
    detail: `${formatBytes(free.bytes)} free on ${free.where}`,
  };
}

/** The data directory first — before install it does not exist, and the home is the same disk. */
function freeSpace(dataDir: string, home: string, ports: DoctorPorts): FreeSpace | null {
  for (const where of [dataDir, home]) {
    const bytes = ports.freeBytes(where);
    if (bytes !== null) return { bytes, where };
  }
  return null;
}

function systemdCheck(ports: DoctorPorts): DoctorCheck {
  if (!ports.exists(SYSTEMD_RUNTIME_DIR)) {
    return {
      id: "systemd",
      title: "systemd",
      status: "warn",
      detail: "systemd is not running on this box",
      fix: "Run the runner in the foreground under your own supervisor: `volli-runner run`.",
    };
  }
  return { id: "systemd", title: "systemd", status: "ok", detail: "systemd is running" };
}

function lingerCheck(
  mode: RunnerPaths["mode"],
  context: CommandContext,
  ports: DoctorPorts,
): DoctorCheck {
  const id = "linger";
  const title = "linger";
  if (mode === "system") {
    return {
      id,
      title,
      status: "info",
      detail: "a system install starts at boot; it needs no linger",
    };
  }
  const login = loginOf(context.env, context.home);
  const answer = ports.run("loginctl", ["show-user", login, "-p", "Linger", "--value"]);
  const value = answer.status === 0 ? answer.stdout.trim() : "";
  if (value === "yes") {
    return {
      id,
      title,
      status: "ok",
      detail: `${login}'s user services stay up after logout`,
    };
  }
  if (value === "no") {
    return {
      id,
      title,
      status: "warn",
      detail: `${login}'s user services stop at logout`,
      fix: `sudo loginctl enable-linger ${login}`,
    };
  }
  return {
    id,
    title,
    status: "unknown",
    detail: `logind did not say whether ${login} lingers`,
    fix: `loginctl show-user ${login} -p Linger --value`,
  };
}

interface NetworkTarget {
  readonly id: string;
  readonly url: string;
  /** What a failed probe means: the deployment is the runner's lifeline, the rest are not. */
  readonly severity: Extract<DoctorStatus, "fail" | "warn">;
  readonly fix: string;
}

function networkTargets(deployment: RunnerDeployment | null): readonly NetworkTarget[] {
  const targets: NetworkTarget[] = [];
  if (deployment !== null) {
    targets.push({
      id: "network.backend",
      url: deployment.url,
      severity: "fail",
      fix: `Allow outbound HTTPS to ${hostOf(deployment.url)} (port 443) from this box.`,
    });
    targets.push({
      id: DEPLOYMENT_TARGET_ID,
      url: deployment.siteUrl,
      severity: "fail",
      fix:
        `Allow outbound HTTPS to ${hostOf(deployment.siteUrl)} (port 443) from this box, ` +
        "and set HTTPS_PROXY before `volli-runner install` if it egresses through one.",
    });
  }
  targets.push({
    id: "network.github.com",
    url: GITHUB_URL,
    severity: "warn",
    fix: "Allow outbound HTTPS to github.com (port 443): the agent clones and pushes over it.",
  });
  for (const endpoint of MODEL_ENDPOINTS) {
    targets.push({
      id: `network.${endpoint.providerId}`,
      url: endpoint.url,
      severity: "warn",
      fix:
        `Allow outbound HTTPS to ${hostOf(endpoint.url)} (port 443), ` +
        "or sign in only to the providers this box can reach.",
    });
  }
  return targets;
}

function deploymentUnknownCheck(): DoctorCheck {
  return {
    id: DEPLOYMENT_TARGET_ID,
    title: "deployment",
    status: "unknown",
    detail: "this build names no server and this box is not linked",
    fix: "volli-runner link --server <url>",
  };
}

function networkCheck(target: NetworkTarget, answer: ReachAnswer): DoctorCheck {
  const title = hostOf(target.url);
  if (answer.reachable) {
    return { id: target.id, title, status: "ok", detail: `answered HTTP ${answer.status}` };
  }
  return {
    id: target.id,
    title,
    status: target.severity,
    detail: `no answer (${answer.reason})`,
    fix: target.fix,
  };
}

function clockCheck(deploymentAnswer: ReachAnswer | undefined, now: number): DoctorCheck {
  const id = "clock";
  const title = "clock";
  const date =
    deploymentAnswer !== undefined && deploymentAnswer.reachable ? deploymentAnswer.date : null;
  if (date === null) {
    return {
      id,
      title,
      status: "unknown",
      detail: "the deployment's clock reading is not available",
      fix: "timedatectl",
    };
  }
  const skew = now - date;
  if (Math.abs(skew) > CLOCK_SKEW_LIMIT_MS) {
    return {
      id,
      title,
      status: "fail",
      detail:
        `this box's clock is ${describeDuration(Math.abs(skew))} ` +
        `${skew > 0 ? "ahead of" : "behind"} the deployment's`,
      fix: "sudo timedatectl set-ntp true",
    };
  }
  return {
    id,
    title,
    status: "ok",
    detail: "within a minute of the deployment's clock",
  };
}

function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function modelsCheck(listing: CredentialListing, env: CommandContext["env"]): DoctorCheck {
  const id = "models";
  const title = "model logins";
  if (listing.state === "unreadable") {
    return {
      id,
      title,
      status: "unknown",
      detail: "this box's Pi credential store could not be read",
      fix: "volli-runner login --status",
    };
  }
  const stored = listing.providers.map(
    (provider) =>
      `${provider.providerId} (${provider.kind === "api-key" ? "API key" : "subscription"})`,
  );
  const ambient = AMBIENT_KEY_PROVIDERS.filter(
    ([name, providerId]) =>
      isSet(env[name]) && !listing.providers.some((provider) => provider.providerId === providerId),
  ).map(([, providerId]) => providerId);
  if (ambient.length > 0) {
    return {
      id,
      title,
      status: "warn",
      detail: `${stored.length > 0 ? `stored: ${stored.join(", ")}; ` : ""}API keys in this shell only: ${ambient.join(", ")}. The service does not inherit them.`,
      fix: `volli-runner login ${ambient[0]}`,
    };
  }
  if (stored.length === 0) {
    return {
      id,
      title,
      status: "warn",
      detail: "no model provider is signed in on this box",
      fix: "volli-runner login <provider>",
    };
  }
  return { id, title, status: "ok", detail: `signed in: ${stored.join(", ")}` };
}

function browserCheck(): DoctorCheck {
  return {
    id: "browser",
    title: "Chromium",
    status: "info",
    detail:
      "not bundled, by design: this runner serves Sessions without an agent browser, " +
      "so nothing on the box needs Chromium or an AppArmor profile for it",
  };
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}
