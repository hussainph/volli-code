/**
 * xAI's subscription window — the one meter a SuperGrok or X Premium account
 * actually spends against.
 *
 * xAI bills two different ways and only one of them is a window:
 *
 * - `GET /v1/billing` answers a monthly DOLLAR allowance (`monthlyLimit` and
 *   `used`, in USD cents). That is a credit balance wearing a month, which is
 *   the same thing OpenRouter's `limit`/`usage` is, and it is out of this
 *   vocabulary for the same reason: money spent is not a share of a window.
 * - `GET /v1/billing?format=credits` answers the UNIFIED PERIOD METER —
 *   `currentPeriod` plus `creditUsagePercent`, the pool shared across Grok
 *   chat, Imagine and the API. That is the number grok.com's own usage page
 *   shows, and it is a window: a stated start, a stated end, a share spent.
 *
 *   → { config: { currentPeriod: { type, start, end },
 *                 creditUsagePercent, productUsage: [ { product, usagePercent } ] } }
 *
 * ONE ROW, NOT FOUR. `productUsage` breaks the same pool down by product, and
 * the parts sum to the whole — drawing both would draw one spend twice and
 * imply four allowances where the account has one.
 *
 * THE PERIOD'S LENGTH NAMES THE WINDOW, not its `type` string. Both are on the
 * wire and they agree today (`USAGE_PERIOD_TYPE_WEEKLY` over seven days), but
 * the length is the fact the rest of this vocabulary is keyed on — it is what
 * puts this account's row on the same `weekly` id as every other provider's,
 * and it is what stays right if xAI ever moves the period without renaming the
 * enum.
 *
 * A ZERO PERCENT IS OFTEN ABSENT. The payload is protobuf-shaped, so a field
 * at its default is omitted rather than sent as `0` — an account that has
 * spent nothing this period sends no `creditUsagePercent` at all. The period
 * itself is what says this is the credits shape; a missing share inside it
 * reads as nothing spent, which is what it means.
 */

import { usageLimitsProbeFailed, clampPercent, type UsageLimits } from "@volli/shared";

import { finiteNumber, isoTimestamp, windowShapeForMinutes } from "./windows";

/**
 * The window the credits endpoint answered with.
 *
 * A failed probe rather than an empty success when no period is stated: this
 * endpoint always names the current period for an account with a
 * subscription, so a body without one is not this account's usage.
 */
export function xaiUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return usageLimitsProbeFailed(checkedAt);
  }
  const config = (body as { config?: unknown }).config;
  if (typeof config !== "object" || config === null) return usageLimitsProbeFailed(checkedAt);
  const fields = config as { currentPeriod?: unknown; creditUsagePercent?: unknown };
  const period = fields.currentPeriod;
  if (typeof period !== "object" || period === null) return usageLimitsProbeFailed(checkedAt);
  const { start, end } = period as { start?: unknown; end?: unknown };
  const startsAt = isoTimestamp(start);
  const resetsAt = isoTimestamp(end);
  if (startsAt === undefined || resetsAt === undefined) return usageLimitsProbeFailed(checkedAt);
  const minutes = Math.round((Date.parse(resetsAt) - Date.parse(startsAt)) / 60_000);
  if (minutes <= 0) return usageLimitsProbeFailed(checkedAt);
  return {
    checkedAt,
    windows: [
      {
        ...windowShapeForMinutes(minutes),
        usedPercent: clampPercent(finiteNumber(fields.creditUsagePercent) ?? 0),
        resetsAt,
        windowDurationMins: minutes,
      },
    ],
  };
}
