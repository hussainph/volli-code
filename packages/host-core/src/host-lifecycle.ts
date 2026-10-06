/**
 * The host's lifecycle (VC-627): one `start()` and one `stop(reason)` that own
 * the order a host comes up and goes down in. A host supplies its quit trigger
 * and the ports below; it no longer sequences teardown itself.
 *
 * STOP, in order. Every step runs even when an earlier one failed, because the
 * full-drain policy's last step is the database. Desktop quit preserves its
 * historical process-exit policy: no additional joins, checkpoint or DB close:
 *
 * 1. **Producers, synchronously:** the scheduler and pending armed Runs, then
 *    the maintenance loops (retention, automatic reap). Nothing new is started
 *    against a host that is going away.
 * 2. **Native drain:** the Session runtime close (watchdog, resume, notices,
 *    RPC and runtime, the MCP backstop, the observability flush — see
 *    `host-shutdown.ts`) and, when given, the agent socket, CONCURRENTLY. This
 *    is desktop's accepted-quit shape; each rejection is reported as it
 *    happens and the step still waits for the other.
 * 3. **Full drain only:** an in-flight start is joined. Closing the runtime above is what
 *    unblocks a boot still waiting on recovery. Its rejection already
 *    reached the `start()` caller, so it does not make the stop unclean.
 * 4. **Full drain only:** detached work (Done-trims a ticket move started, a headless socket's
 *    in-flight requests; see `detached-work.ts`) is drained, so none of it
 *    outlives the database.
 * 5. **The activity watch** is stopped: its flush timer is the last thing that
 *    reads the database on its own, so it keeps flushing through the drains.
 * 6. **Clean drain:** stamp pending follow-up event watermarks before process exit.
 * 7. **Full drain only:** the WAL checkpoint and database close.
 *
 * NO DEADLINE HERE. The deadline stays at the host edge, which wraps `stop()`
 * in `settleShutdownBeforeDeadline` (desktop's quit gate). A bound inside the
 * lifecycle would have to choose between closing the database under a runtime
 * still writing and never closing it; at the edge, a host past its deadline
 * exits the process instead.
 */
import { errorMessage } from "@volli/shared";

import { hostLogger } from "./log/root";

const log = hostLogger("host");

/** The step a failure came from, so a host can report it in its own words. */
export type HostLifecycleStep =
  | "stop-producers"
  | "stop-maintenance"
  | "close-runtime"
  | "close-socket"
  | "drain-detached"
  | "stop-activity"
  | "stamp-clean-close"
  | "close-database";

/**
 * A step reports an unclean close by throwing, or by returning `false` when
 * it has already reported the reason itself (a drain that timed out).
 */
type StepResult = boolean | void;

export interface HostLifecyclePorts {
  /** Boot to readiness. Runs at most once; never after a stop has begun. */
  start(): Promise<void> | void;
  /** The scheduler and pending armed Runs. Synchronous. */
  stopProducers(): void;
  /** The retention poll and automatic reap. Synchronous. */
  stopMaintenance(): void;
  /** The Session runtime drain, including the MCP backstop and export flush. */
  closeRuntime(): Promise<StepResult>;
  /** The agent socket, closed concurrently with the runtime. Absent, nothing runs beside it. */
  closeSocket?(): Promise<StepResult>;
  /** Work detached from any caller: settled (or abandoned) before the database closes. */
  drainDetached(): Promise<StepResult>;
  /** The activity watch's flush timer. Synchronous. */
  stopActivity(): void;
  /** Only after a clean drain, for both desktop process exit and full DB close. */
  stampCleanClose?(): void;
  /** WAL checkpoint and close; see `checkpointAndCloseDatabase`. */
  closeDatabase(): StepResult;
  /** Warn once if a stop cannot stamp, including a deadline at the host edge. */
  reportSkippedCleanClose?(reason: string): void;
  /** Called once per failed step, as it fails. */
  reportFailure(step: HostLifecycleStep, error: unknown): void;
}

/** Desktop exits with SQLite open; headless hosts drain all writers and close it. */
export type HostStopPolicy = "desktop-quit" | "drain-and-close";

export type HostLifecycleState =
  | "idle"
  | "starting"
  | "running"
  | "failed"
  | "stopping"
  | "stopped";

export interface HostStopReport {
  /** The first `stop` call's reason; later calls join it. */
  readonly reason: string;
  /** Whether every step closed without a failure. */
  readonly clean: boolean;
}

export interface HostLifecycle {
  /** Idempotent: every call answers the first one's promise. Rejects once a stop has begun. */
  start(): Promise<void>;
  /** Idempotent: every call answers the first one's promise. Never rejects. */
  stop(reason: string): Promise<HostStopReport>;
  state(): HostLifecycleState;
  /** Diagnostics only: a deadline must not change the ongoing drain/stamp. */
  warnIfCleanCloseSkipped(reason: string): void;
}

/** A start asked of a host that is already stopping. */
export class HostStoppedError extends Error {
  override name = "HostStoppedError";
}

export function createHostLifecycle(
  ports: HostLifecyclePorts,
  stopPolicy: HostStopPolicy = "drain-and-close",
): HostLifecycle {
  let state: HostLifecycleState = "idle";
  let starting: Promise<void> | undefined;
  let stopping: Promise<HostStopReport> | undefined;
  let stopRequested = false;
  let cleanCloseStamped = false;
  let skippedCloseReported = false;

  function warnIfCleanCloseSkipped(reason: string): void {
    if (cleanCloseStamped || skippedCloseReported) return;
    skippedCloseReported = true;
    try {
      ports.reportSkippedCleanClose?.(reason);
    } catch (error) {
      // Diagnostics must not change whether teardown proceeds or stamps.
      log.error("failed to report a skipped clean-close watermark", { error });
    }
  }

  function start(): Promise<void> {
    if (stopRequested && starting === undefined) {
      return Promise.reject(new HostStoppedError("The host is stopping."));
    }
    starting ??= (async () => {
      state = "starting";
      try {
        await ports.start();
      } catch (error) {
        if (!stopRequested) state = "failed";
        throw error;
      }
      if (!stopRequested) state = "running";
    })();
    return starting;
  }

  async function runStop(reason: string): Promise<HostStopReport> {
    state = "stopping";
    let clean = true;
    const fail = (step: HostLifecycleStep, error: unknown): void => {
      clean = false;
      warnIfCleanCloseSkipped(`${reason}: ${step} failed: ${errorMessage(error)}`);
      try {
        ports.reportFailure(step, error);
      } catch (reportError) {
        // A reporter that throws must not strand the database open.
        log.error("failed to report a shutdown step failure", { step, error: reportError });
      }
    };
    const settle = (step: HostLifecycleStep, result: StepResult): void => {
      if (result === false) {
        clean = false;
        warnIfCleanCloseSkipped(`${reason}: ${step} reported an unclean stop`);
      }
    };
    const sync = (step: HostLifecycleStep, run: () => StepResult): void => {
      try {
        settle(step, run());
      } catch (error) {
        fail(step, error);
      }
    };
    const pending = (step: HostLifecycleStep, run: () => Promise<StepResult>): Promise<void> =>
      Promise.resolve()
        .then(run)
        .then(
          (result) => settle(step, result),
          (error: unknown) => fail(step, error),
        );

    sync("stop-producers", () => ports.stopProducers());
    sync("stop-maintenance", () => ports.stopMaintenance());
    const closeSocket = ports.closeSocket;
    await Promise.all([
      pending("close-runtime", () => ports.closeRuntime()),
      closeSocket === undefined ? undefined : pending("close-socket", () => closeSocket()),
    ]);
    if (stopPolicy === "drain-and-close") {
      await starting?.catch(() => undefined);
      await pending("drain-detached", () => ports.drainDetached());
    }
    sync("stop-activity", () => ports.stopActivity());
    const stampCleanClose = ports.stampCleanClose;
    if (clean && stampCleanClose !== undefined)
      sync("stamp-clean-close", () => {
        stampCleanClose();
        cleanCloseStamped = true;
      });
    if (stampCleanClose === undefined)
      warnIfCleanCloseSkipped(`${reason}: clean-close stamping is unavailable`);
    if (stopPolicy === "drain-and-close") sync("close-database", () => ports.closeDatabase());
    state = "stopped";
    return { reason, clean };
  }

  return {
    start,
    stop(reason) {
      if (stopping !== undefined) return stopping;
      // Set before any port runs: a start asked from inside a producer stop is refused.
      stopRequested = true;
      stopping = runStop(reason);
      return stopping;
    },
    state: () => state,
    warnIfCleanCloseSkipped,
  };
}
