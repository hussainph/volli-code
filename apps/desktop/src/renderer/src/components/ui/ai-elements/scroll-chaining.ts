/**
 * The one wheel gesture `use-stick-to-bottom` cannot see (VC-32).
 *
 * The library detaches auto-follow on a wheel-up — but its handler walks from
 * the event target to the NEAREST scrollable ancestor and gives up unless that
 * element is the transcript scroller itself (`useStickToBottom` 1.1.6,
 * `handleWheel`). A wheel-up inside an open bundle or an expanded payload —
 * both capped, both `overflow-auto` — therefore never detaches. While a turn
 * streams, that is a runaway surface: the reader scrolls back through a
 * payload and the transcript keeps snapping to the bottom underneath them,
 * towing the very box they are reading off the screen.
 *
 * A wheel-up is an unambiguous act of reading backward, wherever inside the
 * transcript it lands. This module is the missing half of the library's rule:
 * detach exactly when the library's own handler would have returned early —
 * a wheel-up whose target sits under a NESTED scroller inside the transcript.
 * Everything else stays the library's call: wheel-up over plain transcript is
 * its handler's case (with its own guards), wheel-down re-attaches through its
 * scroll handler, and a wheel that lands in a portal (a dropdown floating over
 * the feed) reaches the transcript through React's tree but not the DOM's, so
 * the walk below never meets the scroller and correctly stays out of it.
 *
 * Relying on the transcript's own scroll events instead would not work: the
 * scroll handler ignores events that arrive inside a resize window
 * (`state.resizeDifference`), and during a stream nearly every frame is one.
 * That masking is exactly why the library added a wheel handler in the first
 * place; this extends the same reasoning to nested scrollers.
 *
 * Pure and DOM-free so the renderer test project (node environment, no DOM)
 * can exercise every branch: the walk sees only `parentElement` and asks the
 * caller for computed `overflow-y`.
 */

/** The one edge the walk follows. `Element` satisfies this structurally. */
export interface ScrollChainNode<Self> {
  readonly parentElement: Self | null;
}

/** What the walk needs to know about the transcript scroller. */
export interface ScrollExtent {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface WheelDetachInput<Node extends ScrollChainNode<Node>> {
  /** Positive scrolls down; only a wheel-up (negative) ever detaches. */
  readonly deltaY: number;
  /** Where the wheel landed, or null when the event target is not an element. */
  readonly target: Node | null;
  /** The transcript's scroll element, or null before the library mounts it. */
  readonly scroller: (Node & ScrollExtent) | null;
  /** Computed `overflow-y` for a node — injected so the walk stays DOM-free. */
  overflowYOf(node: Node): string;
}

/**
 * Whether this wheel event is a read-back gesture the library will miss —
 * a wheel-up landing under a nested scroller inside the transcript — and so
 * must detach auto-follow (`stopScroll`) explicitly.
 */
export function wheelDetachesFollowing<Node extends ScrollChainNode<Node>>(
  input: WheelDetachInput<Node>,
): boolean {
  const { deltaY, target, scroller, overflowYOf } = input;
  if (deltaY >= 0 || scroller === null) return false;
  // Nothing behind the fold means nothing to detach from — mirrors the
  // library's own `scrollHeight > clientHeight` guard, so a short transcript
  // never flips `isAtBottom` off and summons the "Scroll to latest" button.
  if (scroller.scrollHeight <= scroller.clientHeight) return false;
  let sawNestedScroller = false;
  for (let node = target; node !== null; node = node.parentElement) {
    // The scroller itself is the library's jurisdiction, guards and all.
    if (node === scroller) return sawNestedScroller;
    const overflowY = overflowYOf(node);
    if (overflowY === "auto" || overflowY === "scroll") sawNestedScroller = true;
  }
  // The walk never met the scroller: the target lives in a portal above the
  // transcript, not in it. Scrolling a floating listbox is not reading back.
  return false;
}
