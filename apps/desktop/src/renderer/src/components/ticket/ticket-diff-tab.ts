/**
 * Diff-tab identity for ticket Change Set review (CONCEPT #48/#51, issue #109).
 *
 * Tab id is path-stable: `diff:<relPath>`. The base revision belongs on the
 * `diff-base` DocumentIdentity only and is stamped once on the ticket — it must
 * never appear in the tab id, or a base re-stamp would reopen a duplicate tab.
 */

/** Stable tab id for a ticket diff of `relPath` (`diff:<relPath>`). */
export function diffTabId(relPath: string): string {
  return `diff:${relPath}`;
}

/**
 * Inverse of {@link diffTabId}: returns the relPath, or `null` when `tabId` is
 * not a well-formed diff tab id.
 */
export function parseDiffTabId(tabId: string): string | null {
  if (!tabId.startsWith("diff:")) return null;
  const relPath = tabId.slice("diff:".length);
  return relPath.length > 0 ? relPath : null;
}

/** Whether `tabId` names a ticket diff tab. */
export function isDiffTabId(tabId: string): boolean {
  return parseDiffTabId(tabId) !== null;
}
