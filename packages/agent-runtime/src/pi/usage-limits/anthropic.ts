/**
 * Anthropic's subscription windows, from either place they are stated.
 *
 * A Claude Pro/Max account is metered in a five-hour window and a seven-day
 * one, and sometimes a seven-day window scoped to one model family. Two
 * sources carry the same facts:
 *
 * - **Every `/v1/messages` response** answered under an OAuth token carries
 *   `anthropic-ratelimit-unified-{5h,7d}-utilization` (a 0–1 fraction),
 *   `-reset` (epoch seconds) and `-status`; a model-scoped window appears as
 *   `anthropic-ratelimit-unified-7d-<model>-*`.
 * - **`GET /api/oauth/usage`** answers `{ five_hour, seven_day, seven_day_<model>
 *   … }`, each `{ utilization: 0–100, resets_at: ISO }`, without spending a
 *   token. The endpoint is rate-limited on its own — see `probe.ts`.
 *
 * Both map to the same window ids — `five_hour`, `seven_day`, `seven_day_<model>`
 * — so a header seen mid-turn lands on the row the probe drew. The ids are
 * the endpoint's own keys because that is the one spelling a reader can look
 * up; the header's `5h`/`7d` are translated to them here and nowhere else.
 */

import {
  clampPercent,
  type UsageLimits,
  type UsageLimitsUpdate,
  type UsageWindow,
} from "@volli/shared";

import {
  epochSecondsToIso,
  finiteNumber,
  headerReader,
  isoTimestamp,
  percentOf,
  SESSION_WINDOW_MINS,
  WEEKLY_WINDOW_MINS,
  type HeaderMap,
} from "./windows";

const HEADER_PREFIX = "anthropic-ratelimit-unified-";
/** `5h` or `7d`, an optional model segment, then which fact — anchored so a hyphenated model reads whole. */
const HEADER_PATTERN =
  /^anthropic-ratelimit-unified-(5h|7d)(?:-(.+?))?-(utilization|reset|status)$/;
/** `five_hour`, `seven_day`, or `seven_day_<model>` — nothing else the endpoint answers is a window. */
const ENDPOINT_KEY_PATTERN = /^(five_hour|seven_day)(?:_([a-z0-9_]+))?$/;

/**
 * The windows one response's headers state, or null when it states none.
 *
 * A window with no utilization header is skipped rather than drawn at zero: a
 * reset alone says when, not how much. The reset is optional on a window that
 * does have a utilization, and the fold keeps a prior one when it is missing.
 */
export function anthropicHeadersToUpdate(
  headers: HeaderMap,
  observedAt: number,
): UsageLimitsUpdate | null {
  const read = headerReader(headers);
  const seen = new Map<string, { span: "5h" | "7d"; model: string | undefined }>();
  for (const key of Object.keys(headers)) {
    const lowered = key.toLowerCase();
    if (!lowered.startsWith(HEADER_PREFIX)) continue;
    const match = HEADER_PATTERN.exec(lowered);
    if (match === null) continue;
    const span = match[1] as "5h" | "7d";
    const model = match[2];
    seen.set(`${span}${model === undefined ? "" : `-${model}`}`, { span, model });
  }
  const windows: UsageWindow[] = [];
  for (const [prefix, { span, model }] of seen) {
    const fraction = finiteNumber(read(`${HEADER_PREFIX}${prefix}-utilization`));
    if (fraction === undefined) continue;
    const resetsAt = epochSecondsToIso(read(`${HEADER_PREFIX}${prefix}-reset`));
    windows.push(anthropicWindow(span, model, clampPercent(fraction * 100), resetsAt));
  }
  if (windows.length === 0) return null;
  return { observedAt, windows: sortWindows(windows) };
}

/**
 * The windows the usage endpoint answered with.
 *
 * Reported as a failed probe rather than an empty success when the body is
 * not the shape expected or names no window at all: an account with a
 * subscription always has its two windows, so a body without them is a wire
 * that changed, and the honest thing to show is the last good read.
 */
export function anthropicUsageFromEndpoint(body: unknown, checkedAt: number): UsageLimits {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return probeFailed(checkedAt);
  }
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const match = ENDPOINT_KEY_PATTERN.exec(key);
    if (match === null) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { utilization?: unknown; resets_at?: unknown };
    const percent = percentOf(entry.utilization);
    if (percent === undefined) continue;
    const span = match[1] === "five_hour" ? "5h" : "7d";
    windows.push(anthropicWindow(span, match[2], percent, isoTimestamp(entry.resets_at)));
  }
  if (windows.length === 0) return probeFailed(checkedAt);
  return { checkedAt, windows: sortWindows(windows) };
}

function anthropicWindow(
  span: "5h" | "7d",
  model: string | undefined,
  usedPercent: number,
  resetsAt: string | undefined,
): UsageWindow {
  const base = span === "5h" ? "five_hour" : "seven_day";
  const modelKey = model === undefined ? undefined : model.replaceAll("-", "_");
  return {
    id: modelKey === undefined ? base : `${base}_${modelKey}`,
    kind: span === "5h" ? "session" : "weekly",
    label:
      span === "5h" ? "Session" : model === undefined ? "Weekly" : `Weekly · ${modelLabel(model)}`,
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    windowDurationMins: span === "5h" ? SESSION_WINDOW_MINS : WEEKLY_WINDOW_MINS,
  };
}

/** `opus` → `Opus`, `sonnet-4` → `Sonnet 4`: the provider's own family name, capitalized. */
function modelLabel(model: string): string {
  const words = model.replaceAll(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Session first, then the account-wide weekly window, then model-scoped ones by id. */
function sortWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows.toSorted(
    (left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id),
  );
}

function rank(window: UsageWindow): number {
  if (window.kind === "session") return 0;
  return window.id === "seven_day" ? 1 : 2;
}

function probeFailed(checkedAt: number): UsageLimits {
  return { checkedAt, windows: [], unavailable: { reason: "probeFailed" } };
}
