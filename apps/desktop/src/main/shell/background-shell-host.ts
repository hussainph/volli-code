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
 * WHAT ENDS IT. A kill is SIGTERM to the group, then SIGKILL after
 * {@link SHELL_KILL_GRACE_MS}. {@link disposeSession} is the attachment's end
 * — stop, done, detach, replace, relaunch, all through the adapter's one
 * release path — and kills every shell the Session started and forgets them.
 * Shells are live resources, not ledger facts: nothing here survives a
 * relaunch, and nothing is written to the database.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { ShellRefusal, SHELL_MAX_PER_SESSION } from "@volli/agent-runtime";
import type { RuntimeShellRecord } from "@volli/shared";

import type { BackgroundShellState } from "../../ipc/contract";

/** Bytes retained per shell — the PTY peek's own bound (`pty/output.ts`). */
export const SHELL_OUTPUT_MAX_BYTES = 256_000;
/** The most a `tail` read hands back, whatever the caller asked for. */
export const SHELL_TAIL_MAX_BYTES = 64_000;
/** How long a start waits for first output before answering. */
export const SHELL_START_SETTLE_MS = 1_000;
/** How long SIGTERM gets before SIGKILL. */
export const SHELL_KILL_GRACE_MS = 5_000;

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
}

export interface BackgroundShellHostDependencies {
  /** The renderer's feed: a whole snapshot on every change of state. */
  publishState(state: BackgroundShellState): void;
  /** The renderer's feed: a shell the host forgot. */
  publishRemoved(shellId: string): void;
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

  /** The whole retained output, for a person's read; moves nothing. */
  all(): string {
    return this.slice(0);
  }

  private slice(offsetInRetained: number): string {
    return Buffer.concat(this.#chunks).subarray(offsetInRetained).toString("utf8");
  }
}

interface ShellEntry {
  owner: BackgroundShellOwner;
  record: RuntimeShellRecord;
  pid: number;
  child: ChildProcess;
  ring: OutputRing;
  /** Settles when the child exits, however it exits. */
  exited: Promise<void>;
  /** Told on every chunk, for the settle window. */
  onOutput: Set<() => void>;
}

export class BackgroundShellHost {
  private readonly shells = new Map<string, ShellEntry>();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly killGraceMs: number;
  private readonly outputMaxBytes: number;
  private readonly tailMaxBytes: number;

  constructor(private readonly deps: BackgroundShellHostDependencies) {
    this.createId = deps.createId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.settleMs = deps.settleMs ?? SHELL_START_SETTLE_MS;
    this.killGraceMs = deps.killGraceMs ?? SHELL_KILL_GRACE_MS;
    this.outputMaxBytes = deps.outputMaxBytes ?? SHELL_OUTPUT_MAX_BYTES;
    this.tailMaxBytes = deps.tailMaxBytes ?? SHELL_TAIL_MAX_BYTES;
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
    const live = this.ownedBy(owner.sessionId).filter((entry) => entry.record.state === "running");
    if (live.length >= SHELL_MAX_PER_SESSION) {
      throw new ShellRefusal(
        "shell.limit",
        `This Session already holds ${SHELL_MAX_PER_SESSION} running background shells (${live
          .map((entry) => entry.record.shellId)
          .join(", ")}): kill one with shell_kill, or reuse one.`,
      );
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
    const record: RuntimeShellRecord = {
      shellId,
      command: input.command,
      title: input.title,
      state: "running",
      code: null,
      signal: null,
      startedAt: this.now(),
      exitedAt: null,
    };
    const ring = new OutputRing(this.outputMaxBytes);
    const onOutput = new Set<() => void>();
    const receive = (chunk: Buffer): void => {
      ring.append(chunk);
      for (const listener of onOutput) listener();
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    const exited = new Promise<void>((resolve) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (record.state === "exited") return;
        record.state = "exited";
        record.code = code;
        record.signal = signal;
        record.exitedAt = this.now();
        if (this.shells.has(shellId)) this.deps.publishState(this.stateOf(entry));
        resolve();
      };
      child.once("exit", settle);
      // A spawn that failed after a pid was handed out (rare) ends the same way.
      child.once("error", () => settle(null, null));
    });
    const entry: ShellEntry = { owner, record, pid, child, ring, exited, onOutput };
    this.shells.set(shellId, entry);
    this.deps.publishState(this.stateOf(entry));

    await this.settle(entry);
    const { output } = ring.readNew();
    return { shell: { ...record }, pid, output };
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
    const read =
      tail === undefined
        ? entry.ring.readNew()
        : entry.ring.readTail(Math.max(0, Math.min(Math.floor(tail), this.tailMaxBytes)));
    return { shell: { ...entry.record }, ...read };
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

  // ---- the renderer's doors: every shell, unscoped by Session -------------

  listAll(): BackgroundShellState[] {
    return [...this.shells.values()].map((entry) => this.stateOf(entry));
  }

  /** The whole retained output for a person's read; moves no cursor. */
  tailOf(shellId: string): { output: string; shell: BackgroundShellState } | null {
    const entry = this.shells.get(shellId);
    if (entry === undefined) return null;
    return { output: entry.ring.all(), shell: this.stateOf(entry) };
  }

  /** A person's kill: a no-op on a shell that has exited or is unknown, not a refusal. */
  async killAny(shellId: string): Promise<void> {
    const entry = this.shells.get(shellId);
    if (entry === undefined) return;
    await this.terminate(entry);
  }

  /**
   * The attachment's end: kill every shell the Session started and forget
   * them. Fire-and-forget on the kill, because release must not wait on a
   * process that ignores SIGTERM — the SIGKILL still follows after the grace.
   */
  disposeSession(sessionId: string): void {
    for (const entry of this.ownedBy(sessionId)) {
      this.shells.delete(entry.record.shellId);
      void this.terminate(entry);
      this.deps.publishRemoved(entry.record.shellId);
    }
  }
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
