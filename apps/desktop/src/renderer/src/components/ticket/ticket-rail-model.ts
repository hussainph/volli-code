/**
 * Pure ticket-rail mode contract (decision #46).
 *
 * The rail is a navigator: its icon modes only switch what the contextual rail
 * indexes. Changing mode must never open, close, replace, or steal focus from a
 * main-view tab — only a deliberate list-item selection does that. Properties is
 * the deliberate exception and renders metadata in the rail itself; that still
 * must not mutate the active tab.
 *
 */

export const TICKET_RAIL_MODES = ["sessions", "files", "changes", "properties"] as const;

export type TicketRailMode = (typeof TICKET_RAIL_MODES)[number];

/** Default mode when nothing is persisted — Sessions dominate the rail. */
export const DEFAULT_TICKET_RAIL_MODE: TicketRailMode = "sessions";

/** Accessible labels for the icon-mode strip (also used as button aria-labels). */
export const TICKET_RAIL_MODE_LABELS: Record<TicketRailMode, string> = {
  sessions: "Sessions",
  files: "Files",
  changes: "Changes",
  properties: "Properties",
};

/**
 * Couples rail mode with the main strip's active tab solely so mode switches
 * can be proven not to touch the tab. The store keeps these fields separate;
 * this shape exists for the pure decision-#46 contract.
 */
export interface TicketRailChrome {
  mode: TicketRailMode;
  /** Current main-strip active tab id (`"doc"`, `file:…`, `diff:…`, or a session id). */
  activeTabId: string;
}

export function isTicketRailMode(value: unknown): value is TicketRailMode {
  return typeof value === "string" && (TICKET_RAIL_MODES as readonly string[]).includes(value);
}

/** The modes a strip offers, in strip order. */
export function availableRailModes(): readonly TicketRailMode[] {
  return TICKET_RAIL_MODES;
}

/** The mode actually rendered. */
export function resolveRailMode(chrome: TicketRailChrome): TicketRailMode {
  return chrome.mode;
}

/**
 * Switch the rail's icon mode. Returns a new chrome snapshot whose
 * `activeTabId` is **identical** to the input — never opens, closes, or
 * replaces a main-view tab (decision #46).
 */
export function selectRailMode(chrome: TicketRailChrome, mode: TicketRailMode): TicketRailChrome {
  return { ...chrome, mode };
}

/**
 * Deliberate list-item selection: focus (or open) a main-view tab. Mode is
 * unchanged — the rail stays on whatever navigator the user was browsing.
 * Files/Changes agents call this (via the workspace store's set/open helpers)
 * when a row is clicked; they must never call it from agent/fs events alone.
 */
export function selectRailDestination(chrome: TicketRailChrome, tabId: string): TicketRailChrome {
  return { ...chrome, activeTabId: tabId };
}

/**
 * Rehydrate the active rail mode from persisted UI state.
 *
 * Prefers an explicit `railMode`. When absent (pre-icon-rail builds), a legacy
 * `detailsExpanded: true` maps to Properties — the user had the Details drawer
 * open. Everything else defaults to Sessions.
 */
export function resolvePersistedRailMode(stored: {
  railMode?: unknown;
  detailsExpanded?: unknown;
}): TicketRailMode {
  // `session` was a contextual rail surface. It was removed rather than
  // repurposed, so installations that persisted it recover to the default.
  if (stored.railMode === "session") return DEFAULT_TICKET_RAIL_MODE;
  if (isTicketRailMode(stored.railMode)) return stored.railMode;
  if (stored.detailsExpanded === true) return "properties";
  return DEFAULT_TICKET_RAIL_MODE;
}
