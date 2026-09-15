/**
 * What the window-bar glyph is asked to draw, derived from what the popover
 * already lists (VC-376).
 *
 * This module exists so the candidate drawings next door cannot each invent
 * their own idea of "the account closest to running out". `accounts.ts` in the
 * app already picks that account and its binding window for the collapsed row,
 * and `usageTone` in shared already decides the colour — an icon that computed
 * either one itself could disagree with the bars it sits above, which is the
 * one failure the redesign is not allowed to have.
 *
 * SO NOTHING NEW IS COMPUTED HERE. Everything below is a rearrangement of
 * `UsageLimitAccount` into the shapes a 14px box can draw: one lead arc, a
 * short list of windows for a segmented ring, and a count of the other metered
 * accounts for the dots.
 *
 * THE PIN IS THE ONE ADDITION, and it is deliberately a lens rather than a
 * fact: pinning changes which window the glyph reports, never which window is
 * binding. An unpinned glyph tracks whatever is nearest to running out, which
 * is right nearly always and wrong exactly when a person is nursing one
 * particular window through a long Session. See `PinnedWindow`.
 */

import {
  remainingPercent,
  usageTone,
  type UsageTone,
  type UsageWindow,
  type UsageWindowKind,
} from "@volli/shared";

import type { UsageLimitAccount } from "@renderer/components/usage-limits/accounts";

/** What the surface knows, mirroring the popover's own `Reading`. */
export type ReadingKind = "unread" | "failed" | "read";

/**
 * A window the person chose to keep the glyph on, identified the way a
 * snapshot identifies one: provider plus window id. Both are stable across
 * reads, so a pin survives a Refresh, a sign-out of some other account, and a
 * window whose numbers moved.
 */
export interface PinnedWindow {
  providerId: string;
  windowId: string;
}

/** One window, with the two things a drawing needs and nothing else. */
export interface WindowReading {
  id: string;
  kind: UsageWindowKind;
  label: string;
  /** 0–100, whole points — the same rounding the popover's rows print. */
  remaining: number;
  tone: UsageTone;
}

/** One account reduced to what a glyph can carry about it. */
export interface AccountReading {
  providerId: string;
  label: string;
  /** Sorted by {@link KIND_ORDER}, so a segment's position means one thing. */
  windows: readonly WindowReading[];
  /** The window with the least left — `accounts.ts` picked it, not us. */
  binding: WindowReading | null;
}

/**
 * Everything the glyph draws, in one object.
 *
 * `lead` is the account the ring reports: the pinned one if a pin resolves,
 * otherwise the nearest to running out, which `accounts.ts` already sorted to
 * the front. `others` is every remaining metered account — a count for the
 * dots, plus each one's tone so a dot can say "not this one, but look".
 */
export interface IconReading {
  kind: ReadingKind;
  /** Null when read succeeded but nothing is metered, and on unread/failed. */
  lead: AccountReading | null;
  /** The window the ring's arc reports. Null when the lead has none. */
  reported: WindowReading | null;
  /** Whether {@link reported} came from a pin rather than from the sort. */
  pinned: boolean;
  others: readonly AccountReading[];
  /** The worst tone anywhere in `others` — what tints the dots, if anything. */
  othersTone: UsageTone | null;
}

/**
 * Session first, then the longer spans. A segmented ring is only readable if a
 * segment's position is fixed, so the order is by window FAMILY and never by
 * value: a ring whose segments reshuffled as numbers moved would be a ring
 * nobody could learn.
 */
const KIND_ORDER: Record<UsageWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const TONE_RANK: Record<UsageTone, number> = { normal: 0, attention: 1, critical: 2 };

export function iconReading(
  kind: ReadingKind,
  accounts: readonly UsageLimitAccount[],
  now: number,
  pin: PinnedWindow | null = null,
): IconReading {
  if (kind !== "read") {
    return { kind, lead: null, reported: null, pinned: false, others: [], othersTone: null };
  }
  // An account whose own read failed has no window to report and no tone to
  // contribute. It stays in the popover, where a line can explain it; it is
  // nothing to a glyph, so it is dropped before the dots are counted.
  const readings = accounts.map((account) => accountReading(account, now)).filter(hasBinding);
  if (readings.length === 0) {
    return { kind, lead: null, reported: null, pinned: false, others: [], othersTone: null };
  }

  const pinnedIndex =
    pin === null ? -1 : readings.findIndex((r) => r.providerId === pin.providerId);
  const pinnedWindow =
    pin === null || pinnedIndex === -1
      ? undefined
      : readings[pinnedIndex]?.windows.find((w) => w.id === pin.windowId);
  // A pin whose account signed out, or whose window the provider stopped
  // reporting, silently falls back to the sort rather than blanking the glyph.
  // The pin is a preference about a drawing, not a promise the provider made.
  const leadIndex = pinnedWindow === undefined ? 0 : pinnedIndex;
  const lead = readings[leadIndex] ?? null;
  const others = readings.filter((_, index) => index !== leadIndex);

  return {
    kind,
    lead,
    reported: pinnedWindow ?? lead?.binding ?? null,
    pinned: pinnedWindow !== undefined,
    others,
    othersTone: worstTone(others),
  };
}

function accountReading(account: UsageLimitAccount, now: number): AccountReading {
  const windows = account.limits.windows
    .map((window) => windowReading(window, now))
    .toSorted((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
  const bindingId = account.binding?.id;
  return {
    providerId: account.providerId,
    label: account.label,
    windows,
    binding: windows.find((window) => window.id === bindingId) ?? null,
  };
}

function windowReading(window: UsageWindow, now: number): WindowReading {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    // Rounded here, once, so the arc and any number printed inside it are the
    // same figure the popover's row prints. A ring drawn from 7.4 beside a row
    // that says 7% is the surface disagreeing with itself by one point.
    remaining: Math.round(remainingPercent(window)),
    tone: usageTone(window, now),
  };
}

function hasBinding(
  account: AccountReading,
): account is AccountReading & { binding: WindowReading } {
  return account.binding !== null;
}

function worstTone(accounts: readonly AccountReading[]): UsageTone | null {
  let worst: UsageTone | null = null;
  for (const account of accounts) {
    const tone = account.binding?.tone;
    if (tone === undefined) continue;
    if (worst === null || TONE_RANK[tone] > TONE_RANK[worst]) worst = tone;
  }
  return worst;
}

/**
 * The accessible name the button carries.
 *
 * `usage-limits-popover.test.tsx` finds the trigger by `aria-label="Usage
 * limits"`, and more to the point a control whose whole name changes with a
 * number is a control nobody can tell a screen reader to press. So the name
 * keeps its stable head and the reading is a suffix — "Usage limits, 8% left
 * on Anthropic Session" — which `getByLabelText(/^Usage limits/)` and a
 * `[aria-label^="Usage limits"]` query both still find.
 */
export function iconLabel(reading: IconReading): string {
  if (reading.kind === "unread") return "Usage limits";
  if (reading.kind === "failed") return "Usage limits, not read";
  if (reading.reported === null || reading.lead === null) return "Usage limits, none metered";
  const head = `Usage limits, ${reading.reported.remaining}% left on ${reading.lead.label} ${reading.reported.label}`;
  if (reading.others.length === 0) return head;
  return `${head}, ${reading.others.length} more metered`;
}
