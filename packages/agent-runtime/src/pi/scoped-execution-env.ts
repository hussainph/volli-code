import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  BACKGROUND_CONTEXT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  err,
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  sanitizeBinaryOutput,
  truncateHead,
  truncateTail,
  utf8ByteLength,
  type Context,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputCaptureOptions,
  type ShellOutputMetadata,
  type ShellOutputUpdate,
  type ShellOutputView,
} from "@earendil-works/pi-agent-core/node";
import type { SpawnLedgerPort } from "@volli/shared";
import { refuseDaemonizingExecute } from "../shell/refusal";
import { scopedEnvironment } from "./execution-env";

const KILL_GRACE_MS = 250;
/** Prefix and suffix of the spool a truncated command's complete output is preserved in. */
const SPILL_PREFIX = "bash-";
const SPILL_SUFFIX = ".log";

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

/** Who a spawned command belongs to, as the spawn ledger records it (VC-341). */
export interface ExecutionEnvOwner {
  sessionId: string;
  ticketId: string | null;
  projectId: string | null;
}

export interface ScopedExecutionEnvOptions {
  /**
   * Where each spawned command is recorded, and who it is recorded as.
   *
   * The row is written with the pid this environment spawned and the group it
   * leads (`detached`, so the pid IS the group), and is marked exited when the
   * command settles. A command that outlives this app — a daemon that
   * double-forked, a build killed mid-turn — leaves the row open, which is what
   * lets the orphan sweep attribute the process to a Session instead of reading
   * its command line. Absent means nothing is recorded, which is what every
   * caller that has never heard of the ledger gets.
   */
  ledger?: { port: SpawnLedgerPort; owner: ExecutionEnvOwner };
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

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** The truncation and provenance half of a bounded view, without the text beside it. */
function metadataOf(view: ShellOutputView): ShellOutputMetadata {
  return {
    truncation: view.truncation,
    ...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
    ...(view.lastLineBytes === undefined ? {} : { lastLineBytes: view.lastLineBytes }),
  };
}

/**
 * One command's output as Pi 0.85 models it: a single bounded view, not a
 * stdout and a stderr.
 *
 * `Shell.exec` no longer returns text at all. The caller states a byte and line
 * budget in `capture.limits`, the environment keeps only what fits, and the
 * text reaches the caller through `capture`'s companion `onUpdate`. This is the
 * source side of that contract for {@link ScopedExecutionEnv}, whose `exec` is
 * a custom sandboxed spawn rather than one of Pi's.
 *
 * It is written here rather than reused because Pi's own `OutputCapture` is
 * exported from its module and that module is not in the package's `exports`
 * map — nothing outside Pi can import it. The parts that ARE public do the work
 * that would have been worth stealing: `truncateTail`/`truncateHead` decide
 * what survives a limit without ever cutting a line in half, and
 * `sanitizeBinaryOutput` strips the control bytes a terminal would have
 * consumed rather than displayed. What is left here is bookkeeping.
 *
 * Totals are counted as bytes arrive rather than measured off the retained
 * buffer, because the buffer is trimmed: `[Showing lines 1900-2000 of 40000]`
 * has to name the output the command actually produced, not the window that
 * survived it.
 *
 * There is no rate limiter. Pi's environment publishes through a private
 * `AdaptivePublisher`; an update from here carries only the text that changed,
 * or — once the window starts sliding — a replacement bounded by the caller's
 * own limit, so the cost is linear in output either way. The consumer, which is
 * Pi's own bash tool, already decides how often a snapshot becomes a durable
 * checkpoint.
 */
/** PI-RESTATED(0.85.0): bounded output publisher used by Pi's Node environment. */
class BoundedOutput {
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #retain: "head" | "tail";
  /**
   * How much raw text is kept around for {@link truncateTail} to choose from,
   * and the whole of this environment's memory cost for one command's output.
   *
   * Four times the byte budget. The retained window takes at most `maxBytes`
   * bytes from one end, so the ragged edge left by trimming sits three budgets
   * away from it — and the only way to reach that edge is a single line longer
   * than the guard, which comes back as a partial line either way. That is
   * exactly what `lastLinePartial` says about it. The line budget cannot reach
   * it either: enough lines to fill four byte budgets is more bytes than the
   * byte budget, so bytes bind first.
   */
  readonly #guardChars: number;
  #buffer = "";
  #totalBytes = 0;
  #newlines = 0;
  #endsWithNewline = true;
  #currentLineBytes = 0;
  #spillPath: string | undefined;
  #published: ShellOutputView | undefined;

  constructor(capture: ShellOutputCaptureOptions | undefined) {
    this.#maxBytes = capture?.limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxLines = capture?.limits.maxLines ?? DEFAULT_MAX_LINES;
    this.#retain = capture?.limits.retain ?? "tail";
    this.#guardChars = this.#maxBytes * 4;
  }

  /** Whether the command has already produced more than the caller asked to keep. */
  get truncated(): boolean {
    return this.#totalBytes > this.#maxBytes || this.#totalLines() > this.#maxLines;
  }

  /** Absorb one decoded run of output. Returns the text that was actually kept. */
  push(text: string): string {
    const clean = sanitizeBinaryOutput(text);
    if (clean === "") return clean;
    const bytes = utf8ByteLength(clean);
    this.#totalBytes += bytes;
    this.#newlines += countNewlines(clean);
    this.#endsWithNewline = clean.endsWith("\n");
    const lastNewline = clean.lastIndexOf("\n");
    this.#currentLineBytes =
      lastNewline === -1
        ? this.#currentLineBytes + bytes
        : utf8ByteLength(clean.slice(lastNewline + 1));
    this.#buffer += clean;
    if (this.#buffer.length > this.#guardChars * 2) {
      this.#buffer =
        this.#retain === "head"
          ? this.#buffer.slice(0, this.#guardChars)
          : this.#buffer.slice(this.#buffer.length - this.#guardChars);
    }
    return clean;
  }

  /** Name the spool the complete output is being preserved in, once it exists. */
  setSpillPath(path: string): void {
    this.#spillPath = path;
  }

  /** The bounded view as it stands, with totals taken from what arrived rather than what is kept. */
  snapshot(): ShellOutputView {
    const limits = { maxBytes: this.#maxBytes, maxLines: this.#maxLines };
    const retained =
      this.#retain === "head"
        ? truncateHead(this.#buffer, limits)
        : truncateTail(this.#buffer, limits);
    const totalLines = this.#totalLines();
    const truncated = this.truncated;
    const { content, ...truncation } = retained;
    return {
      text: content,
      truncation: {
        ...truncation,
        truncated,
        truncatedBy: truncated ? (totalLines > this.#maxLines ? "lines" : "bytes") : null,
        totalBytes: this.#totalBytes,
        totalLines,
      },
      ...(this.#spillPath === undefined ? {} : { spillPath: this.#spillPath }),
      ...(retained.lastLinePartial ? { lastLineBytes: this.#currentLineBytes } : {}),
    };
  }

  /** Everything about the final view except the text, which the caller already streamed. */
  metadata(): ShellOutputMetadata {
    return metadataOf(this.snapshot());
  }

  /**
   * The change since the last time this was asked.
   *
   * Growth is an `append` carrying only the new text; a window that has started
   * sliding is a `replace`, because the delta Pi's private publisher computes
   * for that case needs a suffix/prefix scan and the replacement it avoids is
   * bounded by the caller's own limit anyway. Text that did not move at all
   * still carries metadata that did — a spool discovered after the last byte
   * arrived, or totals that grew while the window stayed full.
   *
   * Total rather than nullable, because every caller asks only after something
   * changed: a chunk was absorbed, or the spool was named. An "is anything
   * different" flag here would be a branch no command could reach.
   */
  pull(): ShellOutputUpdate {
    const previous = this.#published;
    const current = this.snapshot();
    this.#published = current;
    if (previous === undefined) return { kind: "replace", output: current };
    if (current.text === previous.text) return { kind: "metadata", metadata: metadataOf(current) };
    if (current.text.startsWith(previous.text)) {
      return {
        kind: "append",
        text: current.text.slice(previous.text.length),
        metadata: metadataOf(current),
      };
    }
    return { kind: "replace", output: current };
  }

  #totalLines(): number {
    return this.#newlines + (this.#endsWithNewline || this.#totalBytes === 0 ? 0 : 1);
  }
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

/**
 * The boundary one command runs behind: no network, the workspace as the only
 * writable root, and two carve-outs from that root.
 *
 * The `.git` entries are deliberately not the whole of `.git` — a Session that
 * cannot write the index, refs, and objects cannot commit. Hooks and config are
 * the paths ordinary git operation never writes and the only ones that change
 * what *later* commands do, which is what makes them worth denying, and a
 * submodule's copies under `.git/modules/<name>/` execute exactly the same way.
 * They close what the rule pack cannot reach: `path.git-internals` sees
 * file-tool writes, shell redirects, and `git config`, so a plain
 * `cp evil.sh .git/hooks/pre-commit` passes it as an opaque operand. Neither
 * layer is complete alone.
 *
 * Only a Main checkout is affected. A Ticket worktree's `.git` is a file
 * pointing into the main repository, whose real hooks and config lie outside the
 * workspace that `allowWrite` already limits this to.
 */
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
      denyWrite: [
        join(homeDir, ".npm", "_logs"),
        join(homeDir, ".claude", "debug"),
        "/tmp/claude",
        "/private/tmp/claude",
        join(workspace, ".git", "hooks"),
        join(workspace, ".git", "config"),
        // A submodule's hooks live at `.git/modules/<name>/hooks` and execute
        // exactly like the superproject's. SRT compiles a pattern containing
        // glob characters into a Seatbelt regex, so the whole family is one
        // entry rather than a scan of whatever submodules existed at attach.
        //
        // The trailing `/*` is load-bearing: SRT strips a trailing `/**` before
        // compiling, which would anchor the regex to the directory itself and
        // let every file inside it through.
        join(workspace, ".git", "modules", "**", "hooks"),
        join(workspace, ".git", "modules", "**", "hooks", "**", "*"),
        join(workspace, ".git", "modules", "**", "config"),
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
 * The Seatbelt-backed execution capability — built and tested, and no longer
 * installed.
 *
 * The runtime hands Pi its own uncontained environment now, so this reaches a
 * Session only through an injected `executionEnvFactory`. It is kept whole
 * because `docs/plans/authority-two-axis-rearchitecture.md` rebuilds the
 * boundary on it, and a boundary is a bad thing to delete and rewrite from
 * memory.
 *
 * What it contains is whatever that Session's workspace is — a Ticket worktree,
 * or the project's Main checkout for a Ticket that never took one — and nothing
 * here reads the difference. Process execution stays fail-closed on its own
 * terms: {@link exec} proves SRT's boundary before it spawns anything.
 *
 * Pi 0.85 replaced every method's trailing `abortSignal?: AbortSignal` with a
 * required trailing chord `Context`, cancellation riding `context.abortSignal`.
 * Here the parameter is OPTIONAL, defaulting to {@link BACKGROUND_CONTEXT} — an
 * empty context carrying no values and no cancellation. That still satisfies
 * `ExecutionEnv`, because a parameter a method is willing to do without accepts
 * one every caller supplies, and Pi's tools always supply one. Unlike
 * `piExecutionEnv`, which hands back the interface, this class is named
 * directly by its own callers, and for those an absent context reads exactly as
 * an absent `abortSignal` did before the bump: nobody is offering to cancel.
 * Widening rather than requiring is the port that changes no behaviour.
 */
export class ScopedExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly #delegate: NodeExecutionEnv;
  readonly #sandbox: SandboxRuntime;
  readonly #spawn: Spawn;
  readonly #homeDir: string;
  readonly #processKill: ProcessKill;
  readonly #fileOperations: FileOperations;
  readonly #ledger: { port: SpawnLedgerPort; owner: ExecutionEnvOwner } | undefined;
  readonly #activeChildren = new Set<ChildProcess>();
  readonly #tempDirectories = new Set<string>();

  private constructor(root: string, options: ScopedExecutionEnvOptions) {
    this.cwd = root;
    this.#ledger = options.ledger;
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

  /**
   * Proves the shared SRT process boundary.
   *
   * {@link exec} runs this before every spawn, so containment cannot be skipped
   * by a caller that forgets to ask for it. Public so the boundary can still be
   * inspected before a command depends on it; the runtime no longer preflights
   * it at attach, because an attachment running Pi's own environment has no
   * boundary to prove and must not fail for want of one.
   */
  async prepareProcessExecution(): Promise<Result<void, ExecutionError>> {
    try {
      await prepareSandbox(this.#sandbox);
      return { ok: true, value: undefined };
    } catch (error) {
      return executionError("shell_unavailable", asError(error).message, asError(error));
    }
  }

  async #guard(path: string, context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) {
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

  async absolutePath(path: string, context: Context = BACKGROUND_CONTEXT) {
    return this.#guard(path, context);
  }

  async exists(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, context);
    return guarded.ok ? this.#delegate.exists(guarded.value, context) : guarded;
  }

  async readBinaryFile(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, context);
    return guarded.ok ? this.#delegate.readBinaryFile(guarded.value, context) : guarded;
  }

  async fileInfo(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, context);
    return guarded.ok ? this.#delegate.fileInfo(guarded.value, context) : guarded;
  }

  async readTextFile(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, context);
    return guarded.ok ? this.#delegate.readTextFile(guarded.value, context) : guarded;
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context = BACKGROUND_CONTEXT,
  ) {
    const guarded = await this.#guard(path, context);
    return guarded.ok ? this.#delegate.writeFile(guarded.value, content, context) : guarded;
  }

  #unsupported(path = this.cwd): Result<never, FileError> {
    return err(new FileError("not_supported", "This filesystem operation is not available.", path));
  }

  async joinPath(_parts: string[], _context?: Context) {
    return this.#unsupported();
  }
  async readTextLines(
    _path: string,
    _options?: { maxLines?: number },
    _context?: Context,
  ): Promise<Result<string[], FileError>> {
    return this.#unsupported();
  }
  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context = BACKGROUND_CONTEXT,
  ) {
    const guarded = await this.#guard(path, context);
    if (!guarded.ok) return guarded;
    // 0.84's Node environment took a third argument and ignored it, so this
    // forwarded through a cast. 0.85's honours the context it is given, so the
    // cast is gone and the cancellation is real.
    return this.#delegate.appendFile(guarded.value, content, context);
  }
  async renameFile(_sourcePath: string, _destinationPath: string, _context?: Context) {
    return this.#unsupported();
  }
  async listDir(_path: string, _context?: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#unsupported();
  }
  async canonicalPath(_path: string, _context?: Context) {
    return this.#unsupported();
  }
  async createDir(_path: string, _options?: { recursive?: boolean }, _context?: Context) {
    return this.#unsupported();
  }
  async remove(
    _path: string,
    _options?: { recursive?: boolean; force?: boolean },
    _context?: Context,
  ) {
    return this.#unsupported();
  }
  async createTempDir(_prefix?: string, _context?: Context) {
    return this.#unsupported();
  }
  async createTempFile(
    options?: { prefix?: string; suffix?: string },
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) {
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
      if (context.abortSignal?.aborted) {
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

  /**
   * One command, behind SRT's boundary, reporting its output the way 0.85 asks
   * for it.
   *
   * The result no longer carries text. `ShellExecResult` is an exit code and
   * truncation metadata; the bytes travel through `options.onUpdate` as they
   * arrive, bounded by `options.capture.limits`, and
   * {@link BoundedOutput} is this environment's source side of that.
   *
   * There is deliberately no Volli-shaped `{ stdout, stderr }` helper beside
   * it. 0.85 merged the two streams into one view at the source, and a second
   * pair of buffers kept only to serve the old shape would be inventing a
   * distinction the contract no longer carries and paying for it twice in
   * memory. Nothing in Volli's own code reads `.stdout`/`.stderr` off an
   * execution environment — the only readers were tests, and they now read the
   * merged view through Pi's sanctioned collector, `executeShellWithCapture`.
   * What is lost is the ability to tell the two streams apart, which is a
   * capability Pi's own environment gave up in the same release and which the
   * bash tool never used: it has always shown the model one interleaved
   * transcript.
   *
   * `capture.spill` is honoured here rather than ignored, and that is what
   * keeps {@link createTempFile} earning its place. In 0.84 the collector above
   * this env preserved a truncated command's complete output by calling
   * `createTempFile`/`appendFile` on the env itself; 0.85 moved that job into
   * the env. Doing it here means the spool is still created *inside* the
   * Session workspace, which is the one directory this boundary lets a child
   * write — a spool anywhere else would be a file the contained command could
   * not have produced.
   */
  async exec(
    command: string,
    options: ShellExecOptions = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const abortSignal = context.abortSignal;
    const prepared = await this.prepareProcessExecution();
    if (!prepared.ok) return prepared;
    if (abortSignal?.aborted) return executionError("aborted", "Command aborted before launch.");

    const refusal = refuseDaemonizingExecute(command);
    if (refusal) return executionError("spawn_error", refusal.message, refusal);

    const commandCwd = await this.#commandCwd(options.cwd);
    if (!commandCwd.ok) return commandCwd;

    let descriptor: { argv: string[]; env: NodeJS.ProcessEnv };
    try {
      descriptor = await this.#sandbox.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        perCommandSandboxConfig(this.cwd, this.#homeDir),
        abortSignal,
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

    const collector = new BoundedOutput(options.capture);
    const spilling = options.capture?.spill === true;

    return new Promise((resolveResult) => {
      let child: ChildProcess | undefined;
      let settled = false;
      let closeObserved = false;
      let killEscalated = false;
      let completedGroupTerminationStarted = false;
      let timeout: NodeJS.Timeout | undefined;
      let killEscalation: NodeJS.Timeout | undefined;
      let terminationResult: Result<ShellExecResult, ExecutionError> | undefined;
      let terminationDeadline: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (killEscalation) clearTimeout(killEscalation);
        if (terminationDeadline) clearTimeout(terminationDeadline);
        abortSignal?.removeEventListener("abort", abort);
        if (child) this.#activeChildren.delete(child);
        try {
          this.#sandbox.cleanupAfterCommand();
        } catch {
          /* best-effort SRT cleanup */
        }
      };
      const finish = (result: Result<ShellExecResult, ExecutionError>) => {
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
      const requestTermination = (result: Result<ShellExecResult, ExecutionError>) => {
        if (terminationResult || settled) return;
        terminationResult = result;
        terminate();
        terminationDeadline = setTimeout(() => finish(result), KILL_GRACE_MS * 2);
      };
      const terminateCompletedGroup = () => {
        if (completedGroupTerminationStarted) return;
        completedGroupTerminationStarted = true;
        this.#signalChildGroup(launchedChild, "SIGTERM");
        setTimeout(() => {
          // A descendant that double-forks or calls setsid out of this group
          // escapes by design. VC-341's spawn ledger and cwd sweep own that
          // wider lifecycle; execute only owns the group it started.
          this.#signalChildGroup(launchedChild, "SIGKILL");
        }, KILL_GRACE_MS);
        // Cleanup is deliberately fire-and-forget: a completed command's result
        // must not wait out the grace period.
      };
      const abort = () => requestTermination(executionError("aborted", "Command aborted."));

      // The spool: chunks are held back until the caller's limits are actually
      // crossed, so a command whose output fits writes no file at all, and one
      // that overflows still spools from its very first byte. Writes are
      // serialized through one chain and coalesced, because `appendFile` is the
      // only writer this boundary has and two overlapping appends would
      // interleave a command's own output.
      let spillHeld: string[] = [];
      let spillQueue: string[] = [];
      let spillPath: string | undefined;
      let spillError: ExecutionError | undefined;
      let spillChain: Promise<void> | undefined;
      const drainSpill = async (): Promise<void> => {
        while (spillQueue.length > 0 && spillError === undefined) {
          const text = spillQueue.join("");
          spillQueue = [];
          if (spillPath === undefined) {
            const created = await this.createTempFile(
              { prefix: SPILL_PREFIX, suffix: SPILL_SUFFIX },
              context,
            );
            if (!created.ok) {
              spillError = new ExecutionError(
                "unknown",
                `Failed to preserve complete shell output: ${created.error.message}`,
                created.error,
              );
              return;
            }
            spillPath = created.value;
            collector.setSpillPath(spillPath);
            publish();
          }
          const appended = await this.appendFile(spillPath, text, context);
          if (!appended.ok) {
            spillError = new ExecutionError(
              "unknown",
              `Failed to preserve complete shell output: ${appended.error.message}`,
              appended.error,
            );
          }
        }
      };
      const pumpSpill = () => {
        spillChain = (spillChain ?? Promise.resolve()).then(drainSpill);
      };
      const holdForSpill = (text: string) => {
        spillHeld.push(text);
        if (!collector.truncated) return;
        spillQueue.push(spillHeld.join(""));
        spillHeld = [];
        pumpSpill();
      };

      const publish = () => {
        // No callback after `exec` has resolved. A child can keep writing after
        // its group was killed, and an update then would be about a command the
        // caller has already been told the outcome of. What still happens to
        // that output is what happened to it before the bump: it is absorbed,
        // bounded, and reported to nobody.
        if (settled || options.onUpdate === undefined) return;
        try {
          options.onUpdate(collector.pull(), context);
        } catch (error) {
          requestTermination(
            executionError("callback_error", "Command output callback failed.", asError(error)),
          );
        }
      };
      const absorb = (text: string) => {
        const kept = collector.push(text);
        if (kept === "") return;
        if (spilling) holdForSpill(kept);
        publish();
      };

      try {
        child = this.#spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
          cwd: commandCwd.value,
          env: scopedEnvironment(descriptor.env),
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.#activeChildren.add(child);
      } catch (error) {
        // Nothing spawned, so nothing to record.
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
      // The spawn ledger row (VC-341), written the moment a pid exists and
      // closed by the same `cleanup` every exit path runs through. `detached`
      // above makes the child its own group leader, so its pid is also the
      // group a later reap would signal. A pid-less spawn (Windows, a host
      // double that never forked) records nothing rather than a row naming no
      // process.
      const ledgerId =
        this.#ledger === undefined || launchedChild.pid === undefined
          ? null
          : this.#ledger.port.recordSpawn({
              sessionId: this.#ledger.owner.sessionId,
              ticketId: this.#ledger.owner.ticketId,
              projectId: this.#ledger.owner.projectId,
              kind: "execute",
              pid: launchedChild.pid,
              pgid: launchedChild.pid,
              startedAt: Date.now(),
              cwd: commandCwd.value,
              command,
            });
      if (ledgerId !== null) {
        const ledger = this.#ledger;
        // `close` rather than `exit`: the same event the result waits on, so a
        // row is never marked exited while this command's own pipes are still
        // delivering.
        launchedChild.once("close", () => ledger?.port.markExited(ledgerId));
      }
      // One decoder per stream, one buffer for both. The merge is 0.85's, and
      // it is done on decoded text rather than on bytes: stdout and stderr are
      // separate UTF-8 streams, so a multibyte character split across chunks of
      // one of them must not be completed by bytes that arrived on the other.
      // (Pi's own environment feeds both pipes into a single decoder, which is
      // the corruption this avoids.)
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      child.stdout?.on("data", (data: Buffer | string) => {
        absorb(stdoutDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      });
      child.stderr?.on("data", (data: Buffer | string) => {
        absorb(stderrDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      });
      child.once("error", (error) => finish(executionError("spawn_error", error.message, error)));
      child.once("exit", () => {
        // A background child can inherit the pipes and keep `close` from ever
        // arriving after its shell leader exits. Start the same successful-close
        // cleanup here so close can be observed; the close handler below is the
        // fallback for hosts and test doubles that report only that event.
        if (terminationResult === undefined) terminateCompletedGroup();
      });
      child.once("close", (exitCode) => {
        absorb(stdoutDecoder.end());
        absorb(stderrDecoder.end());
        closeObserved = true;
        if (terminationResult) {
          finishTerminationIfReady();
          return;
        }
        terminateCompletedGroup();
        void (async () => {
          // The spool has to be complete before the exit code is reported:
          // the metadata names a path, and a caller that reads it immediately
          // must not find a half-written file.
          if (spilling) {
            pumpSpill();
            await spillChain;
          }
          if (spillError) {
            finish(err(spillError));
            return;
          }
          finish({ ok: true, value: { exitCode: exitCode ?? 1, ...collector.metadata() } });
        })();
      });
      abortSignal?.addEventListener("abort", abort, { once: true });
      if (options.timeout && options.timeout > 0) {
        timeout = setTimeout(() => {
          requestTermination(
            executionError("timeout", `Command exceeded ${options.timeout} seconds.`),
          );
        }, options.timeout * 1_000);
      }
    });
  }

  async cleanup(context: Context = BACKGROUND_CONTEXT): Promise<void> {
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
      await this.#delegate.cleanup(context);
    } catch {
      /* ExecutionEnv cleanup never rejects. */
    }
  }
}
