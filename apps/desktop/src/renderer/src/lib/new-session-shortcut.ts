/**
 * ⌘T starts a chat, ⌥⌘T starts a terminal, and both start it on whatever owns
 * the surface in front of you — the open ticket, or the project itself.
 *
 * Pure and structurally typed rather than DOM-typed, like every other shortcut
 * predicate in this renderer (`new-ticket-shortcut`, `project-shortcut`,
 * `nav-history`), so it unit-tests in the node environment with no DOM and the
 * hook beside it (`hooks/use-new-session-shortcut.ts`) is left holding nothing
 * but the listener and the store reads.
 */
import type { NavKey } from "@renderer/stores/workspace";

/** The two kinds a press can start. Chat is the default act; a terminal is its companion. */
export type NewSessionKind = "chat" | "terminal";

/** The subset of `KeyboardEvent` the new-Session chords inspect. */
export interface NewSessionKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  /** Physical key, layout-independent — needed for the ⌥-remapped terminal chord. */
  code: string;
  repeat: boolean;
}

/**
 * ⌘T → chat, ⌥⌘T → terminal. Anything else → no Session.
 *
 * One predicate returning the KIND rather than two booleans, because the two
 * chords are one decision and a caller that had to ask twice could get a "both"
 * answer that means nothing.
 *
 * Three details that are not taste:
 *
 *  • The ⌥ chord is matched by `code`, never by `key`. On macOS Option remaps
 *    the character — ⌥T produces "†" — which is the same trap
 *    `isRailToggleKeyEvent` documents for ⌥⌘B and "∫". The un-Optioned ⌘T
 *    accepts either, the way ⌘[ and ⌘] accept `key` or `code`.
 *  • `repeat` is rejected. Holding ⌘T would otherwise spawn a Session per
 *    key-repeat, which is the one failure mode a create chord has that a
 *    navigate chord does not.
 *  • Ctrl is excluded outright, so ⌃T stays with the shell and readline.
 *
 * Shift is excluded too, which quietly reserves ⌘⇧T. That is the browser's
 * reopen-closed-tab chord, and this product has durable Sessions and a History
 * drawer full of them — leaving it free is cheaper than taking it back later.
 */
export function newSessionKindForKeyEvent(event: NewSessionKeyEvent): NewSessionKind | null {
  if (!event.metaKey || event.ctrlKey || event.shiftKey || event.repeat) return null;
  if (event.altKey) return event.code === "KeyT" ? "terminal" : null;
  return event.key.toLowerCase() === "t" || event.code === "KeyT" ? "chat" : null;
}

/** The chrome facts a chord resolves against, read at press time. */
export interface NewSessionChrome {
  selectedProjectId: string | null;
  /** The selected project's nav page. Ticket detail is a STATE of `board`. */
  nav: NavKey;
  /** App-wide Settings is chrome layered OVER the workspace, not a nav page. */
  settingsOpen: boolean;
  /** The selected project's open ticket, or null on the plain board. */
  openTicketId: string | null;
}

/** Who owns the Session a chord starts, and where to land afterwards. */
export interface NewSessionLanding {
  /** The project the Session is minted under. */
  projectId: string;
  /**
   * The ticket that owns it, or `null` for one of the project's ticketless
   * Sessions. Not "unknown" — it is the durable fact `scratchScope` carries.
   */
  ticketId: string | null;
  /** The page to move to, or `null` to stay put. */
  navigateTo: NavKey | null;
}

/**
 * Where a chord's Session goes: onto the ticket in front of you if there is
 * one, onto the project itself otherwise.
 *
 * This reverses an earlier call, and the earlier call's argument is worth
 * keeping straight rather than deleting. It was: a chord that means a different
 * thing depending on what is on screen is a chord you have to look up before
 * pressing, and the whole value of an accelerator is that you do not. That is a
 * real cost and it is being paid deliberately, because the thing it was
 * protecting turned out not to be the thing people wanted protected. ⌘T does not
 * mean "start a project Session"; it means "start a Session HERE", the way ⌘T
 * in a browser opens a tab in the window you are looking at rather than in some
 * canonical first window. Under that reading the chord has ONE meaning and the
 * owner is simply read off the surface, which is also how every other create
 * verb in this app already behaves — the ticket's control mints a ticket
 * Session, the Sessions page's control mints a project one, and neither asks.
 *
 * "In front of you" is resolved exactly as `terminalFocusTargetForChrome`
 * resolves it, and that agreement is the point: `board` + an `openTicketId`,
 * with Settings not layered over the top. `setNav` deliberately does NOT clear
 * `openTicketId` (stores/workspace.ts), so a ticket you opened stays open behind
 * the Files, Sessions and Configure pages — without the nav gate, pressing ⌘T on
 * the Sessions page would silently mint a Session onto a ticket that is nowhere
 * on screen, which is the failure the old decision was actually afraid of.
 *
 * What follows for the menus: a chord hint belongs in any menu whose items
 * resolve the way this does, and now BOTH do — the ticket strip's control and
 * the Sessions strip's control each start what the chord starts, from the
 * surface the chord reads. See `NewSessionControl`.
 *
 * A ticketless Session has no worktree, so it runs in the project's main
 * checkout. That is the honest reading of "a Session that belongs to no ticket"
 * and is what the Sessions surface has always minted.
 *
 * Returning the landing spot rather than performing it keeps this pure and
 * unit-testable in the node environment, the way `selectRailMode` already hands
 * its caller a chrome transition instead of committing one. `navigateTo: null`
 * means stay put — pressing ⌘T inside a ticket, or while already on Sessions,
 * must not re-nav.
 */
export function newSessionLandingForChrome(chrome: NewSessionChrome): NewSessionLanding | null {
  // No project selected: nothing exists that could own a Session, and inventing
  // one is worse than the chord doing nothing.
  const projectId = chrome.selectedProjectId;
  if (projectId === null) return null;
  if (chrome.nav === "board" && !chrome.settingsOpen && chrome.openTicketId !== null) {
    // The ticket is already the surface in front, so the tab appears where the
    // user is looking without moving the page under them.
    return { projectId, ticketId: chrome.openTicketId, navigateTo: null };
  }
  return {
    projectId,
    ticketId: null,
    navigateTo: chrome.nav === "sessions" ? null : "sessions",
  };
}
