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
import { MONACO_SURFACE_SELECTOR } from "@renderer/lib/monaco-surface";
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

/**
 * Selector for the editors a new-Session chord must not fire behind.
 *
 * The point is NOT the one the plain-"c" guard makes — ⌘T inserts no character,
 * so there is no typing to hijack. It is that these surfaces hold an edit that
 * is not yet committed, and a chord that opens a Session tab moves the surface
 * out from under it: double-click a tab to rename it, press ⌘T, and a chat boots
 * behind a rename box still waiting on Enter.
 *
 * Two deliberate exclusions, both of which the sibling guards do include:
 *
 *  • `[data-terminal-renderer]` — a live terminal is not left out by oversight.
 *    A pty is sent Ctrl chords, not Cmd chords, so ⌘T means nothing to a shell,
 *    and suppressing it there would break the chord exactly where a second
 *    Session is most often wanted (see `hooks/use-new-session-shortcut.ts`).
 *  • `[role="dialog"]` — `newSessionLandingForChrome` already refuses the whole
 *    chord while Settings or the New-ticket dialog is up, and it refuses it on
 *    the honest ground: nothing behind a modal is a surface a Session can land
 *    on. A second, DOM-shaped copy of that gate could only drift from it.
 *
 * Monaco needs its own entries because it matches none of the generic tokens —
 * its input surface is a `div.native-edit-context`. Spliced in through the
 * shared `MONACO_SURFACE_SELECTOR`, so this guard, the Escape guard, the nav
 * chords and plain-"c" all recognise a Monaco surface the same way.
 */
export const NEW_SESSION_GUARD_SELECTOR = `input, textarea, select, [contenteditable], ${MONACO_SURFACE_SELECTOR}`;

/**
 * True when a keydown originated inside an editor (see
 * {@link NEW_SESSION_GUARD_SELECTOR}). Structural rather than DOM-typed
 * (`target: unknown`) so it runs unmodified in the node-environment unit tests:
 * a target that is null, not an object, or has no `closest` cannot match a guard
 * and is treated as safe.
 */
export function isNewSessionGuardedTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { closest?(selector: string): unknown; isContentEditable?: unknown };
  if (typeof el.closest !== "function") return false;
  // Must stay a method call — a detached `const closest = el.closest` loses
  // `this`, and real DOM methods throw "Illegal invocation" when unbound.
  if (el.closest(NEW_SESSION_GUARD_SELECTOR)) return true;
  // Covers editable regions Electron exposes via the property rather than a
  // matching `[contenteditable]` attribute.
  return el.isContentEditable === true;
}

/** The chrome facts a chord resolves against, read at press time. */
export interface NewSessionChrome {
  selectedProjectId: string | null;
  /** The selected project's nav page. Ticket detail is a STATE of `board`. */
  nav: NavKey;
  /** App-wide Settings is chrome layered OVER the workspace, not a nav page. */
  settingsOpen: boolean;
  /** The global New-ticket dialog — modal, and layered over the workspace too. */
  newTicketOpen: boolean;
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
 * resolves it, and that agreement is the point: `board` + an `openTicketId`, with
 * no modal layered over the top. `setNav` deliberately does NOT clear
 * `openTicketId` (stores/workspace.ts), so a ticket you opened stays open behind
 * the Files, Sessions and Configure pages — without the nav gate, pressing ⌘T on
 * the Sessions page would silently mint a Session onto a ticket that is nowhere
 * on screen, which is the failure the old decision was actually afraid of.
 *
 * The modal gate is the WHOLE chord, not the ticket branch of it, and that is
 * where it differs in shape from the nav gate. Settings and the New-ticket dialog
 * are layered over the workspace, so while one is up nothing behind it is a
 * surface at all — there is no correct answer to fall through to. Gating only the
 * ticket branch still minted a Session (a ticketless one) and navigated to
 * Sessions UNDERNEATH the sheet, where the tab it opened cannot be seen and
 * nothing here dismisses the sheet to reveal it; the user gets a durable Session
 * they never see created. A chord that cannot land anywhere visible should not
 * fire, which is the call `use-new-ticket-shortcut` already makes for "c" and
 * `terminalFocusTargetForChrome` makes for ⌘⏎.
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
  // Modal chrome owns the keyboard while it is up.
  if (chrome.settingsOpen || chrome.newTicketOpen) return null;
  if (chrome.nav === "board" && chrome.openTicketId !== null) {
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
