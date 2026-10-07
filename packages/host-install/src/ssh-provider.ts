/**
 * The SSH adapter of the step machine (VC-700): adding a host over SSH.
 *
 *     connect → probe → deliver (upload) → install → start → enroll → link (tunnel)
 *
 * Every box-side step is a hostd management command (`install`, `start`,
 * `enroll`), idempotent, so running one twice is always safe.
 *
 * **Upgrade and adopt.** An older hostd asks: update it (the normal path), or
 * use it as it is when it speaks `status --json` (VC-700 and later). One from
 * before cannot be enrolled with, so only updating is offered. A box this
 * Mac is already enrolled with skips straight to the link.
 *
 * **Linux and macOS.** A Linux box runs a systemd unit (system with sudo,
 * user without); a Mac runs a launchd user agent, always as the person. Which
 * targets this build can install is the caller's (`supportedTargets`, from
 * the signed app's pin); a Mac is refused until a darwin hostd ships.
 *
 * **Pinned end to end.** The tarball on the box is the one whose sha256 the
 * signed app pinned: one already there is sent again unless it matches. It
 * is then extracted afresh, every time, into a new staging directory beside
 * it, and only that tree's `volli-hostd` is run (`--version`) and handed to
 * install: an unpacked tree left from before, whatever it says, is never
 * trusted or executed.
 *
 * **Secrets.** A sudo password arrives in the caller's `ProvisionSecrets`, in
 * memory, and goes only to `sudo -S`'s stdin: never a command line, the state
 * or a log. sudo reads it only when it must authenticate (not with a cached
 * timestamp, nor NOPASSWD), so the privileged command never inherits that
 * stdin: it runs under `sh -c 'exec … </dev/null'`, and every hostd command
 * run as the login gets `</dev/null` too.
 *
 * **Typed, never thrown.** A state missing what a step relies on (a result,
 * a fact) stops with `unexpected-state`, retried from the probe.
 */
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import {
  readHostdJson,
  type HostdEnrollResult,
  type HostdFailure,
  type HostdInstallResult,
  type HostdStartResult,
  type InstallMode,
  type ListenAddress,
} from "./contract";
import type { ArtifactFailure, HostdArtifact } from "./artifact";
import { DEFAULT_SUPPORTED_TARGETS } from "./artifact";
import type { ProvisionFailure, ProvisionQuestion, StepId } from "./failures";
import { artifactTarget, compareVersions, probeHost, type ProbeFacts } from "./probe";
import {
  fingerprintsOf,
  type HostProvider,
  type ProvisionContext,
  type ProvisionResults,
  type ProvisionState,
  type ProvisionStop,
  type StepOutcome,
} from "./provision";
import {
  classifySshFailure,
  shellQuote,
  type HostKeyOffer,
  type SshExecOptions,
  type SshExecResult,
  type SshTransport,
} from "./ssh";

/** What the lab's disk-full state names: room for the tarball, the release and its copy. */
export const DEFAULT_REQUIRED_DISK_BYTES = 420 * 1024 ** 2;
const MIN_GLIBC = "2.36";

export interface UploadResult {
  /** The tree freshly extracted from the verified tarball: what install is given. */
  readonly releaseDir: string;
  readonly remoteTarball: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * The box already had the tarball, matching the pin, so it was not sent
   * again. It was still extracted afresh: `releaseDir` is new either way.
   */
  readonly reused: boolean;
}

/** What each SSH step leaves in the state: plain JSON. */
export interface SshStepResults extends ProvisionResults {
  readonly connect?: { readonly ok: true };
  readonly probe?: ProbeFacts & { readonly artifactTarget: string };
  readonly deliver?: UploadResult | { readonly skipped: true };
  readonly install?:
    | HostdInstallResult
    | { readonly skipped: true; readonly binary: string; readonly mode: InstallMode };
  readonly start?: HostdStartResult | { readonly skipped: true };
  readonly enroll?: HostdEnrollResult;
  readonly link?: { readonly url: string };
}

export type SshProvisionState = ProvisionState<SshStepResults>;

/** What the SSH adapter reaches the box and this Mac through. */
export interface SshProviderPorts {
  readonly ssh: SshTransport;
  readonly hostKeys: {
    discover(): Promise<HostKeyOffer | null>;
    accept(offer: HostKeyOffer): Promise<void>;
  };
  readonly artifact: (target: string) => Promise<HostdArtifact | ArtifactFailure>;
  readonly openTunnel: (
    remote: ListenAddress,
  ) => Promise<{ readonly url: string } | { readonly error: string }>;
  readonly openFile?: (path: string) => Readable;
  readonly onUploadProgress?: (sent: number, total: number) => void;
}

const failed = (failure: ProvisionFailure): ProvisionStop => ({ kind: "failed", failure });
const ask = (question: ProvisionQuestion): ProvisionStop => ({ kind: "question", question });

/** A state without what a step relies on; `sshProvider` turns it into `unexpected-state`. */
class UnexpectedState extends Error {}

/** `value`, or an `UnexpectedState` naming what was missing. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new UnexpectedState(`no ${what}`);
  return value;
}

/** A connection-level failure mid-step, or `null` when ssh itself was fine. */
function lost(step: StepId, result: SshExecResult): ProvisionStop | null {
  const failure = classifySshFailure(result);
  return failure === null
    ? null
    : failed({ code: "connection-lost", step, detail: failure.detail });
}

/** The mode the install has or will have; `null` until sudo has been settled. */
export function modeOf(state: SshProvisionState): InstallMode | null {
  // `null` too: a hand-edited or damaged state is not trusted to be whole.
  const install = state.results.install;
  if (install !== undefined && install !== null) return install.mode;
  const probe = state.results.probe;
  if (probe === undefined || probe === null) return null;
  // A Mac's host is a launchd agent: it runs as the person, always.
  if (probe.launchd) return "user";
  if (probe.existing !== null) return probe.existing.mode;
  if (state.decisions.userInstall === true || probe.sudo === "none") return "user";
  return "system";
}

/**
 * `command` as root. With NOPASSWD: `sudo -n`. Else `sudo -S` with the
 * password on the script's stdin (never in the command line, the
 * environment or a log). sudo reads that stdin only when it must
 * authenticate; with a cached timestamp it leaves it unread, so the command
 * itself runs under `sh -c 'exec … </dev/null'` and never inherits it. One
 * sudo, no reliance on its timestamp: a `timestamp_timeout=0` box works too.
 * `null` when a password is needed and not held.
 */
function asRoot(
  ctx: StepContext,
  command: string,
): { readonly script: string; readonly stdin?: string } | null {
  const inner = `${command} </dev/null`;
  if (need(ctx.state.results.probe, "probe facts").sudo === "nopasswd") {
    return { script: `sudo -n ${inner}` };
  }
  if (ctx.secrets.sudoPassword === null) return null;
  return {
    script: `sudo -S -p '' sh -c ${shellQuote(`exec ${inner}`)}`,
    stdin: `${ctx.secrets.sudoPassword}\n`,
  };
}

const WRONG_PASSWORD = /incorrect password|Sorry, try again|no password was provided/u;

/** What stands in for a secret a host echoed back. */
export const SECRET_REDACTED = "[redacted]";

/**
 * `text` with every occurrence of `secret` (a held sudo password) replaced.
 * A host's own words may echo it, in any shape, with no label a pattern could
 * find: only the exact value is reliable.
 */
export function withoutHeldSecret(text: string, secret: string | null): string {
  return secret === null || secret === "" ? text : text.split(secret).join(SECRET_REDACTED);
}

/**
 * Runs a hostd management command (as root, or as the login) and reads its
 * one JSON answer. Asks for a sudo password when one is needed. Its stdin is
 * always `/dev/null`.
 */
async function hostdCommand<T>(
  ctx: StepContext,
  step: "install" | "start" | "enroll",
  command: string,
  as: "root" | "login",
  reason: "install" | "linger" | "enroll",
): Promise<T | HostdFailure | ProvisionStop> {
  let run: { readonly script: string; readonly stdin?: string } | null = {
    script: `${command} </dev/null`,
  };
  if (as === "root") {
    run = asRoot(ctx, command);
    if (run === null) return ask({ kind: "sudo-password", step, reason, command, retry: false });
  }
  const result = await ctx.ports.ssh.exec(run.script, {
    label: step,
    timeoutMs: 180_000,
    ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
  });
  const connection = lost(step, result);
  if (connection !== null) return connection;
  const json = readHostdJson(result.stdout);
  if (json === null) {
    if (run.stdin !== undefined && WRONG_PASSWORD.test(result.stderr)) {
      ctx.secrets.sudoPassword = null;
      return ask({ kind: "sudo-password", step, reason, command, retry: true });
    }
    return failed({
      code: "hostd-refused",
      step,
      hostd: "no-answer",
      message: `volli-hostd ${step} gave no answer`,
      detail: withoutHeldSecret(result.stderr, ctx.secrets.sudoPassword)
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-10),
    });
  }
  return json as T | HostdFailure;
}

function refused(step: "install" | "start" | "enroll", refusal: HostdFailure): ProvisionStop {
  return failed({
    code: "hostd-refused",
    step,
    hostd: refusal.code,
    message: refusal.message,
    detail: refusal.detail ?? [],
  });
}

const isStopValue = (value: unknown): value is ProvisionStop =>
  typeof value === "object" && value !== null && "kind" in value;

interface StepContext extends ProvisionContext<SshStepResults> {
  readonly ports: SshProviderPorts;
}

type Step = (ctx: StepContext) => Promise<StepOutcome>;

const connect: Step = async (ctx) => {
  const { ports, state } = ctx;
  const result = await ports.ssh.exec("echo volli-ok", { label: "connect", timeoutMs: 30_000 });
  const failure = classifySshFailure(result);
  if (failure === null) {
    return result.stdout.includes("volli-ok")
      ? { result: { ok: true } }
      : failed({
          code: "ssh-failed",
          step: "connect",
          detail: result.stderr.trim() || `exit ${result.code}`,
        });
  }
  if (failure.kind !== "host-key-unknown") {
    return failed({ code: failure.kind, step: "connect", detail: failure.detail });
  }
  const offer = await ports.hostKeys.discover();
  if (offer === null)
    return failed({ code: "unreachable", step: "connect", detail: failure.detail });
  // Never an offer without a fingerprint for each key: nothing to compare is nothing to accept.
  if (offer.fingerprints.length === 0 || offer.fingerprints.length !== offer.entries.length) {
    return failed({
      code: "host-key-unverifiable",
      step: "connect",
      detail: `${offer.entries.length} keys, ${offer.fingerprints.length} fingerprints`,
    });
  }
  const accepted = state.decisions.acceptedHostKeys;
  if (accepted === undefined || accepted.join(" ") !== fingerprintsOf(offer).join(" ")) {
    return ask({ kind: "host-key", step: "connect", offer });
  }
  // Accepted, and the box still shows exactly those keys: trust them, then connect for real.
  await ports.hostKeys.accept(offer);
  const { acceptedHostKeys: _, ...decisions } = state.decisions;
  const again = await connect({ ...ctx, state: { ...state, decisions } });
  return isStopValue(again) ? again : { ...again, decisions };
};

const probe: Step = async ({ state, ports }) => {
  const outcome = await probeHost(ports.ssh);
  if (!outcome.ok) {
    const connection = lost("probe", { code: outcome.code, stdout: "", stderr: outcome.stderr });
    return (
      connection ?? failed({ code: "probe-failed", step: "probe", detail: outcome.stderr.trim() })
    );
  }
  const facts = outcome.facts;
  const { request, decisions } = state;
  // Two first-class branches: Linux (systemd) and macOS (a launchd user agent).
  const mac = facts.kernel === "Darwin";
  if (facts.kernel !== "Linux" && !mac) {
    return failed({
      code: "unsupported-system",
      step: "probe",
      system: facts.kernel || "this system",
    });
  }
  const target = artifactTarget(facts);
  if (target === null) return failed({ code: "unsupported-arch", step: "probe", arch: facts.arch });
  if (!(request.supportedTargets ?? DEFAULT_SUPPORTED_TARGETS).includes(target)) {
    // Known, but this build carries no hostd for it (arm64 Linux before VC-701, a Mac today).
    return failed({ code: "target-unavailable", step: "probe", target });
  }
  if (!mac && facts.systemd === null) return failed({ code: "no-systemd", step: "probe" });
  if (!mac && facts.glibc !== null && compareVersions(facts.glibc, MIN_GLIBC) < 0) {
    return failed({ code: "glibc-too-old", step: "probe", glibc: facts.glibc });
  }
  const result = { ...facts, artifactTarget: target };
  const existing = facts.existing;
  let installs = true;
  if (existing !== null) {
    const order = compareVersions(existing.version, request.appVersion);
    if (order > 0) return failed({ code: "host-newer", step: "probe", version: existing.version });
    const status = existing.status;
    const hostId = status?.running?.hostId ?? null;
    const enrolled =
      status?.devices?.some(
        (device) => device.fingerprint === request.device.fingerprint && device.revokedAt === null,
      ) === true;
    if (
      order === 0 &&
      enrolled &&
      status?.verdict === "serving" &&
      hostId !== null &&
      (request.pinnedHostId === null || request.pinnedHostId === hostId)
    ) {
      if (decisions.alreadyPaired !== true)
        return ask({ kind: "already-paired", step: "probe", hostId });
      installs = false;
    } else if (order < 0) {
      if (decisions.existing === undefined) {
        return ask({
          kind: "existing-hostd",
          step: "probe",
          version: existing.version,
          mode: existing.mode,
          adoptable: status !== null,
        });
      }
      installs = decisions.existing === "update" || status === null;
    }
    // A system install is the root's and the volli account's: every step on it needs sudo.
    if (existing.mode === "system" && facts.sudo === "none") {
      return failed({ code: "needs-sudo", step: "probe", version: existing.version });
    }
  } else if (!mac && facts.sudo === "none" && !facts.userManager) {
    return failed({ code: "no-user-manager", step: "probe" });
  }
  if (installs) {
    const system =
      !mac && (existing?.mode === "system" || (existing === null && facts.sudo !== "none"));
    const free = system ? facts.disk.system : facts.disk.home;
    const needBytes = request.requiredDiskBytes ?? DEFAULT_REQUIRED_DISK_BYTES;
    if (free !== null && free < needBytes) {
      return failed({ code: "disk-full", step: "probe", freeBytes: free, needBytes });
    }
  }
  return { result };
};

/**
 * Whether this flow installs, or uses what is there: an enrolled box, or an
 * older hostd the person chose to keep. One from before VC-700 speaks no
 * `status --json` and cannot be enrolled with, so it is always updated.
 */
function installing(state: SshProvisionState): boolean {
  if (state.decisions.alreadyPaired === true) return false;
  return state.decisions.existing !== "adopt" || state.results.probe?.existing?.status === null;
}

/** Every staging directory deliver makes in the cache: `stage.XXXXXX`. */
const STAGE_PREFIX = "stage.";
/**
 * Past this age (by mtime) a staging directory is abandoned and removed.
 * Never a younger one: another desktop (or this one, in another flow) may
 * have delivered it a moment ago and be waiting on a sudo password to
 * install from it. Each is touched when made, so its age is its delivery's.
 */
export const STALE_STAGING_MINUTES = 60;

/**
 * A remote file's SHA-256, hex, alone: `sha256sum` (GNU, Linux) or `shasum -a
 * 256` (a Mac, which has no `sha256sum`). Nothing when it cannot be read.
 */
function digestOf(quotedPath: string): string {
  return `{ sha256sum ${quotedPath} 2>/dev/null || shasum -a 256 ${quotedPath} 2>/dev/null; } | cut -d' ' -f1`;
}

const deliver: Step = async ({ state, ports, logger }) => {
  if (!installing(state)) return { result: { skipped: true } };
  const probeFacts = need(state.results.probe, "probe facts");
  const artifact = await ports.artifact(probeFacts.artifactTarget);
  if ("kind" in artifact)
    return failed({ code: artifact.kind, step: "deliver", detail: artifact.detail });
  const dir = `${probeFacts.home}/.cache/volli-hostd`;
  const tarball = `${dir}/${artifact.fileName}`;
  const part = `${tarball}.part`;
  // Where an earlier version of this step unpacked in place: never trusted, removed.
  const legacy = `${dir}/${artifact.fileName.replace(/\.tar\.gz$/u, "")}`;
  const q = shellQuote;
  const exec = (script: string, options: SshExecOptions) => ports.ssh.exec(script, options);

  // The tarball already there is sent again unless it is exactly the pinned one.
  const have = await exec(digestOf(q(tarball)), {
    label: "upload: check",
  });
  const connection = lost("deliver", have);
  if (connection !== null) return connection;
  const reused = have.stdout.trim() === artifact.sha256;
  if (reused) {
    logger.info("pinned tarball already on the box; not sending it", {
      fileName: artifact.fileName,
    });
  } else {
    const sent = await exec(`umask 022 && mkdir -p ${q(dir)} && cat > ${q(part)}`, {
      label: "upload",
      stdin: (ports.openFile ?? createReadStream)(artifact.path),
      onProgress: (bytes) => ports.onUploadProgress?.(bytes, artifact.bytes),
      timeoutMs: 30 * 60_000,
    });
    const dropped = lost("deliver", sent);
    if (dropped !== null) return dropped;
    if (sent.code !== 0)
      return failed({ code: "upload-failed", step: "deliver", detail: sent.stderr.trim() });
    const verified = await exec(digestOf(q(part)), {
      label: "upload: verify",
    });
    const verifyLost = lost("deliver", verified);
    if (verifyLost !== null) return verifyLost;
    if (verified.stdout.trim() !== artifact.sha256) {
      await exec(`rm -f ${q(part)}`, { label: "upload: discard" });
      return failed({
        code: "remote-checksum",
        step: "deliver",
        detail: `${artifact.fileName} arrived as ${verified.stdout.trim() || "nothing"}, not ${artifact.sha256}`,
      });
    }
  }

  // Always a fresh tree from the verified tarball, checked once more as it is
  // read: an unpacked tree from before (or half of one) is never trusted.
  const unpacked = await exec(
    [
      "umask 022",
      `d=${q(dir)}`,
      ...(reused ? [] : [`mv -f ${q(part)} ${q(tarball)} || exit 1`]),
      `rm -rf ${q(legacy)}`,
      // Only abandoned staging: one younger may be another delivery's, awaiting its install.
      `find "$d" -mindepth 1 -maxdepth 1 -type d -name '${STAGE_PREFIX}*' -mmin +${STALE_STAGING_MINUTES} -exec rm -rf {} + 2>/dev/null`,
      `s=$(mktemp -d "$d/${STAGE_PREFIX}XXXXXX") || exit 1`,
      // mktemp's 0700 would follow the copy into the install, shutting the service account out.
      'chmod 755 "$s" || exit 1',
      `sum=$(${digestOf(q(tarball))})`,
      `if [ "$sum" != ${q(artifact.sha256)} ]; then rm -rf "$s" ${q(tarball)}; echo "checksum=$sum"; exit 3; fi`,
      `tar -xzf ${q(tarball)} -C "$s" --strip-components=1 --no-same-owner || { rm -rf "$s"; exit 1; }`,
      // Its age is this delivery's, whatever times the archive carried.
      'touch "$s"',
      'echo "dir=$s"',
      'echo "version=$("$s/bin/volli-hostd" --version </dev/null)"',
    ].join("\n"),
    { label: "upload: unpack", timeoutMs: 5 * 60_000 },
  );
  const unpackLost = lost("deliver", unpacked);
  if (unpackLost !== null) return unpackLost;
  const said = (key: string) => new RegExp(`^${key}=(.*)$`, "mu").exec(unpacked.stdout)?.[1];
  const changed = said("checksum");
  if (changed !== undefined) {
    return failed({
      code: "remote-checksum",
      step: "deliver",
      detail: `${artifact.fileName} on the box is ${changed || "unreadable"}, not ${artifact.sha256}`,
    });
  }
  const releaseDir = said("dir") ?? "";
  const version = said("version")?.trim() || "no version";
  const problem =
    unpacked.code !== 0
      ? `exit ${unpacked.code}`
      : !releaseDir.startsWith(`${dir}/${STAGE_PREFIX}`)
        ? `it unpacked to ${releaseDir || "nowhere"}`
        : version !== artifact.version
          ? `it reports ${version}`
          : null;
  if (problem !== null) {
    return failed({
      code: "unpack-failed",
      step: "deliver",
      detail: unpacked.stderr.trim() || problem,
    });
  }
  return {
    result: {
      releaseDir,
      remoteTarball: tarball,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      reused,
    } satisfies UploadResult,
  };
};

const install: Step = async (ctx) => {
  const { state } = ctx;
  const probeFacts = need(state.results.probe, "probe facts");
  const mode = need(modeOf(state), "install mode");
  if (!installing(state)) {
    const existing = need(probeFacts.existing, "existing hostd to use");
    return { result: { skipped: true, binary: existing.binary, mode } };
  }
  // Installing, so deliver must have unpacked a release (not skipped, not lost).
  const delivered = state.results.deliver as Partial<UploadResult> | null | undefined;
  const releaseDir = need(delivered?.releaseDir, "delivered release to install");
  const binary = shellQuote(`${releaseDir}/bin/volli-hostd`);
  if (mode === "user") {
    // A Linux user unit needs a systemd user session; a Mac's launchd always has one.
    if (!probeFacts.userManager && !probeFacts.launchd) {
      return failed({ code: "no-user-manager", step: "probe" });
    }
    return finish(
      "install",
      await hostdCommand<HostdInstallResult>(
        ctx,
        "install",
        `${binary} install --user`,
        "login",
        "install",
      ),
    );
  }
  const command = `${binary} install --system --operator ${shellQuote(probeFacts.user)}`;
  const installed = await hostdCommand<HostdInstallResult>(
    ctx,
    "install",
    command,
    "root",
    "install",
  );
  if (!isStopValue(installed) && installed.ok) {
    await makeOperator(ctx, installed.binary, probeFacts.user, probeFacts.home);
  }
  return finish("install", installed);
};

/**
 * The person's own login made an operator (VC-710), while this step holds
 * root: an operator token issued for it unless it holds one already, and the
 * system install's checkout folder made if there is none (runbook steps 6
 * and 7), so "New project…" needs nothing run by hand. Never fails the add:
 * without it, the app shows the one command that issues the token.
 */
async function makeOperator(
  ctx: StepContext,
  binary: string,
  login: string,
  home: string,
): Promise<void> {
  const tokenFile = `${home}/.config/volli/operator-token`;
  // The token's own outcome is the script's: making the folder never masks it.
  const script = [
    "t=0",
    `[ -s ${shellQuote(tokenFile)} ] || ${shellQuote(binary)} operator-token --for ${shellQuote(login)} >/dev/null || t=$?`,
    `[ -e ${SYSTEM_CHECKOUTS} ] || install -d -o volli -g volli -m 750 ${SYSTEM_CHECKOUTS} || echo "could not make ${SYSTEM_CHECKOUTS}" >&2`,
    'exit "$t"',
  ].join("\n");
  const run = asRoot(ctx, `sh -c ${shellQuote(script)}`);
  if (run === null) {
    ctx.logger.warn("no sudo to issue an operator token; the app shows the command instead");
    return;
  }
  // The password is only ever on stdin; the host's words are scrubbed of it
  // before they reach the log or the add flow's transcript, whatever they say.
  const secret = ctx.secrets.sudoPassword;
  let result: SshExecResult;
  try {
    result = await ctx.ports.ssh.exec(run.script, {
      label: "install: operator",
      timeoutMs: 60_000,
      ...(run.stdin === undefined ? {} : { stdin: run.stdin }),
    });
  } catch (error) {
    ctx.logger.warn("could not make the login an operator; the app shows the command instead", {
      login,
      error: withoutHeldSecret(String(error), secret),
    });
    return;
  }
  if (result.code === 0) {
    ctx.logger.info("made the login an operator", { login });
  } else {
    ctx.logger.warn("could not make the login an operator; the app shows the command instead", {
      login,
      code: result.code,
      stderr: withoutHeldSecret(result.stderr, secret).trim().split("\n").slice(-3).join(" "),
    });
  }
}

/** Where a system install's checkouts live (runbook step 6): `volli`'s, 0750. */
const SYSTEM_CHECKOUTS = "/srv/volli";

function finish<T extends { readonly ok: true }>(
  step: "install" | "start" | "enroll",
  outcome: T | HostdFailure | ProvisionStop,
): StepOutcome {
  if (isStopValue(outcome)) return outcome;
  if (outcome.ok) return { result: outcome };
  return refused(step, outcome);
}

const start: Step = async (ctx) => {
  const { state } = ctx;
  const probeFacts = need(state.results.probe, "probe facts");
  const running = probeFacts.existing?.status;
  if (
    state.decisions.alreadyPaired === true ||
    (!installing(state) && running?.verdict === "serving" && running.running?.listen != null)
  ) {
    return { result: { skipped: true } };
  }
  const mode = need(modeOf(state), "install mode");
  const binary = shellQuote(need(state.results.install, "install result").binary);
  if (mode === "system") {
    return finish(
      "start",
      await hostdCommand<HostdStartResult>(
        ctx,
        "start",
        `${binary} start --system`,
        "root",
        "install",
      ),
    );
  }
  const started = await hostdCommand<HostdStartResult>(
    ctx,
    "start",
    `${binary} start --user`,
    "login",
    "linger",
  );
  if (isStopValue(started) || started.ok || started.code !== "linger-required")
    return finish("start", started);
  // A user unit stops at logout unless the account lingers; that one command needs root.
  const user = probeFacts.user;
  const linger = `loginctl enable-linger ${shellQuote(user)}`;
  if (probeFacts.sudo === "none") {
    // No sudo for this login at all: no password would help; an administrator can.
    return failed({ code: "linger-needs-admin", step: "start", user, command: `sudo ${linger}` });
  }
  const enable = asRoot(ctx, linger);
  if (enable === null) {
    return ask({
      kind: "sudo-password",
      step: "start",
      reason: "linger",
      command: `sudo ${linger}`,
      retry: false,
    });
  }
  const enabled = await ctx.ports.ssh.exec(enable.script, {
    label: "start: linger",
    ...(enable.stdin === undefined ? {} : { stdin: enable.stdin }),
  });
  const connection = lost("start", enabled);
  if (connection !== null) return connection;
  if (enabled.code !== 0) {
    if (enable.stdin !== undefined) ctx.secrets.sudoPassword = null;
    return ask({
      kind: "sudo-password",
      step: "start",
      reason: "linger",
      command: `sudo ${linger}`,
      retry: true,
    });
  }
  return finish(
    "start",
    await hostdCommand<HostdStartResult>(ctx, "start", `${binary} start --user`, "login", "linger"),
  );
};

const enroll: Step = async (ctx) => {
  const { state } = ctx;
  const { request } = state;
  const probeFacts = need(state.results.probe, "probe facts");
  if (state.decisions.alreadyPaired === true) {
    // Already enrolled: what the box said in the probe is the pairing.
    const status = need(probeFacts.existing?.status, "status of the paired host");
    const running = need(status.running, "running paired host");
    const device = need(
      status.devices?.find(
        (entry) => entry.fingerprint === request.device.fingerprint && entry.revokedAt === null,
      ),
      "enrollment of this device",
    );
    return {
      result: {
        v: 1,
        ok: true,
        hostId: need(running.hostId, "host id of the paired host"),
        deviceId: device.deviceId,
        fingerprint: device.fingerprint,
        created: false,
        version: running.version,
        listen: running.listen,
      } satisfies HostdEnrollResult,
    };
  }
  const mode = need(modeOf(state), "install mode");
  const binary = shellQuote(need(state.results.install, "install result").binary);
  const command = `${binary} enroll --${mode} --public-key ${shellQuote(request.device.publicKey)} --name ${shellQuote(request.device.name)}`;
  // A system install's device store is root's: enroll runs as root, as install and start do.
  const outcome = await hostdCommand<HostdEnrollResult>(
    ctx,
    "enroll",
    command,
    mode === "system" ? "root" : "login",
    "enroll",
  );
  if (isStopValue(outcome) || !outcome.ok) return finish("enroll", outcome);
  const pinned = request.pinnedHostId;
  if (pinned !== null && pinned !== outcome.hostId && state.decisions.repin !== true) {
    return ask({ kind: "identity-changed", step: "enroll", pinned, hostId: outcome.hostId });
  }
  return { result: outcome };
};

const link: Step = async ({ state, ports }) => {
  const started = state.results.start;
  const listen =
    (started !== undefined && "listen" in started ? started.listen : null) ??
    need(state.results.enroll, "enrollment").listen;
  if (listen === null) {
    return failed({
      code: "tunnel-failed",
      step: "link",
      detail: "The host is not listening for the desktop.",
    });
  }
  const opened = await ports.openTunnel(listen);
  if ("error" in opened)
    return failed({ code: "tunnel-failed", step: "link", detail: opened.error });
  return { result: { url: opened.url } };
};

const STEPS: Record<StepId, Step> = { connect, probe, deliver, install, start, enroll, link };

/**
 * The SSH adapter: the first way to add a host, and the reference for others
 * (a provider's own API in place of a shell, an image in place of a tarball).
 */
export function sshProvider(ports: SshProviderPorts): HostProvider<SshStepResults> {
  return {
    id: "ssh",
    async run(step, context) {
      try {
        return await STEPS[step]({ ...context, ports });
      } catch (error) {
        if (!(error instanceof UnexpectedState)) throw error;
        return failed({ code: "unexpected-state", step, detail: error.message });
      }
    },
  };
}
