/**
 * Pure ticket-rail page contract (decision #46).
 *
 * The rail is a navigator: its tabs only switch which page the rail indexes.
 * Changing page must never open, close, replace, or steal focus from a
 * main-view tab — only a deliberate list-item selection does that. Now is the
 * deliberate exception and renders the ticket's own state (repository summary,
 * properties, sessions) in the rail itself; that still must not mutate the
 * active tab.
 */

/** The rail's pages, in tab order. `now` is the resting page. */
export const TICKET_RAIL_MODES = ["now", "changes", "files"] as const;

export type TicketRailMode = (typeof TICKET_RAIL_MODES)[number];

/** Default page when nothing is persisted. */
export const DEFAULT_TICKET_RAIL_MODE: TicketRailMode = "now";

/** Accessible labels for the tab pill (also used as each tab's title). */
export const TICKET_RAIL_MODE_LABELS: Record<TicketRailMode, string> = {
  now: "Now",
  changes: "Diffs",
  files: "Files",
};

/**
 * Persisted page values this build no longer offers, and where their users land.
 *
 * `railMode` is durable app state written by past builds, so every string one of
 * them could have stored stays readable here for good: dropping an entry does
 * not error, it silently strands whoever persisted it on the default with no
 * record of why. Tolerant on read, exhaustive on write.
 *
 *   session    — a contextual rail surface, removed rather than repurposed.
 *   sessions   — the session list, now the tail of the Now page.
 *   properties — the Details drawer's successor, now folded inline into Now.
 *
 * A Map rather than an object literal: the lookup key is a string a past build
 * chose, so an object would answer `"toString"` with a function off the
 * prototype chain and hand it back as a page.
 */
const RETIRED_TICKET_RAIL_MODES: ReadonlyMap<string, TicketRailMode> = new Map([
  ["session", "now"],
  ["sessions", "now"],
  ["properties", "now"],
]);

/**
 * Couples rail page with the main strip's active tab solely so page switches
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

/** The pages the tab pill offers, in tab order. */
export function availableRailModes(): readonly TicketRailMode[] {
  return TICKET_RAIL_MODES;
}

/** The page actually rendered. */
export function resolveRailMode(chrome: TicketRailChrome): TicketRailMode {
  return chrome.mode;
}

/**
 * Switch the rail's page. Returns a new chrome snapshot whose `activeTabId` is
 * **identical** to the input — never opens, closes, or replaces a main-view tab
 * (decision #46).
 */
export function selectRailMode(chrome: TicketRailChrome, mode: TicketRailMode): TicketRailChrome {
  return { ...chrome, mode };
}

/**
 * Deliberate list-item selection: focus (or open) a main-view tab. The page is
 * unchanged — the rail stays on whatever navigator the user was browsing.
 * Files/Diffs navigators call this (via the workspace store's set/open helpers)
 * when a row is clicked; they must never call it from agent/fs events alone.
 */
export function selectRailDestination(chrome: TicketRailChrome, tabId: string): TicketRailChrome {
  return { ...chrome, activeTabId: tabId };
}

/**
 * Rehydrate the active rail page from persisted UI state.
 *
 * Prefers a `railMode` this build still offers, then maps a retired one onto its
 * successor page ({@link RETIRED_TICKET_RAIL_MODES}). Only then does the legacy
 * pre-icon-rail key matter: `detailsExpanded: true` meant the old Details
 * drawer was open, which became Properties, which now lives inside Now. Nothing
 * recognised is ever written back — the caller persists the resolved page.
 */
export function resolvePersistedRailMode(stored: {
  railMode?: unknown;
  detailsExpanded?: unknown;
}): TicketRailMode {
  if (isTicketRailMode(stored.railMode)) return stored.railMode;
  if (typeof stored.railMode === "string") {
    const landing = RETIRED_TICKET_RAIL_MODES.get(stored.railMode);
    if (landing !== undefined) return landing;
  }
  if (stored.detailsExpanded === true) return "now";
  return DEFAULT_TICKET_RAIL_MODE;
}
