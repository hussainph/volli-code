/**
 * File-tab identity for ticket workspace File tabs (CONCEPT #48/#56).
 *
 * Tab id is path-stable: `file:<relPath>`. Preview/pin state lives on the
 * tab record itself (`FileWorkspaceTab.pinned`), not in the id.
 */

/** Stable tab id for a ticket file of `relPath` (`file:<relPath>`). */
export function fileTabId(relPath: string): string {
  return `file:${relPath}`;
}

/**
 * Inverse of {@link fileTabId}: returns the relPath, or `null` when `tabId` is
 * not a well-formed file tab id.
 */
export function parseFileTabId(tabId: string): string | null {
  if (!tabId.startsWith("file:")) return null;
  const relPath = tabId.slice("file:".length);
  return relPath.length > 0 ? relPath : null;
}

/** Whether `tabId` names a ticket file tab. */
export function isFileTabId(tabId: string): boolean {
  return parseFileTabId(tabId) !== null;
}
