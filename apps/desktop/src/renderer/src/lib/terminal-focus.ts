/**
 * Who may enter terminal focus, and the chord that toggles it.
 *
 * Terminal focus is an in-app zen mode — one terminal Session tab takes the
 * whole canvas and every other piece of chrome steps aside. It is NOT the macOS
 * green button: `hooks/use-fullscreen.ts` is read-only and exists so the
 * traffic-light spacer can collapse.
 *
 * BOTH surfaces that host a terminal may enter it: a ticket's tab strip and the
 * project's own Sessions page. It used to be ticket-only, and nothing about the
 * feature justified that — the gate simply demanded an `openTicketId` because
 * the target type demanded a `ticketId`. A project-level Session is a Session;
 * the PTY it holds fills a canvas exactly as well.
 *
 * Two callers answer the same question — the control drawn ON the pane
 * (`session-split-layout.tsx`, which must decide whether to render at all) and
 * the ⌥⌘Return chord (`hooks/use-terminal-focus-shortcut.ts`, which decides at
 * press time) — so the answer lives here once, and the store reads that feed it
 * live once in `hooks/use-terminal-focus-target.ts`. Pure and structurally typed
 * like every other shortcut predicate in this renderer (`new-session-shortcut`,
 * `nav-history`, `project-shortcut`), so it unit-tests in the node environment
 * with no DOM and both callers are left holding nothing but their store reads.
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
  /**
   * The live terminal Session the OPEN TICKET's active tab names, else null —
   * see {@link activeTerminalSessionId}.
   */
  ticketSessionId: string | null;
  /** The live terminal Session the SESSIONS page's active tab names, else null. */
  projectSessionId: string | null;
}

/**
 * The Session that would take the canvas, or `null` when nothing may.
 *
 * One question, asked per page, because the two surfaces that host a terminal
 * are two different pages and only one of them can be in front:
 *
 *  • `board` + an open ticket → that ticket's active tab, if it is a terminal.
 *  • `sessions` → the project's own strip, if its active tab is a terminal.
 *
 * The nav and Settings gates are not belt-and-braces. `setNav` deliberately does
 * NOT clear `openTicketId` (stores/workspace.ts) — a ticket you opened stays open
 * behind the Files, Sessions and Configure pages so returning to Board lands you
 * back on it — so `openTicketId != null` is true on every page in the workspace,
 * not just the one where the ticket is on screen. Without the nav line, standing
 * on Sessions would offer to focus a ticket terminal that is nowhere in front of
 * the user; without the Settings line, both would offer it from underneath a
 * sheet covering them.
 *
 * Returning the target rather than committing it keeps this pure, and lets the
 * pane render off the same value it will later write.
 */
export function terminalFocusTargetForChrome(
  chrome: TerminalFocusChrome,
): TerminalFocusTarget | null {
  const projectId = chrome.selectedProjectId;
  if (projectId === null || chrome.settingsOpen) return null;
  if (chrome.nav === "board") {
    if (chrome.openTicketId === null || chrome.ticketSessionId === null) return null;
    return { projectId, ticketId: chrome.openTicketId, sessionId: chrome.ticketSessionId };
  }
  if (chrome.nav === "sessions") {
    if (chrome.projectSessionId === null) return null;
    // ticketId null is not "unknown": it is the durable fact that this Session
    // belongs to no ticket, the same reading `projectScope` already carries.
    return { projectId, ticketId: null, sessionId: chrome.projectSessionId };
  }
  return null;
}

/**
 * The terminal Session id `activeTabId` names, or `null` when the active tab is
 * a ticket's Body, a file, a diff, or a chat — on either strip.
 *
 * Both strips mix id spaces the same way: chat Sessions are `chat:<id>`, a
 * ticket's Body is `"doc"`, files and diffs are prefixed, and a terminal Session
 * tab is the bare session id. Matching against that surface's live session
 * container is what tells the last case from the rest — and it is also what
 * makes the answer honest after a Session closes, where the recorded active id
 * outlives the tab.
 *
 * `activeTabId` is nullable because the Sessions page records `null` for a
 * project that has never had a tab in front, where a ticket always has at least
 * its Body. Structurally typed and total on `undefined` so a caller can hand it
 * a lookup straight out of a Zustand selector without minting an empty array to
 * stand in for an owner that has never had a Session.
 */
export function activeTerminalSessionId(
  activeTabId: string | null,
  tabs: readonly { readonly sessionId: string }[] | undefined,
): string | null {
  if (activeTabId === null || tabs === undefined) return null;
  return tabs.some((tab) => tab.sessionId === activeTabId) ? activeTabId : null;
}
