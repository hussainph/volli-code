/**
 * OpenAI Codex's subscription windows, from either place they are stated.
 *
 * A ChatGPT subscription driving Codex is metered in a session window and a
 * weekly one. Two sources carry the same facts:
 *
 * - **A `/codex/responses` SSE response** carries `x-codex-{primary,secondary}-
 *   used-percent`, `-window-minutes`, `-reset-at` (epoch seconds) and sometimes
 *   `-reset-after-seconds`. These are absent on the WebSocket transport pi-ai
 *   prefers, so most turns say nothing here and the endpoint does the work.
 * - **`GET https://chatgpt.com/backend-api/wham/usage`** answers
 *   `rate_limit.{primary,secondary}_window.{used_percent, limit_window_seconds,
 *   reset_after_seconds | reset_at}`.
 *
 * Neither source is read by slot. Some plans expose only a weekly window and
 * put it in `primary`, so a window is named by its length — 300 minutes is the
 * session row, 10 080 the weekly one — and a slot whose length is not stated is
 * skipped rather than guessed. Both sources agree on the ids `session` and
 * `weekly` because both go through {@link windowShapeForMinutes}.
 */

import type { UsageLimits, UsageLimitsUpdate, UsageWindow } from "@volli/shared";

import {
  epochSecondsToIso,
  finiteNumber,
  headerReader,
  percentOf,
  secondsFromNowToIso,
  windowShapeForMinutes,
  type HeaderMap,
} from "./windows";

const SLOTS = ["primary", "secondary"] as const;

/** The windows one response's headers state, or null when it states none. */
export function codexHeadersToUpdate(
  headers: HeaderMap,
  observedAt: number,
): UsageLimitsUpdate | null {
  const read = headerReader(headers);
  const windows: UsageWindow[] = [];
  for (const slot of SLOTS) {
    const usedPercent = percentOf(read(`x-codex-${slot}-used-percent`));
    const minutes = finiteNumber(read(`x-codex-${slot}-window-minutes`));
    if (usedPercent === undefined || minutes === undefined || minutes <= 0) continue;
    const resetsAt =
      epochSecondsToIso(read(`x-codex-${slot}-reset-at`)) ??
      secondsFromNowToIso(read(`x-codex-${slot}-reset-after-seconds`), observedAt);
    windows.push(codexWindow(minutes, usedPercent, resetsAt));
  }
  if (windows.length === 0) return null;
  return { observedAt, windows: sortWindows(windows) };
}

/**
 * The windows the usage endpoint answered with.
 *
 * A failed probe rather than an empty success when the body carries no
 * `rate_limit` windows: the endpoint always names at least a primary window
 * for a subscribed account, so a body without one is not this account's usage.
 */
export function codexUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return probeFailed(checkedAt);
  }
  const rateLimit = (body as { rate_limit?: unknown }).rate_limit;
  if (typeof rateLimit !== "object" || rateLimit === null) return probeFailed(checkedAt);
  const windows: UsageWindow[] = [];
  for (const slot of SLOTS) {
    const entry = (rateLimit as Record<string, unknown>)[`${slot}_window`];
    if (typeof entry !== "object" || entry === null) continue;
    const fields = entry as {
      used_percent?: unknown;
      limit_window_seconds?: unknown;
      reset_after_seconds?: unknown;
      reset_at?: unknown;
    };
    const usedPercent = percentOf(fields.used_percent);
    const seconds = finiteNumber(fields.limit_window_seconds);
    if (usedPercent === undefined || seconds === undefined || seconds <= 0) continue;
    const resetsAt =
      epochSecondsToIso(fields.reset_at) ??
      secondsFromNowToIso(fields.reset_after_seconds, checkedAt);
    windows.push(codexWindow(seconds / 60, usedPercent, resetsAt));
  }
  if (windows.length === 0) return probeFailed(checkedAt);
  return { checkedAt, windows: sortWindows(windows) };
}

function codexWindow(
  minutes: number,
  usedPercent: number,
  resetsAt: string | undefined,
): UsageWindow {
  const rounded = Math.round(minutes);
  return {
    ...windowShapeForMinutes(rounded),
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    windowDurationMins: rounded,
  };
}

/** Shortest window first: the session row above the weekly one, whichever slot carried each. */
function sortWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.toSorted(
    (left, right) => (left.windowDurationMins ?? 0) - (right.windowDurationMins ?? 0),
  );
}

function probeFailed(checkedAt: number): UsageLimits {
  return { checkedAt, windows: [], unavailable: { reason: "probeFailed" } };
}
