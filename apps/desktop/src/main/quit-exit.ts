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
 * SIGKILL, after it has made itself the writes a normal exit leaves to that
 * teardown:
 *
 * - every browser session's cookies (`cookies.flushStore()`, awaited) and DOM
 *   storage (`flushStorageData()`, which returns before the write lands: it
 *   is followed by the cookie round trip and a short wait, and is
 *   best-effort; measured on Electron 44.9.3, a localStorage value set just
 *   before survived 10 of 10 kills made this way, and 0 of 8 made at once
 *   after the call);
 * - the first-paint mirror's pending write;
 * - the process's `exit` listeners (the perf store's close, the setup
 *   commands' process groups), which Node runs during its teardown, then the
 *   log's tail, so what those listeners log is kept.
 *
 * Windows and IPC stay alive until the kill, so the decision is asked again
 * after every wait, the last time in the same tick as the kill; any answer
 * but "exit now" falls back to the ordinary `app.exit`.
 *
 * It replaces only the call that ends the quit: the quit's drain (Sessions,
 * the agent socket, the runner, terminals, drafts) runs first, as before, and
 * as before an exit after the drain's 15 s deadline comes part-way through it
 * (the `exit call` line says `afterDeadline`). What the kill skips: the rest
 * of Chromium's teardown (pending Preferences and Local State writes, network
 * state and HSTS, the HTTP cache index), the windows' `closed` handlers (the
 * Browser Tabs' `closeAll`: in-memory tab registry, an IPC event and hold
 * notices, nothing on disk), and Node's cleanup hooks (better-sqlite3's close,
 * so the host's connection is not checkpointed; committed data is on disk).
 *
 * An upgrade is never cut short: a quit asked during one is held, its window
 * stays up saying so, and the quit runs once the upgrade's worker has exited.
 *
 * The ordinary exit, with no worker running (VC-652), is bounded too:
 * Electron's own teardown can outlive the exit by minutes on a loaded Mac, and
 * the exit watch (`exit-watch.ts`) ends the process 5 s after the real
 * `app.exit`. Before it is armed, the quit does itself everything a kill in
 * that teardown would skip and the next launch could notice: the same writes
 * as an immediate exit (same bound), the setup commands' process groups and
 * the perf store's buffer (`stopChildren`), then the log's tail. Then, in one
 * tick with the last count of zero workers, it arms the watch and calls the
 * real `app.exit`, so the 5 s measure Electron's native shutdown only, never
 * JavaScript of ours. The watch is never started while a worker runs, and a
 * worker that starts after it disarms it, so the worker rules above stay the
 * only ones that apply to a live worker.
 *
 * Every exit writes the log's tail before `app.exit` (bounded): the lines a
 * quit just wrote are the ones a person reading the log wants most.
 *
 * Electron-free: `app`, the workers and the writes are ports.
 */
import { hostLogger } from "@volli/host-core/log";
import type { QuitExitDecision, QuitReasonCode } from "@volli/shared";

/** How long an exit waits for live workers to end by themselves, the ordinary way. */
const WORKER_SETTLE_GRACE_MS = 1_000;

/** The bound on the writes an exit makes itself (immediate, or ordinary with no worker). */
const IMMEDIATE_EXIT_FLUSH_MS = 2_000;

/**
 * The bound on stopping children before a watched exit: a stdio MCP server
 * that ignores SIGTERM gets SIGKILL within it (`stopMcpServerProcessGroups`).
 */
const CHILDREN_STOP_MS = 1_000;

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
  /**
   * Stops, before a watched exit, what Node's teardown would otherwise stop
   * (the setup commands' and the stdio MCP servers' process groups) and
   * writes what it would write (the perf store's buffer): a kill can land
   * before that teardown runs. Bounded like the writes.
   */
  stopChildren(): Promise<unknown> | void;
  /** Whether this platform has the exit watch (it is armed only after the log is written). */
  watchAvailable(): boolean;
  /**
   * Starts the exit watch, its grace counted from now; null when it did not
   * start (the spawn failed). Either way it leaves a note the next launch
   * reads, as the quit's log is already written.
   */
  watchExit(): { disarm(): void } | null;
  /** Leaves the next launch a note that this exit was not watched, and why. */
  watchSkipped(reason: "worker-started"): void;
  /** Calls `listener` whenever a worker starts from now on; returns the unsubscribe. */
  onWorkerStarted(listener: () => void): () => void;
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

/** Waits for `work`, at most `limitMs`; its failure, thrown or rejected, is ignored. */
const bounded = async (
  work: () => Promise<unknown> | void,
  limitMs = IMMEDIATE_EXIT_FLUSH_MS,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => work())().catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, limitMs);
    }),
  ]);
  clearTimeout(timer);
};

export function createQuitExit(ports: QuitExitPorts): QuitExit {
  let acceptedAt: number | null = null;
  let deadlineExpired = false;
  let exiting = false;
  let holding = false;
  const sinceQuitMs = (): number | null =>
    acceptedAt === null ? null : Math.round(ports.now() - acceptedAt);

  const accepted = (reason: QuitReasonCode): void => {
    if (acceptedAt !== null) return;
    acceptedAt = ports.now();
    log.info("quit accepted", { reason });
  };

  /** The exit's line: how it ends, what still runs, and whether the drain ran out of time. */
  const exitLine = (
    mode: "immediate" | "normal",
    changed: boolean,
    watch?: "arming" | "unavailable",
  ): void => {
    log.info("exit call", {
      mode,
      liveWorkers: ports.liveWorkers(),
      sinceQuitMs: sinceQuitMs(),
      afterDeadline: deadlineExpired,
      ...(changed ? { changed: true } : {}),
      ...(watch === undefined ? {} : { watch }),
    });
  };

  /** The writes a normal exit leaves to the teardown, made now, bounded. */
  const flushBounded = (): Promise<void> => bounded(() => ports.flush());

  /**
   * Windows and IPC are still alive until the process ends, so a worker
   * may start while this waits: every step that awaits is followed by
   * asking again, and the last answer comes in the same tick as the kill.
   */
  const stillExitNow = (): boolean => ports.decide({ claim: true }) === "exit-now";

  /** The ordinary exit, unwatched: the log's tail first, as every exit. */
  const plainExit = async (app: { exit(code?: number): void }, code: number): Promise<void> => {
    await ports.flushLog().catch(() => undefined);
    app.exit(code);
  };

  const exitNow = async (app: { exit(code?: number): void }, code: number): Promise<void> => {
    await flushBounded();
    if (!stillExitNow()) {
      exitLine("normal", true);
      await plainExit(app, code);
      return;
    }
    exitLine("immediate", false);
    // The exit listeners first, then the log: anything they log is kept.
    try {
      ports.runExitHandlers(code);
    } catch {
      // One listener that throws must not keep the process alive.
    }
    await ports.flushLog().catch(() => undefined);
    // No JavaScript runs between this answer and the kill.
    if (!stillExitNow()) {
      exitLine("normal", true);
      // This exit waits for its workers as before: writing its line costs nothing.
      await plainExit(app, code);
      return;
    }
    ports.kill();
  };

  /**
   * The ordinary exit with no worker running, watched. Everything that awaits
   * comes first; the last count of zero workers, the watch and the real exit
   * share one tick, so nothing starts between them and the watch's grace is
   * Electron's native shutdown only. A worker that starts later disarms it.
   */
  const watchedExit = async (app: { exit(code?: number): void }, code: number): Promise<void> => {
    await flushBounded();
    // After the browser sessions' writes; never more than its own second.
    await bounded(() => ports.stopChildren(), CHILDREN_STOP_MS);
    // Windows and IPC are alive until the exit: a worker may have started.
    if (ports.liveWorkers() > 0) {
      exitLine("normal", true);
      await plainExit(app, code);
      return;
    }
    const armable = ports.watchAvailable();
    // How arming went cannot be in this log, which is written before it: the
    // watch's record, or the note it leaves, tells the next launch.
    exitLine("normal", false, armable ? "arming" : "unavailable");
    await ports.flushLog().catch(() => undefined);
    if (!armable) {
      app.exit(code);
      return;
    }
    if (ports.liveWorkers() > 0) {
      // Started while the log was written: exit as before, unwatched.
      ports.watchSkipped("worker-started");
      app.exit(code);
      return;
    }
    const watch = ports.watchExit();
    if (watch !== null) {
      // Nothing is logged past this point: the watch's record says `disarmed`.
      const stop = ports.onWorkerStarted(() => {
        stop();
        watch.disarm();
      });
    }
    app.exit(code);
  };

  const exit = async (app: { exit(code?: number): void }, code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (ports.liveWorkers() > 0) {
      ports.endReadOnlyWorkers();
      await ports.settleWorkers(WORKER_SETTLE_GRACE_MS);
    }
    if (stillExitNow()) {
      await exitNow(app, code);
      return;
    }
    if (ports.liveWorkers() === 0) {
      await watchedExit(app, code);
      return;
    }
    exitLine("normal", false);
    await plainExit(app, code);
  };

  const waitForUpgrade = async (): Promise<void> => {
    while (ports.decide({ claim: false }) === "finish-upgrade-first") {
      await ports.settleWorkers(WORKER_SETTLE_GRACE_MS);
    }
  };

  return {
    accepted,
    drained(expired) {
      deadlineExpired = expired;
      log.info("shutdown drained", { durationMs: sinceQuitMs(), deadlineExpired: expired });
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
