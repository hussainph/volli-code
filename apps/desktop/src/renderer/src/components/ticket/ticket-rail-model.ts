/**
 * Pure ticket-rail mode contract (decision #46).
 *
 * The rail is a navigator: its icon modes only switch what the contextual rail
 * indexes. Changing mode must never open, close, replace, or steal focus from a
 * main-view tab — only a deliberate list-item selection does that. Properties is
 * the deliberate exception and renders metadata in the rail itself; that still
 * must not mutate the active tab.
 *
 * One mode is conditional. `session` indexes the live Session behind a session
 * tab (Plan, Subagents, Background processes), so it exists only while such a
 * tab is active. That gate lives here rather than in JSX because this module
 * already owns the mode-vs-active-tab relationship, and because a rule spread
 * across a strip, a content switch and a rehydrator is three chances to
 * disagree — here it is one predicate every path runs through.
 */

import type { TicketTabKind } from "./ticket-tabs";

export const TICKET_RAIL_MODES = ["sessions", "files", "changes", "properties", "session"] as const;

export type TicketRailMode = (typeof TICKET_RAIL_MODES)[number];

/** Default mode when nothing is persisted — Sessions dominate the rail. */
export const DEFAULT_TICKET_RAIL_MODE: TicketRailMode = "sessions";

/** Accessible labels for the icon-mode strip (also used as button aria-labels). */
export const TICKET_RAIL_MODE_LABELS: Record<TicketRailMode, string> = {
  sessions: "Sessions",
  files: "Files",
  changes: "Changes",
  properties: "Properties",
  session: "Session",
};

/** Modes whose content only exists while a session tab is the active tab. */
const SESSION_TAB_MODES: ReadonlySet<TicketRailMode> = new Set<TicketRailMode>(["session"]);

/**
 * Couples rail mode with the main strip's active tab solely so mode switches
 * can be proven not to touch the tab. The store keeps these fields separate;
 * this shape exists for the pure decision-#46 contract.
 */
export interface TicketRailChrome {
  mode: TicketRailMode;
  /** Current main-strip active tab id (`"doc"`, `file:…`, `diff:…`, or a session id). */
  activeTabId: string;
  /**
   * Kind of the active tab. Optional because not every host tracks it; absent
   * reads as "not a session tab", so a conditional mode stays unoffered rather
   * than appearing and rendering nothing.
   */
  activeTabKind?: TicketTabKind;
}

export function isTicketRailMode(value: unknown): value is TicketRailMode {
  return typeof value === "string" && (TICKET_RAIL_MODES as readonly string[]).includes(value);
}

/** Whether this mode has anything to index given the active tab. */
export function isRailModeAvailable(
  mode: TicketRailMode,
  chrome: Pick<TicketRailChrome, "activeTabKind">,
): boolean {
  return !SESSION_TAB_MODES.has(mode) || chrome.activeTabKind === "session";
}

/** The modes a strip may offer right now, in strip order. */
export function availableRailModes(
  chrome: Pick<TicketRailChrome, "activeTabKind">,
): readonly TicketRailMode[] {
  return TICKET_RAIL_MODES.filter((mode) => isRailModeAvailable(mode, chrome));
}

/**
 * The mode actually rendered. A stored or in-flight `session` mode survives the
 * user switching away from the session tab, so the fallback is read on every
 * render rather than written back into state — leaving the rail where it was
 * once the session tab returns.
 */
export function resolveRailMode(chrome: TicketRailChrome): TicketRailMode {
  return isRailModeAvailable(chrome.mode, chrome) ? chrome.mode : DEFAULT_TICKET_RAIL_MODE;
}

/**
 * Switch the rail's icon mode. Returns a new chrome snapshot whose
 * `activeTabId` is **identical** to the input — never opens, closes, or
 * replaces a main-view tab (decision #46). An unavailable mode falls back to
 * the default instead of being refused, so the rail always shows something.
 */
export function selectRailMode(chrome: TicketRailChrome, mode: TicketRailMode): TicketRailChrome {
  return {
    ...chrome,
    mode: isRailModeAvailable(mode, chrome) ? mode : DEFAULT_TICKET_RAIL_MODE,
  };
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
  if (isTicketRailMode(stored.railMode)) return stored.railMode;
  if (stored.detailsExpanded === true) return "properties";
  return DEFAULT_TICKET_RAIL_MODE;
}
