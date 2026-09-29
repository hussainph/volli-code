/**
 * Which windows a person has pinned the window-bar glyph to (VC-452).
 *
 * Unpinned, the glyph reports the account nearest to running out — the rule
 * `accounts.ts` already applies to the popover. That is right nearly always,
 * and wrong in one common case: a long Session where the window you are
 * nursing is Anthropic's five-hour one while some other account's monthly
 * meter sits lower and so owns the glyph. A pin overrules the rule.
 *
 * THE GLYPH HAS TWO BARS, SO A PIN HOLDS AT MOST TWO WINDOWS, AND ONE ACCOUNT.
 * Each side of the glyph is one window's gauge and the mark between them says
 * whose they are. Two windows from two accounts would put one account's mark
 * between another account's bars, so pinning a window of a second account
 * starts a new pin rather than joining the first. A third window of the same
 * account lets go of the oldest, so the one just pressed always shows.
 *
 * IT IS A LENS, NOT A FACT. A pin changes which windows are DRAWN — never
 * which window is binding, never the popover's order. A pin whose account
 * signs out, or whose window the provider stops reporting, falls back to the
 * sort silently and is KEPT, so signing back in puts it back: it is a
 * preference about a drawing, not a promise the provider made.
 */

/** A stable address for up to two windows of one account. */
export interface UsagePin {
  providerId: string;
  /** In the order they were pinned, oldest first; one or two, never empty. */
  windowIds: readonly string[];
}

/** One per side of the glyph. */
export const MAX_PINNED_WINDOWS = 2;

export function isUsageWindowPinned(
  pin: UsagePin | null,
  providerId: string,
  windowId: string,
): boolean {
  return pin !== null && pin.providerId === providerId && pin.windowIds.includes(windowId);
}

/** What pressing the pin on one window row does to the pin that stands. */
export function toggleUsagePin(
  pin: UsagePin | null,
  providerId: string,
  windowId: string,
): UsagePin | null {
  if (pin === null || pin.providerId !== providerId) return { providerId, windowIds: [windowId] };
  if (pin.windowIds.includes(windowId)) {
    const windowIds = pin.windowIds.filter((id) => id !== windowId);
    return windowIds.length === 0 ? null : { providerId, windowIds };
  }
  return { providerId, windowIds: [...pin.windowIds, windowId].slice(-MAX_PINNED_WINDOWS) };
}

/**
 * A pin a past build wrote, read back without trusting it: anything that is
 * not one provider and one or two distinct window ids is no pin at all, and
 * the glyph goes back to its own rule rather than drawing from a guess.
 */
export function sanitizeUsagePin(value: unknown): UsagePin | null {
  if (typeof value !== "object" || value === null) return null;
  const { providerId, windowIds } = value as { providerId?: unknown; windowIds?: unknown };
  if (typeof providerId !== "string" || providerId === "") return null;
  if (!Array.isArray(windowIds)) return null;
  const ids = [
    ...new Set(windowIds.filter((id): id is string => typeof id === "string" && id !== "")),
  ].slice(-MAX_PINNED_WINDOWS);
  return ids.length === 0 ? null : { providerId, windowIds: ids };
}
