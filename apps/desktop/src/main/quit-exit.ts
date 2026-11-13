/**
 * The quit's last step, and its timeline in the log (VC-1208, VC-1207).
 *
 * `app.exit()` hands the process to Electron's teardown, and Node's part of
 * it joins every worker thread. A worker inside one long SQLite call holds
 * that join, so a quit during the launch's database check or the automatic
 * backup used to leave the process alive with no window: on a 2 GB profile
 * for hours, with the single-instance lock held and Squirrel's installer
 * waiting. Nothing JavaScript can call skips that join (`process.exit` and
 * `process.reallyExit` wait for it too), so when the only workers left are
 * read-only (`decideQuitExit` in `@volli/shared`) this ends the process with
 * SIGKILL, after it has made itself every write a normal exit leaves to that
 * teardown:
 *
 * - every browser session's cookies and DOM storage, which Chromium would
 *   write after Node's teardown, the step the join blocks;
 * - the first-paint mirror's pending write and the log's tail;
 * - the process's `exit` listeners (the perf store's close, the setup
 *   commands' process groups), which Node runs during its teardown.
 *
 * Everything the quit itself drains (Sessions, the agent socket, the runner,
 * terminals, drafts) has drained before this runs: it replaces only the call
 * that ends the quit. What it skips is the rest of Chromium's teardown (its
 * caches: preferences, network state, HSTS, the HTTP cache index) and Node's
 * cleanup hooks; committed SQLite data is on disk either way.
 *
 * An upgrade is never cut short: a quit asked during one is held, its window
 * stays up saying so, and the quit runs once the upgrade's worker has exited.
 *
 * Electron-free: `app`, the workers and the writes are ports.
 */
import { hostLogger } from "@volli/host-core/log";
import type { QuitExitDecision, QuitReasonCode } from "@volli/shared";

/** How long an exit waits for live workers to end by themselves, the ordinary way. */
const WORKER_SETTLE_GRACE_MS = 1_000;

/** The bound on the writes an immediate exit makes itself. */
const IMMEDIATE_EXIT_FLUSH_MS = 2_000;

export interface QuitExitPorts {
  /** Milliseconds, monotonic. */
  now(): number;
  /** Workers running now (`liveWorkerCount`). */
  liveWorkers(): number;
  /**
   * Ends the workers the quit may end, as Node's teardown would
   * (`endReadOnlyWorkers`): any still running after the grace is inside a
   * native call.
   */
  endReadOnlyWorkers(): number;
  /** Resolves once none run, or after `graceMs` (`settleLiveWorkers`). */
  settleWorkers(graceMs: number): Promise<void>;
  /** The rule over the live workers (`quitExitDecision`). */
  decide(options: { claim: boolean }): QuitExitDecision;
  /** The browser sessions' and the first-paint mirror's writes, made now. */
  flush(): Promise<unknown>;
  /** The log's tail, bounded. */
  flushLog(): Promise<void>;
  /** The process's `exit` listeners, as Node's teardown would run them. */
  runExitHandlers(code: number): void;
  /** Ends the process at once. */
  kill(): void;
}

/** What the quit holds while an upgrade finishes. */
export interface UpgradeQuitHold {
  /** Why the app is quitting, for the timeline. */
  reason(): QuitReasonCode;
  /** Keeps a window up that says the quit waits for the upgrade. */
  showWaiting(): void;
  /** Asks the quit again, once the upgrade's worker has exited. */
  quit(): void;
}

export interface QuitExit {
  /** The timeline's first line: once per process, with the most specific reason. */
  accepted(reason: QuitReasonCode): void;
  /** The quit's own drain is done (or its deadline passed). */
  drained(deadlineExpired: boolean): void;
  /** `app`, whose `exit` ends the process at once when only read-only workers remain. */
  exitingApp<App extends { exit(code?: number): void }>(app: App): App;
  /**
   * A `before-quit` listener's verdict: holds a quit while an upgrade runs.
   * True when it held this one.
   */
  holdForUpgrade(event: { preventDefault(): void }, hold: UpgradeQuitHold): boolean;
  /** Whether a quit has been accepted: a launch still composing must not go on past it. */
  quitting(): boolean;
}

const log = hostLogger("quit");

export function createQuitExit(ports: QuitExitPorts): QuitExit {
  let acceptedAt: number | null = null;
  let exiting = false;
  let holding = false;
  const sinceQuitMs = (): number | null =>
    acceptedAt === null ? null : Math.round(ports.now() - acceptedAt);

  const accepted = (reason: QuitReasonCode): void => {
    if (acceptedAt !== null) return;
    acceptedAt = ports.now();
    log.info("quit accepted", { reason });
  };

  const exitNow = async (code: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ports.flush().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, IMMEDIATE_EXIT_FLUSH_MS);
      }),
    ]);
    clearTimeout(timer);
    await ports.flushLog().catch(() => undefined);
    try {
      ports.runExitHandlers(code);
    } catch {
      // One listener that throws must not keep the process alive.
    }
    ports.kill();
  };

  const exit = async (app: { exit(code?: number): void }, code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (ports.liveWorkers() > 0) {
      ports.endReadOnlyWorkers();
      await ports.settleWorkers(WORKER_SETTLE_GRACE_MS);
    }
    const immediate = ports.decide({ claim: true }) === "exit-now";
    log.info("exit call", {
      mode: immediate ? "immediate" : "normal",
      liveWorkers: ports.liveWorkers(),
      sinceQuitMs: sinceQuitMs(),
    });
    if (immediate) await exitNow(code);
    else app.exit(code);
  };

  const waitForUpgrade = async (): Promise<void> => {
    while (ports.decide({ claim: false }) === "finish-upgrade-first") {
      await ports.settleWorkers(WORKER_SETTLE_GRACE_MS);
    }
  };

  return {
    accepted,
    drained(deadlineExpired) {
      log.info("shutdown drained", { durationMs: sinceQuitMs(), deadlineExpired });
    },
    exitingApp(app) {
      return new Proxy(app, {
        get(target, property, receiver) {
          if (property === "exit") {
            return (code = 0) => {
              void exit(target, code);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
    holdForUpgrade(event, hold) {
      if (ports.decide({ claim: false }) !== "finish-upgrade-first") return false;
      event.preventDefault();
      if (holding) return true;
      holding = true;
      accepted(hold.reason());
      log.info("quit waits for the database upgrade");
      hold.showWaiting();
      void waitForUpgrade().then(() => {
        holding = false;
        hold.quit();
      });
      return true;
    },
    quitting: () => acceptedAt !== null,
  };
}
