/**
 * Owns every background shell a Session started (VC-270): the process, its
 * output ring, its read cursor and its record, keyed by the Session that
 * owns it — the shell half of what `browser/tab-host.ts` is for tabs.
 *
 * FOREGROUND CALLS (VC-757). `runForeground` owns the same child and retained
 * output, privately keyed by Session and tool call. Until `moveForeground`
 * atomically promotes it, it is neither published, capped nor announced. A
 * move clears the bash deadline and cancellation binding, answers the call
 * with a tail and id, and keeps the original process and spawn-ledger row.
 *
 * WHAT A SHELL IS. `/bin/bash -c <command>` for shell_start; foreground calls
 * use the executor's resolved shell and command transport. Spawned detached
 * in its own process group with stdout and stderr piped, through the
 * environment the caller built — the port hands in the same record the
 * `execute` tool's child gets, and this module never reads `process.env`. No
 * PTY: a shell a person types into is the terminal, and a read-only tail does
 * not need a terminal emulator.
 *
 * WHAT IT REMEMBERS. One ring buffer per shell, bound by
 * {@link SHELL_OUTPUT_MAX_BYTES}; a read cursor, so a read returns only what
 * arrived since the last one and a poll loop costs the same context every
 * time; `startedAt`, `exitedAt`, the exit code and the signal. An exited
 * shell's record and tail stay readable until its Session's attachment ends —
 * a Subagent Session's only until its turn completes (VC-809) — so a model
 * that comes back to a finished build can still read how it finished.
 *
 * WHAT IT REFUSES. The per-Session cap, a shell another Session owns (unknown
 * rather than forbidden — a shell this Session cannot touch is one it was
 * never shown), a kill on a shell already exited. Each is a
 * {@link ShellRefusal} with its rule named; anything else thrown here is a
 * broken host and fails the call. The `cwd` rule lives in the port, which
 * knows the workspace.
 *
 * WHAT THE LEDGER KNOWS. Every start writes one row to the spawn ledger
 * (VC-341) — the Session, the Ticket, the pid, the group, the clock and the
 * cwd — and every close marks it exited. The record here is still not a ledger
 * fact and still does not survive a relaunch; the ROW does, and that is the
 * point. A shell whose Volli was killed mid-turn leaves a live process and a
 * durable row saying whose it was, which is what lets a later sweep list it
 * instead of guessing from its command line.
 *
 * WHAT IT SAYS BY ITSELF (VC-495). A shell is no longer pull-only: through
 * `onNotice` it tells the Session that started it when it exits on its own,
 * and, if the model asked with `notifyOn`, the first time a line of its output
 * matches. The host decides WHEN to speak and hands over only redacted text;
 * `shell-notices.ts` words it and `session-runtime/host-notice-delivery.ts`
 * gets it into the chat. It stays quiet when the model already has the news
 * (its own `shell_kill`; an exit it read with `shell_output` inside the
 * {@link SHELL_EXIT_NOTICE_GRACE_MS} grace; output `start` itself returned) and
 * when there is no one to tell (the attachment ended). A person's kill from the
 * Island is NOT quiet: the Session has no other way to learn of it. At most one
 * exit notice and one match notice per shell, however chatty it is.
 *
 * WHAT ENDS IT. A kill is SIGTERM to the group, then SIGKILL after
 * {@link SHELL_KILL_GRACE_MS}. {@link disposeSession} is the attachment's end
 * — stop, done, detach, replace, relaunch, all through the adapter's one
 * release path — and kills every shell the Session started and forgets them.
 * A Subagent Session's completed turn calls it too (VC-809), so a shell it
 * left running cannot reopen it after its parent has the answer.
 * Shells are live resources, not ledger facts: nothing here survives a
 * relaunch, and nothing is written to the database. The record flips to
 * `exited` on the child's `close`, not its `exit` — the two are not ordered
 * against each other, and marking a fast command exited on `exit` alone can
 * beat its last stdout chunk into the ring. Private foreground calls instead
 * finish after leader exit and a 100ms stdio idle grace (or normal close),
 * then close their own pipes; promotion withdraws that foreground-only wait.
 *
 * WHAT KEEPS IT LIVE (VC-666). The shell's process group, not its pipes. A
 * grandchild that left the group (`setsid`, a daemonizing server) can hold
 * our stdout long after everything the shell started is gone, and a live
 * shell keeps its worktree busy ({@link liveCwds}) — after its Session is
 * disposed, with no list entry left to stop it from. So once the leader has
 * exited the host polls the group every {@link GROUP_POLL_MS}; when no member
 * is left it gives the pipes one more poll to drain, then closes its own read
 * ends, which fires the `close` that settles the record as usual. The escaped
 * process is not ours to kill and is left running; Volli simply stops
 * listening, so its later writes to that pipe fail (EPIPE / SIGPIPE).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { ShellRefusal, SHELL_MAX_PER_SESSION } from "@volli/agent-runtime";
import {
  redactPayloadSecrets,
  shellCommandLine,
  type BackgroundShellState,
  type RuntimeShellRecord,
  type SpawnLedgerPort,
} from "@volli/shared";

import { NO_SPAWN_LEDGER } from "../process/spawn-ledger";
import { NoticeMatchWatch, NoticeOutput } from "./notice-output";
import {
  compileNotifyPattern,
  SHELL_NOTIFY_LINE_MAX_CHARS,
  type ShellNotifyPattern,
} from "./notify-pattern";
import { hostLogger } from "../log/root";

const log = hostLogger("background-shell");

/** The renderer's snapshot of one shell is client wire vocabulary (`@volli/shared`, VC-632). */
export type { BackgroundShellState } from "@volli/shared";

/** Bytes retained per shell — the PTY peek's own bound (`pty/output.ts`). */
export const SHELL_OUTPUT_MAX_BYTES = 256_000;
/** The most a `tail` read hands back, whatever the caller asked for. */
export const SHELL_TAIL_MAX_BYTES = 64_000;
/** How long a start waits for first output before answering. */
export const SHELL_START_SETTLE_MS = 1_000;
/** How long SIGTERM gets before SIGKILL. */
export const SHELL_KILL_GRACE_MS = 5_000;
/** Foreground leader exit gets the executor's 100ms idle window to drain final bytes. */
const FOREGROUND_EXIT_STDIO_GRACE_MS = 100;
/**
 * How often a shell whose leader exited but whose pipes are still open checks
 * its process group (VC-666); also the drain grace once the group is empty.
 */
const GROUP_POLL_MS = 250;

/** How long an exit waits for the model to have read it itself before a notice is sent. */
export const SHELL_EXIT_NOTICE_GRACE_MS = 1_000;
/** The most of a shell's output an exit notice carries: its last few kilobytes. */
export const SHELL_NOTICE_TAIL_MAX_BYTES = 4_000;

/** The longest label a notice names a shell by, in characters. */
export const SHELL_NOTICE_LABEL_MAX_CHARS = 80;
/** The most of a matching line a match notice quotes, in characters. */
export const SHELL_NOTICE_MATCH_LINE_MAX_CHARS = 500;

/**
 * What the host tells main about a shell that has something to say (VC-495).
 * Every string here has already been through the redactors: the host is the
 * one place that holds both the raw output and the credential store's exact
 * values, so nothing downstream ever sees a secret to scrub.
 */
export type BackgroundShellNotice = {
  sessionId: string;
  shellId: string;
  /** The model's title, else the command's first line; redacted and bounded. */
  label: string;
} & (
  | {
      kind: "exited";
      code: number | null;
      signal: string | null;
      runtimeMs: number;
      /** A person ended it from the Island; the agent's own kill never notifies. */
      byPerson: boolean;
      tail: string;
      /** The tail is not all of the output: the ring dropped bytes, or the notice bound cut it. */
      truncated: boolean;
    }
  | {
      kind: "matched";
      pattern: string;
      regex: boolean;
      line: string;
    }
);

/** Who a shell belongs to: the Session, and the scope the adapter stated for it. */
export interface BackgroundShellOwner {
  sessionId: string;
  attachmentId: string;
  projectId: string;
  ticketId: string | null;
}

export interface BackgroundShellStartInput {
  command: string;
  /** Already judged inside the workspace by the port. */
  cwd: string;
  title: string | null;
  /** The whole environment the child gets; nothing is added here. */
  env: Record<string, string>;
  /** Foreground executor's resolved shell; shell_start retains its bash default. */
  shellConfig?: { shell: string; args: string[]; commandTransport?: "argv" | "stdin" };
  /**
   * Tell the Session the first time this appears in a line of output (VC-495).
   * Judged before anything is spawned: a pattern the host will not run is a
   * `shell.pattern` refusal.
   */
  notifyOn?: ShellNotifyPattern;
}

/** Foreground timeout is in seconds, matching the bash tool. */
export interface ForegroundShellOptions {
  toolCallId: string;
  timeout?: number;
  signal: AbortSignal;
  /** Retained, redacted snapshots for clients that do not own a capture. */
  onOutput?(text: string): void;
  /** Executor-internal bytes; the tool's existing capture/redactor owns their publication. */
  onChunk?(chunk: Uint8Array): void;
  onReady?(control: { pauseOutput(): void; resumeOutput(): void }): void;
}

export interface ForegroundShellResult {
  output: string;
  code: number | null;
  signal: string | null;
  background?: { shellId: string };
}

interface ForegroundRun {
  entry?: ShellEntry;
  cancel(message: string): void;
  promote(): ForegroundShellResult;
}

export interface BackgroundShellHostPorts {
  /** The renderer's feed: a whole snapshot on every change of state. */
  publishState(state: BackgroundShellState): void;
  /** The renderer's feed: a shell the host forgot. */
  publishRemoved(shellId: string): void;
  /** Apply after combining chunks, before tool or renderer reads. Never logs output. */
  redactOutput?: (text: string) => string;
  /** Union shared/original exact spans AND unfinished credentials in live previews. */
  redactNoticeOutput?: (text: string) => string;
  /**
   * A shell has something to tell the Session that started it (VC-495): it
   * exited on its own, or its output matched the pattern the model asked to
   * be told about. Never called for a shell the Session's own `shell_kill`
   * ended, nor once the Session's attachment has ended.
   */
  onNotice?(notice: BackgroundShellNotice): void;
  /** Overridable for tests; defaults to {@link SHELL_EXIT_NOTICE_GRACE_MS}. */
  exitNoticeGraceMs?: number;
  /** Where a started shell is recorded so a later launch can still attribute it. */
  ledger?: SpawnLedgerPort;
  createId?: () => string;
  now?: () => number;
  settleMs?: number;
  killGraceMs?: number;
  outputMaxBytes?: number;
  tailMaxBytes?: number;
}

/**
 * One shell's retained output: whole chunks, trimmed off the front once a
 * chunk can go while the bound still holds, with absolute byte offsets so
 * the cursor survives the trim. Buffers rather than strings because the bound
 * is bytes and a chunk may end mid-codepoint; decoding happens once per read.
 */
class OutputRing {
  #chunks: Buffer[] = [];
  /** Absolute offset of the first retained byte. */
  #head = 0;
  /** Absolute offset one past the last retained byte. */
  #end = 0;
  /** Where the model's next incremental read starts. */
  cursor = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#end += chunk.length;
    let first = this.#chunks[0];
    while (first !== undefined && this.#end - this.#head - first.length >= this.maxBytes) {
      this.#chunks.shift();
      this.#head += first.length;
      first = this.#chunks[0];
    }
    // What is left may still overshoot by less than one chunk; cut that
    // chunk's front so the bound is exact rather than chunk-granular.
    const excess = this.#end - this.#head - this.maxBytes;
    if (excess > 0 && first !== undefined) {
      this.#chunks[0] = first.subarray(excess);
      this.#head += excess;
    }
  }

  /** Everything new since the cursor; `truncated` when the ring dropped some of it. */
  readNew(): { output: string; truncated: boolean } {
    const truncated = this.cursor < this.#head;
    const from = Math.max(this.cursor, this.#head);
    const output = this.slice(from - this.#head);
    this.cursor = this.#end;
    return { output, truncated };
  }

  /** The last `bytes` of everything retained; `truncated` when that is not all of it. */
  readTail(bytes: number): { output: string; truncated: boolean } {
    const retained = this.#end - this.#head;
    const take = Math.min(bytes, retained);
    const output = this.slice(retained - take);
    this.cursor = this.#end;
    return { output, truncated: take < retained || this.#head > 0 };
  }

  get truncated(): boolean {
    return this.#head > 0;
  }

  /** The whole retained output, for a person's read; moves nothing. */
  all(): string {
    return this.slice(0);
  }

  /**
   * The retained bytes from `offsetInRetained` on, decoded once.
   *
   * The offset is a BYTE offset — the ring's bound and the tail cap are both
   * byte bounds — so it can land inside a multi-byte character. Decoding from
   * there would manufacture a U+FFFD the process never wrote, and, because a
   * replacement character re-encodes to three bytes, could hand back MORE
   * bytes than the bound the caller was promised. So the start is advanced
   * past any continuation bytes to the next character boundary: the model
   * loses at most the fragment of one character our own cut broke, and never
   * reads a corruption we invented.
   */
  private slice(offsetInRetained: number): string {
    const retained = Buffer.concat(this.#chunks);
    let from = Math.min(offsetInRetained, retained.length);
    // 0b10xxxxxx is a UTF-8 continuation byte: still inside a character.
    while (from < retained.length && (retained[from]! & 0xc0) === 0x80) from += 1;
    return retained.subarray(from).toString("utf8");
  }
}

interface ShellEntry {
  cwd: string;
  owner: BackgroundShellOwner;
  record: RuntimeShellRecord;
  pid: number;
  child: ChildProcess;
  /** Only private foreground pipes may be closed without waiting for inherited writers. */
  foreground: boolean;
  ring: OutputRing;
  /** Each pipe retains its own bounded, uncut redaction/UTF-8 context. */
  stdout: NoticeOutput;
  stderr: NoticeOutput;
  /** Settles when the child exits, however it exits. */
  exited: Promise<void>;
  /** Told on every chunk, for the settle window. */
  onOutput: Set<(chunk: Buffer) => void>;
  /**
   * `start` has handed the model its first answer. An exit before that is in
   * the answer itself (its record is copied after this flips), so only an exit
   * after it is news.
   */
  returned: boolean;
  /** The pending exit notice, while the grace for the model's own read runs. */
  noticeTimer?: ReturnType<typeof setTimeout>;
  /**
   * Who asked for the kill, once someone did. The Session's own `shell_kill`
   * is confirmed by its tool result and is never echoed back (VC-485's rule for
   * a Session's own stops); a person's is news the Session has no other way to
   * learn.
   */
  endedBy?: "agent" | "person";
}

export class BackgroundShellHost {
  private readonly shells = new Map<string, ShellEntry>();
  /** Foreground calls are private until promoted; never part of the shell cap or feed. */
  private readonly foreground = new Map<string, Map<string, ForegroundRun>>();
  /** Disposed attachments can still have a kill in flight; retain those processes until close. */
  private readonly processes = new Set<ShellEntry>();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly killGraceMs: number;
  private readonly outputMaxBytes: number;
  private readonly tailMaxBytes: number;
  private readonly ledger: SpawnLedgerPort;
  private readonly exitNoticeGraceMs: number;

  constructor(private readonly deps: BackgroundShellHostPorts) {
    this.ledger = deps.ledger ?? NO_SPAWN_LEDGER;
    this.createId = deps.createId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.settleMs = deps.settleMs ?? SHELL_START_SETTLE_MS;
    this.killGraceMs = deps.killGraceMs ?? SHELL_KILL_GRACE_MS;
    this.outputMaxBytes = deps.outputMaxBytes ?? SHELL_OUTPUT_MAX_BYTES;
    this.tailMaxBytes = deps.tailMaxBytes ?? SHELL_TAIL_MAX_BYTES;
    this.exitNoticeGraceMs = deps.exitNoticeGraceMs ?? SHELL_EXIT_NOTICE_GRACE_MS;
  }

  private stateOf(entry: ShellEntry): BackgroundShellState {
    return {
      shellId: entry.record.shellId,
      sessionId: entry.owner.sessionId,
      projectId: entry.owner.projectId,
      ticketId: entry.owner.ticketId,
      command: entry.record.command,
      title: entry.record.title,
      state: entry.record.state,
      code: entry.record.code,
      signal: entry.record.signal,
      startedAt: entry.record.startedAt,
      exitedAt: entry.record.exitedAt,
      pid: entry.pid,
    };
  }

  private ownedBy(sessionId: string): ShellEntry[] {
    return [...this.shells.values()].filter((entry) => entry.owner.sessionId === sessionId);
  }

  /** The Session's shell, or the `shell.unknown` refusal — another Session's is unknown too. */
  private requireOwn(owner: Pick<BackgroundShellOwner, "sessionId">, shellId: string): ShellEntry {
    const entry = this.shells.get(shellId);
    if (entry === undefined || entry.owner.sessionId !== owner.sessionId) {
      throw new ShellRefusal(
        "shell.unknown",
        `No background shell ${JSON.stringify(shellId)} belongs to this Session: the ids you hold are listed at the end of every shell result.`,
      );
    }
    return entry;
  }

  /** The Session's shells, in start order. */
  list(sessionId: string): RuntimeShellRecord[] {
    return this.ownedBy(sessionId).map((entry) => copyOf(entry.record));
  }

  /**
   * Spawn, wait for the settle window or the first exit, and answer with the
   * record and whatever arrived. The settle window is not a timeout on the
   * command: a shell still running when it closes is the ordinary case.
   */
  async start(
    owner: BackgroundShellOwner,
    input: BackgroundShellStartInput,
  ): Promise<{ shell: RuntimeShellRecord; pid: number; output: string }> {
    this.requireOpen();
    this.requireCapacity(owner.sessionId);
    const entry = await this.spawnShell(owner, input, true);
    await this.settle(entry);
    // Flipped in the same synchronous block that copies the record below: an
    // exit lands either before it (and is in the answer) or after (and is news).
    entry.returned = true;
    const { output } = entry.ring.readNew();
    return { shell: { ...entry.record }, pid: entry.pid, output: this.safeOutput(output) };
  }

  private requireOpen(): void {
    if (this.closing !== undefined)
      throw new ShellRefusal(
        "shell.closing",
        "The host is stopping; no new background shell can start.",
      );
  }

  private requireCapacity(sessionId: string): void {
    const live = this.ownedBy(sessionId).filter((entry) => entry.record.state === "running");
    if (live.length >= SHELL_MAX_PER_SESSION) {
      throw new ShellRefusal(
        "shell.limit",
        `This Session already holds ${SHELL_MAX_PER_SESSION} running background shells (${live
          .map((entry) => entry.record.shellId)
          .join(", ")}): kill one with shell_kill, or reuse one.`,
      );
    }
  }

  /** Both modes own the same child, output, process group and spawn-ledger lifecycle. */
  private async spawnShell(
    owner: BackgroundShellOwner,
    input: BackgroundShellStartInput,
    background: boolean,
  ): Promise<ShellEntry> {
    let notifyTest: ((line: string) => boolean) | null = null;
    if (input.notifyOn !== undefined) {
      const compiled = compileNotifyPattern(input.notifyOn);
      if (!compiled.ok) {
        throw new ShellRefusal(
          "shell.pattern",
          `The shell was not started, because ${compiled.reason}. Use notifyOn with a plain string, or a simpler regular expression with notifyOnRegex.`,
        );
      }
      notifyTest = compiled.test;
    }
    const shellId = this.createId();
    const config = input.shellConfig ?? { shell: "/bin/bash", args: ["-c"] };
    const commandFromStdin = config.commandTransport === "stdin";
    const child = spawn(
      config.shell,
      commandFromStdin ? config.args : [...config.args, input.command],
      {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    if (commandFromStdin) {
      // A shell can exit before consuming its script. Match the executor's
      // transport: close stdin at EOF and let child exit report that outcome.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input.command);
    }
    const pid = child.pid;
    if (pid === undefined) {
      // Node reports a failed spawn as an `error` event with no pid; the
      // command never ran, and that is a host fault rather than a refusal.
      const failure = await new Promise<Error>((resolve) => child.once("error", resolve));
      throw new Error(`Could not start a background shell: ${failure.message}`);
    }
    const startedAt = this.now();
    // Written before the first chunk can arrive, and with the pid the group
    // kill would signal: `detached: true` above makes this child its own group
    // leader, so its pid IS its pgid.
    const ledgerId = this.ledger.recordSpawn({
      sessionId: owner.sessionId,
      ticketId: owner.ticketId,
      projectId: owner.projectId,
      kind: "shell",
      pid,
      pgid: pid,
      startedAt,
      cwd: input.cwd,
      command: input.command,
    });
    const record: RuntimeShellRecord = {
      shellId,
      command: input.command,
      title: input.title,
      state: "running",
      code: null,
      signal: null,
      startedAt,
      exitedAt: null,
    };
    const ring = new OutputRing(this.outputMaxBytes);
    const onOutput = new Set<(chunk: Buffer) => void>();
    const notifyOn = input.notifyOn;
    const stdout = new NoticeOutput((text) => this.redactNoticeText(text), this.outputMaxBytes);
    const stderr = new NoticeOutput((text) => this.redactNoticeText(text), this.outputMaxBytes);
    let matched = false;
    const makeWatch = (): NoticeMatchWatch | null =>
      notifyTest === null || notifyOn === undefined || this.deps.onNotice === undefined
        ? null
        : new NoticeMatchWatch(
            notifyTest,
            (line) => {
              if (matched) return;
              matched = true;
              this.announceMatch(entry, notifyOn, line);
            },
            SHELL_NOTIFY_LINE_MAX_CHARS,
          );
    const stdoutWatch = makeWatch();
    const stderrWatch = makeWatch();
    const matchOutput = (output: NoticeOutput, watch: NoticeMatchWatch | null): void => {
      if (matched || output.withheld || entry.endedBy === "agent" || watch === null) return;
      const safe = output.snapshot();
      if (!output.withheld) watch.feed(safe);
    };
    const receive = (output: NoticeOutput, watch: NoticeMatchWatch | null, chunk: Buffer): void => {
      ring.append(chunk);
      output.feed(chunk);
      matchOutput(output, watch);
      for (const listener of onOutput) listener(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => receive(stdout, stdoutWatch, chunk));
    child.stderr?.on("data", (chunk: Buffer) => receive(stderr, stderrWatch, chunk));
    const exited = new Promise<void>((resolve) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (record.state === "exited") return;
        record.state = "exited";
        record.code = code;
        record.signal = signal;
        record.exitedAt = this.now();
        if (ledgerId !== null) this.ledger.markExited(ledgerId, record.exitedAt);
        this.processes.delete(entry);
        if (this.shells.has(shellId)) {
          this.deps.publishState(this.stateOf(entry));
          stdout.finish();
          stderr.finish();
          matchOutput(stdout, stdoutWatch);
          matchOutput(stderr, stderrWatch);
          this.scheduleExitNotice(entry);
        }
        resolve();
      };
      // `close`, not `exit`: Node fires `exit` the moment the process itself
      // is reaped, which is a separate notification path from the stdout/
      // stderr pipes and is not ordered against them — on some platforms a
      // fast command's `exit` is observed before its last `data` chunk,
      // which would mark the record exited while bytes it already wrote are
      // still in flight. `close` is Node's own guarantee that every stdio
      // stream has finished emitting before it fires, so a read after
      // `state === "exited"` never misses output the process produced. This
      // only waits on OUR pipes, not a lingering process. A grandchild still
      // in the group keeps the shell running (a group kill reaches it); one
      // that escaped the group while holding our stdout is cut loose by
      // `watchGroup` once the group is empty (VC-666).
      child.once("close", settle);
      child.once("exit", () => this.watchGroup(entry));
      // A spawn that failed after a pid was handed out (rare) ends the same way.
      child.once("error", () => settle(null, null));
    });
    const entry: ShellEntry = {
      cwd: input.cwd,
      owner,
      record,
      pid,
      child,
      foreground: !background,
      ring,
      stdout,
      stderr,
      exited,
      onOutput,
      returned: false,
    };
    this.processes.add(entry);
    if (background) {
      this.shells.set(shellId, entry);
      this.deps.publishState(this.stateOf(entry));
    }
    return entry;
  }

  /**
   * After the leader exits, the process group decides liveness (VC-666): while
   * any member is left the shell is running; once none is, the pipes get one
   * poll to drain and then the host closes its read ends, so a grandchild that
   * escaped the group cannot hold the record open — or its worktree busy —
   * forever. A private foreground call is left to its own leader-exit drain,
   * which also respects the executor's backpressure pause; it can no longer be
   * promoted once its leader has exited.
   */
  private watchGroup(entry: ShellEntry): void {
    if (entry.foreground) return;
    const closePipes = (): void => {
      if (entry.record.state === "exited") return;
      entry.child.stdout?.destroy();
      entry.child.stderr?.destroy();
    };
    const poll = (): void => {
      if (entry.record.state === "exited") return;
      if (groupAlive(entry.pid)) setTimeout(poll, GROUP_POLL_MS);
      else setTimeout(closePipes, GROUP_POLL_MS);
    };
    setTimeout(poll, GROUP_POLL_MS);
  }

  /** Run privately until exit, cancellation, or an atomic move to the background. */
  runForeground(
    owner: BackgroundShellOwner,
    input: BackgroundShellStartInput,
    options: ForegroundShellOptions,
  ): Promise<ForegroundShellResult> {
    return new Promise((resolve, reject) => {
      this.requireOpen();
      if (options.signal.aborted)
        throw Object.assign(new Error("Command aborted"), { code: "aborted", output: "" });
      if (
        options.timeout !== undefined &&
        (!Number.isFinite(options.timeout) ||
          options.timeout <= 0 ||
          options.timeout > 2_147_483.647)
      )
        throw new Error(
          "Invalid timeout: must be a positive finite number of seconds within the timer limit",
        );
      let calls = this.foreground.get(owner.sessionId);
      if (calls?.has(options.toolCallId))
        throw new Error("This foreground shell call is already running");
      if (calls === undefined) {
        calls = new Map();
        this.foreground.set(owner.sessionId, calls);
      }
      const sessionCalls = calls;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let outputPaused = false;
      const leaderExited = (): boolean =>
        run.entry !== undefined &&
        (run.entry.child.exitCode !== null || run.entry.child.signalCode !== null);
      const finish = (): void => {
        if (!active) return;
        const entry = run.entry!;
        const result = {
          output: snapshot(),
          code: entry.child.exitCode ?? entry.record.code,
          signal: entry.child.signalCode ?? entry.record.signal,
        };
        cleanup();
        // A grandchild can retain the pipes long after bash exits. Foreground
        // completion follows the leader, unlike a promoted/background record.
        entry.child.stdout?.destroy();
        entry.child.stderr?.destroy();
        resolve(result);
      };
      const drainAfterExit = (): void => {
        clearTimeout(drainTimer);
        drainTimer = setTimeout(() => {
          // The executor may be spilling output: do not discard unread bytes
          // during its backpressure pause. Cancellation has its own bound.
          if (outputPaused) drainAfterExit();
          else finish();
        }, FOREGROUND_EXIT_STDIO_GRACE_MS);
      };
      const snapshot = (): string => this.safeOutput(run.entry?.ring.all() ?? "");
      const update = (chunk: Buffer): void => {
        try {
          options.onChunk?.(chunk);
          if (options.onOutput !== undefined) options.onOutput(snapshot());
          if (active && leaderExited()) drainAfterExit();
        } catch (error) {
          cancel(
            error instanceof Error ? error.message : "Shell output callback failed",
            "callback_error",
          );
        }
      };
      const cleanup = (): void => {
        active = false;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        options.signal.removeEventListener("abort", abort);
        run.entry?.child.removeListener("exit", drainAfterExit);
        run.entry?.onOutput.delete(update);
        sessionCalls.delete(options.toolCallId);
        if (sessionCalls.size === 0) this.foreground.delete(owner.sessionId);
      };
      const cancel = (
        message: string,
        code: "aborted" | "timeout" | "callback_error" = "aborted",
      ): void => {
        if (!active) return;
        const output = snapshot();
        cleanup();
        if (run.entry !== undefined) {
          run.entry.endedBy = "agent";
          void this.terminate(run.entry);
        }
        // The executor already captured these bytes. Keep status separate from
        // output so its error result cannot duplicate the entire retained ring.
        reject(Object.assign(new Error(message.slice(0, 500)), { code, output }));
      };
      const abort = (): void => cancel("Command aborted");
      const run: ForegroundRun = {
        cancel,
        promote: () => {
          const entry = run.entry!;
          cleanup();
          entry.foreground = false;
          const { text: output } = lastBytes(this.safeOutput(entry.ring.all()), this.tailMaxBytes);
          entry.ring.readNew();
          entry.returned = true;
          this.shells.set(entry.record.shellId, entry);
          // Capture backpressure belonged to the foreground reader, not the moved process.
          entry.child.stdout?.resume();
          entry.child.stderr?.resume();
          const result: ForegroundShellResult = {
            output,
            code: null,
            signal: null,
            background: { shellId: entry.record.shellId },
          };
          resolve(result);
          this.deps.publishState(this.stateOf(entry));
          return result;
        },
      };
      sessionCalls.set(options.toolCallId, run);
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.timeout !== undefined) {
        timer = setTimeout(
          () => cancel(`Command timed out after ${options.timeout} seconds`, "timeout"),
          options.timeout * 1_000,
        );
      }
      void this.spawnShell(owner, input, false).then(
        (entry) => {
          run.entry = entry;
          if (!active) {
            entry.endedBy = "agent";
            void this.terminate(entry);
            return;
          }
          entry.onOutput.add(update);
          entry.child.once("exit", drainAfterExit);
          // Register before onReady, which can synchronously move or cancel.
          void entry.exited.then(finish);
          if (leaderExited()) drainAfterExit();
          try {
            options.onReady?.({
              pauseOutput: () => {
                if (!active) return;
                outputPaused = true;
                entry.child.stdout?.pause();
                entry.child.stderr?.pause();
              },
              resumeOutput: () => {
                if (!active) return;
                outputPaused = false;
                entry.child.stdout?.resume();
                entry.child.stderr?.resume();
                if (leaderExited()) drainAfterExit();
              },
            });
          } catch (error) {
            cancel(
              error instanceof Error ? error.message : "Shell ready callback failed",
              "callback_error",
            );
          }
        },
        (error: unknown) => {
          if (!active) return;
          cleanup();
          reject(error);
        },
      );
    });
  }

  /** A running, uncancelled call with room in the background shell cap. */
  foregroundAvailable(sessionId: string, toolCallId: string): boolean {
    const entry = this.foreground.get(sessionId)?.get(toolCallId)?.entry;
    return (
      this.closing === undefined &&
      entry?.record.state === "running" &&
      entry.child.exitCode === null &&
      entry.child.signalCode === null &&
      this.ownedBy(sessionId).filter((shell) => shell.record.state === "running").length <
        SHELL_MAX_PER_SESSION
    );
  }

  /** No await: state/cap checks and promotion happen in one event-loop turn. */
  moveForeground(sessionId: string, toolCallId: string): { shellId: string } {
    this.requireOpen();
    const run = this.foreground.get(sessionId)?.get(toolCallId);
    const entry = run?.entry;
    if (entry === undefined)
      throw new ShellRefusal("shell.unknown", "No running foreground shell belongs to this call.");
    this.requireCapacity(sessionId);
    if (!this.foregroundAvailable(sessionId, toolCallId))
      throw new ShellRefusal("shell.exited", "This foreground shell already exited.");
    run!.promote();
    return { shellId: entry.record.shellId };
  }

  /**
   * The exit notice, after a short grace (VC-495): a model that reads the exit
   * itself inside it has been told, and a notice on top would only repeat it.
   */
  private scheduleExitNotice(entry: ShellEntry): void {
    if (this.deps.onNotice === undefined || !entry.returned || entry.endedBy === "agent") return;
    entry.noticeTimer = setTimeout(() => {
      entry.noticeTimer = undefined;
      const { record } = entry;
      // Redact each complete pipe context BEFORE selecting a tail. Do not
      // move the incremental read cursor: delivery can fail or remain parked.
      const stdout = entry.stdout.snapshot();
      const stderr = entry.stderr.snapshot();
      const separator =
        stdout.length > 0 && stderr.length > 0 && !stdout.endsWith("\n") ? "\n" : "";
      const tail = lastBytes(`${stdout}${separator}${stderr}`, SHELL_NOTICE_TAIL_MAX_BYTES);
      this.emit({
        kind: "exited",
        sessionId: entry.owner.sessionId,
        shellId: record.shellId,
        label: this.labelOf(record),
        code: record.code,
        signal: record.signal,
        runtimeMs: (record.exitedAt ?? this.now()) - record.startedAt,
        byPerson: entry.endedBy === "person",
        tail: tail.text,
        truncated:
          entry.ring.truncated || entry.stdout.withheld || entry.stderr.withheld || tail.cut,
      });
    }, this.exitNoticeGraceMs);
  }

  /**
   * The one way a notice leaves the host. The sink is main's, and this runs
   * inside the child's `close` and `data` handlers, where a throw would be an
   * uncaught exception in the main process and would skip the listeners behind
   * it. A notice that could not be sent is written to the log (nobody is
   * waiting on it) and the shell stays readable.
   */
  private emit(notice: BackgroundShellNotice): void {
    try {
      this.deps.onNotice?.(notice);
    } catch (error) {
      log.error("background shell notice failed", { error });
    }
  }

  /**
   * Text on its way into a notice, and so into a durable transcript: the
   * credential store's exact values first (it knows what to look for), then
   * the shared pattern redactor for the secrets nobody stored.
   */
  private redactNoticeText(text: string): string {
    return redactPayloadSecrets(
      this.deps.redactNoticeOutput?.(text) ?? this.deps.redactOutput?.(text) ?? text,
    );
  }

  private noticeText(text: string): string {
    try {
      return this.redactNoticeText(text);
    } catch {
      return "[Output withheld: credential redaction failed.]";
    }
  }

  /** What a notice calls a shell: its title, else the command's first line, scrubbed and short. */
  private labelOf(record: RuntimeShellRecord): string {
    const named = this.noticeText(record.title ?? shellCommandLine(record.command));
    const chars = [...named];
    return chars.length <= SHELL_NOTICE_LABEL_MAX_CHARS
      ? named
      : `${chars.slice(0, SHELL_NOTICE_LABEL_MAX_CHARS - 1).join("")}…`;
  }

  /**
   * The match notice (VC-495). Silent for a match inside the settle window —
   * `start` hands the model that very output — and for a shell whose Session
   * has gone; the watch has used its one match either way.
   */
  private announceMatch(entry: ShellEntry, notifyOn: ShellNotifyPattern, line: string): void {
    if (!entry.returned || entry.endedBy === "agent" || !this.shells.has(entry.record.shellId))
      return;
    const chars = [...line];
    this.emit({
      kind: "matched",
      sessionId: entry.owner.sessionId,
      shellId: entry.record.shellId,
      label: this.labelOf(entry.record),
      pattern: this.noticeText(notifyOn.pattern),
      regex: notifyOn.regex,
      line:
        chars.length <= SHELL_NOTICE_MATCH_LINE_MAX_CHARS
          ? line
          : `${chars.slice(0, SHELL_NOTICE_MATCH_LINE_MAX_CHARS - 1).join("")}…`,
    });
  }

  private cancelExitNotice(entry: ShellEntry): void {
    if (entry.noticeTimer === undefined) return;
    clearTimeout(entry.noticeTimer);
    entry.noticeTimer = undefined;
  }

  /** The settle window: the exit, or the bound, whichever is first. */
  private async settle(entry: ShellEntry): Promise<void> {
    await Promise.race([
      entry.exited,
      new Promise<void>((resolve) => setTimeout(resolve, this.settleMs)),
    ]);
    // Give the pipes one turn to drain what arrived with the exit.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /**
   * What is new since the last read, or with `tail` the last N bytes of
   * everything retained. Either read moves the cursor to the end: the model
   * has now seen up to there, by its own choice of window.
   */
  read(
    owner: Pick<BackgroundShellOwner, "sessionId">,
    shellId: string,
    tail?: number,
  ): { shell: RuntimeShellRecord; output: string; truncated: boolean } {
    const entry = this.requireOwn(owner, shellId);
    // The model is reading the exit itself; a notice on top would repeat it.
    if (entry.record.state === "exited") this.cancelExitNotice(entry);
    const read =
      tail === undefined
        ? entry.ring.readNew()
        : entry.ring.readTail(Math.max(0, Math.min(Math.floor(tail), this.tailMaxBytes)));
    return { shell: { ...entry.record }, ...read, output: this.safeOutput(read.output) };
  }

  /** SIGTERM the group, SIGKILL after the grace; resolves once the shell has exited. */
  async kill(
    owner: Pick<BackgroundShellOwner, "sessionId">,
    shellId: string,
  ): Promise<{ shell: RuntimeShellRecord }> {
    const entry = this.requireOwn(owner, shellId);
    if (entry.record.state === "exited") {
      throw new ShellRefusal(
        "shell.exited",
        `Background shell ${JSON.stringify(shellId)} already exited (${
          entry.record.signal ?? `code ${entry.record.code}`
        }); there is nothing to kill. Its output is still readable with shell_output.`,
      );
    }
    entry.endedBy = "agent";
    await this.terminate(entry);
    return { shell: { ...entry.record } };
  }

  private async terminate(entry: ShellEntry): Promise<void> {
    if (entry.record.state === "exited") return;
    signalGroup(entry.pid, "SIGTERM");
    const grace = new Promise<"grace">((resolve) =>
      setTimeout(() => resolve("grace"), this.killGraceMs),
    );
    if ((await Promise.race([entry.exited, grace])) === "grace") {
      signalGroup(entry.pid, "SIGKILL");
      if (entry.foreground) {
        // An escaped grandchild may be in its own group yet still hold our
        // pipes. After the kill grace, private foreground cleanup must not
        // join that unrelated writer forever. Background shells keep their
        // close-based drain, including after promotion; `watchGroup` closes
        // their pipes once the group is empty (VC-666).
        entry.child.stdout?.destroy();
        entry.child.stderr?.destroy();
      }
      await entry.exited;
    }
  }

  private safeOutput(text: string): string {
    try {
      return this.deps.redactOutput?.(text) ?? text;
    } catch {
      return "[Output withheld: credential redaction failed.]";
    }
  }

  // ---- the renderer's doors: every shell, unscoped by Session -------------

  /** Every running shell cwd, including shells between a turn and attachment cleanup. */
  liveCwds(): string[] {
    return [...this.processes].map((entry) => entry.cwd);
  }

  private closing: Promise<void> | undefined;
  /** Headless shutdown joins the kills before the spawn ledger's database closes. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const entries = [...new Set([...this.processes, ...this.shells.values()])];
    for (const calls of this.foreground.values()) {
      for (const run of calls.values()) run.cancel("Command aborted: the host is stopping");
    }
    for (const entry of entries) this.cancelExitNotice(entry);
    this.shells.clear();
    this.closing = Promise.all(entries.map((entry) => this.terminate(entry))).then(() => undefined);
    return this.closing;
  }

  listAll(): BackgroundShellState[] {
    return [...this.shells.values()].map((entry) => this.stateOf(entry));
  }

  /** The whole retained output for a person's read; moves no cursor. */
  tailOf(shellId: string): { output: string; shell: BackgroundShellState } | null {
    const entry = this.shells.get(shellId);
    if (entry === undefined) return null;
    return { output: this.safeOutput(entry.ring.all()), shell: this.stateOf(entry) };
  }

  /** A person's kill: a no-op on a shell that has exited or is unknown, not a refusal. */
  async killAny(shellId: string): Promise<void> {
    const entry = this.shells.get(shellId);
    if (entry === undefined) return;
    if (entry.record.state === "running") entry.endedBy ??= "person";
    await this.terminate(entry);
  }

  /**
   * The attachment's end — or a Subagent Session's completed turn (VC-809):
   * kill every shell the Session started and forget them. Fire-and-forget on the kill, because release must not wait on a
   * process that ignores SIGTERM — the SIGKILL still follows after the grace.
   *
   * A Session that has ended is told nothing (VC-495): an exit notice still
   * waiting out its grace is dropped with the shell, and the forgotten entry is
   * what keeps a match or an exit that lands later quiet.
   */
  disposeSession(sessionId: string): void {
    for (const run of this.foreground.get(sessionId)?.values() ?? []) {
      run.cancel("Command aborted: the Session attachment ended");
    }
    for (const entry of this.ownedBy(sessionId)) {
      this.cancelExitNotice(entry);
      this.shells.delete(entry.record.shellId);
      void this.terminate(entry);
      this.deps.publishRemoved(entry.record.shellId);
    }
  }
}

/**
 * The last `bytes` of `text`, advanced past any continuation bytes to a
 * character boundary for the reason {@link OutputRing.slice} gives: a cut
 * through a character would be decoded into a U+FFFD that re-encodes larger
 * than the bound promised.
 */
function lastBytes(text: string, bytes: number): { text: string; cut: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) return { text, cut: false };
  let from = encoded.length - bytes;
  while (from < encoded.length && (encoded[from]! & 0xc0) === 0x80) from += 1;
  return { text: encoded.subarray(from).toString("utf8"), cut: true };
}

/** A record as handed out: a copy, so a caller never holds the live one. */
function copyOf(record: RuntimeShellRecord): RuntimeShellRecord {
  return { ...record };
}

/**
 * Whether any process is still in the group `pgid` leads. ESRCH is the only
 * answer that means empty; EPERM means a member exists we may not signal.
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Signal the process group, falling back to the process when the group is gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead; the exit event settles the record.
    }
  }
}
