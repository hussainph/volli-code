/**
 * Owns every background shell a Session started (VC-270): the process, its
 * output ring, its read cursor and its record, keyed by the Session that
 * owns it — the shell half of what `browser/tab-host.ts` is for tabs.
 *
 * WHAT A SHELL IS. `/bin/bash -c <command>`, spawned detached in its own
 * process group with stdout and stderr piped and stdin closed, through the
 * environment the caller built — the port hands in the same record the
 * `execute` tool's child gets, and this module never reads `process.env`. No
 * PTY: a shell a person types into is the terminal, and a read-only tail does
 * not need a terminal emulator.
 *
 * WHAT IT REMEMBERS. One ring buffer per shell, bound by
 * {@link SHELL_OUTPUT_MAX_BYTES}; a read cursor, so a read returns only what
 * arrived since the last one and a poll loop costs the same context every
 * time; `startedAt`, `exitedAt`, the exit code and the signal. An exited
 * shell's record and tail stay readable until its Session's attachment ends,
 * so a model that comes back to a finished build can still read how it
 * finished.
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
 * Shells are live resources, not ledger facts: nothing here survives a
 * relaunch, and nothing is written to the database. The record flips to
 * `exited` on the child's `close`, not its `exit` — the two are not ordered
 * against each other, and marking a fast command exited on `exit` alone can
 * beat its last stdout chunk into the ring.
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
  /**
   * Tell the Session the first time this appears in a line of output (VC-495).
   * Judged before anything is spawned: a pattern the host will not run is a
   * `shell.pattern` refusal.
   */
  notifyOn?: ShellNotifyPattern;
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
  ring: OutputRing;
  /** Each pipe retains its own bounded, uncut redaction/UTF-8 context. */
  stdout: NoticeOutput;
  stderr: NoticeOutput;
  /** Settles when the child exits, however it exits. */
  exited: Promise<void>;
  /** Told on every chunk, for the settle window. */
  onOutput: Set<() => void>;
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
    if (this.closing !== undefined)
      throw new ShellRefusal(
        "shell.closing",
        "The host is stopping; no new background shell can start.",
      );
    const live = this.ownedBy(owner.sessionId).filter((entry) => entry.record.state === "running");
    if (live.length >= SHELL_MAX_PER_SESSION) {
      throw new ShellRefusal(
        "shell.limit",
        `This Session already holds ${SHELL_MAX_PER_SESSION} running background shells (${live
          .map((entry) => entry.record.shellId)
          .join(", ")}): kill one with shell_kill, or reuse one.`,
      );
    }
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
    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const onOutput = new Set<() => void>();
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
      for (const listener of onOutput) listener();
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
      // only waits on OUR pipes, not a lingering process: `& disown` inside
      // the command orphans a grandchild holding our stdout open, which is
      // exactly the `&` CONTEXT.md's Background shell entry says to avoid —
      // an accepted edge, not one this host promises to resolve promptly.
      child.once("close", settle);
      // A spawn that failed after a pid was handed out (rare) ends the same way.
      child.once("error", () => settle(null, null));
    });
    const entry: ShellEntry = {
      cwd: input.cwd,
      owner,
      record,
      pid,
      child,
      ring,
      stdout,
      stderr,
      exited,
      onOutput,
      returned: false,
    };
    this.shells.set(shellId, entry);
    this.processes.add(entry);
    this.deps.publishState(this.stateOf(entry));

    await this.settle(entry);
    // Flipped in the same synchronous block that copies the record below: an
    // exit lands either before it (and is in the answer) or after (and is news).
    entry.returned = true;
    const { output } = ring.readNew();
    return { shell: { ...record }, pid, output: this.safeOutput(output) };
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
   * The attachment's end: kill every shell the Session started and forget
   * them. Fire-and-forget on the kill, because release must not wait on a
   * process that ignores SIGTERM — the SIGKILL still follows after the grace.
   *
   * A Session that has ended is told nothing (VC-495): an exit notice still
   * waiting out its grace is dropped with the shell, and the forgotten entry is
   * what keeps a match or an exit that lands later quiet.
   */
  disposeSession(sessionId: string): void {
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
