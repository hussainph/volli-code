/**
 * Pure, in-memory workspace navigation history — the Slack-style ←/→ model.
 *
 * A "location" is a {@link NavSnapshot}: which project is selected, which nav
 * page is showing, and which ticket (if any) is open in the full-page detail
 * view. Every organic navigation records a snapshot; the ←/→ chrome-bar
 * buttons (and ⌘[ / ⌘]) walk the back/forward stacks over it.
 *
 * The reducer keeps three parts: a `back` stack (older locations, newest last),
 * the `current` location, and a `forward` stack (locations you backed out of,
 * nearest first). Semantics, kept deliberately Slack/browser-plain:
 *   - Consecutive identical snapshots are deduped (no-op, same reference back).
 *   - An organic navigation clears the forward stack (you branched a new path).
 *   - The back stack is capped at {@link NAV_HISTORY_CAP}; the oldest entries
 *     fall off the bottom so a long session can't grow it without bound.
 *
 * This module is intentionally free of store/DOM imports (only a type-only
 * import of `NavKey`, erased at compile time) so it stays a unit-testable pure
 * reducer; the wiring that feeds it live state and applies its output lives in
 * hooks/use-nav-history.ts.
 */
import type { NavKey } from "@renderer/stores/workspace";

/** A single navigable location: selected project + nav page + open ticket. */
export interface NavSnapshot {
  /** The selected project, or `null` when no project is selected (empty app). */
  projectId: string | null;
  /** The active nav page for that project. */
  nav: NavKey;
  /** The ticket open in the full-page detail view, or `null` on the plain board. */
  openTicketId: string | null;
}

/** Back/forward stacks around the current location. */
export interface NavHistory {
  /** Older locations, oldest first / newest last (the next ← target). */
  readonly back: readonly NavSnapshot[];
  /** The location currently shown, or `null` before the first record. */
  readonly current: NavSnapshot | null;
  /** Locations backed out of, nearest first (the next → target). */
  readonly forward: readonly NavSnapshot[];
}

/** Fresh, empty history — the store's initial value. */
export const EMPTY_NAV_HISTORY: NavHistory = { back: [], current: null, forward: [] };

/** Max depth of the back stack; oldest entries fall off beyond this. */
export const NAV_HISTORY_CAP = 100;

/** Whether two snapshots name the exact same location. */
export function sameSnapshot(a: NavSnapshot | null, b: NavSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.projectId === b.projectId && a.nav === b.nav && a.openTicketId === b.openTicketId;
}

/**
 * The semantic parent of a full-page ticket detail is the selected project's
 * plain Board. This is derivable even when the detail was restored from
 * persisted state and the deliberately in-memory history starts empty.
 */
export function ticketParentSnapshot(snapshot: NavSnapshot): NavSnapshot | null {
  if (snapshot.projectId === null || snapshot.nav !== "board" || snapshot.openTicketId === null) {
    return null;
  }
  return { projectId: snapshot.projectId, nav: "board", openTicketId: null };
}

/**
 * Record an organic navigation to `next`. Dedupes against the current location
 * (returns the SAME reference so callers can skip a store update), pushes the
 * old current onto the back stack (capped), and clears the forward stack.
 */
export function recordNav(history: NavHistory, next: NavSnapshot): NavHistory {
  if (sameSnapshot(history.current, next)) return history;

  // Seed the very first location without a back entry (nothing to go back to).
  if (history.current === null) {
    return { back: history.back, current: next, forward: [] };
  }

  const grown = [...history.back, history.current];
  // Cap from the FRONT so the oldest locations fall off, keeping recent ones.
  const back = grown.length > NAV_HISTORY_CAP ? grown.slice(grown.length - NAV_HISTORY_CAP) : grown;
  return { back, current: next, forward: [] };
}

/** Whether there is a location to step back to. */
export function canGoBack(history: NavHistory): boolean {
  return history.back.length > 0;
}

/** Whether there is a location to step forward to. */
export function canGoForward(history: NavHistory): boolean {
  return history.forward.length > 0;
}

/** The output of a back/forward step: the new history plus the snapshot to apply. */
export interface NavStep {
  history: NavHistory;
  snapshot: NavSnapshot;
}

/**
 * Step back one location: pop the back stack into `current`, push the old
 * `current` onto the forward stack. Returns `null` when the back stack is empty
 * (nothing to do), so callers can no-op cleanly.
 */
export function goBack(history: NavHistory): NavStep | null {
  const target = history.back.at(-1);
  if (target === undefined || history.current === null) return null;
  return {
    history: {
      back: history.back.slice(0, -1),
      current: target,
      forward: [history.current, ...history.forward],
    },
    snapshot: target,
  };
}

/**
 * Step forward one location: shift the forward stack into `current`, push the
 * old `current` back onto the back stack. Returns `null` when the forward stack
 * is empty.
 */
export function goForward(history: NavHistory): NavStep | null {
  const [target, ...rest] = history.forward;
  if (target === undefined || history.current === null) return null;
  return {
    history: {
      back: [...history.back, history.current],
      current: target,
      forward: rest,
    },
    snapshot: target,
  };
}

// --- Keyboard-event predicates (pure, so they're unit-testable) -------------

/** The subset of `KeyboardEvent` the nav shortcuts inspect. */
export interface NavKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  /** Physical key, layout-independent — needed for the ⌥-remapped rail chord. */
  code: string;
  repeat: boolean;
}

/**
 * True for ⌘[ (browser/VS-Code "back"). Requires Cmd alone — no Alt (⌥[ is a
 * different glyph), Shift, or Ctrl. Matches the physical bracket key by both
 * `key` and `code` so it works whether or not the layout maps `[` there.
 */
export function isNavBackKeyEvent(event: NavKeyEvent): boolean {
  if (!event.metaKey || event.altKey || event.shiftKey || event.ctrlKey) return false;
  return event.key === "[" || event.code === "BracketLeft";
}

/** True for ⌘] ("forward") — mirror of {@link isNavBackKeyEvent}. */
export function isNavForwardKeyEvent(event: NavKeyEvent): boolean {
  if (!event.metaKey || event.altKey || event.shiftKey || event.ctrlKey) return false;
  return event.key === "]" || event.code === "BracketRight";
}

/**
 * True for ⌥⌘B (mirror of ⌘B's left-sidebar toggle, VS-Code secondary-sidebar
 * style). Keyed by `code` ("KeyB"), not `key`: on macOS Option remaps B's
 * character (to "∫"), so only the physical code is reliable for an ⌥ chord.
 */
export function isRailToggleKeyEvent(event: NavKeyEvent): boolean {
  if (!event.metaKey || !event.altKey || event.shiftKey || event.ctrlKey) return false;
  return event.code === "KeyB" || event.key.toLowerCase() === "b";
}

/**
 * Selector for editing contexts where ⌘[ / ⌘] must stay hands-off — it means
 * "outdent" in a text field or code editor, not "go back". Covers form fields,
 * contenteditable regions, and CodeMirror (`.cm-editor`).
 */
export const NAV_SUPPRESS_SELECTOR = "input, textarea, [contenteditable], .cm-editor";

/**
 * True when a keydown originated inside an editing context (see
 * {@link NAV_SUPPRESS_SELECTOR}). Structural (`target: unknown`) so it also runs
 * in the node-environment unit tests: a target that is null / not an object /
 * has no `closest` can't match and is treated as safe.
 */
export function isEditingTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { closest?(selector: string): unknown; isContentEditable?: unknown };
  if (typeof el.closest !== "function") return false;
  // Keep it a method call — a detached `el.closest` reference loses `this` and
  // real DOM methods throw "Illegal invocation".
  if (el.closest(NAV_SUPPRESS_SELECTOR)) return true;
  return el.isContentEditable === true;
}
