/**
 * The exit watch (VC-652): a bound on how long the process lives after an
 * ordinary exit, and a record of how long it did.
 *
 * After `app.exit()`, Electron's own teardown can keep the process alive with
 * no window for seconds, or for as long as the machine stays loaded. Chromium
 * waits up to 10 s for its network service to exit, then waits with no bound
 * for thread-pool work that runs at background priority (the BTM/DIPS and
 * performance-observer databases' first open), which macOS barely schedules
 * while other work fills every core. Nothing of Volli's is still running by
 * then, and no JavaScript can run: Node has been torn down (closing the
 * host's SQLite connections) before either wait. Squirrel's installer waits
 * for the process to end, so an update waits with it.
 *
 * So the bound cannot live in this process. In the same tick as the real
 * `app.exit` the quit starts a detached `/bin/zsh` that outlives it. It is
 * given the pid, the pid's start time (read once at launch by the same
 * script), the exit's time and its bounds, as numbers. It:
 *
 * - touches nothing if the pid's start time is not the one it was given (a
 *   reused pid, or a start time this launch could not read);
 * - polls until the process is gone, and once `graceMs` has passed since the
 *   exit, by the wall clock AND by its own running sum of the time between
 *   polls, each step counted at most ten polls long (a system sleep or a clock
 *   step after the exit is not time the process had: it adds at most one
 *   such step), sends it SIGKILL if it is still that same process;
 * - on SIGUSR1 (a worker started after the exit) stops being allowed to
 *   kill and only measures; the disarm is the last thing looked at before the
 *   kill;
 * - leaves the background band a throttled app would hand it
 *   (`taskpolicy -B` on itself), so its own clock is not throttled with the
 *   process it watches;
 * - ends itself in every case: at the latest once it has itself run `maxMs`
 *   by that same sum (a laptop asleep for hours does not end it before the
 *   process it watches gets the time to linger), with 24 h of wall clock as
 *   the backstop; durations it records are never negative (a backwards clock
 *   step);
 * - writes one record, `exit-watch-<pid>.json` in its working directory (the
 *   profile's), through a temporary file it removes if the rename fails. A
 *   later launch logs and removes the records of pids that are gone, so a
 *   relaunch that starts while the old process lingers never reads a watch
 *   still running, or credits one launch's record to another.
 *
 * The quit's own log is written before the watch starts, so it cannot say
 * how arming went: the exit line says `watch: 'arming'`, and the quit leaves
 * `exit-watch-<pid>.pending` (written synchronously, in the tick of the exit)
 * saying whether the watch started. A later launch reads it with the record:
 * a record wins; a pending note without one is logged as `spawn-failed`,
 * `not-armed` (a worker started while the log was written) or `no-record`
 * (the watch started but wrote nothing). The log is never wrong about it.
 *
 * It runs only for an exit with no worker running (`quit-exit.ts` arms it
 * after that decision), so the cases VC-1208 handles keep their own rules and
 * an upgrade is never cut short. The quit writes the browser sessions' storage
 * itself before every such exit, as an immediate exit does, so a kill skips
 * only Chromium's own teardown (its caches and metrics).
 *
 * The script is fixed text, run with `zsh -f -c` (no rc files, no file in the
 * app bundle to hold open), with an environment of `LC_ALL=C` and a system
 * `PATH` only. macOS only: elsewhere nothing is started and the record is
 * never written.
 *
 * Electron-free: `createExitWatch` takes the spawn and the files as ports;
 * `nodeExitWatchPorts` are the real ones.
 */
import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { hostLogger } from "@volli/host-core/log";

/** A watched pid's record file name, in the profile directory (the watch's working directory). */
export function exitWatchRecordFileName(pid: number): string {
  return `exit-watch-${pid}.json`;
}

/** A pid's pending note: written by the quit when it armed (or could not arm) the watch. */
export function exitWatchPendingFileName(pid: number): string {
  return `exit-watch-${pid}.pending`;
}

/** The pid a record (or pending note) file name is for, or null when the name is neither. */
export function exitWatchRecordPid(fileName: string): number | null {
  const match = /^exit-watch-(\d{1,10})\.(?:json|pending)$/.exec(fileName);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** How long after the exit call a process that is still alive is ended. */
export const EXIT_WATCH_GRACE_MS = 5_000;
/** The watch's own life, at most, counted from the exit call. */
export const EXIT_WATCH_MAX_MS = 120_000;
/** How often the watch looks. */
export const EXIT_WATCH_POLL_MS = 50;
/** How long the launch's start-time read may take. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * The watch. `$1` is the mode: `probe <pid>` prints the pid's start time
 * (epoch seconds, from `ps`'s `lstart` in the C locale), `watch <pid> <start>
 * <exitCallAtMs> <graceMs> <maxMs> <pollMs>` watches. Anything else, or any
 * argument that is not a plain number, ends it at once. A start of 0 means
 * unknown: it then measures and never kills.
 *
 * Fixed text: never built from input. Its record carries numbers and fixed
 * words only.
 */
export const EXIT_WATCH_SCRIPT = String.raw`zmodload zsh/datetime zsh/zselect 2>/dev/null || exit 0
[[ $# -ge 2 && $2 == <1-> ]] || exit 0
pid=$2
started() {
  local s e
  s=$(ps -o lstart= -p $pid 2>/dev/null) || return 1
  set -- $=s
  s="$*"
  [[ -n $s ]] || return 1
  strftime -r -s e '%a %b %e %H:%M:%S %Y' "$s" 2>/dev/null || return 1
  print -r -- $e
}
if [[ $1 == probe && $# -eq 2 ]]; then started; exit 0; fi
[[ $1 == watch && $# -eq 7 && $3 == <-> && $4 == <1-> && $5 == <1-> && $6 == <1-> && $7 == <1-> ]] || exit 0
start=$3 t0=$4 grace=$5 max=$6 poll=$7
(( poll < 10 )) && poll=10
integer step=$(( poll * 10 ))
nokill=0
trap 'nokill=1' USR1
trap '' HUP INT PIPE
same() { (( start > 0 )) && [[ $(started) == $start ]]; }
integer t gone killedAt=0 slept=0 dt prev=t0
outcome=gone killed=false
taskpolicy -B -p $$ >/dev/null 2>&1
if (( start > 0 )) && kill -0 $pid 2>/dev/null && ! same && kill -0 $pid 2>/dev/null; then
  outcome=mismatch
else
  while kill -0 $pid 2>/dev/null; do
    (( t = EPOCHREALTIME * 1000 ))
    (( dt = t - prev, prev = t ))
    (( dt < 0 )) && dt=0
    (( dt > step )) && dt=step
    (( slept += dt ))
    if (( slept >= max || t - t0 >= 86400000 )); then outcome=timeout; break; fi
    if [[ $killed == false ]] && (( t - t0 >= grace && slept >= grace )); then
      if same; then
        if (( nokill == 0 )); then
          kill -KILL $pid 2>/dev/null && { killed=true; (( killedAt = t - t0 < 0 ? 0 : t - t0 )); }
        fi
      elif (( start > 0 )) && kill -0 $pid 2>/dev/null; then
        outcome=mismatch; break
      fi
    fi
    zselect -t $(( poll / 10 )) 2>/dev/null
  done
fi
[[ $killed == true && $outcome == gone ]] && outcome=killed
(( nokill == 1 )) && [[ $outcome == gone ]] && outcome=disarmed
(( gone = EPOCHREALTIME * 1000 - t0 ))
(( gone < 0 )) && gone=0
record=exit-watch-$pid.json
print -r -- "{\"v\":1,\"goneMs\":$gone,\"killed\":$killed,\"killedAtMs\":$killedAt,\"outcome\":\"$outcome\",\"graceMs\":$grace}" > $record.$$ 2>/dev/null && mv -f $record.$$ $record 2>/dev/null || rm -f $record.$$ 2>/dev/null
exit 0
`;

/** What a watch's record says, as the next launch logs it. */
export type ExitWatchOutcome =
  /** The process ended by itself. */
  | "gone"
  /** It was still alive at the grace and was ended. */
  | "killed"
  /** A worker started after the exit call; it only measured. */
  | "disarmed"
  /** The pid no longer named this process: nothing was touched. */
  | "mismatch"
  /** Still alive at the watch's own bound (it could not end it). */
  | "timeout";

export interface ExitWatchRecord {
  /** From the exit call until the process was gone (or, for `timeout`/`mismatch`, until the watch stopped). */
  readonly goneMs: number;
  readonly killed: boolean;
  /** When the kill was sent, from the exit call; 0 when none was. A process dies some time after. */
  readonly killedAtMs: number;
  readonly outcome: ExitWatchOutcome;
  readonly graceMs: number;
}

const OUTCOMES: ReadonlySet<string> = new Set<ExitWatchOutcome>([
  "gone",
  "killed",
  "disarmed",
  "mismatch",
  "timeout",
]);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The record the watch wrote, or null when it is missing or not one. */
export function parseExitWatchRecord(text: string): ExitWatchRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["v"] !== 1) return null;
  const { goneMs, killed, killedAtMs, outcome, graceMs } = record;
  if (!isCount(goneMs) || !isCount(graceMs) || !isCount(killedAtMs)) return null;
  if (typeof killed !== "boolean") return null;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  return { goneMs, killed, killedAtMs, outcome: outcome as ExitWatchOutcome, graceMs };
}

/** What the quit leaves about arming, before the watch's record exists. */
type PendingNote = { armed: true } | { armed: false; reason: "spawn-failed" | "worker-started" };

/**
 * A previous exit with a pending note and no record: the watch did not start
 * (`spawn-failed`), the quit chose not to arm it (`not-armed`), or it started
 * and wrote nothing (`no-record`).
 */
export function unrecordedOutcome(pending: string): "spawn-failed" | "not-armed" | "no-record" {
  let value: unknown;
  try {
    value = JSON.parse(pending);
  } catch {
    return "no-record";
  }
  const note = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (note["armed"] === false && note["reason"] === "spawn-failed") return "spawn-failed";
  if (note["armed"] === false && note["reason"] === "worker-started") return "not-armed";
  return "no-record";
}

export interface ExitWatchArgs {
  readonly pid: number;
  /** The pid's start time, epoch seconds as the probe read it; 0 when unknown. */
  readonly startedAt: number;
  /** The exit call, epoch milliseconds. */
  readonly exitCallAtMs: number;
  readonly graceMs: number;
  readonly maxMs: number;
  readonly pollMs: number;
}

/** The watch's argv after `-c <script>` (`$0` first): numbers only, or null if one is not. */
export function exitWatchArgv(args: ExitWatchArgs): string[] | null {
  const positive = [args.pid, args.exitCallAtMs, args.graceMs, args.maxMs, args.pollMs];
  if (!positive.every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  if (!Number.isSafeInteger(args.startedAt) || args.startedAt < 0) return null;
  return [
    "volli-exit-watch",
    "watch",
    String(args.pid),
    String(args.startedAt),
    String(args.exitCallAtMs),
    String(args.graceMs),
    String(args.maxMs),
    String(args.pollMs),
  ];
}

/** The start-time probe's argv after `-c <script>`. */
export function exitWatchProbeArgv(pid: number): string[] | null {
  return Number.isSafeInteger(pid) && pid > 0 ? ["volli-exit-watch", "probe", String(pid)] : null;
}

/** The probe's answer: epoch seconds, or 0 when it gave none. */
export function parseProbeOutput(output: string): number {
  const text = output.trim();
  if (!/^\d{1,12}$/.test(text)) return 0;
  return Number(text);
}

/** A started watch. */
export interface ExitWatchHandle {
  /** From now on it only measures: it never kills. */
  disarm(): void;
}

/** The one shell the watch runs in, and its fixed environment. */
export const EXIT_WATCH_SHELL = "/bin/zsh";
export const EXIT_WATCH_ENV: Readonly<Record<string, string>> = {
  LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};

export interface ExitWatchPorts {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  /** Epoch milliseconds. */
  now(): number;
  /** The profile directory: the watch's working directory and the record's home. */
  readonly directory: string;
  /** Runs the probe; resolves with its stdout. */
  probe(shell: string, argv: readonly string[], options: ProbeOptions): Promise<string>;
  /** Starts the watch detached, stdio ignored, and returns a way to signal it. */
  spawn(shell: string, argv: readonly string[], options: SpawnOptions): { signal(): void } | null;
  /** The pids the profile holds records or pending notes for. */
  listRecords(): Promise<number[]>;
  readRecord(pid: number): Promise<string | null>;
  readPending(pid: number): Promise<string | null>;
  /** Removes a pid's record and pending note. */
  removeRecord(pid: number): Promise<void>;
  /** Writes a pid's pending note now, synchronously: it runs in the tick of the exit. */
  writePending(pid: number, text: string): void;
  /** Whether `pid` is running (a watch may still be watching it). */
  isAlive(pid: number): boolean;
}

export interface ProbeOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ExitWatch {
  /** Reads this process's start time for later; call once at launch. */
  probe(): Promise<void>;
  /** Whether this platform has the watch. */
  available(): boolean;
  /**
   * Starts the watch, its grace counted from now, and leaves the pending note
   * saying whether it started; null on a platform without it, or when it did
   * not start.
   */
  arm(): ExitWatchHandle | null;
  /** Leaves the pending note for an exit the quit chose not to watch. */
  skipped(reason: "worker-started"): void;
  /** Logs each previous exit's record (or pending note) of a pid that is gone, and removes them. */
  logPreviousExit(): Promise<void>;
}

const log = hostLogger("quit");

/** How long the watch gives the process, its own bound, and how often it looks. */
export interface ExitWatchBounds {
  readonly graceMs: number;
  readonly maxMs: number;
  readonly pollMs: number;
}

const DEFAULT_BOUNDS: ExitWatchBounds = {
  graceMs: EXIT_WATCH_GRACE_MS,
  maxMs: EXIT_WATCH_MAX_MS,
  pollMs: EXIT_WATCH_POLL_MS,
};

export function createExitWatch(
  ports: ExitWatchPorts,
  bounds: ExitWatchBounds = DEFAULT_BOUNDS,
): ExitWatch {
  const supported = ports.platform === "darwin";
  let startedAt = 0;
  /** The pending note: fixed words only. A failed write only loses the note. */
  const note = (pending: PendingNote): void => {
    try {
      ports.writePending(ports.pid, JSON.stringify({ v: 1, ...pending }));
    } catch {
      // The record, if the watch writes one, still says what happened.
    }
  };
  return {
    available: () => supported,
    skipped(reason) {
      if (supported) note({ armed: false, reason });
    },
    async probe() {
      if (!supported) return;
      const argv = exitWatchProbeArgv(ports.pid);
      if (argv === null) return;
      try {
        const output = await ports.probe(
          EXIT_WATCH_SHELL,
          ["-f", "-c", EXIT_WATCH_SCRIPT, ...argv],
          {
            cwd: ports.directory,
            env: EXIT_WATCH_ENV,
            timeoutMs: PROBE_TIMEOUT_MS,
          },
        );
        startedAt = parseProbeOutput(output);
      } catch {
        startedAt = 0;
      }
      if (startedAt === 0) log.info("exit watch start unknown", { code: "probe-failed" });
    },
    arm() {
      if (!supported) return null;
      const argv = exitWatchArgv({
        pid: ports.pid,
        startedAt,
        exitCallAtMs: Math.round(ports.now()),
        ...bounds,
      });
      if (argv === null) return null;
      let child: { signal(): void } | null = null;
      try {
        child = ports.spawn(EXIT_WATCH_SHELL, ["-f", "-c", EXIT_WATCH_SCRIPT, ...argv], {
          cwd: ports.directory,
          env: EXIT_WATCH_ENV,
        });
      } catch {
        child = null;
      }
      note(child === null ? { armed: false, reason: "spawn-failed" } : { armed: true });
      if (child === null) return null;
      const started = child;
      return {
        disarm() {
          try {
            started.signal();
          } catch {
            // Already gone: nothing left to disarm.
          }
        },
      };
    },
    async logPreviousExit() {
      if (!supported) return;
      let pids: number[];
      try {
        pids = await ports.listRecords();
      } catch {
        return;
      }
      // A pid still running may still be watched: its record is a later launch's to read.
      for (const pid of new Set(pids)) {
        if (pid === ports.pid || ports.isAlive(pid)) continue;
        let text: string | null;
        let pending: string | null;
        try {
          [text, pending] = await Promise.all([ports.readRecord(pid), ports.readPending(pid)]);
        } catch {
          continue;
        }
        if (text !== null) {
          const record = parseExitWatchRecord(text);
          if (record === null) log.warn("previous exit unreadable", { code: "bad-record" });
          else log.info("previous exit", { ...record });
        } else if (pending !== null) {
          // No record: the note says why, so the log never claims a watch that did not run.
          log.info("previous exit", { outcome: unrecordedOutcome(pending) });
        }
        await ports.removeRecord(pid).catch(() => undefined);
      }
    },
  };
}

/** The real ports: `execFile` for the probe, a detached `spawn` for the watch, the profile's record file. */
export function nodeExitWatchPorts(options: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly directory: string;
}): ExitWatchPorts {
  const record = (pid: number) => join(options.directory, exitWatchRecordFileName(pid));
  const pending = (pid: number) => join(options.directory, exitWatchPendingFileName(pid));
  return {
    ...options,
    now: () => Date.now(),
    probe: (shell, argv, probeOptions) =>
      new Promise((resolve, reject) => {
        execFile(
          shell,
          [...argv],
          {
            cwd: probeOptions.cwd,
            env: { ...probeOptions.env },
            timeout: probeOptions.timeoutMs,
            encoding: "utf8",
          },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
      }),
    spawn: (shell, argv, spawnOptions) => {
      // Its own session, no stdio: it outlives this process and holds nothing of it.
      const child = spawn(shell, [...argv], {
        cwd: spawnOptions.cwd,
        env: { ...spawnOptions.env },
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
      if (child.pid === undefined) return null;
      return {
        signal: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGUSR1");
        },
      };
    },
    listRecords: async () =>
      (await readdir(options.directory))
        .map((name) => exitWatchRecordPid(name))
        .filter((pid): pid is number => pid !== null),
    readRecord: (pid) => readIfPresent(record(pid)),
    readPending: (pid) => readIfPresent(pending(pid)),
    removeRecord: async (pid) => {
      await Promise.all([rm(record(pid), { force: true }), rm(pending(pid), { force: true })]);
    },
    writePending: (pid, text) => writeFileSync(pending(pid), text),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: a process of another user holds the pid; it is not ours, and not gone.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
