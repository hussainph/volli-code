/**
 * OpenCode Go's subscription windows, from the one place they are stated.
 *
 * Go is a flat monthly subscription to a curated set of open models, metered
 * in dollars across three windows — five hours, a week, a month — and driven
 * with an ordinary API key rather than OAuth. The gateway puts nothing about
 * the windows on a turn's response, so there is no passive half here; the
 * console answers on demand:
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <the same key the turns use>
 *   → { usage: { rolling, weekly, monthly } }
 *     each { status: "ok" | "rate-limited", percent: 0–100, resetsAt: ISO }
 *
 * That is the shape the route serves from `dev` (the pull request that added
 * it was opened with a different one — `rollingUsage.{usagePercent,
 * resetInSec}` — and at least one downstream coded to that draft). A window
 * the body omits is skipped, not guessed. The three are named by their key,
 * not their length: unlike Codex, the source says which is which, and the
 * monthly one has no fixed length to name it by.
 *
 * `rate-limited` is read as nothing left. The gateway is refusing requests on
 * that window, and a bar that still showed a sliver would be a sliver nobody
 * can spend.
 */

import {
  clampWindowDurationMins,
  usageLimitsProbeFailed,
  type UsageLimits,
  type UsageWindow,
} from "@volli/shared";

import {
  isoTimestamp,
  percentOf,
  recordOf,
  SESSION_WINDOW_MINS,
  WEEKLY_WINDOW_MINS,
} from "./windows";

/** The three windows Go meters, in the order the rows are drawn. */
const WINDOWS = [
  { key: "rolling", id: "session", kind: "session", label: "Session" },
  { key: "weekly", id: "weekly", kind: "weekly", label: "Weekly" },
  { key: "monthly", id: "monthly", kind: "monthly", label: "Monthly" },
] as const satisfies readonly {
  key: string;
  id: string;
  kind: UsageWindow["kind"];
  label: string;
}[];

/**
 * The windows the usage endpoint answered with.
 *
 * A failed probe rather than an empty success when the body carries no usable
 * window: the route always names all three for a subscribed account, so a
 * body without any is not this account's usage.
 */
export function opencodeGoUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  const usage = recordOf(recordOf(body)?.usage);
  if (usage === undefined) return usageLimitsProbeFailed(checkedAt);
  const windows: UsageWindow[] = [];
  for (const shape of WINDOWS) {
    const fields = recordOf(usage[shape.key]);
    if (fields === undefined) continue;
    const reported = percentOf(fields.percent);
    if (reported === undefined) continue;
    const usedPercent = fields.status === "rate-limited" ? 100 : reported;
    const resetsAt = isoTimestamp(fields.resetsAt);
    const windowDurationMins = durationMinutes(shape.key, resetsAt);
    windows.push({
      id: shape.id,
      kind: shape.kind,
      label: shape.label,
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    });
  }
  if (windows.length === 0) return usageLimitsProbeFailed(checkedAt);
  return { checkedAt, windows };
}

/**
 * How long each window is. The rolling and weekly windows are fixed; the
 * monthly one runs from one subscription anniversary to the next, so its
 * length is the calendar month that ends at its reset — 28 to 31 days — and
 * without a reset it has no length to state.
 */
function durationMinutes(key: (typeof WINDOWS)[number]["key"], resetsAt: string | undefined) {
  switch (key) {
    case "rolling":
      return SESSION_WINDOW_MINS;
    case "weekly":
      return WEEKLY_WINDOW_MINS;
    case "monthly": {
      if (resetsAt === undefined) return undefined;
      const end = new Date(resetsAt);
      const start = new Date(end);
      start.setUTCMonth(start.getUTCMonth() - 1);
      return clampWindowDurationMins((end.getTime() - start.getTime()) / 60_000);
    }
  }
}
