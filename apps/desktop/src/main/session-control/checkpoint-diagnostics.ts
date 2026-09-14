/**
 * Reporting for recovered Session projection checkpoint failures (VC-355).
 *
 * A checkpoint is a derived cache: every failure to read, fold, or write one is
 * recovered by refolding the immutable event log, so none of them can fail a
 * read. That is exactly why they are worth reporting. A cache that misses on
 * every single read is behaviourally identical to one that is merely cold —
 * the only symptom is that opening a long chat never got faster — and an
 * unreported failure would leave that condition undiagnosable.
 *
 * The reporter is throttled rather than per-failure because the failing case is
 * the repeating one: a permanently undecodable row would otherwise emit a line
 * per Session per listing. The first failure is always reported, later ones are
 * counted and summarized, so the signal survives without becoming noise.
 */

/** How long a burst of identical failures is summarized into one line. */
const REPORT_INTERVAL_MS = 60_000;

export interface CheckpointFailureReporterPorts {
  /** Defaults to `console.warn`; injected so a test can read what was emitted. */
  warn?: (message: string) => void;
  /** Defaults to `Date.now`; injected so a test controls the throttle window. */
  now?: () => number;
}

/**
 * Builds one throttled reporter. Callers share a single instance so the engine's
 * read path and the runtime's write path cannot each open their own window and
 * double the output for the same underlying fault.
 */
export function createCheckpointFailureReporter(
  ports: CheckpointFailureReporterPorts = {},
): (error: unknown) => void {
  const warn = ports.warn ?? ((message: string) => console.warn(message));
  const now = ports.now ?? Date.now;
  let reportedAt: number | null = null;
  let suppressed = 0;

  return (error: unknown): void => {
    const at = now();
    if (reportedAt !== null && at - reportedAt < REPORT_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    const since =
      suppressed === 0 ? "" : ` (${suppressed} more since the previous report were suppressed)`;
    reportedAt = at;
    suppressed = 0;
    warn(
      `[session-checkpoint] projection checkpoint unusable; refolded from the event log${since}: ${describe(error)}`,
    );
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
