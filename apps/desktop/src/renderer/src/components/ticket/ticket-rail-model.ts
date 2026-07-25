/**
 * Pure ticket-rail mode contract (decision #46 / monaco-migration §8).
 *
 * The rail is a navigator: its four icon modes only switch what the contextual
 * rail indexes. Changing mode must never open, close, replace, or steal focus
 * from a main-view tab — only a deliberate list-item selection does that.
 * Properties is the deliberate exception and renders metadata in the rail
 * itself; that still must not mutate the active tab.
 */

export const TICKET_RAIL_MODES = ["sessions", "files", "changes", "properties"] as const;

export type TicketRailMode = (typeof TICKET_RAIL_MODES)[number];

/** Default mode when nothing is persisted — Sessions dominate the rail. */
export const DEFAULT_TICKET_RAIL_MODE: TicketRailMode = "sessions";

/**
 * Couples rail mode with the main strip's active tab solely so mode switches
 * can be proven not to touch the tab. The store keeps these fields separate;
 * this shape exists for the pure decision-#46 contract.
 */
export interface TicketRailChrome {
  mode: TicketRailMode;
  /** Current main-strip active tab id (`"doc"`, `file:…`, or a session id). */
  activeTabId: string;
}

export function isTicketRailMode(value: unknown): value is TicketRailMode {
  return typeof value === "string" && (TICKET_RAIL_MODES as readonly string[]).includes(value);
}

/**
 * Switch the rail's icon mode. Returns a new chrome snapshot whose
 * `activeTabId` is **identical** to the input — never opens, closes, or
 * replaces a main-view tab (decision #46).
 */
export function selectRailMode(chrome: TicketRailChrome, mode: TicketRailMode): TicketRailChrome {
  return { mode, activeTabId: chrome.activeTabId };
}

/**
 * Deliberate list-item selection: focus (or open) a main-view tab. Mode is
 * unchanged — the rail stays on whatever navigator the user was browsing.
 * Files/Changes agents call this (via the workspace store's set/open helpers)
 * when a row is clicked; they must never call it from agent/fs events alone.
 */
export function selectRailDestination(chrome: TicketRailChrome, tabId: string): TicketRailChrome {
  return { mode: chrome.mode, activeTabId: tabId };
}
