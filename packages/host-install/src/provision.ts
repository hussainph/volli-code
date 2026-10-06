/**
 * The step machine for adding a host over SSH (VC-700):
 *
 *     connect → probe → upload → install → start → enroll → tunnel
 *
 * **Typed and resumable.** The state is plain JSON: the request, each
 * finished step's result, the person's decisions and why it stopped. It holds
 * no secret: a sudo password is handed to `advance` in memory, per call, and
 * goes only to a child's stdin. `advance` runs from the first step without a
 * result until it finishes, fails or needs an answer. `retry` clears the
 * failed step and everything after it; `answer` records a decision. Every
 * box-side step is idempotent (hostd's `install`, `start` and `enroll`), so
 * running one twice is always safe.
 *
 * **Upgrade and adopt.** An older hostd asks: update it (the normal path), or
 * use it as it is when it speaks `status --json` (VC-700 and later). One from
 * before cannot be enrolled with, so only updating is offered. A box this
 * Mac is already enrolled with skips straight to the tunnel.
 *
 * **Logging.** Every step logs its start and its end with `component:
 * host-install`, the host and the step, never a secret.
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
import {
  STEP_ORDER,
  type ProvisionAnswer,
  type ProvisionFailure,
  type ProvisionQuestion,
  type StepId,
} from "./failures";
import { componentLogger, type InstallLogger } from "./logger";
import { artifactTarget, compareVersions, probeHost, type ProbeFacts } from "./probe";
import {
  classifySshFailure,
  shellQuote,
  type HostKeyOffer,
  type SshExecResult,
  type SshTransport,
} from "./ssh";
import type { SshTarget } from "./target";

/** What the lab's disk-full state names: room for the tarball, the release and its copy. */
export const DEFAULT_REQUIRED_DISK_BYTES = 420 * 1024 ** 2;
const MIN_GLIBC = "2.36";

export interface DeviceIdentity {
  /** P-256 SPKI, base64url: the public half only. */
  readonly publicKey: string;
  readonly fingerprint: string;
  /** The label the host shows for this Mac. */
  readonly name: string;
}

export interface ProvisionRequest {
  readonly target: SshTarget;
  readonly appVersion: string;
  readonly device: DeviceIdentity;
  /** The host id this Mac pinned for this host before, if any. */
  readonly pinnedHostId: string | null;
  readonly requiredDiskBytes?: number;
  readonly supportedTargets?: readonly string[];
}

export interface UploadResult {
  readonly releaseDir: string;
  readonly remoteTarball: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The box already had this exact tarball unpacked: nothing was sent. */
  readonly reused: boolean;
}

export interface StepResults {
  readonly connect?: { readonly ok: true };
  readonly probe?: ProbeFacts & { readonly artifactTarget: string };
  readonly upload?: UploadResult | { readonly skipped: true };
  readonly install?:
    | HostdInstallResult
    | { readonly skipped: true; readonly binary: string; readonly mode: InstallMode };
  readonly start?: HostdStartResult | { readonly skipped: true };
  readonly enroll?: HostdEnrollResult;
  readonly tunnel?: { readonly url: string };
}

export interface ProvisionDecisions {
  /** The fingerprints the person accepted, exactly: a different key is asked about again. */
  readonly acceptedHostKeys?: readonly string[];
  readonly existing?: "update" | "adopt";
  readonly alreadyPaired?: boolean;
  /** The person settled for a user unit rather than give sudo a password. */
  readonly userInstall?: boolean;
  readonly repin?: boolean;
}

export type ProvisionStop =
  | { readonly kind: "failed"; readonly failure: ProvisionFailure }
  | { readonly kind: "question"; readonly question: ProvisionQuestion };

export interface ProvisionState {
  readonly request: ProvisionRequest;
  readonly results: StepResults;
  readonly decisions: ProvisionDecisions;
  readonly status: "ready" | "stopped" | "done";
  readonly stop: ProvisionStop | null;
}

export function initialProvisionState(request: ProvisionRequest): ProvisionState {
  return { request, results: {}, decisions: {}, status: "ready", stop: null };
}

/** The step to run next, or `null` when all have results. */
export function nextStep(state: ProvisionState): StepId | null {
  return STEP_ORDER.find((step) => state.results[step] === undefined) ?? null;
}

/** Drops `from` and every step after it, so they run again. */
function without(results: StepResults, from: StepId): StepResults {
  const kept = STEP_ORDER.slice(0, STEP_ORDER.indexOf(from)).filter((step) => step in results);
  return Object.fromEntries(kept.map((step) => [step, results[step]])) as StepResults;
}

/** Clears a failure so `advance` runs its step (or `from`, earlier) again. */
export function retry(state: ProvisionState, from?: StepId): ProvisionState {
  const step = from ?? (state.stop?.kind === "failed" ? state.stop.failure.step : nextStep(state));
  return {
    ...state,
    results: step === null ? state.results : without(state.results, step),
    status: "ready",
    stop: null,
  };
}

function fingerprintsOf(offer: HostKeyOffer): string[] {
  return offer.fingerprints.map((entry) => entry.fingerprint).toSorted();
}

/** Records the person's answer to the question the state stopped on. */
export function answer(state: ProvisionState, reply: ProvisionAnswer): ProvisionState {
  const decisions = { ...state.decisions };
  switch (reply.kind) {
    case "accept-host-key":
      if (state.stop?.kind === "question" && state.stop.question.kind === "host-key") {
        decisions.acceptedHostKeys = fingerprintsOf(state.stop.question.offer);
      }
      break;
    case "update":
    case "adopt":
      decisions.existing = reply.kind;
      break;
    case "open":
      decisions.alreadyPaired = true;
      break;
    case "user-install":
      decisions.userInstall = true;
      break;
    case "repair":
      decisions.repin = true;
      break;
    case "sudo-password":
      // The password itself goes to `advance`'s secrets, never into state.
      break;
  }
  return { ...state, decisions, status: "ready", stop: null };
}

export interface ProvisionPorts {
  readonly ssh: SshTransport;
  readonly hostKeys: {
    discover(): Promise<HostKeyOffer | null>;
    accept(offer: HostKeyOffer): Promise<void>;
  };
  readonly artifact: (target: string) => Promise<HostdArtifact | ArtifactFailure>;
  readonly openTunnel: (
    remote: ListenAddress,
  ) => Promise<{ readonly url: string } | { readonly error: string }>;
  readonly logger: InstallLogger;
  readonly openFile?: (path: string) => Readable;
  /** A step began; the UI shows its verb. */
  readonly onStep?: (step: StepId) => void;
  readonly onUploadProgress?: (sent: number, total: number) => void;
}

/** What the caller holds in memory for this flow, and only for it. */
export interface ProvisionSecrets {
  sudoPassword: string | null;
}

type StepOutcome =
  | { readonly result: unknown; readonly decisions?: ProvisionDecisions }
  | ProvisionStop;

const isStop = (outcome: StepOutcome): outcome is ProvisionStop => "kind" in outcome;

/** Runs steps until done, failed, or waiting on the person. */
export async function advance(
  initial: ProvisionState,
  ports: ProvisionPorts,
  secrets: ProvisionSecrets = { sudoPassword: null },
): Promise<ProvisionState> {
  if (initial.status === "stopped") return initial;
  const { request } = initial;
  const results: Record<string, unknown> = { ...initial.results };
  let decisions = initial.decisions;
  const now = (): ProvisionState => ({
    request,
    results: results as StepResults,
    decisions,
    status: "ready",
    stop: null,
  });
  const logger = componentLogger(ports.logger, { host: request.target.label });
  for (let step = nextStep(now()); step !== null; step = nextStep(now())) {
    ports.onStep?.(step);
    const started = Date.now();
    logger.info("step started", { step });
    const outcome = await STEPS[step]({ state: now(), ports, secrets, logger });
    const ms = Date.now() - started;
    if (isStop(outcome)) {
      if (outcome.kind === "failed") {
        logger.warn("step failed", {
          step,
          ms,
          code: outcome.failure.code,
          failure: outcome.failure,
        });
      } else {
        logger.info("step needs an answer", { step, ms, question: outcome.question.kind });
      }
      return { ...now(), status: "stopped", stop: outcome };
    }
    logger.info("step finished", { step, ms });
    results[step] = outcome.result;
    decisions = outcome.decisions ?? decisions;
  }
  logger.info("host added", { mode: modeOf(now()) });
  return { ...now(), status: "done" };
}

interface StepContext {
  readonly state: ProvisionState;
  readonly ports: ProvisionPorts;
  readonly secrets: ProvisionSecrets;
  readonly logger: InstallLogger;
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
export function modeOf(state: ProvisionState): InstallMode | null {
  const install = state.results.install;
  if (install !== undefined) return install.mode;
  const probe = state.results.probe;
  if (probe === undefined) return null;
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
  return isStop(again) ? again : { ...again, decisions };
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
  if (facts.kernel !== "Linux") {
    return failed({
      code: "unsupported-system",
      step: "probe",
      system: facts.kernel || "this system",
    });
  }
  const target = artifactTarget(facts);
  if (
    target === null ||
    !(request.supportedTargets ?? DEFAULT_SUPPORTED_TARGETS).includes(target)
  ) {
    return failed({ code: "unsupported-arch", step: "probe", arch: facts.arch });
  }
  if (facts.systemd === null) return failed({ code: "no-systemd", step: "probe" });
  if (facts.glibc !== null && compareVersions(facts.glibc, MIN_GLIBC) < 0) {
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
  } else if (facts.sudo === "none" && !facts.userManager) {
    return failed({ code: "no-user-manager", step: "probe" });
  }
  if (installs) {
    const system = existing?.mode === "system" || (existing === null && facts.sudo !== "none");
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
function installing(state: ProvisionState): boolean {
  if (state.decisions.alreadyPaired === true) return false;
  return state.decisions.existing !== "adopt" || state.results.probe?.existing?.status === null;
}

const upload: Step = async ({ state, ports, logger }) => {
  if (!installing(state)) return { result: { skipped: true } };
  const probeFacts = state.results.probe!;
  const artifact = await ports.artifact(probeFacts.artifactTarget);
  if ("kind" in artifact)
    return failed({ code: artifact.kind, step: "upload", detail: artifact.detail });
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
  const connection = lost("upload", have);
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
  const dropped = lost("upload", sent);
  if (dropped !== null) return dropped;
  if (sent.code !== 0)
    return failed({ code: "upload-failed", step: "upload", detail: sent.stderr.trim() });
  const verified = await ports.ssh.exec(`sha256sum ${q(`${tarball}.part`)} | cut -d' ' -f1`, {
    label: "upload: verify",
  });
  if (verified.stdout.trim() !== artifact.sha256) {
    await ports.ssh.exec(`rm -f ${q(`${tarball}.part`)}`, { label: "upload: discard" });
    return failed({
      code: "remote-checksum",
      step: "upload",
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
  const unpackLost = lost("upload", unpacked);
  if (unpackLost !== null) return unpackLost;
  if (unpacked.code !== 0 || unpacked.stdout.trim() !== artifact.version) {
    return failed({
      code: "unpack-failed",
      step: "upload",
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
  const releaseDir = (state.results.upload as UploadResult).releaseDir;
  const binary = shellQuote(`${releaseDir}/bin/volli-hostd`);
  if (mode === "user") {
    if (!probeFacts.userManager) return failed({ code: "no-user-manager", step: "probe" });
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

const tunnel: Step = async ({ state, ports }) => {
  const started = state.results.start;
  const listen =
    (started !== undefined && "listen" in started ? started.listen : null) ??
    state.results.enroll!.listen;
  if (listen === null) {
    return failed({
      code: "tunnel-failed",
      step: "tunnel",
      detail: "The host is not listening for the desktop.",
    });
  }
  const opened = await ports.openTunnel(listen);
  if ("error" in opened)
    return failed({ code: "tunnel-failed", step: "tunnel", detail: opened.error });
  return { result: { url: opened.url } };
};

const STEPS: Record<StepId, Step> = { connect, probe, upload, install, start, enroll, tunnel };
