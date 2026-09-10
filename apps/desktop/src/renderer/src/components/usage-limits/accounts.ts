/**
 * Which accounts the usage-limits popover lists, and in what order.
 *
 * The popover answers one question — "am I about to run out of anything?" —
 * from anywhere in the app, so the answer has to survive being read at a
 * glance, with only one account expanded. Two decisions make that possible and
 * both live here rather than in the view:
 *
 * - **The BINDING window is the account's headline.** An account meters two or
 *   three windows and only one of them is about to stop a turn. That one is
 *   what the collapsed row states, so a closed accordion is still an answer.
 * - **The account closest to running out sorts first**, so the thing worth
 *   knowing is the thing already on top and open. Accounts that measured the
 *   same fall back to their name, which keeps the order still while numbers
 *   drift; an account whose read failed has nothing to compare and sits last.
 *
 * An `unsupported` account is not listed at all. That verdict is a fact about
 * the account rather than about one attempt — an API key is invoiced, not
 * windowed — so a row for it would be a row that can never change, taking
 * space in a surface whose whole argument is that it is small.
 */

import { remainingPercent, type ModelAccessProvider, type UsageLimits } from "@volli/shared";
import type { UsageWindow } from "@volli/shared";

/** One signed-in account with subscription windows to show. */
export interface UsageLimitAccount {
  providerId: string;
  /** The provider's own name, as Pi's catalogue states it. */
  label: string;
  limits: UsageLimits;
  /**
   * The window with the least left — what the collapsed row states and what
   * the ordering is taken from. Null when this account has no window to show,
   * which today means a read that failed.
   */
  binding: UsageWindow | null;
}

export function usageLimitAccounts(
  providers: readonly ModelAccessProvider[],
): readonly UsageLimitAccount[] {
  const accounts: UsageLimitAccount[] = [];
  for (const provider of providers) {
    const limits = provider.usageLimits;
    if (limits === undefined) continue;
    if (limits.unavailable?.reason === "unsupported") continue;
    accounts.push({
      providerId: provider.id,
      label: provider.label,
      limits,
      binding: bindingWindow(limits.windows),
    });
  }
  return accounts.toSorted(compareAccounts);
}

/** The window with the least left, or null when there is none. */
function bindingWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  let binding: UsageWindow | null = null;
  for (const window of windows) {
    if (binding === null || remainingPercent(window) < remainingPercent(binding)) binding = window;
  }
  return binding;
}

/** Least left first; then by name, so equal readings keep a settled order. */
function compareAccounts(left: UsageLimitAccount, right: UsageLimitAccount): number {
  if (left.binding === null || right.binding === null) {
    // An account with no reading has nothing to be closer or further with.
    if (left.binding !== null) return -1;
    if (right.binding !== null) return 1;
    return left.label.localeCompare(right.label);
  }
  const difference = remainingPercent(left.binding) - remainingPercent(right.binding);
  return difference !== 0 ? difference : left.label.localeCompare(right.label);
}
