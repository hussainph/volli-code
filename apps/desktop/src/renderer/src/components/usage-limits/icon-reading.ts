/**
 * What the window-bar glyph draws, derived from what the popover already lists
 * (VC-376).
 *
 * NOTHING NEW IS COMPUTED HERE, and that is the module's whole job. The icon
 * sits directly above the bars it summarises, so the one failure it is not
 * allowed to have is disagreeing with them: `accounts.ts` already picks the
 * account closest to running out and the window that binds it, `usageTone`
 * already decides the verdict, and `remainingPercent` already rounds the
 * figure the rows print. Everything below is a rearrangement of
 * {@link UsageLimitAccount} into the handful of facts a 26px box can hold —
 * the lead account, its windows in a fixed order, and a count of the other
 * metered accounts for the accessible name.
 *
 * THE PIN IS THE ONE INPUT THE POPOVER DOES NOT HAVE (VC-452), and it is a
 * lens rather than a new rule: it chooses which account and windows are
 * DRAWN, and leaves every number, tone and binding exactly as computed. See
 * `usage-pin.ts`.
 *
 * A glyph derived any other way would drift the first time one of those rules
 * changed, and it would drift silently: an icon and a popover are never on
 * screen at the same moment, so nobody would see the two disagree.
 */

import { paceOf, remainingPercent, usageTone } from "@volli/shared";
import type { UsagePace, UsageTone, UsageWindow, UsageWindowKind } from "@volli/shared";

import type { UsageLimitAccount } from "@renderer/components/usage-limits/accounts";
import type { UsagePin } from "@renderer/components/usage-limits/usage-pin";

/** One window, with the things a drawing needs and nothing else. */
export interface UsageWindowReading {
  id: string;
  kind: UsageWindowKind;
  /** `Session`, `Weekly` — the provider's own word, for the spoken name. */
  label: string;
  /** 0–100, whole points: the same rounding the popover's rows print. */
  remaining: number;
  tone: UsageTone;
  /**
   * Ahead of, on, or under an even burn across the window; null when the
   * window cannot be placed in time. Straight from `paceOf`, never re-derived,
   * because `usageTone` turns amber on this alone — a glyph that computed pace
   * for itself could be amber for a reason its own drawing denied.
   */
  pace: UsagePace | null;
}

/** One account reduced to what a glyph can carry about it. */
export interface UsageAccountReading {
  providerId: string;
  label: string;
  /** Ordered by {@link KIND_ORDER}, so a slot's position means one thing. */
  windows: readonly UsageWindowReading[];
  /** The window with the least left — `accounts.ts` picked it, not us. */
  binding: UsageWindowReading | null;
}

/** What the surface knows, mirroring the popover's own reading. */
export type UsageIconInput =
  /** Nothing has been asked for yet. */
  | { kind: "unread" }
  /** Asked, and the answer never came. */
  | { kind: "failed" }
  | {
      kind: "read";
      accounts: readonly UsageLimitAccount[];
      /**
       * The clock the snapshot is judged against, captured when it was read
       * rather than per render: tone reads pace, so a reading re-derived at
       * paint time could change verdict while nothing about the numbers did.
       */
      now: number;
    };

/** Everything the glyph draws, in one object. */
export interface UsageIconReading {
  kind: UsageIconInput["kind"];
  /**
   * The account the glyph reports: the pinned one when the pin resolves,
   * otherwise the one nearest to running out. Null when none.
   */
  lead: UsageAccountReading | null;
  /**
   * The window the spoken name leads with: the one with least left among the
   * pinned windows, or the lead's binding window when nothing is pinned.
   */
  reported: UsageWindowReading | null;
  /**
   * The lead's windows the pin resolved to, in family order. Empty when
   * nothing is pinned or the pin names nothing this snapshot reports.
   */
  pinned: readonly UsageWindowReading[];
  /** Every other metered account — a count for the spoken name. */
  others: readonly UsageAccountReading[];
}

const EMPTY: UsageIconReading = {
  kind: "unread",
  lead: null,
  reported: null,
  pinned: [],
  others: [],
};

/**
 * Session first, then the longer spans.
 *
 * The order is by window FAMILY and never by value. The glyph prints two
 * figures stacked, and a stack that re-sorted itself as numbers crossed each
 * other would be unlearnable — the top slot has to mean "the short window"
 * every day, or reading the icon means reading it twice.
 */
const KIND_ORDER: Record<UsageWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function usageIconReading(
  input: UsageIconInput,
  pin: UsagePin | null = null,
): UsageIconReading {
  if (input.kind !== "read") return { ...EMPTY, kind: input.kind };
  // An account whose own read failed has no window to report and no tone to
  // contribute. It stays in the popover, where a line can explain it; it is
  // nothing to a glyph, so it is dropped before the others are counted.
  const readings = input.accounts
    .map((account) => accountReading(account, input.now))
    .filter(hasBinding);
  // A pin that names no account or window this snapshot reports — signed out,
  // or a window the provider stopped sending — falls back to the sort rather
  // than blanking the glyph. Half a pin that still resolves is still honoured.
  const pinnedIds = pin?.windowIds ?? [];
  const pinnedAccount = readings.findIndex((reading) => reading.providerId === pin?.providerId);
  const pinned =
    readings[pinnedAccount]?.windows.filter((window) => pinnedIds.includes(window.id)) ?? [];
  const leadIndex = pinned.length === 0 ? 0 : pinnedAccount;
  const lead = readings[leadIndex];
  if (lead === undefined) return { ...EMPTY, kind: "read" };
  return {
    kind: "read",
    lead,
    reported: pinned.length === 0 ? lead.binding : leastLeft(pinned),
    pinned,
    others: readings.filter((_, index) => index !== leadIndex),
  };
}

/** The window with least left; the first in family order on a tie. */
function leastLeft(windows: readonly UsageWindowReading[]): UsageWindowReading | null {
  let least: UsageWindowReading | null = null;
  for (const window of windows) {
    if (least === null || window.remaining < least.remaining) least = window;
  }
  return least;
}

function accountReading(account: UsageLimitAccount, now: number): UsageAccountReading {
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

function windowReading(window: UsageWindow, now: number): UsageWindowReading {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    // Rounded here, once, so the figure in the glyph is the figure the row
    // prints. A glyph drawn from 7.4 beside a row that says 7% is the surface
    // disagreeing with itself by a point.
    remaining: Math.round(remainingPercent(window)),
    tone: usageTone(window, now),
    pace: paceOf(window, now),
  };
}

function hasBinding(
  account: UsageAccountReading,
): account is UsageAccountReading & { binding: UsageWindowReading } {
  return account.binding !== null;
}

/**
 * The two windows the glyph prints, in family order.
 *
 * Pinned windows are ALWAYS among them, and so is the reported window: a
 * glyph whose bars report a window neither figure names would be arguing with
 * itself. Two pins fill both slots; otherwise the free slot goes to the next
 * window by family order, so an account reporting three (OpenCode Go) loses
 * its third rather than reshuffling the two that stayed.
 *
 * One window fills the top slot and lends its reading to both bars — see
 * `usage-limits-icon.tsx` for why an empty second bar is worse than a
 * mirrored one.
 */
export function usageIconWindows(reading: UsageIconReading): readonly UsageWindowReading[] {
  const windows = reading.lead?.windows ?? [];
  if (windows.length <= 2) return windows;
  const kept = new Set(reading.pinned.map((window) => window.id));
  if (reading.reported !== null) kept.add(reading.reported.id);
  for (const window of windows) {
    if (kept.size >= 2) break;
    kept.add(window.id);
  }
  // Filtered from the family-ordered list rather than rebuilt from the set, so
  // what comes back is always in family order and the slots cannot swap.
  return windows.filter((window) => kept.has(window.id));
}

/**
 * The accessible name the button carries.
 *
 * A control whose whole name changes with a number is a control nobody can
 * tell a screen reader to press, so the name keeps a stable head and the
 * reading is a suffix — "Usage limits, 8% left on Anthropic Session". Both
 * `getByLabelText(/^Usage limits/)` and `[aria-label^="Usage limits"]` still
 * find it, which is what VC-376 asked for when it made the name dynamic.
 *
 * PACE IS SPOKEN, because in this drawing it is not drawn. `usageTone` turns
 * amber on pace alone, and the two figures leave no room for the notch the
 * round variants used to mark it with — so for a reader the alternative to
 * saying it is an amber nobody can hear and, on a screen, a colour some people
 * cannot see. The same words would otherwise describe a window that is fine.
 *
 * A PIN IS SPOKEN TOO. A pinned glyph may be reporting an account that is NOT
 * the nearest to running out, and a reader who is not told so would take it
 * for the one the sort chose.
 */
export function usageIconLabel(reading: UsageIconReading): string {
  if (reading.kind === "unread") return "Usage limits";
  if (reading.kind === "failed") return "Usage limits, not read";
  if (reading.lead === null || reading.reported === null) return "Usage limits, none metered";
  const head = `Usage limits, ${reading.reported.remaining}% left on ${reading.lead.label} ${reading.reported.label}`;
  const paced = reading.reported.pace === "ahead" ? `${head}, ahead of pace` : head;
  const pinned = reading.pinned.length === 0 ? paced : `${paced}, pinned`;
  if (reading.others.length === 0) return pinned;
  return `${pinned}, ${reading.others.length} more metered`;
}
