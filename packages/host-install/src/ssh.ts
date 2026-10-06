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
 *   share one authenticated connection.
 * - No forwarding of the agent, X11 or ports from the person's config.
 *
 * Failures are classified from ssh's own words (`classifySshFailure`), so
 * each lab failure state has its own type and its own recovery.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  /** Ends the shared connection. */
  close(): Promise<void>;
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
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/u.test(text)) {
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
  const denied = /Permission denied \(([^)]*)\)/u.exec(text);
  if (denied !== null) {
    const methods = denied[1]!.split(",");
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
    "ClearAllForwardings=yes",
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

/** Runs one process to its end, feeding stdin and collecting output. Never rejects. */
export function runProcess(
  spawn: SpawnProcess,
  command: string,
  args: readonly string[],
  options: SshExecOptions = {},
): Promise<SshExecResult> {
  return new Promise((resolve) => {
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
    const finish = (result: SshExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            finish({ code: 255, stdout, stderr: `${stderr}\nConnection timed out (volli)` });
          }, options.timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: error.code === "ENOENT" ? 127 : 255, stdout, stderr: error.message });
    });
    child.on("close", (code) => finish({ code: code ?? 255, stdout, stderr }));
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
   * default.
   */
  readonly controlDir?: string;
  readonly spawn?: SpawnProcess;
}

/** The runner over the system `ssh`. */
export function systemSsh(options: SystemSshOptions): SshTransport {
  const { target, logger } = options;
  const ssh = options.sshPath ?? "ssh";
  const spawn = options.spawn ?? LIVE_SPAWN;
  const owned = options.controlDir === undefined;
  const controlDir =
    options.controlDir ?? mkdtempSync(join("/tmp", `volli-ssh-${userInfo().uid}-`));
  const controlPath = join(controlDir, "%C");
  const base = [...connectionOptions(controlPath), "-T"];
  return {
    target,
    async exec(script, execOptions = {}) {
      const started = Date.now();
      const args = [...base, ...targetArgs(target), `sh -c ${shellQuote(script)}`];
      logger.debug("ssh exec", { label: execOptions.label ?? "command", script });
      const result = await runProcess(spawn, ssh, args, execOptions);
      const failure = classifySshFailure(result);
      logger[failure === null ? "debug" : "warn"]("ssh exec finished", {
        label: execOptions.label ?? "command",
        code: result.code,
        ms: Date.now() - started,
        ...(failure === null ? {} : { failure: failure.kind, detail: failure.detail }),
      });
      return result;
    },
    async close() {
      await runProcess(spawn, ssh, [
        ...connectionOptions(controlPath),
        "-O",
        "exit",
        ...targetArgs(target),
      ]);
      if (owned) rmSync(controlDir, { recursive: true, force: true });
    },
  };
}

export interface HostKeyOffer {
  /** known_hosts lines, exactly as ssh wrote them, to append once accepted. */
  readonly entries: readonly string[];
  /** What the person compares: `SHA256:…`, with the key type. */
  readonly fingerprints: readonly { readonly type: string; readonly fingerprint: string }[];
}

/**
 * The keys the box presents, without trusting them and without offering any
 * credential to it: ssh records them into a scratch known_hosts while every
 * authentication method is off, so the connection ends at "Permission
 * denied" and nothing of the person's (no key, no agent, no password) ever
 * reaches a host they have not accepted. ProxyJump hops authenticate as usual.
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
    await runProcess(spawn, options.sshPath ?? "ssh", [
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
        "ControlMaster=no",
        "ControlPath=none",
        "ConnectTimeout=15",
      ].flatMap((option) => ["-o", option]),
      ...targetArgs(options.target),
      "true",
    ]);
    let entries: string[];
    try {
      entries = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      entries = [];
    }
    if (entries.length === 0) return null;
    const listed = await runProcess(spawn, options.keygenPath ?? "ssh-keygen", ["-l", "-f", file]);
    const fingerprints = listed.stdout
      .split("\n")
      .map((line) => /^\d+\s+(SHA256:\S+)\s+.*\((\S+)\)\s*$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => ({ type: match[2]!, fingerprint: match[1]! }));
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
  const resolved = await runProcess(spawn, options.sshPath ?? "ssh", [
    "-G",
    ...targetArgs(options.target),
  ]);
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
