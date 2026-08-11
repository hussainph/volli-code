/**
 * Who may enter terminal focus, and the chord that toggles it.
 *
 * Terminal focus is an in-app zen mode — one ticket Session tab takes the whole
 * canvas and every other piece of chrome steps aside. It is NOT the macOS green
 * button: `hooks/use-fullscreen.ts` is read-only and exists so the traffic-light
 * spacer can collapse.
 *
 * Two surfaces answer the same question about it — the chrome band's toggle
 * (`chrome-bar.tsx`, which must decide whether to render at all) and the ⌥⌘Return
 * chord (`hooks/use-terminal-focus-shortcut.ts`, which decides at press time) —
 * so the answer lives here once. Pure and structurally typed like every other
 * shortcut predicate in this renderer (`new-session-shortcut`, `nav-history`,
 * `project-shortcut`), so it unit-tests in the node environment with no DOM and
 * the two callers are left holding nothing but their store reads.
 */
import type { TerminalFocusTarget } from "@renderer/stores/ui";
import type { NavKey } from "@renderer/stores/workspace";

/** The subset of `KeyboardEvent` the terminal-focus chord inspects. */
export interface TerminalFocusKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  /** Physical key, layout-independent — the same insurance every chord here carries. */
  code: string;
  repeat: boolean;
}

/**
 * True for ⌥⌘Return, the toggle in both directions.
 *
 * ⌥⌘ mirrors ⌥⌘B, the app's other panel-geometry chord, and Return is free —
 * ⌃⌘F is macOS's own fullscreen and is not wired to this. Return is one of the
 * few keys Option does NOT remap on macOS, so `key` stays "Enter" and both it
 * and `code` are accepted (which also lets the numeric keypad's Enter through,
 * whose `code` is "NumpadEnter").
 *
 * `repeat` is rejected: holding the chord would otherwise flip the whole app
 * canvas in and out on every key-repeat, and each flip costs a PTY resize.
 */
export function isTerminalFocusKeyEvent(event: TerminalFocusKeyEvent): boolean {
  if (!event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey || event.repeat) {
    return false;
  }
  return event.code === "Enter" || event.key === "Enter";
}

/** The chrome facts terminal focus resolves against, read at render or press time. */
export interface TerminalFocusChrome {
  selectedProjectId: string | null;
  /** The selected project's nav page. Ticket detail is a child of `board`. */
  nav: NavKey;
  /** App-wide Settings is chrome layered OVER the workspace, not a nav page. */
  settingsOpen: boolean;
  /** The selected project's open ticket, or null on the plain board. */
  openTicketId: string | null;
  /** The live terminal Session that ticket's active tab names — see {@link activeTerminalSessionId}. */
  activeSessionId: string | null;
}

/**
 * The Session that would take the canvas, or `null` when nothing may.
 *
 * The nav and Settings gates are not belt-and-braces. `setNav` deliberately does
 * NOT clear `openTicketId` (stores/workspace.ts) — a ticket you opened stays open
 * behind the Files, Sessions and Configure pages so returning to Board lands you
 * back on it — so `openTicketId != null` is true on every page in the workspace,
 * not just the one where the ticket is on screen. Without these two lines the
 * band would offer to focus a terminal that is nowhere in front of the user.
 *
 * Returning the target rather than committing it keeps this pure, and lets the
 * band render off the same value it will later write.
 */
export function terminalFocusTargetForChrome(
  chrome: TerminalFocusChrome,
): TerminalFocusTarget | null {
  if (chrome.selectedProjectId === null) return null;
  if (chrome.nav !== "board" || chrome.settingsOpen) return null;
  if (chrome.openTicketId === null) return null;
  if (chrome.activeSessionId === null) return null;
  return {
    projectId: chrome.selectedProjectId,
    ticketId: chrome.openTicketId,
    sessionId: chrome.activeSessionId,
  };
}

/**
 * The terminal Session id `activeTabId` names, or `null` when the ticket's
 * active tab is its Body, a file, a diff, or a chat.
 *
 * A ticket's tab strip mixes id spaces: the Ticket Body is `"doc"`, files and
 * diffs are prefixed, chat Sessions are `chat:<id>`, and a terminal Session tab
 * is the bare session id. Matching against the ticket's live session container
 * is what tells the last case from the rest — and it is also what makes the
 * answer honest after a Session closes, where the persisted `active` id outlives
 * the tab.
 *
 * Structurally typed and total on `undefined` so a caller can hand it a lookup
 * straight out of a Zustand selector without minting an empty array to stand in
 * for a ticket that has never had a Session.
 */
export function activeTerminalSessionId(
  activeTabId: string,
  tabs: readonly { readonly sessionId: string }[] | undefined,
): string | null {
  if (tabs === undefined) return null;
  return tabs.some((tab) => tab.sessionId === activeTabId) ? activeTabId : null;
}
