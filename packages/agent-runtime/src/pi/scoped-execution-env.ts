import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  err,
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core/node";

const MAX_CAPTURED_OUTPUT_BYTES = 1_000_000;
const KILL_GRACE_MS = 250;

type SandboxDependencyCheck = { errors: string[]; warnings: string[] };

interface SandboxRuntime {
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  checkDependenciesAsync(): Promise<SandboxDependencyCheck>;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  getConfig(): SandboxRuntimeConfig | undefined;
  wrapWithSandboxArgv(
    command: string,
    shell: string,
    config: Partial<SandboxRuntimeConfig>,
    signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type ProcessKill = (pid: number, signal: NodeJS.Signals) => void;
interface FileOperations {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface ScopedExecutionEnvOptions {
  /** Internal test seam for SRT's process-global manager. */
  sandbox?: SandboxRuntime;
  /** Internal test seam for the host process boundary. */
  spawn?: Spawn;
  /** Internal test seam for canonical home-boundary policy. */
  homeDir?: string;
  /** Internal test seam for process-group signals. */
  processKill?: ProcessKill;
  /** Internal test seam for owned temporary output spools. */
  fileOperations?: FileOperations;
}

/**
 * The contained execution capability Pi's coding tools receive.
 *
 * Named for the Session rather than the Ticket because the root it contains is
 * whatever that Session's workspace is: a Ticket worktree, or the project's
 * Main checkout for a project Session. Nothing here reads the difference.
 */
export interface SessionExecutionEnv extends ExecutionEnv {
  /** Proves the process boundary before Pi's bash tool is advertised. */
  prepareProcessExecution(): Promise<Result<void, ExecutionError>>;
  /** Releases active commands and owned output spools when an attachment ends. */
  cleanup(): Promise<void>;
}

const processPreflights = new WeakMap<object, Promise<void>>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const PROCESS_SANDBOX_CONFIG: SandboxRuntimeConfig = deepFreeze({
  network: {
    allowedDomains: [],
    deniedDomains: ["*"],
    strictAllowlist: true,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
  },
  filesystem: {
    denyRead: [],
    allowRead: [],
    allowWrite: [],
    denyWrite: [],
  },
  allowAppleEvents: false,
});

function executionError<T = never>(
  code: ConstructorParameters<typeof ExecutionError>[0],
  message: string,
  cause?: Error,
): Result<T, ExecutionError> {
  return err(new ExecutionError(code, message, cause));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function boundedAppend(current: Buffer, chunk: Buffer): Buffer {
  const remaining = MAX_CAPTURED_OUTPUT_BYTES - current.length;
  if (remaining <= 0) return current;
  return chunk.length <= remaining
    ? Buffer.concat([current, chunk])
    : Buffer.concat([current, chunk.subarray(0, remaining)]);
}

/** Keep the per-stream byte cap without emitting a replacement character for a cut UTF-8 sequence. */
function decodeBounded(bytes: Buffer): string {
  return new StringDecoder("utf8").write(bytes);
}

function sanitizedPath(pathValue: string | undefined): string {
  const safeRoots = ["/opt/homebrew", "/usr/local", "/System", "/usr", "/bin", "/sbin"];
  const safe = (pathValue ?? "")
    .split(":")
    .filter((entry) => safeRoots.some((root) => entry === root || entry.startsWith(`${root}/`)));
  return [...new Set(safe)].join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: sanitizedPath(source.PATH) };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ", "CI", "NO_COLOR"]) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function isSafeTempFragment(value: string): boolean {
  if (isAbsolute(value) || value.includes("..") || value.includes("\\") || value.includes("/")) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return true;
}

function perCommandSandboxConfig(
  workspace: string,
  homeDir: string,
): Partial<SandboxRuntimeConfig> {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      // SRT's maintained macOS policy uses deny-read plus this carve-back for a
      // workspace that is commonly nested under the user's home directory.
      denyRead: [homeDir],
      allowRead: [workspace],
      allowWrite: [workspace],
      // SRT adds these compatibility defaults. Deny its home and temporary
      // Claude scratch paths so the Session workspace remains the only writable
      // agent-controlled location.
      //
      // The two `.git` entries are the writable root's own carve-out, and they
      // are deliberately not the whole of `.git`: a Session that cannot write
      // the index, refs, and objects cannot commit. Hooks and config are the
      // paths ordinary git operation never writes and the only ones that change
      // what *later* commands do. This closes what the rule pack cannot reach —
      // `path.git-internals` sees file-tool writes, shell redirects, and `git
      // config`, so a plain `cp evil.sh .git/hooks/pre-commit` passes it as an
      // opaque operand. Neither layer is complete alone. Only a Main checkout is
      // affected: a Ticket worktree's `.git` is a file pointing into the main
      // repository, whose real hooks and config `allowWrite` already excludes.
      denyWrite: [
        join(homeDir, ".npm", "_logs"),
        join(homeDir, ".claude", "debug"),
        "/tmp/claude",
        "/private/tmp/claude",
        join(workspace, ".git", "hooks"),
        join(workspace, ".git", "config"),
      ],
    },
    allowAppleEvents: false,
  };
}

async function prepareSandbox(sandbox: SandboxRuntime): Promise<void> {
  const key = sandbox as object;
  const cached = processPreflights.get(key);
  if (cached) return cached;

  const preflight = (async () => {
    if (!sandbox.isSupportedPlatform()) {
      throw new Error("The contained process boundary is unavailable on this platform.");
    }
    const dependencies = await sandbox.checkDependenciesAsync();
    if (dependencies.errors.length > 0) {
      throw new Error(`Sandbox dependencies are unavailable: ${dependencies.errors.join(", ")}`);
    }
    // SRT owns a process-global configuration.  Check it before calling
    // initialize as well: a caller can leave configuration behind while a
    // mocked/partially-initialized manager still reports disabled.
    const beforeInitialize = sandbox.getConfig();
    if (beforeInitialize && !isDeepStrictEqual(beforeInitialize, PROCESS_SANDBOX_CONFIG)) {
      throw new Error(
        "The process-global sandbox was initialized with an incompatible configuration.",
      );
    }
    if (sandbox.isSandboxingEnabled()) {
      if (!isDeepStrictEqual(beforeInitialize, PROCESS_SANDBOX_CONFIG)) {
        throw new Error(
          "The process-global sandbox was initialized with an incompatible configuration.",
        );
      }
    } else {
      await sandbox.initialize(PROCESS_SANDBOX_CONFIG);
      if (!isDeepStrictEqual(sandbox.getConfig(), PROCESS_SANDBOX_CONFIG)) {
        throw new Error(
          "The process-global sandbox did not retain Volli's required configuration.",
        );
      }
    }
  })();
  let cachedPreflight: Promise<void>;
  cachedPreflight = preflight.catch((error: unknown) => {
    // Every concurrent caller shares this cached promise, so a retry cannot
    // replace it until its rejection has cleared the cache.
    processPreflights.delete(key);
    throw error;
  });
  processPreflights.set(key, cachedPreflight);
  return cachedPreflight;
}

/**
 * The filesystem capability supplied to Pi's contained coding tools.
 * Process execution is fail-closed until SRT's process-global boundary is ready.
 */
export class ScopedExecutionEnv implements SessionExecutionEnv {
  readonly cwd: string;
  readonly #delegate: NodeExecutionEnv;
  readonly #sandbox: SandboxRuntime;
  readonly #spawn: Spawn;
  readonly #homeDir: string;
  readonly #processKill: ProcessKill;
  readonly #fileOperations: FileOperations;
  readonly #activeChildren = new Set<ChildProcess>();
  readonly #tempDirectories = new Set<string>();

  private constructor(root: string, options: ScopedExecutionEnvOptions) {
    this.cwd = root;
    this.#delegate = new NodeExecutionEnv({ cwd: root });
    this.#sandbox = options.sandbox ?? SandboxManager;
    this.#spawn = options.spawn ?? spawn;
    this.#homeDir = options.homeDir ?? homedir();
    this.#processKill = options.processKill ?? process.kill;
    this.#fileOperations = options.fileOperations ?? { mkdtemp, rm, writeFile };
  }

  static async create(
    root: string,
    options: ScopedExecutionEnvOptions = {},
  ): Promise<ScopedExecutionEnv> {
    return new ScopedExecutionEnv(await realpath(root), options);
  }

  /** Proves the shared SRT process boundary before Pi advertises bash. */
  async prepareProcessExecution(): Promise<Result<void, ExecutionError>> {
    try {
      await prepareSandbox(this.#sandbox);
      return { ok: true, value: undefined };
    } catch (error) {
      return executionError("shell_unavailable", asError(error).message, asError(error));
    }
  }

  async #guard(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> {
    if (signal?.aborted) {
      return err(new FileError("aborted", "Operation aborted.", path));
    }
    const target = resolve(this.cwd, path);
    if (!isInside(this.cwd, target)) {
      return err(
        new FileError("permission_denied", "Path is outside the Session workspace.", target),
      );
    }

    let current = this.cwd;
    for (const part of relative(this.cwd, target).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          return err(
            new FileError(
              "permission_denied",
              "Symlinks are not available inside the contained Session tool boundary.",
              current,
            ),
          );
        }
      } catch (error) {
        const cause = asError(error);
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") break;
        return err(new FileError("unknown", cause.message, current, cause));
      }
    }
    return { ok: true, value: target };
  }

  async #commandCwd(path: string | undefined): Promise<Result<string, ExecutionError>> {
    try {
      const canonical = await realpath(resolve(this.cwd, path ?? "."));
      if (!isInside(this.cwd, canonical)) {
        return executionError(
          "spawn_error",
          "Command working directory is outside the Session workspace.",
        );
      }
      return { ok: true, value: canonical };
    } catch (error) {
      return executionError(
        "spawn_error",
        `Command working directory is unavailable: ${asError(error).message}`,
        asError(error),
      );
    }
  }

  async absolutePath(path: string, abortSignal?: AbortSignal) {
    return this.#guard(path, abortSignal);
  }

  async exists(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.exists(guarded.value) : guarded;
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.readBinaryFile(guarded.value, abortSignal) : guarded;
  }

  async fileInfo(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.fileInfo(guarded.value) : guarded;
  }

  async readTextFile(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.readTextFile(guarded.value, abortSignal) : guarded;
  }

  async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.writeFile(guarded.value, content, abortSignal) : guarded;
  }

  #unsupported(path = this.cwd): Result<never, FileError> {
    return err(new FileError("not_supported", "This filesystem operation is not available.", path));
  }

  async joinPath(_parts: string[], _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }
  async readTextLines(_path: string, _options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    return this.#unsupported();
  }
  async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    if (!guarded.ok) return guarded;
    // Pi's current Node environment ignores this third argument, but forwarding
    // it preserves cancellation when its implementation gains support.
    const append = this.#delegate.appendFile as (
      target: string,
      value: string | Uint8Array,
      signal?: AbortSignal,
    ) => ReturnType<ExecutionEnv["appendFile"]>;
    return append.call(this.#delegate, guarded.value, content, abortSignal);
  }
  async renameFile(_sourcePath: string, _destinationPath: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }
  async listDir(_path: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }
  async canonicalPath(_path: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }
  async createDir(_path: string, _options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    return this.#unsupported();
  }
  async remove(
    _path: string,
    _options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ) {
    return this.#unsupported();
  }
  async createTempDir(_prefix?: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }
  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>> {
    if (options?.abortSignal?.aborted) {
      return { ok: false, error: new FileError("aborted", "Operation aborted.") };
    }
    const prefix = options?.prefix ?? "";
    const suffix = options?.suffix ?? "";
    if (!isSafeTempFragment(prefix) || !isSafeTempFragment(suffix)) {
      return {
        ok: false,
        error: new FileError(
          "invalid",
          "Temporary-file names cannot contain paths or control characters.",
        ),
      };
    }
    let directory: string | undefined;
    let created = false;
    try {
      directory = await this.#fileOperations.mkdtemp(join(this.cwd, ".volli-bash-"));
      this.#tempDirectories.add(directory);
      const path = resolve(directory, `${prefix}output${suffix}`);
      if (options?.abortSignal?.aborted) {
        return { ok: false, error: new FileError("aborted", "Operation aborted.") };
      }
      await this.#fileOperations.writeFile(path, "");
      created = true;
      return { ok: true, value: path };
    } catch (error) {
      return {
        ok: false,
        error: new FileError("unknown", asError(error).message, undefined, asError(error)),
      };
    } finally {
      // An error or late abort must not strand a directory that only this env owns.
      if (directory && !created) {
        this.#tempDirectories.delete(directory);
        try {
          await this.#fileOperations.rm(directory, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  #signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid && process.platform !== "win32") this.#processKill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* process is already gone */
      }
    }
  }

  async #terminateDuringCleanup(child: ChildProcess): Promise<void> {
    this.#signalChildGroup(child, "SIGTERM");
    await new Promise<void>((complete) => {
      let closed = false;
      const done = () => complete();
      child.once("close", () => {
        closed = true;
      });
      setTimeout(() => {
        // Always target the original process group: its leader can close while a
        // TERM-resistant descendant remains alive.
        this.#signalChildGroup(child, "SIGKILL");
        if (closed) done();
        else setTimeout(done, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    });
  }

  async exec(
    command: string,
    options: ShellExecOptions = {},
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const prepared = await this.prepareProcessExecution();
    if (!prepared.ok) return prepared;
    if (options.abortSignal?.aborted)
      return executionError("aborted", "Command aborted before launch.");

    const commandCwd = await this.#commandCwd(options.cwd);
    if (!commandCwd.ok) return commandCwd;

    let descriptor: { argv: string[]; env: NodeJS.ProcessEnv };
    try {
      descriptor = await this.#sandbox.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        perCommandSandboxConfig(this.cwd, this.#homeDir),
        options.abortSignal,
        commandCwd.value,
      );
    } catch (error) {
      return executionError(
        "shell_unavailable",
        `Sandbox policy could not wrap command: ${asError(error).message}`,
        asError(error),
      );
    }
    if (descriptor.argv.length === 0)
      return executionError("spawn_error", "Sandbox returned no command argv.");

    return new Promise((resolveResult) => {
      let child: ChildProcess | undefined;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let settled = false;
      let closeObserved = false;
      let killEscalated = false;
      let timeout: NodeJS.Timeout | undefined;
      let killEscalation: NodeJS.Timeout | undefined;
      let terminationResult:
        | Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
        | undefined;
      let terminationDeadline: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (killEscalation) clearTimeout(killEscalation);
        if (terminationDeadline) clearTimeout(terminationDeadline);
        options.abortSignal?.removeEventListener("abort", abort);
        if (child) this.#activeChildren.delete(child);
        try {
          this.#sandbox.cleanupAfterCommand();
        } catch {
          /* best-effort SRT cleanup */
        }
      };
      const finish = (
        result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveResult(result);
      };
      const finishTerminationIfReady = () => {
        if (terminationResult && closeObserved && killEscalated) finish(terminationResult);
      };
      const terminate = () => {
        this.#signalChildGroup(launchedChild, "SIGTERM");
        killEscalation = setTimeout(() => {
          // Do not key this on the leader's liveness. A background child can
          // outlive the shell after it has emitted close.
          this.#signalChildGroup(launchedChild, "SIGKILL");
          killEscalated = true;
          finishTerminationIfReady();
        }, KILL_GRACE_MS);
      };
      const requestTermination = (
        result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>,
      ) => {
        if (terminationResult || settled) return;
        terminationResult = result;
        terminate();
        terminationDeadline = setTimeout(() => finish(result), KILL_GRACE_MS * 2);
      };
      const abort = () => requestTermination(executionError("aborted", "Command aborted."));
      const callback = (handler: ((chunk: string) => void) | undefined, chunk: string) => {
        if (!handler || settled || chunk.length === 0) return;
        try {
          handler(chunk);
        } catch (error) {
          requestTermination(
            executionError("callback_error", "Command output callback failed.", asError(error)),
          );
        }
      };

      try {
        child = this.#spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
          cwd: commandCwd.value,
          env: sanitizedEnvironment(descriptor.env),
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.#activeChildren.add(child);
      } catch (error) {
        finish(
          executionError(
            "spawn_error",
            `Could not start sandboxed command: ${asError(error).message}`,
            asError(error),
          ),
        );
        return;
      }

      const launchedChild = child;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      child.stdout?.on("data", (data: Buffer | string) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stdout = boundedAppend(stdout, bytes);
        callback(options.onStdout, stdoutDecoder.write(bytes));
      });
      child.stderr?.on("data", (data: Buffer | string) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stderr = boundedAppend(stderr, bytes);
        callback(options.onStderr, stderrDecoder.write(bytes));
      });
      child.once("error", (error) => finish(executionError("spawn_error", error.message, error)));
      child.once("close", (exitCode) => {
        callback(options.onStdout, stdoutDecoder.end());
        callback(options.onStderr, stderrDecoder.end());
        closeObserved = true;
        if (terminationResult) {
          finishTerminationIfReady();
          return;
        }
        finish({
          ok: true,
          value: {
            stdout: decodeBounded(stdout),
            stderr: decodeBounded(stderr),
            exitCode: exitCode ?? 1,
          },
        });
      });
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      if (options.timeout && options.timeout > 0) {
        timeout = setTimeout(() => {
          requestTermination(
            executionError("timeout", `Command exceeded ${options.timeout} seconds.`),
          );
        }, options.timeout * 1_000);
      }
    });
  }

  async cleanup(): Promise<void> {
    const children = [...this.#activeChildren];
    await Promise.all(
      children.map(async (child) => {
        try {
          await this.#terminateDuringCleanup(child);
        } catch {
          /* best-effort lifecycle hygiene */
        }
      }),
    );
    this.#activeChildren.clear();
    await Promise.all(
      [...this.#tempDirectories].map(async (directory) => {
        try {
          await this.#fileOperations.rm(directory, { recursive: true, force: true });
        } catch {
          /* best-effort temp cleanup */
        }
      }),
    );
    this.#tempDirectories.clear();
    try {
      await this.#delegate.cleanup();
    } catch {
      /* ExecutionEnv cleanup never rejects. */
    }
  }
}
