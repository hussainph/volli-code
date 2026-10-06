/**
 * The desktop's structured log (VC-699): where Electron main, the in-process
 * host (host-core) and the renderer's forwarded warnings write.
 *
 * - **On disk**, rotating JSON lines under the profile's own log directory,
 *   `<userData>/logs` (`volli-YYYY-MM-DD.jsonl`; a dev profile's userData is
 *   its own, so is its log). Defaults: 10 MiB a file, 7 days, 100 MiB in all
 *   (`LOG_FILE_POLICY`).
 * - **In the terminal** too in a dev build, as readable lines.
 * - **Levels:** `VOLLI_LOG_LEVEL` when set; otherwise `debug` in a dev build
 *   (every hop, for the end-to-end view) and `info` in a packaged one.
 *
 * Nothing here is visible to a person using the app: no window, no setting.
 */
import { join } from "node:path";

import {
  consoleSink,
  createLogRing,
  createRotatingFileSink,
  hostLogger,
  installHostLog,
  reportToStderr,
  teeSinks,
  type LogRing,
  type LogSink,
  type RotatingFileSink,
} from "@volli/host-core/log";
import { logLevelFrom, type LogLevel } from "@volli/shared";

export interface DesktopLog {
  /** Where the files are. */
  readonly directory: string;
  readonly level: LogLevel;
  readonly file: RotatingFileSink;
  /**
   * The recent lines in memory (bounded: `LOG_RING_BOUNDS`), which the
   * handler map's `logs.*` read: the dev log viewer's local stream.
   */
  readonly ring: LogRing;
  /** Resolves once every line so far reached the disk, or after `deadlineMs`, whichever is first. */
  flush(deadlineMs?: number): Promise<void>;
  /** Uninstalls and closes the file. */
  close(): Promise<void>;
}

export interface DesktopLogOptions {
  readonly userData: string;
  readonly dev: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** More destinations beside the file (the in-memory ring the log viewer reads). */
  readonly sinks?: readonly LogSink[];
  /** The terminal, in a dev build. */
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Whether lines also go to the terminal. Defaults to `dev`. */
  readonly terminal?: boolean;
}

/** The profile's log directory. */
export function desktopLogDirectory(userData: string): string {
  return join(userData, "logs");
}

/** Installs the desktop's log root: every host logger writes here from now on. */
export function startDesktopLog(options: DesktopLogOptions): DesktopLog {
  const directory = desktopLogDirectory(options.userData);
  // Never fatal (VC-699): a directory that cannot be made, a file that cannot
  // be opened or a full disk stops the file, once, said on stderr and to the
  // other destinations; the app starts and runs regardless.
  const file = createRotatingFileSink({
    directory,
    onFailure: (failure) => {
      reportToStderr(failure);
      hostLogger("log").warn("log file disabled: lines are dropped from here on", {
        stage: failure.stage,
        code: failure.code,
      });
    },
  });
  const level = logLevelFrom(options.env["VOLLI_LOG_LEVEL"], options.dev ? "debug" : "info");
  const ring = createLogRing();
  const sinks: LogSink[] = [file, ring, ...(options.sinks ?? [])];
  if (options.terminal ?? options.dev) sinks.push(consoleSink(options.console));
  const undo = installHostLog({ level, sink: teeSinks(...sinks) });
  return {
    directory,
    level,
    file,
    ring,
    flush: (deadlineMs = 500) =>
      Promise.race([
        file.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, deadlineMs).unref()),
      ]),
    async close() {
      undo();
      await file.close();
    },
  };
}

/**
 * `app` with an `exit` that writes the log's tail first (bounded): Electron's
 * `app.exit` ends the process at once, and the lines a quit just wrote are
 * the ones a person reading the log wants most.
 */
export function exitAfterLogFlush<App extends { exit(code?: number): void }>(
  app: App,
  log: Pick<DesktopLog, "flush">,
): App {
  return new Proxy(app, {
    get(target, property, receiver) {
      if (property === "exit") {
        return (code?: number) => {
          void log.flush().finally(() => target.exit(code));
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** The power transitions a lid close and reopen make, and what this log calls them. */
const POWER_EVENTS = {
  suspend: "system sleeping",
  resume: "system woke",
  "lock-screen": "screen locked",
  "unlock-screen": "screen unlocked",
} as const;

/**
 * One line per power transition (component `power`), each with its reason:
 * a lid closed and reopened reads as `suspend` then `resume`, which is when
 * every host link probes or reconnects.
 */
export function logPowerTransitions(power: {
  on(event: keyof typeof POWER_EVENTS, listener: () => void): unknown;
}): void {
  const log = hostLogger("power");
  for (const [event, msg] of Object.entries(POWER_EVENTS) as [
    keyof typeof POWER_EVENTS,
    string,
  ][]) {
    power.on(event, () => log.info(msg, { reason: event }));
  }
}
