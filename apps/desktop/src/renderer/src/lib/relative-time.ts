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
  if (diff < 4 * WEEK) return `${Math.floor(diff / WEEK)}w ago`;

  const date = new Date(epochMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
