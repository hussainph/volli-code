/**
 * A compact "time ago" formatter for the Activity feed's event/comment stamps
 * (ticket-detail-mvp step 4). Pure and `now`-injectable so it's deterministic
 * under test — no existing helper covered this, so this is the small one the
 * plan allowed adding. Rolls up to an absolute date once a stamp is older than
 * ~4 weeks, where "3w ago" stops being more useful than the actual date.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Where the relative ladder stops and an absolute date takes over. Named once
 * because {@link compactAge} has to know the same boundary — it formats that
 * rollup differently, and a second literal here is a second boundary waiting to
 * drift from this one.
 */
const ROLLUP_AFTER = 4 * WEEK;

/**
 * The one place owning absolute-date `Intl`/`toLocaleString` option objects
 * (three call sites previously each rolled their own): `{ time: true }` adds
 * hour/minute to the date-only default. Always includes the year — unlike
 * {@link relativeTime}'s year-omitted-if-current-year rollup, an explicit
 * "created"/"updated"/"archived" stamp reads better with it always present.
 */
export function formatStamp(epochMs: number, options: { time?: boolean } = {}): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(options.time ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/**
 * `epochMs` phrased relative to `now` (default: wall clock): "just now",
 * "5m ago", "3h ago", "2d ago", "3w ago", or an absolute "Mon D" / "Mon D, YYYY"
 * date beyond ~4 weeks. Future or sub-45s stamps read as "just now".
 */
export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const diff = now - epochMs;

  if (diff < 45 * SECOND) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < ROLLUP_AFTER) return `${Math.floor(diff / WEEK)}w ago`;

  const date = new Date(epochMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * {@link relativeTime} trimmed for a list row's age column: "12m ago" → "12m".
 *
 * The column is one glance wide — the sidebar reserves `3ch` of tabular figures
 * for it — so the two answers `relativeTime` gives that don't fit are given
 * forms that do, and nothing else changes.
 *
 * "just now" is eight characters for the first forty-five seconds, and every
 * row this formats is in the past by construction; "now" says the same thing in
 * the width of "12h". The rollup past four weeks is the other one: the year is
 * omitted only WITHIN the current calendar year, so a row from December renders
 * "Dec 6, 2025" in January — twelve characters, and the widest string the
 * column can be asked to hold. Cross-year rows drop the day for the year, which
 * is the part that still tells you something at that distance.
 *
 * The two-digit year is arithmetic rather than `{ year: "2-digit" }` because
 * that option renders bare digits ("Dec 25") which read as a day of the month
 * beside the same formatter's "Dec 6". The apostrophe is what makes it a year.
 */
export function compactAge(epochMs: number, now: number = Date.now()): string {
  if (now - epochMs < ROLLUP_AFTER) {
    const relative = relativeTime(epochMs, now);
    return relative === "just now" ? "now" : relative.replace(/ ago$/, "");
  }

  const date = new Date(epochMs);
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const year = String(date.getFullYear() % 100).padStart(2, "0");
  return `${date.toLocaleDateString(undefined, { month: "short" })} '${year}`;
}

/** The first instant past the `unit`-wide bucket `diff` currently sits in. */
function bucketEnd(diff: number, unit: number): number {
  return (Math.floor(diff / unit) + 1) * unit;
}

/**
 * The first instant at which {@link compactAge}(`epochMs`, …) reads differently
 * from what it reads at `now`.
 *
 * A row showing an age is stale from that instant and correct until it, which
 * makes this the whole of what a caller needs to keep one accurate: arm a timer
 * on the soonest one on screen and there is no polling clock, no interval
 * chosen against the smallest unit anything might display, and no window in
 * which a stamp is wrong.
 *
 * It walks {@link relativeTime}'s ladder, and each rung's answer is the end of
 * the bucket the stamp currently sits in — the "just now" bucket closes at 45
 * seconds, every rung after it closes on its own unit. Past the four-week
 * rollup the string is an absolute date with exactly one moving part: the year,
 * which {@link compactAge} omits inside the current calendar year and prints
 * outside it, so the next change is the turn of the year.
 *
 * It answers for {@link relativeTime} as well, and callers on both formatters
 * rely on that: `compactAge` shortens two of the ladder's strings and neither
 * of them moves a bucket, so the instant either one starts reading differently
 * is the same instant.
 *
 * Always strictly after `now`, a future stamp included, so a caller arming a
 * timer on it can never spin.
 */
export function nextAgeChangeAt(epochMs: number, now: number): number {
  const diff = now - epochMs;

  if (diff < 45 * SECOND) return epochMs + 45 * SECOND;
  if (diff < HOUR) return epochMs + bucketEnd(diff, MINUTE);
  if (diff < DAY) return epochMs + bucketEnd(diff, HOUR);
  if (diff < WEEK) return epochMs + bucketEnd(diff, DAY);
  if (diff < ROLLUP_AFTER) return epochMs + bucketEnd(diff, WEEK);

  return new Date(new Date(now).getFullYear() + 1, 0, 1).getTime();
}
