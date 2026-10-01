import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import {
  capabilityRead,
  capabilityWrite,
  containsPath,
  sandboxWriteCarveOuts,
  type CapabilityPolicy,
  type RuntimeContainedLaunch,
  type SpawnLedgerPort,
} from "@volli/shared";
import { resolveCapabilityPolicy } from "../authority/capability";
import { throughLinks } from "../authority/gate";
import { resolvePathForPolicy } from "../authority/vendor/paths";
import { refuseDaemonizingExecute } from "../shell/refusal";
import {
  identityVariables,
  prefixedPath,
  scopedEnvironment,
  type PiSessionEnvIdentity,
} from "./execution-env";
import { gitVariables, NO_HOST_GIT, readHostGitSettings, type HostGitSettings } from "./host-git";

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
   * The capability policy the walls are compiled from (VC-45) — the same
   * object the authority gate judges calls against, so the file guard, the
   * kernel and the gate give one answer for one path. Absent, it is resolved
   * for this root alone: the built-in denylist, and the workspace (plus the git
   * directory a worktree commits into) as the only writable roots.
   */
  policy?: CapabilityPolicy;
  /**
   * A directory inside the policy's writable roots, handed to every command as
   * `TMPDIR`. Without one, a compiler or a test runner that writes the system
   * temporary directory is refused there. Owned by whoever created it.
   */
  scratchDirectory?: string;
  /**
   * Unix sockets a contained command may connect to: the `volli` socket, so the
   * bundled CLI keeps working behind the walls. SRT takes these only from its
   * process-global configuration, so every environment in one process must
   * name the same set — a different one fails closed at the preflight.
   */
  unixSockets?: readonly string[];
  /** As `piExecutionEnv`'s: directories put in front of `PATH`, in order. */
  pathPrefixes?: readonly string[];
  /** As `piExecutionEnv`'s: the host-minted Session identity every command is told. */
  identity?: PiSessionEnvIdentity;
  /** As `piExecutionEnv`'s: host facts about the machine, such as the concurrency budget. */
  environment?: Readonly<Record<string, string>>;
  /** As `piExecutionEnv`'s: runs once when the attachment cleans this environment up. */
  onCleanup?: () => void | Promise<void>;
  /**
   * What the host's git configuration contributes to a contained git — the
   * identity, the global excludes and attributes, `safe.directory`, signing —
   * see `host-git.ts`. The excludes and attributes files must be among the
   * policy's read grants for git to read them; the runtime puts them there.
   * Absent, they are read from git on the host — outside the walls, which is
   * the point — when the environment is created; `null` hands over none.
   */
  git?: HostGitSettings | null;
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

/**
 * SRT's process-global configuration: no network, and nothing on the
 * filesystem — every path travels per command, so two Sessions in one process
 * cannot see each other's roots. The one exception is the unix sockets, which
 * SRT reads from here alone.
 *
 * The network stays denied, and that is the pairing rule rather than an
 * oversight: egress opens in the sandbox only together with the Tier 3
 * classifier (VC-28 v1), never before it.
 */
function processSandboxConfig(unixSockets: readonly string[]): SandboxRuntimeConfig {
  return deepFreeze({
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowUnixSockets: [...unixSockets],
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
}

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

/** A guarded file operation is one of two accesses, judged by the policy's two verdicts. */
type FileAccess = "read" | "write";

/** Whether an existing path is a regular file with more than one name. */
async function isMultiplyLinked(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && entry.nlink > 1;
  } catch {
    return false;
  }
}

/**
 * Create a directory chain one component at a time, never following a link:
 * `mkdir` creates exactly the component named, and an existing component that
 * is not a real directory stops the chain.
 */
async function mkdirEach(directory: string): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  for (;;) {
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory()) {
        throw Object.assign(new Error(`${current} is not a directory.`), { code: "ENOTDIR" });
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(current);
      current = dirname(current);
    }
  }
  for (const component of missing) await mkdir(component);
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
 * The boundary one command runs behind, compiled from the attachment's
 * capability policy (VC-45): no network; reads machine-wide minus the
 * denylist, with the Session's own grants carved back; writes in the writable
 * roots, minus the metadata carved out of every root and any secret that lies
 * inside one.
 *
 * The carve-outs are the kernel spelling of `writeCarveOut`, from the same
 * module (`sandboxWriteCarveOuts`), so the file guard below and this profile
 * refuse the same paths. They are deliberately not the whole of `.git`: a
 * Session that cannot write the index, refs and objects cannot commit, which is
 * also why a Ticket worktree's common git directory is a writable root at all.
 * Hooks and config are the paths ordinary git operation never writes and the
 * only ones that change what *later* commands do. They close what the rule pack
 * cannot reach: `path.git-internals` sees file-tool writes, shell redirects and
 * `git config`, so a plain `cp evil.sh .git/hooks/pre-commit` passes it as an
 * opaque operand. Neither layer is complete alone.
 *
 * A secret is denied for writing only where it lies inside a root. A deny over
 * a root would revoke the root itself (Seatbelt's last match wins), and a write
 * outside every root is refused already — which is exactly `writeDenial`'s
 * "the deeper of the two decides".
 */
function perCommandSandboxConfig(
  policy: CapabilityPolicy,
  homeDir: string,
): Partial<SandboxRuntimeConfig> {
  const roots = policy.writableRoots;
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
      denyRead: [...policy.credentialDeny, ...policy.privateDeny],
      allowRead: [...policy.readAllow],
      allowWrite: [...roots],
      denyWrite: [
        // SRT adds these compatibility defaults. Deny its home and temporary
        // Claude scratch paths so the writable roots remain the only writable
        // agent-controlled locations.
        join(homeDir, ".npm", "_logs"),
        join(homeDir, ".claude", "debug"),
        "/tmp/claude",
        "/private/tmp/claude",
        ...roots.flatMap((root) => sandboxWriteCarveOuts(root, policy.sandboxCarveOuts)),
        ...policy.protectedPaths,
        // A credential or the host's data wherever it meets a root, in either
        // direction; a private entry only strictly inside one, so a root equal
        // to it — a workspace that IS `~/.pi` — keeps its own tree.
        ...[...policy.credentialDeny, ...policy.hostDataDeny].filter((deny) =>
          roots.some((root) => containsPath(root, deny) || containsPath(deny, root)),
        ),
        ...policy.privateDeny.filter((deny) =>
          roots.some((root) => containsPath(root, deny) && deny !== root),
        ),
      ],
    },
    allowAppleEvents: false,
  };
}

async function prepareSandbox(
  sandbox: SandboxRuntime,
  required: SandboxRuntimeConfig,
): Promise<void> {
  const key = sandbox as object;
  const cached = processPreflights.get(key);
  if (cached) {
    await cached;
    // The cache is per manager, not per configuration: an environment asking
    // for different sockets than the one that initialized SRT must not be
    // told the boundary it wants is in place.
    if (!isDeepStrictEqual(sandbox.getConfig(), required)) {
      throw new Error(
        "The process-global sandbox was initialized with an incompatible configuration.",
      );
    }
    return;
  }

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
    if (beforeInitialize && !isDeepStrictEqual(beforeInitialize, required)) {
      throw new Error(
        "The process-global sandbox was initialized with an incompatible configuration.",
      );
    }
    if (sandbox.isSandboxingEnabled()) {
      if (!isDeepStrictEqual(beforeInitialize, required)) {
        throw new Error(
          "The process-global sandbox was initialized with an incompatible configuration.",
        );
      }
    } else {
      await sandbox.initialize(required);
      if (!isDeepStrictEqual(sandbox.getConfig(), required)) {
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
 * The Seatbelt-backed execution capability: what a Scoped Session runs in
 * (VC-45).
 *
 * A project whose authority policy says `containment: "scoped"` gets this in
 * place of Pi's own environment. Both of its layers read ONE capability policy:
 * the file tools through {@link ScopedExecutionEnv.#guard}, and the shell
 * through the Seatbelt profile {@link exec} compiles per command. The authority
 * gate judges calls against the same object, so a path gets the same answer
 * from `read`, from `cat`, and from the rule pack.
 *
 * What it contains is whatever that Session's workspace is — a Ticket worktree,
 * or the project's Main checkout for a Ticket that never took one — and nothing
 * here reads the difference. Process execution stays fail-closed on its own
 * terms: {@link exec} proves SRT's boundary before it spawns anything.
 *
 * The file guard is userspace and checks before it opens, so a symlink swapped
 * in between the two is a seam the kernel does not share. The plan's slice 8 —
 * one enforcement layer, the seam closed — is where that goes; what this guard
 * does in the meantime is judge both the path as named and the path it
 * resolves to, so a link planted beforehand reaches nothing the target could
 * not.
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
  /** The capability policy both layers are compiled from. */
  readonly policy: CapabilityPolicy;
  readonly #delegate: NodeExecutionEnv;
  readonly #sandbox: SandboxRuntime;
  readonly #spawn: Spawn;
  readonly #homeDir: string;
  readonly #processKill: ProcessKill;
  readonly #fileOperations: FileOperations;
  readonly #ledger: { port: SpawnLedgerPort; owner: ExecutionEnvOwner } | undefined;
  readonly #processConfig: SandboxRuntimeConfig;
  readonly #commandVariables: Record<string, string>;
  readonly #pathPrefixes: readonly string[];
  readonly #onCleanup: (() => void | Promise<void>) | undefined;
  readonly #activeChildren = new Set<ChildProcess>();
  readonly #tempDirectories = new Set<string>();
  #cleaned = false;

  private constructor(
    root: string,
    policy: CapabilityPolicy,
    git: HostGitSettings,
    options: ScopedExecutionEnvOptions,
  ) {
    this.cwd = root;
    this.policy = policy;
    this.#ledger = options.ledger;
    this.#delegate = new NodeExecutionEnv({ cwd: root });
    this.#sandbox = options.sandbox ?? SandboxManager;
    this.#spawn = options.spawn ?? spawn;
    this.#homeDir = options.homeDir ?? homedir();
    this.#processKill = options.processKill ?? process.kill;
    this.#fileOperations = options.fileOperations ?? { mkdtemp, rm, writeFile };
    this.#processConfig = processSandboxConfig(options.unixSockets ?? []);
    this.#pathPrefixes = options.pathPrefixes ?? [];
    this.#onCleanup = options.onCleanup;
    // Composed once: everything here is host-minted, so nothing a command
    // asks for can change it. Identity last, as `sessionCommandEnvironment`
    // orders it, so the budget channel cannot shadow who is running.
    this.#commandVariables = {
      ...options.environment,
      ...gitVariables(git),
      ...(options.scratchDirectory === undefined ? {} : { TMPDIR: options.scratchDirectory }),
      ...identityVariables(options.identity),
    };
  }

  static async create(
    root: string,
    options: ScopedExecutionEnvOptions = {},
  ): Promise<ScopedExecutionEnv> {
    const canonicalRoot = await realpath(root);
    const policy =
      options.policy ??
      resolveCapabilityPolicy({
        workspacePath: canonicalRoot,
        ...(options.homeDir === undefined ? {} : { home: options.homeDir }),
        sandboxCarveOuts: true,
      });
    const git =
      options.git === undefined
        ? await readHostGitSettings(canonicalRoot)
        : (options.git ?? NO_HOST_GIT);
    return new ScopedExecutionEnv(canonicalRoot, policy, git, options);
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
      await prepareSandbox(this.#sandbox, this.#processConfig);
      return { ok: true, value: undefined };
    } catch (error) {
      return executionError("shell_unavailable", asError(error).message, asError(error));
    }
  }

  /**
   * One file operation, judged against the capability policy before it runs.
   *
   * Three spellings of the path must all pass: as named, as the filesystem
   * resolves it (one real component at a time, case and Unicode folded the way
   * APFS stores the name), and — for a multiply-linked regular file — as the
   * denied name the resolver indexed for the same inode, since Seatbelt cannot
   * see a hard link. A write to a multiply-linked file is refused outright: it
   * would change every other name the file has, which may be one no root
   * covers. The refusal carries the policy's own sentence, which the model reads.
   */
  async #guard(
    path: string,
    access: FileAccess,
    context: Context,
  ): Promise<Result<{ target: string; resolved: string }, FileError>> {
    if (context.abortSignal?.aborted) {
      return err(new FileError("aborted", "Operation aborted.", path));
    }
    const target = resolve(this.cwd, path);
    const resolved = resolvePathForPolicy(target);
    if (resolved === undefined) {
      return err(
        new FileError(
          "permission_denied",
          "This path cannot be resolved, so the Session's capability policy cannot say what it names.",
          target,
        ),
      );
    }
    const candidates = new Set([target, resolved]);
    if (access === "read") candidates.add(throughLinks(this.policy, resolved));
    for (const candidate of candidates) {
      const verdict =
        access === "read"
          ? capabilityRead(this.policy, candidate)
          : capabilityWrite(this.policy, candidate);
      if (verdict.outcome === "deny") {
        return err(new FileError("permission_denied", verdict.reason, target));
      }
    }
    if (access === "write" && (await isMultiplyLinked(resolved))) {
      return err(
        new FileError(
          "permission_denied",
          `${target} has more than one name on disk, so writing it would change a file this Session may not; copy it to a new file instead.`,
          target,
        ),
      );
    }
    return { ok: true, value: { target, resolved } };
  }

  /**
   * Create a write's missing parent directories one component at a time, then
   * open the file itself without following a link, and only write once the
   * open handle is a single-named regular file (VC-45 review, B1).
   *
   * Pi's own environment would `mkdir -p` the parent and open the path, both
   * following every link on the way — so a dangling link planted by the shell
   * (`x -> s/../LaunchAgents/x.plist`) took a judged write somewhere no root
   * covers. Here the directory chain is re-resolved after it exists and must
   * resolve where the guard judged, and the final component is opened
   * `O_NOFOLLOW`.
   *
   * The window that remains is a parent directory swapped for a link between
   * that re-resolution and the open. Closing it needs a descriptor-relative
   * open (`openat` beneath the root, or `O_RESOLVE_BENEATH`), which Node does
   * not expose; it is the plan's slice 8. The file tools run in this process,
   * outside the Seatbelt profile the shell runs under, so nothing behind this
   * check catches a write that wins that race: winning it needs a command
   * running concurrently with the write, swapping a directory in the
   * microseconds between two syscalls.
   */
  async #writeContained(
    path: string,
    content: string | Uint8Array,
    append: boolean,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const guarded = await this.#guard(path, "write", context);
    if (!guarded.ok) return guarded;
    const { target, resolved } = guarded.value;
    const denied = (message: string): Result<void, FileError> =>
      err(new FileError("permission_denied", message, target));
    try {
      await mkdirEach(dirname(resolved));
      // The chain exists now; resolve it again, so a link that appeared in it
      // since the guard looked is judged rather than followed.
      if (resolvePathForPolicy(resolved) !== resolved) {
        return denied(`${target} changed while it was being written; refusing to follow it.`);
      }
      if (context.abortSignal?.aborted) {
        return err(new FileError("aborted", "Operation aborted.", target));
      }
      const handle = await open(
        resolved,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_NOFOLLOW |
          (append ? fsConstants.O_APPEND : 0),
        0o666,
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1) {
          return denied(`${target} is not a single-named regular file; refusing to write it.`);
        }
        if (!append) await handle.truncate(0);
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return { ok: true, value: undefined };
    } catch (error) {
      const cause = asError(error);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        return denied(`${target} is a symbolic link; a contained write never follows one.`);
      }
      return err(new FileError("unknown", cause.message, target, cause));
    }
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
    const guarded = await this.#guard(path, "read", context);
    return guarded.ok ? ({ ok: true, value: guarded.value.target } as const) : guarded;
  }

  async exists(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, "read", context);
    return guarded.ok ? this.#delegate.exists(guarded.value.target, context) : guarded;
  }

  async readBinaryFile(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, "read", context);
    return guarded.ok ? this.#delegate.readBinaryFile(guarded.value.target, context) : guarded;
  }

  async fileInfo(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, "read", context);
    return guarded.ok ? this.#delegate.fileInfo(guarded.value.target, context) : guarded;
  }

  async readTextFile(path: string, context: Context = BACKGROUND_CONTEXT) {
    const guarded = await this.#guard(path, "read", context);
    return guarded.ok ? this.#delegate.readTextFile(guarded.value.target, context) : guarded;
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Result<void, FileError>> {
    return this.#writeContained(path, content, false, context);
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
  /**
   * Pi 0.87's pull-based line reader, which its Node environment builds
   * `readTextLines` on. The same answer as `readTextLines`: nothing this
   * runtime hands the scoped environment reads a file line by line, and a
   * capability nobody uses stays fail-closed rather than quietly delegated.
   */
  async openTextLineReader(
    _path: string,
    _context?: Context,
  ): ReturnType<ExecutionEnv["openTextLineReader"]> {
    return this.#unsupported();
  }
  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Result<void, FileError>> {
    if (context.abortSignal?.aborted) {
      return err(new FileError("aborted", "Operation aborted.", path));
    }
    return this.#writeContained(path, content, true, context);
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
        perCommandSandboxConfig(this.policy, this.#homeDir),
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
          env: this.#childEnvironment(descriptor.env),
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

  /**
   * One background shell's command, wrapped in the same walls as {@link exec}
   * (VC-45): the argv a host spawns in place of `/bin/bash -c`, and the whole
   * environment it is handed.
   *
   * The background shell host owns the child — it spawns with pipes and
   * outlives the turn — so this returns the launch rather than running it. It
   * throws rather than answering with something uncontained: a Scoped Session
   * whose walls cannot be put up gets no shell at all.
   */
  async containLaunch(command: string, cwd: string): Promise<RuntimeContainedLaunch> {
    const prepared = await this.prepareProcessExecution();
    if (!prepared.ok) throw prepared.error;
    const commandCwd = await this.#commandCwd(cwd);
    if (!commandCwd.ok) throw commandCwd.error;
    const descriptor = await this.#sandbox.wrapWithSandboxArgv(
      command,
      "/bin/bash",
      perCommandSandboxConfig(this.policy, this.#homeDir),
      undefined,
      commandCwd.value,
    );
    if (descriptor.argv.length === 0) throw new Error("Sandbox returned no command argv.");
    return { argv: descriptor.argv, env: this.#childEnvironment(descriptor.env) };
  }

  /**
   * What one contained command is handed: {@link scopedEnvironment} over what
   * SRT returned, the host-minted variables composed at construction, and the
   * prefixes in front of whatever `PATH` that came to — the contained twin of
   * `sessionCommandEnvironment`. The caller's own `env` is not consulted: a
   * command does not get to choose what crosses the boundary.
   */
  #childEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
    const merged = { ...scopedEnvironment(source), ...this.#commandVariables };
    return { ...merged, PATH: prefixedPath(merged.PATH ?? "", this.#pathPrefixes) };
  }

  async cleanup(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    try {
      await this.#releaseOwned(context);
    } finally {
      await this.#onCleanup?.();
    }
  }

  async #releaseOwned(context: Context): Promise<void> {
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
