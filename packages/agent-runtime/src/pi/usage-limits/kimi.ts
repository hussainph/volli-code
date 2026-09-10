/**
 * Kimi Code's subscription windows, from the one place they are stated.
 *
 * A Kimi membership meters coding in a plan-wide allowance and a five-hour
 * rate-limit window, both in REQUEST COUNTS rather than percentages:
 *
 *   GET https://api.kimi.com/coding/v1/usages
 *   Authorization: Bearer <the same credential the turns use>
 *   → { usage:  { limit, remaining, resetTime },
 *       limits: [ { window: { duration, timeUnit }, detail: { limit, remaining, resetTime } } ] }
 *
 * The body is protobuf-flavoured JSON, which is why every count arrives as a
 * STRING and the unit wears a `TIME_UNIT_` prefix. `finiteNumber` already
 * reads either spelling, so nothing here parses text.
 *
 * TWO WINDOWS, NAMED TWO DIFFERENT WAYS, because the body states their
 * identity two different ways:
 *
 * - Each `limits[]` entry STATES ITS OWN LENGTH (`duration` + `timeUnit`), so
 *   it is named by that length through {@link windowShapeForMinutes} — the
 *   same function Codex's two sources go through, which is why 300 minutes
 *   lands on the `session` row here too. Kimi's own membership guide names
 *   this one: "about 300–1,200 requests every 5 hours".
 * - The top-level `usage` states only its key and reset. It is therefore the
 *   `usage` window, with no invented length. Published captures show its reset
 *   advancing by seven days, but that observation is not part of either
 *   response. Calling it weekly would violate the rule that a window is named
 *   only by a key or length the source itself states.
 *
 * `totalQuota` IS DELIBERATELY NOT MAPPED. It is the monthly membership cap,
 * and it does not carry a usable share: its `remaining` is sticky (99 both
 * while an account is frozen and immediately after its reset), so the only
 * signal in it is whether `used` is present and non-zero — a boolean. This
 * vocabulary carries windows a share is spent from, and a binary "frozen"
 * drawn as a 0%-or-100% bar would claim a measurement nobody made. It belongs
 * to whatever surface says an account is blocked, not to a usage window.
 *
 * There is no passive half: the Anthropic-compatible gateway at
 * `api.kimi.com/coding` puts no usage headers on a turn's response.
 */

import {
  clampPercent,
  clampWindowDurationMins,
  usageLimitsProbeFailed,
  type UsageLimits,
  type UsageWindow,
} from "@volli/shared";

import { finiteNumber, isoTimestamp, recordOf, windowShapeForMinutes } from "./windows";

/**
 * How long one `TIME_UNIT_*` is, in minutes.
 *
 * A unit outside this set leaves the entry unnamed and therefore skipped: a
 * window whose length cannot be read is one this vocabulary cannot place.
 */
const UNIT_MINUTES: Readonly<Record<string, number>> = {
  TIME_UNIT_SECOND: 1 / 60,
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1_440,
  TIME_UNIT_WEEK: 10_080,
};

/** The three spellings the endpoint has been seen using for one reset. */
function resetOf(entry: Record<string, unknown>): string | undefined {
  return (
    isoTimestamp(entry.resetTime) ?? isoTimestamp(entry.reset_at) ?? isoTimestamp(entry.resetAt)
  );
}

/**
 * The windows the usage endpoint answered with.
 *
 * A failed probe rather than an empty success when the body names no usable
 * window: a subscribed account always has its plan allowance, so a body
 * without one is not this account's usage.
 */
export function kimiUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  const fields = recordOf(body);
  if (fields === undefined) return usageLimitsProbeFailed(checkedAt);
  const windows = new Map<string, UsageWindow>();

  for (const value of Array.isArray(fields.limits) ? fields.limits : []) {
    const entry = recordOf(value);
    if (entry === undefined) continue;
    const window = recordOf(entry.window);
    const detail = recordOf(entry.detail);
    if (window === undefined || detail === undefined) continue;
    const minutes = windowMinutes(window);
    if (minutes === undefined) continue;
    keepBinding(windows, minutes, detail);
  }

  const usage = recordOf(fields.usage);
  if (usage !== undefined) keepPlanBinding(windows, usage);

  if (windows.size === 0) return usageLimitsProbeFailed(checkedAt);
  return { checkedAt, windows: [...windows.values()] };
}

/** Adds the top-level window under the key the source states. */
function keepPlanBinding(windows: Map<string, UsageWindow>, detail: Record<string, unknown>): void {
  const built = countedWindow(detail);
  if (built === undefined) return;
  windows.set("usage", {
    id: "usage",
    kind: "other",
    label: "Plan",
    usedPercent: built.usedPercent,
    ...(built.resetsAt === undefined ? {} : { resetsAt: built.resetsAt }),
  });
}

/**
 * Adds one duration-named window, or keeps whichever of two readings of the same span binds
 * first.
 *
 * Standard and HighSpeed are two tiers of one membership, so the endpoint can
 * state two limits over the same length. They share an id — the id is the
 * length — and two rows under one id is not a row anyone can read. The one
 * further along is the one that stops a turn first, so it is the one drawn.
 */
function keepBinding(
  windows: Map<string, UsageWindow>,
  minutes: number,
  detail: Record<string, unknown>,
): void {
  const built = countedWindow(detail);
  if (built === undefined) return;
  const shape = windowShapeForMinutes(minutes);
  const held = windows.get(shape.id);
  if (held !== undefined && held.usedPercent >= built.usedPercent) return;
  windows.set(shape.id, {
    ...shape,
    usedPercent: built.usedPercent,
    ...(built.resetsAt === undefined ? {} : { resetsAt: built.resetsAt }),
    windowDurationMins: minutes,
  });
}

/** `duration` in the stated unit, as whole minutes, or nothing when unreadable. */
function windowMinutes(window: Record<string, unknown>): number | undefined {
  const duration = finiteNumber(window.duration);
  if (duration === undefined || duration <= 0) return undefined;
  const unit = typeof window.timeUnit === "string" ? UNIT_MINUTES[window.timeUnit] : undefined;
  if (unit === undefined) return undefined;
  return clampWindowDurationMins(duration * unit);
}

/**
 * The share spent, from counts rather than a percentage.
 *
 * `remaining` is what the endpoint always sends and `used` is what it
 * sometimes sends instead; either answers the question against `limit`. A
 * limit of zero is no window — nothing can be spent from it, and the division
 * would not be a share.
 */
function countedWindow(
  detail: Record<string, unknown>,
): { usedPercent: number; resetsAt: string | undefined } | undefined {
  const limit = finiteNumber(detail.limit);
  if (limit === undefined || limit <= 0) return undefined;
  const remaining = finiteNumber(detail.remaining);
  const used = remaining === undefined ? finiteNumber(detail.used) : limit - remaining;
  if (used === undefined) return undefined;
  return { usedPercent: clampPercent((used / limit) * 100), resetsAt: resetOf(detail) };
}
