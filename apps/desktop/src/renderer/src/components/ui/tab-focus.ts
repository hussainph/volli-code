/**
 * Where focus goes in a tab strip, as arithmetic — no DOM, no React.
 *
 * The three strips (Project Files, ticket detail, project Sessions) each wrote
 * this out by hand: the same `moveTabFocus` helper, the same four-arm keydown
 * switch, and in two of them the same close-time successor walk. Three copies
 * of "which tab does the keyboard land on" is three places for the roving
 * tabindex to drift, and it already had: two strips fell back to the first tab
 * when nothing was selected, the third left every tab at `-1` and dropped
 * itself out of the document's tab order entirely.
 *
 * It is a `.ts` beside the component rather than lines inside it because that
 * is the shelf the coverage gate reaches (`apps/desktop/vite.config.ts`), and
 * focus order is exactly the kind of off-by-one nobody notices from a
 * screenshot. `ui/tab-strip.tsx` holds the four lines of DOM that turn an index
 * into a `.focus()`.
 */

/** An arrow/Home/End request, named by where it wants to go. */
export type TabFocusMove = "prev" | "next" | "first" | "last";

/**
 * The keys a tablist owns, per the ARIA authoring practices for a horizontal
 * tablist. Everything else — Tab, typing, the app's own chords — belongs to
 * whatever is listening above and must pass through untouched.
 */
const KEY_MOVES = new Map<string, TabFocusMove>([
  ["ArrowRight", "next"],
  ["ArrowLeft", "prev"],
  ["Home", "first"],
  ["End", "last"],
]);

/** The move a keydown asks for, or `null` for every key a tablist does not own. */
export function tabFocusMove(key: string): TabFocusMove | null {
  return KEY_MOVES.get(key) ?? null;
}

/**
 * Where `move` lands, starting from the tab at `from`.
 *
 * Wraps at both ends: past the last tab is the first, and the ARIA practices
 * call that the expected behaviour for a tablist that is not also a scroll
 * region. `null` when `from` names no tab in the strip — which is what a stale
 * element or an empty strip looks like from here, and neither is worth moving
 * focus for.
 */
export function movedTabIndex(count: number, from: number, move: TabFocusMove): number | null {
  if (from < 0 || from >= count) return null;
  switch (move) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
      return (from + 1) % count;
    case "prev":
      return (from - 1 + count) % count;
  }
}

/**
 * The tab that inherits focus when the one at `from` closes — the neighbour to
 * the right, or the left one when the closing tab was last.
 *
 * Asked BEFORE the close lands, so the successor is picked from the strip as it
 * still stands and focus never spends a frame on `<body>`. `null` when the
 * closing tab was the only one: there is no successor, the surface falls back
 * to its empty state, and that state carries its own control.
 */
export function successorTabIndex(count: number, from: number): number | null {
  if (from < 0 || from >= count) return null;
  if (from + 1 < count) return from + 1;
  if (from > 0) return from - 1;
  return null;
}

/**
 * The single tab in the document's tab order — the roving tabindex's entry
 * point, from which the arrows move.
 *
 * It is the active tab, and the FIRST tab whenever nothing is active. A strip
 * can be open with no selection (nothing opened yet, or an active id naming a
 * tab that has since closed), and keying the tab stop solely off `active` in
 * that state leaves every tab at `-1` and makes the whole strip unreachable
 * from the keyboard. `null` only for an empty strip, which renders no tabs to
 * put the stop on.
 */
export function tabStopIndex(count: number, activeIndex: number): number | null {
  if (count <= 0) return null;
  return activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
}
