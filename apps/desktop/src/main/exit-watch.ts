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
 * So the bound cannot live in this process. At the exit call the quit starts
 * a detached `/bin/zsh` that outlives it. It is given the pid, the pid's start
 * time (read once at launch by the same script), the exit call's time and its
 * bounds, as numbers. It:
 *
 * - touches nothing if the pid's start time is not the one it was given (a
 *   reused pid, or a start time this launch could not read);
 * - polls until the process is gone, and once `graceMs` has passed since the
 *   exit call sends it SIGKILL, if it is still that same process;
 * - on SIGUSR1 (a worker started after the exit call) stops being allowed to
 *   kill and only measures;
 * - leaves the background band a throttled app would hand it
 *   (`taskpolicy -B` on itself), so its own clock is not throttled with the
 *   process it watches;
 * - ends itself in every case, at the latest `maxMs` after the exit call;
 * - writes one record, `exit-watch.json` in its working directory (the
 *   profile's), which the next launch logs and removes.
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
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { hostLogger } from "@volli/host-core/log";

/** The record's file name, in the profile directory (the watch's working directory). */
export const EXIT_WATCH_RECORD_FILE_NAME = "exit-watch.json";

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
nokill=0
trap 'nokill=1' USR1
trap '' HUP INT PIPE
same() { (( start > 0 )) && [[ $(started) == $start ]]; }
integer t gone killedAt=0
outcome=gone killed=false
taskpolicy -B -p $$ >/dev/null 2>&1
if (( start > 0 )) && kill -0 $pid 2>/dev/null && ! same && kill -0 $pid 2>/dev/null; then
  outcome=mismatch
else
  while kill -0 $pid 2>/dev/null; do
    (( t = EPOCHREALTIME * 1000 ))
    if (( t - t0 >= max )); then outcome=timeout; break; fi
    if [[ $killed == false ]] && (( nokill == 0 && t - t0 >= grace )); then
      if same; then
        kill -KILL $pid 2>/dev/null && { killed=true; killedAt=$(( t - t0 )); }
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
print -r -- "{\"v\":1,\"goneMs\":$gone,\"killed\":$killed,\"killedAtMs\":$killedAt,\"outcome\":\"$outcome\",\"graceMs\":$grace}" > exit-watch.json.$$ 2>/dev/null && mv -f exit-watch.json.$$ exit-watch.json 2>/dev/null
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
  readRecord(): Promise<string | null>;
  removeRecord(): Promise<void>;
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
  /** Starts the watch at the exit call; null on a platform without it, or when it would not start. */
  arm(): ExitWatchHandle | null;
  /** Logs the previous exit's record, if there is one, and removes it. */
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
  return {
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
      let text: string | null;
      try {
        text = await ports.readRecord();
      } catch {
        return;
      }
      if (text === null) return;
      const record = parseExitWatchRecord(text);
      if (record === null) log.warn("previous exit unreadable", { code: "bad-record" });
      else log.info("previous exit", { ...record });
      await ports.removeRecord().catch(() => undefined);
    },
  };
}

/** The real ports: `execFile` for the probe, a detached `spawn` for the watch, the profile's record file. */
export function nodeExitWatchPorts(options: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly directory: string;
}): ExitWatchPorts {
  const record = join(options.directory, EXIT_WATCH_RECORD_FILE_NAME);
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
    readRecord: async () => {
      try {
        return await readFile(record, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    removeRecord: () => rm(record, { force: true }),
  };
}
