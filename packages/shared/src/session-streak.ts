/**
 * Sessions per day, as a fixed window of cells (VC-55's Streak visual).
 *
 * The Home empty chat opens on a field of many — every Session ever run in
 * Volli, project and ticket, across every project — because "many" is what a
 * Project Session's scope IS, and it is read before anything is read. A ticket
 * chat cannot draw this, and that asymmetry is the identity signal.
 *
 * THE WINDOW IS FIXED at {@link STREAK_WEEKS} weeks so the grid cannot grow
 * into a wall as the history does; a chart that reflows every week is also a
 * chart whose shape says nothing.
 *
 * DAYS ARE LOCAL DAYS, and bucketed through the calendar rather than by
 * dividing epoch milliseconds: a DST boundary makes one local day 23 or 25
 * hours long, and a fixed 86,400,000 divisor slides every cell after it by an
 * hour until it silently lands in the wrong column. {@link localDayNumber} asks
 * the Date for its calendar day and counts THOSE, which no offset change can
 * shift.
 *
 * Pure and clock-injected — `nowMs` is an argument, never `Date.now()` — so the
 * grid a test asserts is the grid the app draws.
 */

/** Fixed window: 26 weeks of cells, 7 rows deep, column-major when drawn. */
export const STREAK_WEEKS = 26;

/** Cells in the window — one per day. */
export const STREAK_DAYS = STREAK_WEEKS * 7;

/** One cell. */
export interface StreakDay {
  /** Position in the window: 0 is the oldest cell, `STREAK_DAYS - 1` is today. */
  index: number;
  /** Whole local days before today; 0 is today. Drives the tooltip's "4 days ago". */
  daysAgo: number;
  /** Sessions started that day. */
  count: number;
}

/** The window, plus the three totals drawn under it. */
export interface StreakGrid {
  days: readonly StreakDay[];
  /** Sessions inside the window. Deliberately not "ever": the drawing is the window. */
  total: number;
  /** Days in the window with at least one Session. */
  activeDays: number;
  /**
   * Consecutive days with at least one Session, counting back from today. `0`
   * when today has none — and the caller hides it rather than printing a zero,
   * because "0-day streak" is a scolding, not a measurement.
   */
  currentStreak: number;
}

/** Milliseconds in a whole UTC day — the unit {@link localDayNumber} counts in. */
const DAY_MS = 86_400_000;

/**
 * A timestamp's local calendar day, as a count of days.
 *
 * Built from the local Y/M/D re-encoded as UTC, so the arithmetic runs on a
 * calendar where every day is exactly 24 hours long while the day it names is
 * the one the user's clock showed. Comparing two of these is comparing two
 * calendar dates; subtracting them is counting nights.
 */
function localDayNumber(ms: number): number {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/**
 * Local midnight opening the window that ends today — the `sinceMs` a caller
 * fetches Session starts from.
 *
 * Local midnight, not `now - 182 days`: the oldest cell is a whole day, so a
 * window that starts at this afternoon's o'clock would drop that day's morning
 * and draw a cell that undercounts itself.
 */
export function streakWindowStart(nowMs: number, days: number = STREAK_DAYS): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
}

/**
 * The window's cells and totals, from Session creation stamps.
 *
 * Stamps outside the window are ignored rather than clamped into the edge
 * cells: the caller fetches from {@link streakWindowStart}, so anything older
 * is a Session the window is not about, and folding it into the first cell
 * would draw a spike that never happened. Stamps in the FUTURE (a clock that
 * moved, a row written by another machine) are ignored on the same ground.
 */
export function streakGrid(
  startedAt: readonly number[],
  nowMs: number,
  days: number = STREAK_DAYS,
): StreakGrid {
  const today = localDayNumber(nowMs);
  const first = today - (days - 1);
  // Sparse on purpose: most days in a 26-week window are empty, and an absent
  // key is exactly what an empty day is.
  const counts = new Map<number, number>();
  let total = 0;
  for (const stamp of startedAt) {
    const index = localDayNumber(stamp) - first;
    if (index < 0 || index >= days) continue;
    counts.set(index, (counts.get(index) ?? 0) + 1);
    total += 1;
  }

  let activeDays = 0;
  const cells: StreakDay[] = [];
  for (let index = 0; index < days; index += 1) {
    const count = counts.get(index) ?? 0;
    if (count > 0) activeDays += 1;
    cells.push({ index, daysAgo: days - 1 - index, count });
  }

  let currentStreak = 0;
  let running = true;
  for (let index = days - 1; index >= 0 && running; index -= 1) {
    if (counts.has(index)) currentStreak += 1;
    else running = false;
  }

  return { days: cells, total, activeDays, currentStreak };
}

/**
 * Which of four intensity steps a day's count draws at — `0` is an empty day.
 *
 * Fixed thresholds rather than quartiles over the window: the ramp has to mean
 * the same thing in week one as in week twenty-six, and a relative scale makes
 * a quiet fortnight look exactly like a busy one.
 */
export function streakStep(count: number): 0 | 1 | 2 | 3 {
  if (count === 0) return 0;
  if (count >= 9) return 3;
  if (count >= 5) return 2;
  return 1;
}
