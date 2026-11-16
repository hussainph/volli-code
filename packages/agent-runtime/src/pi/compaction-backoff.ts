/**
 * When a threshold compaction that has failed in this run may be tried again
 * (VC-1206).
 *
 * Threshold compaction is asked for before every request once the context is
 * over its threshold, and a summary request that keeps failing — a rate limit,
 * an outage, a model that refuses the prompt — would otherwise be bought again
 * at every tool round, each attempt billing most of a large window for nothing.
 * The rule is a pure function of token counts so a run's worst case is bounded
 * by arithmetic rather than by a clock:
 *
 * - **Growth, not time, earns the next attempt.** After a failure, try again
 *   only once the context has grown by at least `step` beyond what it held at
 *   the failed attempt. Growth is what makes compaction urgent; a context that
 *   has not grown is no closer to overflowing than it was when the summary last
 *   failed.
 * - **A cap ends it.** After `cap` failed attempts in one run, threshold
 *   compaction stops for the rest of that run. A later overflow is the
 *   one-shot overflow recovery's to answer, which this rule never reaches.
 *
 * The caller owns the state and its lifetime: a success resets it, and so does
 * the start of a run. Manual compaction and overflow recovery never ask.
 */

/**
 * How many failed threshold compactions one run may make before it stops
 * attempting them. The owner's number: three attempts in all.
 */
export const THRESHOLD_COMPACTION_FAILURE_CAP = 3;

export interface ThresholdCompactionRetryInput {
  /**
   * The context the threshold check just found over the threshold, in the
   * same measure it compared: the last provider measurement plus the
   * estimated unmeasured suffix.
   */
  occupied: number;
  /**
   * The same measure at this run's last failed attempt; absent exactly when
   * `failures` is zero.
   */
  failedAt: number | undefined;
  /** Failed threshold compactions so far in this run. */
  failures: number;
  /** The growth a failure must be followed by before the next attempt. */
  step: number;
  /** The failures after which this run attempts no more. */
  cap: number;
}

/** Whether a due threshold compaction should actually be attempted now. */
export function thresholdCompactionAllowed(input: ThresholdCompactionRetryInput): boolean {
  const { occupied, failedAt, failures, step, cap } = input;
  if (failures >= cap) return false;
  if (failedAt === undefined) return true;
  return occupied - failedAt >= step;
}
