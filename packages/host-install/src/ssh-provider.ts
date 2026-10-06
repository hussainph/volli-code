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
 * **Secrets.** A sudo password arrives in the caller's `ProvisionSecrets`, in
 * memory, and goes only to `sudo -S`'s stdin: never a command line, the state
 * or a log.
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
  type SshExecResult,
  type SshTransport,
} from "./ssh";

/** What the lab's disk-full state names: room for the tarball, the release and its copy. */
export const DEFAULT_REQUIRED_DISK_BYTES = 420 * 1024 ** 2;
const MIN_GLIBC = "2.36";

export interface UploadResult {
  readonly releaseDir: string;
  readonly remoteTarball: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The box already had this exact tarball unpacked: nothing was sent. */
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

/** A connection-level failure mid-step, or `null` when ssh itself was fine. */
function lost(step: StepId, result: SshExecResult): ProvisionStop | null {
  const failure = classifySshFailure(result);
  return failure === null
    ? null
    : failed({ code: "connection-lost", step, detail: failure.detail });
}

/** The mode the install has or will have; `null` until sudo has been settled. */
export function modeOf(state: SshProvisionState): InstallMode | null {
  const install = state.results.install;
  if (install !== undefined) return install.mode;
  const probe = state.results.probe;
  if (probe === undefined) return null;
  // A Mac's host is a launchd agent: it runs as the person, always.
  if (probe.launchd) return "user";
  if (probe.existing !== null) return probe.existing.mode;
  if (state.decisions.userInstall === true || probe.sudo === "none") return "user";
  return "system";
}

/**
 * A command as root, or as `asUser`: `sudo -n` when sudo needs no password,
 * else `sudo -S` with the password on stdin (never in the command line, the
 * environment or a log). `null` when a password is needed and not held.
 */
function sudo(
  ctx: StepContext,
  command: string,
  asUser?: string,
): { readonly script: string; readonly stdin?: string } | null {
  const user = asUser === undefined ? "" : `-u ${asUser} `;
  if (ctx.state.results.probe!.sudo === "nopasswd") return { script: `sudo -n ${user}${command}` };
  if (ctx.secrets.sudoPassword === null) return null;
  return { script: `sudo -S -p '' ${user}${command}`, stdin: `${ctx.secrets.sudoPassword}\n` };
}

const WRONG_PASSWORD = /incorrect password|Sorry, try again|no password was provided/u;

/**
 * Runs a hostd management command (as root, as `asUser`, or as the login)
 * and reads its one JSON answer. Asks for a sudo password when one is needed.
 */
async function hostdCommand<T>(
  ctx: StepContext,
  step: "install" | "start" | "enroll",
  command: string,
  as: "root" | "service" | "login",
  reason: "install" | "linger" | "service-account",
): Promise<T | HostdFailure | ProvisionStop> {
  let run: { readonly script: string; readonly stdin?: string } | null = { script: command };
  if (as !== "login") {
    run = sudo(ctx, command, as === "service" ? "volli" : undefined);
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
      detail: result.stderr.trim().split("\n").filter(Boolean).slice(-10),
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
    const need = request.requiredDiskBytes ?? DEFAULT_REQUIRED_DISK_BYTES;
    if (free !== null && free < need) {
      return failed({ code: "disk-full", step: "probe", freeBytes: free, needBytes: need });
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

const deliver: Step = async ({ state, ports, logger }) => {
  if (!installing(state)) return { result: { skipped: true } };
  const probeFacts = state.results.probe!;
  const artifact = await ports.artifact(probeFacts.artifactTarget);
  if ("kind" in artifact)
    return failed({ code: artifact.kind, step: "deliver", detail: artifact.detail });
  const dir = `${probeFacts.home}/.cache/volli-hostd`;
  const tarball = `${dir}/${artifact.fileName}`;
  const releaseDir = `${dir}/${artifact.fileName.replace(/\.tar\.gz$/u, "")}`;
  const binary = `${releaseDir}/bin/volli-hostd`;
  const q = shellQuote;
  const facts = {
    releaseDir,
    remoteTarball: tarball,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };

  // Resumable: the exact tarball already there and unpacked is not sent again.
  const have = await ports.ssh.exec(
    `sha256sum ${q(tarball)} 2>/dev/null | cut -d' ' -f1; ${q(binary)} --version 2>/dev/null`,
    { label: "upload: check" },
  );
  const connection = lost("deliver", have);
  if (connection !== null) return connection;
  const [sum, version] = have.stdout.trim().split("\n");
  if (sum === artifact.sha256 && version === artifact.version) {
    logger.info("tarball already on the box", { fileName: artifact.fileName });
    return { result: { ...facts, reused: true } };
  }

  const sent = await ports.ssh.exec(
    `umask 022 && mkdir -p ${q(dir)} && cat > ${q(`${tarball}.part`)}`,
    {
      label: "upload",
      stdin: (ports.openFile ?? createReadStream)(artifact.path),
      onProgress: (bytes) => ports.onUploadProgress?.(bytes, artifact.bytes),
      timeoutMs: 30 * 60_000,
    },
  );
  const dropped = lost("deliver", sent);
  if (dropped !== null) return dropped;
  if (sent.code !== 0)
    return failed({ code: "upload-failed", step: "deliver", detail: sent.stderr.trim() });
  const verified = await ports.ssh.exec(`sha256sum ${q(`${tarball}.part`)} | cut -d' ' -f1`, {
    label: "upload: verify",
  });
  if (verified.stdout.trim() !== artifact.sha256) {
    await ports.ssh.exec(`rm -f ${q(`${tarball}.part`)}`, { label: "upload: discard" });
    return failed({
      code: "remote-checksum",
      step: "deliver",
      detail: `${artifact.fileName} arrived as ${verified.stdout.trim() || "nothing"}, not ${artifact.sha256}`,
    });
  }
  const unpacked = await ports.ssh.exec(
    [
      "umask 022",
      `mv -f ${q(`${tarball}.part`)} ${q(tarball)}`,
      `rm -rf ${q(releaseDir)}`,
      `mkdir -p ${q(releaseDir)}`,
      `tar -xzf ${q(tarball)} -C ${q(releaseDir)} --strip-components=1 --no-same-owner`,
      `${q(binary)} --version`,
    ].join(" && "),
    { label: "upload: unpack", timeoutMs: 5 * 60_000 },
  );
  const unpackLost = lost("deliver", unpacked);
  if (unpackLost !== null) return unpackLost;
  if (unpacked.code !== 0 || unpacked.stdout.trim() !== artifact.version) {
    return failed({
      code: "unpack-failed",
      step: "deliver",
      detail: unpacked.stderr.trim() || `it reports ${unpacked.stdout.trim() || "no version"}`,
    });
  }
  return { result: { ...facts, reused: false } };
};

const install: Step = async (ctx) => {
  const { state } = ctx;
  const probeFacts = state.results.probe!;
  const mode = modeOf(state)!;
  if (!installing(state)) {
    return { result: { skipped: true, binary: probeFacts.existing!.binary, mode } };
  }
  const releaseDir = (state.results.deliver as UploadResult).releaseDir;
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
  return finish(
    "install",
    await hostdCommand<HostdInstallResult>(ctx, "install", command, "root", "install"),
  );
};

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
  const running = state.results.probe!.existing?.status;
  if (
    state.decisions.alreadyPaired === true ||
    (!installing(state) && running?.verdict === "serving" && running.running?.listen != null)
  ) {
    return { result: { skipped: true } };
  }
  const mode = modeOf(state)!;
  const binary = shellQuote(state.results.install!.binary);
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
  const user = state.results.probe!.user;
  const started = await hostdCommand<HostdStartResult>(
    ctx,
    "start",
    `${binary} start --user`,
    "login",
    "linger",
  );
  if (isStopValue(started) || started.ok || started.code !== "linger-required")
    return finish("start", started);
  // A user unit stops at logout unless the account lingers; that one command needs sudo.
  const linger = `loginctl enable-linger ${shellQuote(user)}`;
  const enable = sudo(ctx, linger);
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
  const probeFacts = state.results.probe!;
  if (state.decisions.alreadyPaired === true) {
    // Already enrolled: what the box said in the probe is the pairing.
    const status = probeFacts.existing!.status!;
    const device = status.devices!.find(
      (entry) => entry.fingerprint === request.device.fingerprint,
    )!;
    return {
      result: {
        v: 1,
        ok: true,
        hostId: status.running!.hostId!,
        deviceId: device.deviceId,
        fingerprint: device.fingerprint,
        created: false,
        version: status.running!.version,
        listen: status.running!.listen,
      } satisfies HostdEnrollResult,
    };
  }
  const mode = modeOf(state)!;
  const binary = shellQuote(state.results.install!.binary);
  const command = `${binary} enroll --${mode} --public-key ${shellQuote(request.device.publicKey)} --name ${shellQuote(request.device.name)}`;
  const outcome = await hostdCommand<HostdEnrollResult>(
    ctx,
    "enroll",
    command,
    mode === "system" ? "service" : "login",
    "service-account",
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
    state.results.enroll!.listen;
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
    run: (step, context) => STEPS[step]({ ...context, ports }),
  };
}
