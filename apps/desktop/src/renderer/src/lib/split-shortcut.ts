/**
 * ⌘\ splits the pane you are in, ⇧⌘\ splits it downward, and ⌃⌘ + an arrow
 * moves between panes (VC-202 §5).
 *
 * Pure and structurally typed rather than DOM-typed, like every other shortcut
 * predicate in this renderer (`new-session-shortcut`, `project-shortcut`,
 * `rail-toggle`), so it unit-tests in the node environment and the hook beside
 * it (`hooks/use-split-shortcuts.ts`) is left holding nothing but the listener
 * and the store reads.
 *
 * WHY ⌘\. It is VS Code's Split Editor, Zed's and Sublime's neighbour, and the
 * chord this app's own terminal split already rhymes with (⌘D / ⇧⌘D inside a
 * terminal tab). The surface-level split takes the editor chord and leaves the
 * terminal's alone: one is about the tab you are in, the other about the pane
 * the whole surface is drawn in, and a person who learns one has learned the
 * shape of the other.
 */
import { isHomeBoardTab } from "@renderer/components/home/home-tabs";
import type { NavKey } from "@renderer/stores/workspace";
import type { SplitViewEdge, SplitViewFocusDirection } from "@volli/shared";

/** The subset of `KeyboardEvent` the split chords inspect. */
export interface SplitKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Physical key, layout-independent — the only spelling `\` can be matched by. */
  code: string;
  repeat: boolean;
}

/** What a press asks for: a new pane, or a different pane. */
export type SplitShortcut =
  | { kind: "split"; edge: SplitViewEdge }
  | { kind: "focus"; direction: SplitViewFocusDirection };

const ARROWS: Readonly<Record<string, SplitViewFocusDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * The chord, or `null`.
 *
 * Three details that are not taste:
 *
 *  • `\` is matched by `code` ONLY. On a German or French layout the backslash
 *    is not on that key at all, and on macOS ⌥-less ⌘\ still reports whatever
 *    the layout says — so `event.key` would make the chord mean different
 *    things on different keyboards. `code` is the physical key, which is what a
 *    muscle-memory chord actually is.
 *  • A SPLIT rejects `repeat`. Holding ⌘\ would otherwise open a pane per
 *    key-repeat, which is the failure mode a create chord has and a navigate
 *    chord does not — the same rule ⌘T takes.
 *  • FOCUS accepts repeat, deliberately: holding ⌃⌘→ to walk across a row of
 *    panes is the gesture, and every arrow-key navigation in the app repeats.
 *
 * ⌥ is excluded from both. ⌥⌘ + arrows is the terminal tab's OWN pane
 * navigation (`session-split-layout.tsx`), and the two must not collide: one
 * moves inside a terminal, the other between surface panes.
 */
export function splitShortcutForKeyEvent(event: SplitKeyEvent): SplitShortcut | null {
  if (!event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    if (event.shiftKey) return null;
    const direction = ARROWS[event.code];
    return direction === undefined ? null : { kind: "focus", direction };
  }
  if (event.repeat || event.code !== "Backslash") return null;
  return { kind: "split", edge: event.shiftKey ? "down" : "right" };
}

/**
 * Surfaces that own the keyboard while they are up.
 *
 * Narrower than the Escape guard's list on purpose, and the difference is the
 * point: ⌘\ inserts no character, so there is nothing to protect a text field
 * from — VS Code splits the editor from inside the editor, and refusing the
 * chord while a file tab has focus would break it exactly where it is most
 * used. What a split must not happen BEHIND is modal chrome: a dialog, an alert
 * or an open menu is the only thing on screen, and rearranging the panes under
 * it is a change nobody can see.
 */
export const SPLIT_GUARD_SELECTOR = "[role=dialog], [role=alertdialog], [role=menu]";

/**
 * True when a keydown originated inside modal chrome (see
 * {@link SPLIT_GUARD_SELECTOR}). Structural rather than DOM-typed
 * (`target: unknown`) so it runs unmodified in the node-environment unit tests:
 * a target that is null, not an object, or has no `closest` cannot match a
 * guard and is treated as safe.
 */
export function isSplitGuardedTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { closest?(selector: string): unknown };
  if (typeof el.closest !== "function") return false;
  // Must stay a method call — a detached `const closest = el.closest` loses
  // `this`, and real DOM methods throw "Illegal invocation" when unbound.
  return Boolean(el.closest(SPLIT_GUARD_SELECTOR));
}

/** The chrome facts a split chord resolves against, read at press time. */
export interface SplitShortcutChrome {
  selectedProjectId: string | null;
  /** The selected project's nav page. Ticket detail is a STATE of `home`. */
  nav: NavKey;
  /** Which Home tab is in front — with `openTicketId`, this says whether a
   * ticket workspace is actually on screen (`home-tabs.ts`). */
  homeActiveTab: string;
  /** App-wide Settings is chrome layered OVER the workspace, not a nav page. */
  settingsOpen: boolean;
  /** The global New-ticket dialog — modal, and layered over the workspace too. */
  newTicketOpen: boolean;
  /** The selected project's open ticket, or null on the plain board. */
  openTicketId: string | null;
  /** Whether a terminal has taken the whole canvas (zen). */
  terminalFocused: boolean;
}

/** Which tabbed surface a split chord acts on. `ticketId: null` is Home. */
export interface SplitShortcutSurface {
  projectId: string;
  ticketId: string | null;
}

/**
 * The surface in front, or `null` for a press that must do nothing.
 *
 * "In front" is resolved exactly as `newSessionLandingForChrome` resolves it,
 * and the agreement is the point: a ticket is on screen exactly when Home's
 * Board tab is the one in front and a ticket is open behind it. Anything else
 * on Home is Home's own surface.
 *
 * Four refusals, each for its own reason:
 *  • no project — there is no surface to split;
 *  • `configure` — Settings is not a tabbed surface, and splitting a plane
 *    nobody can see is a rearrangement discovered later as a surprise;
 *  • Settings or the New-ticket dialog up — modal chrome owns the keyboard, the
 *    whole chord, exactly as ⌘T refuses;
 *  • ZEN — a terminal has the entire canvas and the panes are not drawn at all.
 *    Splitting behind it would rearrange a surface the person cannot see, and
 *    ⌘\ inside a full-screen terminal reads as meant for the terminal.
 */
export function splitSurfaceForChrome(chrome: SplitShortcutChrome): SplitShortcutSurface | null {
  const projectId = chrome.selectedProjectId;
  if (projectId === null) return null;
  if (chrome.settingsOpen || chrome.newTicketOpen || chrome.terminalFocused) return null;
  if (chrome.nav !== "home") return null;
  const openTicketId = chrome.openTicketId;
  if (isHomeBoardTab(chrome.homeActiveTab) && openTicketId !== null) {
    return { projectId, ticketId: openTicketId };
  }
  return { projectId, ticketId: null };
}
