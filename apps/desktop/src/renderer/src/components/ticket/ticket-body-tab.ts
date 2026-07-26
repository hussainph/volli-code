/**
 * Ticket Body tab identity (decision #46).
 *
 * The main-strip tab formerly called "Doc" is the Ticket Body. Its **persisted
 * wire id remains `"doc"`** so existing `volli:workspace` / `app_state` rows keep
 * restoring the same active tab after upgrade — renaming the on-disk key would
 * force a one-shot migration of every ticketTabs record for no user-visible win.
 *
 * Callers use these helpers instead of scattering `"doc"` string literals; the
 * UI label is "Ticket Body" / the ticket display id, never "doc".
 */

/** Stable persisted / in-memory id of the always-present Ticket Body tab. */
export const TICKET_BODY_TAB_ID = "doc";

/**
 * Normalize a persisted or live tab id so a legacy `"doc"` value still resolves
 * to the Ticket Body tab. Unknown ids pass through unchanged (file/session tabs).
 */
export function normalizeTicketBodyTabId(tabId: string): string {
  if (tabId === "doc") return TICKET_BODY_TAB_ID;
  return tabId;
}

/** Whether `tabId` names the Ticket Body tab (including the legacy `"doc"` key). */
export function isTicketBodyTabId(tabId: string): boolean {
  return normalizeTicketBodyTabId(tabId) === TICKET_BODY_TAB_ID;
}
