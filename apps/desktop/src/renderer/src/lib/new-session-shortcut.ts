/**
 * ⌘T starts a chat, ⌥⌘T starts a terminal, and both start it on the project
 * rather than on whatever happens to be open.
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
  nav: NavKey;
}

/** Who owns the Session a chord starts, and where to land afterwards. */
export interface NewSessionLanding {
  /** The project the ticketless Session is minted under. */
  projectId: string;
  /** The page to move to, or `null` to stay put. */
  navigateTo: NavKey | null;
}

/**
 * Where a chord's Session goes: always the project's ticketless surface, even
 * with a ticket open.
 *
 * The alternative — ticket-scoped inside a ticket, global everywhere else —
 * was drawn and rejected. A chord that means a different thing depending on
 * what is on screen is a chord you have to look up before pressing, and the
 * whole value of an accelerator is that you do not. So ⌘T has one meaning, and
 * the ticket's own split control (which is scoped, and sits where the ticket's
 * Sessions already are) is how a ticket-owned Session gets started. That also
 * settles what the menus may announce: a chord hint belongs only in the menus
 * whose items resolve the same way this does — see `NewSessionControl`.
 *
 * A ticketless Session has no worktree, so it runs in the project's main
 * checkout. That is the honest reading of "a Session that belongs to no ticket"
 * and is what the Sessions surface has always minted.
 *
 * Returning the landing spot rather than performing it keeps this pure and
 * unit-testable in the node environment, the way `selectRailMode` already hands
 * its caller a chrome transition instead of committing one. `navigateTo: null`
 * means stay put — pressing ⌘T while already on Sessions must not re-nav.
 */
export function newSessionLandingForChrome(chrome: NewSessionChrome): NewSessionLanding | null {
  // No project selected: nothing exists that could own a Session, and inventing
  // one is worse than the chord doing nothing.
  if (chrome.selectedProjectId === null) return null;
  return {
    projectId: chrome.selectedProjectId,
    navigateTo: chrome.nav === "sessions" ? null : "sessions",
  };
}
