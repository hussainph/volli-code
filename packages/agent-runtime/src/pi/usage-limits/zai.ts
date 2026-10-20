/**
 * Z.AI's GLM Coding Plan windows, from the subscription console's own read.
 *
 *   GET https://api.z.ai/api/monitor/usage/quota/limit          (international)
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit  (mainland)
 *   Authorization: Bearer <the same API key the turns use>
 *   → { code, success, data: { level?, limits: [ {
 *         type, unit, number, usage, currentValue, remaining,
 *         percentage, nextResetTime?, usageDetails? } ] } }
 *
 * The body is wrapped in the console's `{ code, data, success }` envelope, and
 * the payload has also been seen served unwrapped, so the limits are read from
 * `data` when it is an object and from the root otherwise.
 *
 * THE FIELD NAMES INVERT THE USUAL SENSE and that is the one thing to get
 * right here: `usage` is the window's LIMIT, `currentValue` is what has been
 * SPENT, and `remaining` is what is left. Reading `usage` as consumption would
 * put every healthy account at 100%.
 *
 * A WINDOW IS NAMED BY ITS LENGTH, which this body states as a `number` of
 * `unit`s rather than in minutes — `unit: 3, number: 5` is the five-hour
 * session window and `unit: 6, number: 7` is the seven-day one. Only the unit
 * codes actually observed on this endpoint are mapped; an unknown code leaves
 * the entry unnamed and therefore skipped, the same way Kimi treats a
 * `TIME_UNIT_*` it does not know. Guessing at the rest of an undocumented enum
 * would name windows this vocabulary cannot vouch for.
 *
 * ONLY `TOKENS_LIMIT` IS MAPPED. The other type this endpoint serves,
 * `TIME_LIMIT`, meters web-search and reader tool calls, not model turns —
 * spending all of it does not stop a turn. It would still be the account's
 * smallest remaining share, and `usageLimitAccounts` takes the account's
 * headline from exactly that: a used-up search allowance would present a
 * coding plan with a full token budget as the account closest to running out.
 * This is the same line Kimi's mapper draws around `totalQuota` — the window
 * vocabulary carries shares that stop work, and a different resource belongs
 * to a surface that says so.
 *
 * There is no passive half. Turns run against the OpenAI-completions API at
 * `.../api/coding/paas/v4`, which carries no usage headers.
 */

import {
  clampPercent,
  clampWindowDurationMins,
  usageLimitsProbeFailed,
  type UsageLimits,
  type UsageWindow,
} from "@volli/shared";

import {
  epochMillisToIso,
  finiteNumber,
  percentOf,
  recordOf,
  windowShapeForMinutes,
} from "./windows";

/**
 * How long one `unit` code is, in minutes.
 *
 * Confirmed against this endpoint: 3 is an hour (`unit: 3, number: 5` is the
 * five-hour window) and 6 is a day (`unit: 6, number: 7` is the weekly one).
 * 5 is a month, which the console uses for its calendar-month allowances;
 * thirty days is what {@link windowShapeForMinutes} already reads as monthly.
 */
const UNIT_MINUTES: Readonly<Record<string, number>> = {
  3: 60,
  5: 43_200,
  6: 1_440,
};

/** The one limit type that meters model turns. */
const TOKEN_LIMIT_TYPE = "TOKENS_LIMIT";

/**
 * The windows the quota endpoint answered with.
 *
 * A failed probe rather than an empty success when the body names no usable
 * window: a live coding plan always meters at least its session tokens, so a
 * body without one is not this account's usage.
 */
export function zaiUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  const envelope = recordOf(body);
  if (envelope === undefined) return usageLimitsProbeFailed(checkedAt);
  const payload = recordOf(envelope.data) ?? envelope;
  const windows = new Map<string, UsageWindow>();

  for (const value of Array.isArray(payload.limits) ? payload.limits : []) {
    const entry = recordOf(value);
    if (entry === undefined || entry.type !== TOKEN_LIMIT_TYPE) continue;
    const minutes = windowMinutes(entry);
    if (minutes === undefined) continue;
    keepBinding(windows, minutes, entry);
  }

  if (windows.size === 0) return usageLimitsProbeFailed(checkedAt);
  return { checkedAt, windows: [...windows.values()] };
}

/**
 * Adds one window, keeping whichever of two readings of the same span binds
 * first.
 *
 * Two entries can share a length — the console has served a token limit beside
 * a per-tier one over the same five hours — and two rows under one id is not a
 * row anyone can read. The one further along is the one that stops a turn
 * first, so it is the one drawn.
 */
function keepBinding(
  windows: Map<string, UsageWindow>,
  minutes: number,
  entry: Record<string, unknown>,
): void {
  const usedPercent = spentShare(entry);
  if (usedPercent === undefined) return;
  const shape = windowShapeForMinutes(minutes);
  const held = windows.get(shape.id);
  if (held !== undefined && held.usedPercent >= usedPercent) return;
  const resetsAt = epochMillisToIso(entry.nextResetTime);
  windows.set(shape.id, {
    ...shape,
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    windowDurationMins: minutes,
  });
}

/** `number` of `unit`s as whole minutes, or nothing when either is unreadable. */
function windowMinutes(entry: Record<string, unknown>): number | undefined {
  const count = finiteNumber(entry.number);
  if (count === undefined || count <= 0) return undefined;
  const unit = UNIT_MINUTES[String(entry.unit)];
  if (unit === undefined) return undefined;
  return clampWindowDurationMins(count * unit);
}

/**
 * The share spent, from the counts when they are usable and from the stated
 * percentage otherwise.
 *
 * Counts first because `percentage` arrives as a whole number: at 800M tokens
 * a point is eight million, and the pace reading deserves better than that.
 * `currentValue` is the spend; `remaining` answers the same question from the
 * other side when it is missing. A limit of zero is no window — nothing can be
 * spent from it, and the division would not be a share.
 */
function spentShare(entry: Record<string, unknown>): number | undefined {
  const limit = finiteNumber(entry.usage);
  if (limit !== undefined && limit > 0) {
    const remaining = finiteNumber(entry.remaining);
    const spent =
      finiteNumber(entry.currentValue) ?? (remaining === undefined ? undefined : limit - remaining);
    if (spent !== undefined) return clampPercent((spent / limit) * 100);
  }
  return percentOf(entry.percentage);
}
