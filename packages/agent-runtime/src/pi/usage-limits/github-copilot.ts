/**
 * GitHub Copilot's monthly quotas, from the endpoint its own editors read.
 *
 * A Copilot seat is metered per CLASS of interaction over a calendar month —
 * premium requests, chat, completions — and the account endpoint states all
 * three at once:
 *
 *   GET https://api.github.com/copilot_internal/user
 *   Authorization: token <the GitHub OAuth token>
 *   → { copilot_plan, quota_reset_date: "YYYY-MM-DD",
 *       quota_snapshots: { premium_interactions | chat | completions:
 *         { entitlement, remaining, percent_remaining, unlimited, … } } }
 *
 * Three things this mapper is careful about:
 *
 * - **`unlimited` is a window that does not exist**, not a full one. On a paid
 *   seat chat and completions both come back `unlimited: true` with
 *   `percent_remaining: 100`, and drawing two permanently full bars beside the
 *   one real meter would bury it. A class that says it is unlimited is skipped,
 *   which is why a Pro seat draws exactly one row.
 * - **`percent_remaining` is what is LEFT**; every other source in this
 *   vocabulary states what is spent. The subtraction happens here, once.
 * - **The reset is a DATE, not a moment.** GitHub resets premium requests on
 *   the first of the month at 00:00 UTC and states the next one as
 *   `2026-04-01`. The window is therefore the calendar month that ENDS at that
 *   reset — the same reading OpenCode Go's monthly window gets — so a February
 *   reset spans 31 days of January and an April one 31 days of March.
 *
 * Window ids are the endpoint's own keys, the way Anthropic's are: three
 * monthly windows cannot all be `monthly`, and the key is the one spelling a
 * reader can look up.
 *
 * A FREE SEAT IS NOT MAPPED. It answers a different shape entirely
 * (`limited_user_quotas` / `monthly_quotas` / `limited_user_reset_date`, all
 * raw counts and no percentages) and it is not the subscription this ticket
 * meters. Such a body names no window here, which reads as a failed probe. A
 * valid `quota_snapshots` body whose known classes are all unlimited is instead
 * a successful empty read: there is no Usage Window, but the probe did work.
 *
 * There is no passive half. The `x-quota-snapshot-*` headers the Copilot
 * gateway puts on turn responses carry the same three classes in a
 * form-encoded shape — but a probe replaces held windows wholesale, so a
 * second source reporting a DIFFERENT set of ids (those responses also carry
 * short-term burst limits) would flip rows in and out between an inspection
 * and a turn. One source, one set of ids.
 */

import {
  clampPercent,
  clampWindowDurationMins,
  usageLimitsProbeFailed,
  type UsageLimits,
  type UsageWindow,
} from "@volli/shared";

import { isoTimestamp, percentOf, recordOf } from "./windows";

/** The classes a seat is metered in, in the order the rows are drawn. */
const CLASSES = [
  { key: "premium_interactions", label: "Premium requests" },
  { key: "chat", label: "Chat" },
  { key: "completions", label: "Completions" },
] as const;

/**
 * The windows the account endpoint answered with.
 *
 * A failed probe when no known class is readable. Known classes that all say
 * `unlimited` are a successful empty result because each explicitly says its
 * Usage Window does not exist.
 */
export function githubCopilotUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  const fields = recordOf(body);
  const snapshots = recordOf(fields?.quota_snapshots);
  if (fields === undefined || snapshots === undefined) return usageLimitsProbeFailed(checkedAt);
  const resetsAt = isoTimestamp(fields.quota_reset_date);
  const windowDurationMins = monthEndingAt(resetsAt);
  const windows: UsageWindow[] = [];
  let sawUnlimitedClass = false;
  for (const shape of CLASSES) {
    const snapshot = recordOf(snapshots[shape.key]);
    if (snapshot === undefined) continue;
    if (snapshot.unlimited === true) {
      sawUnlimitedClass = true;
      continue;
    }
    const remaining = percentOf(snapshot.percent_remaining);
    if (remaining === undefined) continue;
    windows.push({
      id: shape.key,
      kind: "monthly",
      label: shape.label,
      usedPercent: clampPercent(100 - remaining),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    });
  }
  if (windows.length === 0 && !sawUnlimitedClass) return usageLimitsProbeFailed(checkedAt);
  return { checkedAt, windows };
}

/**
 * The length of the calendar month that ends at the reset — 28 to 31 days.
 *
 * Without a reset there is no month to measure, and the window carries no
 * length rather than a guessed one.
 */
function monthEndingAt(resetsAt: string | undefined): number | undefined {
  if (resetsAt === undefined) return undefined;
  const end = new Date(resetsAt);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return clampWindowDurationMins((end.getTime() - start.getTime()) / 60_000);
}
