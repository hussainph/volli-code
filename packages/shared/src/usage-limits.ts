/**
 * Subscription usage limits, as one provider account reports them (VC-263).
 *
 * A subscription meters use in WINDOWS — a five-hour session allowance and a
 * seven-day one on Claude Pro/Max, a session and a weekly one on Codex — and
 * each window is a share used and a moment it resets. Two sources say the same
 * thing in different clothes: an on-demand read of the provider's usage
 * endpoint during a Model Access probe, and the rate-limit headers every turn's
 * response carries. Both are mapped to this one vocabulary in
 * `@volli/agent-runtime`, keyed by the same window ids, so a header seen
 * mid-turn lands on the row a probe drew.
 *
 * Everything here is pure. The fold rules that decide what a person sees when
 * the two sources disagree — a failed probe never wipes the last good read, an
 * `unsupported` verdict is final — live here so a renderer and a main process
 * cannot each have their own reading of them.
 */

/** How long a window is, as a family: what the label should say and how rows sort. */
export type UsageWindowKind = "session" | "weekly" | "monthly" | "other";

/** One metered window of one account. */
export interface UsageWindow {
  /**
   * Stable across both sources for one provider — `five_hour`/`seven_day` on
   * Anthropic, `session`/`weekly` on Codex — so a passive update upserts the
   * row an on-demand read created rather than adding a second one.
   */
  id: string;
  kind: UsageWindowKind;
  /** What the row is called. A noun; the control is the explanation. */
  label: string;
  /** 0–100. Clamped by the mappers, trusted here. */
  usedPercent: number;
  /** When the window resets, ISO 8601. Absent when the source did not say. */
  resetsAt?: string;
  /**
   * The window's length, in minutes. With {@link resetsAt} it places "now"
   * inside the window, which is what the pace reading needs.
   */
  windowDurationMins?: number;
}

/**
 * Why an account has no windows to show.
 *
 * `unsupported` is a fact about the account — an API key is metered by
 * invoice, not by window, and no later read can change that. `probeFailed`
 * is a fact about one attempt, and the fold treats it as such: it never
 * replaces a good read that came before it.
 */
export type UsageLimitsUnavailableReason = "unsupported" | "probeFailed";

/** What one account's usage looked like the last time anything reported it. */
export interface UsageLimits {
  /** When these numbers were last confirmed, epoch milliseconds. */
  checkedAt: number;
  windows: readonly UsageWindow[];
  unavailable?: { reason: UsageLimitsUnavailableReason };
}

/**
 * A partial report: whichever windows one response happened to name.
 *
 * A turn's headers may carry the session window without the weekly one, or a
 * utilization without its reset. The fold upserts what arrived and keeps the
 * rest of each row as it was.
 */
export interface UsageLimitsUpdate {
  /** When the response that carried these was received, epoch milliseconds. */
  observedAt: number;
  windows: readonly UsageWindow[];
}

/** Where a person stands against even spending across the window. */
export type UsagePace = "ahead" | "on" | "under";

/**
 * The band around even pace that still reads as "on pace", in percentage
 * points. Narrower and every row would flip between glyphs turn to turn; wider
 * and a window half spent at a quarter of its length would read as fine.
 */
export const USAGE_PACE_BAND_POINTS = 5;

/** The share of the window still available, 0–100. */
export function remainingPercent(window: Pick<UsageWindow, "usedPercent">): number {
  return clampPercent(100 - window.usedPercent);
}

/**
 * How far into the window `now` is, 0–1, or null when the window cannot be
 * placed — no reset time, no length, or a length that is not positive.
 *
 * A window whose reset has already passed reads as fully elapsed rather than
 * beyond it: the provider has not reported the new window yet, and a share
 * over one would draw the hairline off the bar.
 */
export function elapsedShare(
  window: Pick<UsageWindow, "resetsAt" | "windowDurationMins">,
  now: number,
): number | null {
  if (window.resetsAt === undefined || window.windowDurationMins === undefined) return null;
  if (!(window.windowDurationMins > 0)) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (Number.isNaN(resetsAt)) return null;
  const durationMs = window.windowDurationMins * 60_000;
  const startedAt = resetsAt - durationMs;
  return Math.min(1, Math.max(0, (now - startedAt) / durationMs));
}

/**
 * Whether spending is ahead of, on, or under an even pace across the window.
 *
 * `ahead` means more has been used than the elapsed share would predict — the
 * allowance will run out before the reset if the rate holds. Null when the
 * window cannot be placed in time.
 */
export function paceOf(window: UsageWindow, now: number): UsagePace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const difference = window.usedPercent - elapsed * 100;
  if (difference > USAGE_PACE_BAND_POINTS) return "ahead";
  if (difference < -USAGE_PACE_BAND_POINTS) return "under";
  return "on";
}

/**
 * A duration as a countdown reads it: the two largest units that are not zero.
 *
 * `2h 13m`, `3d 4h`, `45m`, and `<1m` below the minute — never seconds, because
 * these countdowns are anchored once and never tick, so a seconds figure would
 * be wrong within moments of being drawn.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) return "<1m";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * `resets in 2h 13m`, or `resets now` once the reset time has passed and the
 * provider has not yet reported the next window. Null when the source never
 * said when the window resets.
 */
export function formatResetsIn(window: Pick<UsageWindow, "resetsAt">, now: number): string | null {
  if (window.resetsAt === undefined) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (Number.isNaN(resetsAt)) return null;
  if (resetsAt <= now) return "resets now";
  return `resets in ${formatDuration(resetsAt - now)}`;
}

/**
 * Folds one partial report into what is held for the account.
 *
 * Upsert by window id. A window the update names replaces the held row field
 * by field, except that a reset time or a length the update omits is kept from
 * before — a header that carries utilization alone must not erase the reset a
 * fuller read supplied. Windows the update does not name are untouched.
 *
 * Returns the very same object when nothing changed, so a holder comparing by
 * identity can tell a confirming update from a changing one without a deep
 * compare — and so the renderer is not told about a snapshot that says what
 * the last one said.
 *
 * `unsupported` is authoritative. An API-key account has no windows and never
 * grows any; whatever headers such a response carries are not this account's
 * subscription, and are dropped.
 */
export function applyUsageLimitsUpdate(
  current: UsageLimits | undefined,
  update: UsageLimitsUpdate,
): UsageLimits | undefined {
  if (current?.unavailable?.reason === "unsupported") return current;
  if (update.windows.length === 0) return current;
  const held = current?.windows ?? [];
  const next: UsageWindow[] = [...held];
  let changed = current === undefined || current.unavailable !== undefined;
  for (const incoming of update.windows) {
    const index = next.findIndex((window) => window.id === incoming.id);
    const prior = index === -1 ? undefined : next[index];
    const merged = mergeWindow(prior, incoming);
    if (prior === undefined) {
      next.push(merged);
      changed = true;
    } else if (!sameWindow(prior, merged)) {
      next[index] = merged;
      changed = true;
    }
  }
  if (!changed) return current;
  return { checkedAt: update.observedAt, windows: next };
}

/**
 * What a completed on-demand probe leaves published.
 *
 * A probe that failed says nothing about the account — only about the attempt —
 * so it keeps the last good read rather than replacing it with a shrug. Every
 * other outcome is authoritative: a full read replaces the held windows
 * wholesale (a window the provider stopped reporting is gone, not stale), and
 * an `unsupported` verdict stands whatever headers were folded before it.
 */
export function resolveUsageLimitsAfterProbe(
  published: UsageLimits | undefined,
  probe: UsageLimits,
): UsageLimits {
  if (probe.unavailable?.reason !== "probeFailed") return probe;
  if (published === undefined || published.unavailable !== undefined) return probe;
  return published;
}

function mergeWindow(prior: UsageWindow | undefined, incoming: UsageWindow): UsageWindow {
  const resetsAt = incoming.resetsAt ?? prior?.resetsAt;
  const windowDurationMins = incoming.windowDurationMins ?? prior?.windowDurationMins;
  return {
    id: incoming.id,
    kind: incoming.kind,
    label: incoming.label,
    usedPercent: clampPercent(incoming.usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function sameWindow(left: UsageWindow, right: UsageWindow): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.usedPercent === right.usedPercent &&
    left.resetsAt === right.resetsAt &&
    left.windowDurationMins === right.windowDurationMins
  );
}

/** 0–100, and a number that is not one (NaN) reads as nothing used. */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
