/**
 * Drain and stop: the foreground process shell every headless daemon runs
 * its service under.
 *
 * `runService` boots the daemon, then waits for the reason it stops:
 *
 * - **SIGTERM or SIGINT**: a clean stop. A second signal exits at once.
 * - **An uncaught exception or unhandled rejection**: a throw nobody caught
 *   leaves the daemon in a state nobody chose, so it stops serving, closes
 *   what it opened, and exits non-zero for the supervisor to restart.
 * - **The deadline**: past {@link SHUTDOWN_DEADLINE_MS} from the request, a
 *   stop that has not finished is abandoned and the process exits 1.
 *
 * A stop asked for during boot waits for boot to finish, so it closes what
 * boot opened rather than exiting under an open database; the deadline
 * starts at the request, not when boot finishes.
 *
 * Exit codes: 0 after a clean stop; 1 when something failed at runtime or
 * the stop was not clean; {@link EXIT_CONFIG} for a {@link BootError}, which
 * an operator must fix and the systemd unit does not restart.
 */
import { BootError, EXIT_CONFIG } from "./boot-error";
import type { ShellLogger } from "./log";

/** Past this, a stop that has not finished is abandoned and the process exits 1. */
export const SHUTDOWN_DEADLINE_MS = 30_000;

/** What a booted daemon offers the shell: a stop that says whether it was clean. */
export interface StoppableService {
  /** Idempotent; resolves `true` when everything closed cleanly. */
  stop(reason: string): Promise<boolean>;
}

/** The parts of `process` the shell listens on and exits through. */
export interface ServiceProcess {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exit(code: number): void;
}

export interface RunServiceOptions {
  readonly logger: ShellLogger;
  /** Boots the daemon. A {@link BootError} is a refusal; any other throw a failure. */
  readonly start: () => Promise<StoppableService>;
  readonly deadlineMs?: number;
  /** `process`, by default; a test's stand-in otherwise. */
  readonly process?: ServiceProcess;
  /** `setTimeout`, by default. The deadline timer is referenced on purpose. */
  readonly setTimer?: (run: () => void, ms: number) => unknown;
}

/** Boots, serves until asked to stop, stops; resolves the exit code. */
export async function runService(options: RunServiceOptions): Promise<number> {
  const { logger } = options;
  const target: ServiceProcess = options.process ?? process;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let running: StoppableService | undefined;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  // Any failure seen before the stop completes makes the exit non-zero, even
  // when the stop itself was clean and was asked for by a signal first.
  let failed = false;
  let stopRequested = false;
  let stopReason = "";
  let stopping = false;
  /** Exits now, from anywhere: boot may be stuck on I/O that never returns. */
  const forceExit = (msg: string, fields: Record<string, unknown>): void => {
    logger.error(msg, fields);
    target.exit(1);
  };
  const beginStop = (): void => {
    if (running === undefined || stopping) return;
    stopping = true;
    void running.stop(stopReason).then(
      (clean) => finish(clean && !failed ? 0 : 1),
      (error: unknown) => {
        logger.error("shutdown failed", { error });
        finish(1);
      },
    );
  };
  const requestStop = (why: string, failure: boolean): void => {
    if (failure) failed = true;
    if (stopRequested) return;
    stopRequested = true;
    stopReason = why;
    // Referenced on purpose: a boot stuck on a promise with no I/O behind it
    // would otherwise let the event loop drain and exit 0.
    setTimer(() => forceExit("shutdown deadline passed; exiting", { deadlineMs }), deadlineMs);
    beginStop();
  };
  let signalled = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    target.on(signal, () => {
      if (signalled) {
        forceExit("second signal; exiting without waiting", { signal });
        return;
      }
      signalled = true;
      requestStop(signal, false);
    });
  }
  target.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error, stack: error.stack });
    requestStop("uncaught exception", true);
  });
  target.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { error: reason });
    requestStop("unhandled rejection", true);
  });

  try {
    running = await options.start();
  } catch (error) {
    if (error instanceof BootError) {
      logger.error(error.message, { reason: error.reason, ...error.fields });
      return EXIT_CONFIG;
    }
    logger.error("boot failed", { error, stack: (error as Error).stack });
    return 1;
  }
  if (stopRequested) beginStop();
  return finished;
}

/** Whether every execution in `inflight` settled within `timeoutMs`. */
export async function drain(
  inflight: ReadonlySet<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  if (inflight.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(inflight).then(() => true as const);
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
