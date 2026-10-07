/**
 * The SSH runner (VC-700): every remote command goes through the system
 * `ssh` binary, so the person's `~/.ssh/config`, agent, ProxyJump and
 * known_hosts apply exactly as they do in Terminal. Volli never holds, copies
 * or stores their keys or passwords.
 *
 * Every connection adds only:
 * - `BatchMode=yes`: never a prompt. A key that is not loaded, or a server
 *   that wants a password, is a designed failure, not a hang.
 * - `StrictHostKeyChecking=yes`: an unknown host key is surfaced with its
 *   fingerprint for the person to accept (`discoverHostKeys`,
 *   `acceptHostKeys`); never blind `accept-new`.
 * - ControlMaster multiplexing, so the probe, the upload and each command
 *   share one authenticated connection, its socket in a 0700 directory of
 *   this user's alone.
 * - No forwarding of the agent, X11 or ports from the person's config, no
 *   `LocalCommand`, and never daemonizing (`ForkAfterAuthentication=no`,
 *   OpenSSH 8.7+): every command's ssh stays this process's child.
 *
 * Failures are classified from ssh's own words (`classifySshFailure`), so
 * each lab failure state has its own type and its own recovery.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import type { InstallLogger } from "./logger";
import { targetArgs, type SshTarget } from "./target";

export interface SshExecOptions {
  /** Bytes for the remote command's stdin: a string, or a stream (an upload). */
  readonly stdin?: string | Readable;
  /** Called with the running byte count of a streamed stdin. */
  readonly onProgress?: (bytes: number) => void;
  readonly timeoutMs?: number;
  /** Ends the command early, as a timeout does: SIGTERM, SIGKILL after a grace, then it answers. */
  readonly signal?: AbortSignal;
  /** What the log calls this command; the command itself is logged at debug only. */
  readonly label?: string;
}

export interface SshExecResult {
  /** The remote command's exit code; 255 is ssh's own failure. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One box, reached over SSH. The step machine sees only this; tests fake it. */
export interface SshTransport {
  readonly target: SshTarget;
  /** Runs `script` with the box's `/bin/sh`, whatever the login shell is. */
  exec(script: string, options?: SshExecOptions): Promise<SshExecResult>;
  /**
   * Ends every command still running (each answers as cancelled, once its
   * process has exited) and the shared connection. Every call after the
   * first shares it; an `exec` after it answers cancelled and spawns nothing.
   * With a `deadline` (epoch ms), ending the connection gets no longer than
   * what is left of it.
   */
  close(options?: SshCloseOptions): Promise<void>;
  /**
   * Past a deadline: SIGKILL every process this transport still owns, at
   * once, and resolve once they have exited (or a short wait has run out).
   * Closes it too. Optional: a transport with no processes need not have it.
   */
  kill?(): Promise<void>;
}

export interface SshCloseOptions {
  /** Epoch ms by which closing must be done; past it, the caller kills what is left. */
  readonly deadline?: number;
}

/** How SSH itself failed, typed from its own words. */
export type SshFailure =
  | { readonly kind: "unresolvable"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "host-key-unknown"; readonly detail: string }
  | { readonly kind: "host-key-changed"; readonly detail: string }
  /** The server offers only passwords or keyboard-interactive: no key of this Mac's is accepted. */
  | { readonly kind: "password-only"; readonly detail: string }
  /** Publickey was offered and refused: no key loaded in the agent, or not this box's. */
  | { readonly kind: "key-refused"; readonly detail: string }
  | { readonly kind: "ssh-missing"; readonly detail: string }
  | { readonly kind: "ssh-failed"; readonly detail: string };

/** The last few meaningful lines of ssh's stderr: never a secret, ssh prints none. */
function tail(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Warning: Permanently added"))
    .slice(-3)
    .join(" ");
}

/** What a failed connection means, or `null` when ssh connected and the command itself failed. */
export function classifySshFailure(result: SshExecResult): SshFailure | null {
  const text = result.stderr;
  const detail = tail(text);
  if (result.code === 127 && /spawn \S+ ENOENT/u.test(text)) return { kind: "ssh-missing", detail };
  if (result.code !== 255) return null;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/u.test(text)) {
    return { kind: "host-key-changed", detail };
  }
  if (/No \S+ host key is known|Host key verification failed/u.test(text)) {
    return { kind: "host-key-unknown", detail };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/u.test(text)) {
    return { kind: "unresolvable", detail };
  }
  if (
    /Connection timed out|Operation timed out|Connection refused|No route to host|Network is unreachable|Connection closed by|Connection reset/u.test(
      text,
    )
  ) {
    return { kind: "unreachable", detail };
  }
  // Found by index, not a backtracking pattern: stderr is the remote's to say.
  const deniedAt = text.indexOf("Permission denied (");
  const closed = deniedAt < 0 ? -1 : text.indexOf(")", deniedAt);
  if (closed >= 0) {
    const methods = text.slice(deniedAt + "Permission denied (".length, closed).split(",");
    return methods.includes("publickey")
      ? { kind: "key-refused", detail }
      : { kind: "password-only", detail };
  }
  return { kind: "ssh-failed", detail };
}

/** POSIX single-quoting: the one quoting every remote shell parses the same way. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The options every runner connection adds to the person's own config. */
export function connectionOptions(controlPath: string | null): string[] {
  const options = [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "ConnectTimeout=15",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
    "ForwardAgent=no",
    "ForwardX11=no",
    // No -L/-R here, so clearing every forwarding drops only the config's.
    "ClearAllForwardings=yes",
    "PermitLocalCommand=no",
    "ForkAfterAuthentication=no",
    ...(controlPath === null
      ? ["ControlMaster=no", "ControlPath=none"]
      : ["ControlMaster=auto", `ControlPath=${controlPath}`, "ControlPersist=60"]),
  ];
  return options.flatMap((option) => ["-o", option]);
}

export type SpawnProcess = (command: string, args: readonly string[]) => ChildProcess;

const LIVE_SPAWN: SpawnProcess = (command, args) =>
  nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });

/** The most output kept from one command: the probe and JSON answers are a few KB. */
const MAX_OUTPUT = 4 * 1024 * 1024;

/** How long a process has after SIGTERM before SIGKILL, and after SIGKILL before it is given up on. */
export const DEFAULT_KILL_AFTER_MS = 2_000;

/** How long `kill` waits for SIGKILLed processes to exit before it answers anyway. */
export const KILL_WAIT_MS = 500;

/** Resolves once every child in `children` has exited, or after `ms`. */
export function exitsWithin(children: Iterable<ChildProcess>, ms: number): Promise<void> {
  const exits = [...children].map(
    (child) =>
      new Promise<void>((resolve) => {
        // Already exited: Node sets one of these once it has.
        if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([Promise.all(exits).then(() => {}), late]).finally(() => clearTimeout(timer));
}

/** What a command ended by this runner answers, after ssh's own words. */
export const TIMED_OUT = "Connection timed out (volli)";
export const CANCELLED = "Cancelled (volli)";

export interface RunProcessOptions extends SshExecOptions {
  /** SIGTERM's grace before SIGKILL; {@link DEFAULT_KILL_AFTER_MS} by default. */
  readonly killAfterMs?: number;
}

/**
 * Runs one process to its end, feeding stdin and collecting output. Never
 * rejects. A timeout or an abort ends it: SIGTERM, then SIGKILL if it is
 * still there `killAfterMs` later, and it answers (code 255) only once the
 * process has exited, so nothing it started outlives its answer.
 */
export function runProcess(
  spawn: SpawnProcess,
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<SshExecResult> {
  const killAfterMs = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  const { signal } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: 255, stdout: "", stderr: CANCELLED });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args);
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: (error as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    /** Why this runner is ending it, once it is. */
    let ending: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: SshExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const ended = (): void =>
      finish({ code: 255, stdout, stderr: stderr === "" ? ending! : `${stderr}\n${ending!}` });
    const stop = (why: string): void => {
      if (ending !== null || settled) return;
      ending = why;
      if (exited) {
        ended();
        return;
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        // SIGKILL cannot be ignored: past this, there is no process left to wait on.
        killTimer = setTimeout(ended, killAfterMs);
      }, killAfterMs);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => stop(TIMED_OUT), options.timeoutMs);
    const onAbort = (): void => stop(CANCELLED);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: error.code === "ENOENT" ? 127 : 255, stdout, stderr: error.message });
    });
    child.on("exit", () => {
      exited = true;
      // Ended by this runner: it has exited, which is what its answer waits for.
      if (ending !== null) ended();
    });
    child.on("close", (code) => {
      if (ending !== null) ended();
      else finish({ code: code ?? 255, stdout, stderr });
    });
    const stdin = child.stdin!;
    // A remote end that stops reading early is its own failure, reported by its exit code.
    stdin.on("error", () => {});
    if (options.stdin === undefined) {
      stdin.end();
    } else if (typeof options.stdin === "string") {
      stdin.end(options.stdin);
    } else {
      let sent = 0;
      options.stdin.on("data", (chunk: Buffer) => {
        sent += chunk.length;
        options.onProgress?.(sent);
      });
      options.stdin.pipe(stdin);
    }
  });
}

export interface SystemSshOptions {
  readonly target: SshTarget;
  readonly logger: InstallLogger;
  /** The `ssh` binary; `ssh` on the PATH by default. */
  readonly sshPath?: string;
  /**
   * Where the ControlMaster socket lives. Short, because a Unix socket path
   * is capped near 104 bytes on macOS: a fresh 0700 directory under /tmp by
   * default. One given is made 0700 when missing, and refused unless it is a
   * real directory (not a symlink) of this user's that no one else can enter.
   */
  readonly controlDir?: string;
  readonly spawn?: SpawnProcess;
  /** SIGTERM's grace before SIGKILL for a command it ends; {@link DEFAULT_KILL_AFTER_MS} by default. */
  readonly killAfterMs?: number;
}

/** How long `close` waits for `ssh -O exit` to end the master. */
const CONTROL_EXIT_TIMEOUT_MS = 5_000;

/** A ControlMaster directory another user could reach: whoever can, can ride the connection. */
export class UnsafeControlDirError extends Error {
  readonly code = "unsafe-control-dir";
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Refusing ${path} for ssh's control socket: ${reason}`);
    this.name = "UnsafeControlDirError";
  }
}

/** Makes `dir` 0700 when missing; refuses it unless it is this user's private, real directory. */
export function ensureControlDir(dir: string, uid: number = userInfo().uid): string {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new UnsafeControlDirError(dir, (error as Error).message);
    }
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) throw new UnsafeControlDirError(dir, "it is a symbolic link");
  if (!stat.isDirectory()) throw new UnsafeControlDirError(dir, "it is not a directory");
  if (stat.uid !== uid) throw new UnsafeControlDirError(dir, `it is owned by uid ${stat.uid}`);
  if ((stat.mode & 0o077) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    throw new UnsafeControlDirError(dir, `others can reach it (mode ${mode})`);
  }
  return dir;
}

/**
 * The runner over the system `ssh`. Throws `UnsafeControlDirError` for an
 * unsafe `controlDir`.
 *
 * **It owns its ssh processes.** Every command's process is this one's child
 * until it exits; `close()` ends the ones still running (SIGTERM, then
 * SIGKILL) and waits for them before it ends the master, so a cancelled flow
 * or a quit never leaves one behind, and a command with no timeout can still
 * be ended.
 */
export function systemSsh(options: SystemSshOptions): SshTransport {
  const { target, logger } = options;
  const ssh = options.sshPath ?? "ssh";
  const spawnChild = options.spawn ?? LIVE_SPAWN;
  const killAfterMs = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  /** Every process it started that has not exited: a command's, or `-O exit`'s. */
  const children = new Set<ChildProcess>();
  const spawn: SpawnProcess = (command, args) => {
    const child = spawnChild(command, args);
    children.add(child);
    const gone = (): void => {
      children.delete(child);
    };
    child.once("exit", gone);
    child.once("error", gone);
    return child;
  };
  const owned = options.controlDir === undefined;
  const controlDir =
    options.controlDir === undefined
      ? mkdtempSync(join("/tmp", `volli-ssh-${userInfo().uid}-`))
      : ensureControlDir(options.controlDir);
  const controlPath = join(controlDir, "%C");
  const base = [...connectionOptions(controlPath), "-T"];
  /** Ends every command at close. */
  const closing = new AbortController();
  /** Every command still running: close waits for each to answer. */
  const active = new Set<Promise<SshExecResult>>();
  let closed: Promise<void> | null = null;
  return {
    target,
    async exec(script, execOptions = {}) {
      const label = execOptions.label ?? "command";
      if (closing.signal.aborted) {
        logger.debug("ssh exec refused: the connection is closed", { label });
        return { code: 255, stdout: "", stderr: CANCELLED };
      }
      const started = Date.now();
      const args = [...base, ...targetArgs(target), `sh -c ${shellQuote(script)}`];
      logger.debug("ssh exec", { label, script });
      const run = runProcess(spawn, ssh, args, {
        ...execOptions,
        killAfterMs,
        signal:
          execOptions.signal === undefined
            ? closing.signal
            : AbortSignal.any([closing.signal, execOptions.signal]),
      });
      active.add(run);
      const result = await run;
      active.delete(run);
      const failure = classifySshFailure(result);
      logger[failure === null ? "debug" : "warn"]("ssh exec finished", {
        label,
        code: result.code,
        ms: Date.now() - started,
        ...(failure === null ? {} : { failure: failure.kind, detail: failure.detail }),
      });
      return result;
    },
    close(closeOptions = {}) {
      closed ??= (async () => {
        closing.abort();
        await Promise.all(active);
        const left =
          closeOptions.deadline === undefined
            ? CONTROL_EXIT_TIMEOUT_MS
            : Math.min(CONTROL_EXIT_TIMEOUT_MS, closeOptions.deadline - Date.now());
        if (left > 0) {
          await runProcess(
            spawn,
            ssh,
            [...connectionOptions(controlPath), "-O", "exit", ...targetArgs(target)],
            { timeoutMs: left, killAfterMs },
          );
        } else {
          logger.warn("ssh master left to its ControlPersist: no time to end it", {});
        }
        if (owned) rmSync(controlDir, { recursive: true, force: true });
      })();
      return closed;
    },
    async kill() {
      closing.abort();
      const left = [...children];
      if (left.length === 0) return;
      logger.warn("ssh processes still running past the deadline; killing them", {
        processes: left.length,
      });
      for (const child of left) child.kill("SIGKILL");
      await exitsWithin(left, KILL_WAIT_MS);
    },
  };
}

export interface HostKeyOffer {
  /** known_hosts lines, exactly as ssh wrote them, to append once accepted. */
  readonly entries: readonly string[];
  /** What the person compares: `SHA256:…`, with the key type. */
  readonly fingerprints: readonly { readonly type: string; readonly fingerprint: string }[];
}

/** A host-key command's bound: past ssh's own 15 s connect timeout, never forever. */
const HOST_KEY_TIMEOUT_MS = 30_000;

/** `ssh-keygen -l`'s name for each known_hosts key type. */
const KEYGEN_TYPES: Readonly<Record<string, string>> = {
  "ssh-ed25519": "ED25519",
  "ssh-rsa": "RSA",
  "ssh-dss": "DSA",
  "ecdsa-sha2-nistp256": "ECDSA",
  "ecdsa-sha2-nistp384": "ECDSA",
  "ecdsa-sha2-nistp521": "ECDSA",
  "sk-ssh-ed25519@openssh.com": "ED25519-SK",
  "sk-ecdsa-sha2-nistp256@openssh.com": "ECDSA-SK",
};

/**
 * Whether each fingerprint is its entry's, in order: one per entry, of the
 * entry's key type where that type is known.
 */
function fingerprintsMatch(
  entries: readonly string[],
  fingerprints: HostKeyOffer["fingerprints"],
): boolean {
  if (fingerprints.length === 0 || fingerprints.length !== entries.length) return false;
  return entries.every((entry, index) => {
    const keyType = entry.trim().split(/\s+/u)[1];
    if (keyType === undefined) return false;
    const type = KEYGEN_TYPES[keyType];
    return type === undefined || type === fingerprints[index]!.type;
  });
}

/**
 * The keys the box presents, without trusting them and without offering any
 * credential to it: ssh records them into a scratch known_hosts while every
 * authentication method is off, so the connection ends at "Permission
 * denied" and nothing of the person's (no key, no agent, no password) ever
 * reaches a host they have not accepted. ProxyJump hops authenticate as usual.
 *
 * Fails closed: `null` unless every key has its computed fingerprint, since
 * a key the person cannot compare is a key they cannot accept.
 */
export async function discoverHostKeys(options: {
  readonly target: SshTarget;
  readonly sshPath?: string;
  readonly keygenPath?: string;
  readonly spawn?: SpawnProcess;
  readonly logger: InstallLogger;
}): Promise<HostKeyOffer | null> {
  const spawn = options.spawn ?? LIVE_SPAWN;
  const scratch = mkdtempSync(join(tmpdir(), "volli-hostkey-"));
  const file = join(scratch, "known_hosts");
  try {
    await runProcess(
      spawn,
      options.sshPath ?? "ssh",
      [
        ...[
          "BatchMode=yes",
          "StrictHostKeyChecking=accept-new",
          `UserKnownHostsFile=${file}`,
          "GlobalKnownHostsFile=/dev/null",
          "PubkeyAuthentication=no",
          "PasswordAuthentication=no",
          "KbdInteractiveAuthentication=no",
          "GSSAPIAuthentication=no",
          "HostbasedAuthentication=no",
          "IdentityAgent=none",
          "ForwardAgent=no",
          "ClearAllForwardings=yes",
          "PermitLocalCommand=no",
          "ForkAfterAuthentication=no",
          "ControlMaster=no",
          "ControlPath=none",
          "ConnectTimeout=15",
        ].flatMap((option) => ["-o", option]),
        ...targetArgs(options.target),
        "true",
      ],
      { timeoutMs: HOST_KEY_TIMEOUT_MS },
    );
    let entries: string[];
    try {
      entries = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      entries = [];
    }
    if (entries.length === 0) return null;
    const listed = await runProcess(spawn, options.keygenPath ?? "ssh-keygen", ["-l", "-f", file], {
      timeoutMs: HOST_KEY_TIMEOUT_MS,
    });
    const fingerprints = listed.stdout
      .split("\n")
      .map((line) => /^\d+\s+(SHA256:\S+)\s+.*\((\S+)\)\s*$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => ({ type: match[2]!, fingerprint: match[1]! }));
    if (listed.code !== 0 || !fingerprintsMatch(entries, fingerprints)) {
      options.logger.warn("host key fingerprints unavailable", {
        keys: entries.length,
        fingerprints: fingerprints.length,
        code: listed.code,
        detail: tail(listed.stderr),
      });
      return null;
    }
    options.logger.info("host keys offered", { fingerprints });
    return { entries, fingerprints };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The person accepted these keys: append them to the known_hosts file their
 * own ssh reads for this target (`ssh -G`'s `userknownhostsfile`, its first
 * entry), as ssh's own prompt would have.
 */
export async function acceptHostKeys(options: {
  readonly target: SshTarget;
  readonly offer: HostKeyOffer;
  readonly home: string;
  readonly sshPath?: string;
  readonly spawn?: SpawnProcess;
  readonly logger: InstallLogger;
}): Promise<string> {
  const spawn = options.spawn ?? LIVE_SPAWN;
  const resolved = await runProcess(
    spawn,
    options.sshPath ?? "ssh",
    ["-G", ...targetArgs(options.target)],
    {
      timeoutMs: HOST_KEY_TIMEOUT_MS,
    },
  );
  const configured = /^userknownhostsfile\s+(\S+)/mu.exec(resolved.stdout)?.[1];
  const file = (configured ?? "~/.ssh/known_hosts").replace(/^~(?=\/)/u, options.home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let separator = "";
  try {
    const existing = readFileSync(file, "utf8");
    separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  } catch {
    // A first known_hosts.
  }
  appendFileSync(file, `${separator}${options.offer.entries.join("\n")}\n`, { mode: 0o600 });
  options.logger.info("host keys accepted", { file, fingerprints: options.offer.fingerprints });
  return file;
}
