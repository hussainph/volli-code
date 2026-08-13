/**
 * The sidebar's scrollport, with its scrollbar taken out of the layout.
 *
 * THE FOURTH RIGHT EDGE. `globals.css` styles `*::-webkit-scrollbar` at 10px
 * wide, and authoring that pseudo-element is what takes an element OFF
 * Chromium's overlay path: the bar becomes a classic one that claims 10px of
 * scrollport the moment the content overflows. The scroll container here is the
 * pane's own, so a session list long enough to scroll shoved every row's ink 10px
 * inward and back out again as the list grew and shrank — a right edge that moves
 * with the length of the list, on the surface whose whole claim is that it has
 * one right edge.
 *
 * That also disposes of the macOS "Show scroll bars: Always" setting, in the
 * direction nobody wants: the app already draws its own bar, so the system
 * preference is irrelevant and the space is reserved under BOTH settings. The
 * answer is not to reserve less; it is to reserve nothing.
 * `[&::-webkit-scrollbar]:hidden` keeps the custom path (so the system setting
 * stays irrelevant) and takes the width to zero, so the layout is identical
 * whether or not the list overflows. There is deliberately no
 * `scrollbar-gutter: stable` — a stable gutter is the always-on reservation this
 * removes.
 *
 * The thumb that replaces it is a sibling, absolutely positioned, drawn in the
 * 8px channel `SidebarGroup`'s padding already leaves to the right of every row
 * pill. It is ephemeral by construction rather than by timing: it cannot reserve
 * a gutter because it is not in the layout at all. It reveals while the pane is
 * scrolling or hovered and fades otherwise, which is the same progressive reveal
 * the global scrollbar rules describe.
 *
 * Dragging it is wired up here rather than left to the wheel, because hiding the
 * native widget takes the drag away with it — the one part of an overlay
 * scrollbar that has to exist in app source rather than in a prototype.
 *
 * IT SHARED THOSE PIXELS WITH THE RESIZE GRIP, and lost them. The grip was 6px
 * of the panel's right edge while this thumb's 4px start 4px in, so they
 * overlapped on 2 — the grip's z-20 over this z-10 — and `elementFromPoint` at
 * the thumb's own midpoint returned the grip. Aiming at the scrollbar where it
 * is drawn resized the panel. The grip is 4px now and the two tile exactly
 * (`sidebar-resize-handle.tsx` carries the reasoning and the stacking-context
 * trap that makes z-index no use here).
 *
 * WHAT IS INTERACTIVE IS WHAT IS DRAWN, and that has to be said in the class
 * list because opacity does not say it: this thumb is `opacity-0` at rest, and
 * an `opacity-0` box still takes every hit inside it. So `pointer-events`
 * follows the same condition the opacity does, on the same line, and the thumb
 * refuses the pointer whenever there is no pill on screen to aim at. That is
 * what keeps the fix above from being re-broken by a later 1px of drift: a
 * scrollbar nobody can see can no longer capture anything, whatever the geometry
 * does next.
 *
 * Turning it off cannot lock it off, because the wrapper below is what carries
 * the hover and it is strictly larger than the thumb: a pointer landing on a
 * hidden thumb falls through to the pane, the pane hovers, and the thumb is
 * live by the next sample.
 */
import * as React from "react";

import { SidebarContent } from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";

/** The app's own 4px pill, centred in the channel below. */
const THUMB_WIDTH = 4;
/** Short lists make a proportional thumb vanish; this is the floor it stops at. */
const THUMB_MIN_HEIGHT = 20;
/**
 * `SidebarGroup`'s own right padding — the gap every row pill already stops
 * inside, and therefore the only column the thumb can use without crossing one.
 */
const THUMB_CHANNEL = 8;
/** How long the thumb stays up after the last scroll event. */
const FADE_MS = 700;
/** How far a row dissolves where it passes under the nav above or the footer below. */
const EDGE_FADE = 12;

/** Where the thumb sits, in the scrollport's own pixels. */
interface ThumbGeometry {
  top: number;
  height: number;
}

/** Which ends of the list are flush against their own edge, and so uncut. */
interface ScrollEdges {
  atTop: boolean;
  atBottom: boolean;
}

/**
 * The scrollport clips, and a clip is a straight cut: a row sliding past the nav
 * lost its top half to a hard horizontal line, mid-glyph, with nothing to say it
 * was scrolling rather than broken.
 *
 * Only the cut ends fade. Softening an edge the list is already flush against
 * would dim the first row for no reason — the fade means "this continues", so an
 * edge where nothing continues must not have one.
 */
function edgeMask({ atTop, atBottom }: ScrollEdges): string | undefined {
  if (atTop && atBottom) return undefined;
  const head = atTop ? "#000 0" : `transparent 0, #000 ${EDGE_FADE}px`;
  const tail = atBottom ? "#000 100%" : `#000 calc(100% - ${EDGE_FADE}px), transparent 100%`;
  return `linear-gradient(to bottom, ${head}, ${tail})`;
}

/** The proportional thumb, floored so a very long list still leaves something to grab. */
function thumbHeightFor(clientHeight: number, scrollHeight: number): number {
  return Math.max(THUMB_MIN_HEIGHT, (clientHeight / scrollHeight) * clientHeight);
}

export function SidebarScrollArea({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const thumbRef = React.useRef<HTMLDivElement | null>(null);
  const fadeRef = React.useRef<number | null>(null);
  /**
   * A drag, measured once. Every quantity here is fixed for the whole gesture —
   * dragging a thumb changes neither the scrollport's height nor its content's —
   * so reading them per pointer sample bought nothing and cost a forced layout
   * each time. See {@link handleThumbMove}.
   */
  const dragRef = React.useRef<{
    pointerId: number;
    startY: number;
    /** Where the thumb stood when the press landed, in scrollport px. */
    startTop: number;
    /** The thumb's own range: scrollport height less the thumb's. */
    travel: number;
    /** The content's: scrollHeight less the scrollport's. */
    maxScroll: number;
    /** The latest position the pointer has asked for, applied on the next frame. */
    top: number;
    frame: number | null;
  } | null>(null);
  const [thumb, setThumb] = React.useState<ThumbGeometry | null>(null);
  const [edges, setEdges] = React.useState<ScrollEdges>({ atTop: true, atBottom: true });
  const [scrolling, setScrolling] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  /**
   * Idempotent on purpose, and that is load-bearing rather than tidy: the layout
   * effect below runs after EVERY render, including the one this setter causes,
   * so a measure that returned a fresh object each time would never reach a
   * fixed point. Returning the same object when nothing moved is what lets React
   * bail out.
   */
  const measure = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    // A thumb drag drives the thumb straight from the pointer and React is out
    // of the loop until release (see {@link handleThumbMove}). Measuring here
    // would put it back in: three element reads and a fresh `{top, height}` per
    // sample, whose commit then re-runs the layout effect below — and the render
    // would write a stale `top` over the live one anyway, because React diffs
    // against the props it last rendered rather than against the DOM.
    if (dragRef.current !== null) return;
    const { clientHeight, scrollHeight, scrollTop } = element;
    // Sub-pixel scrollHeights mean the bottom never reaches equality exactly, so
    // the last pixel would keep a fade the reader has already scrolled past.
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
    setEdges((current) =>
      current.atTop === atTop && current.atBottom === atBottom ? current : { atTop, atBottom },
    );
    if (scrollHeight <= clientHeight) {
      setThumb((current) => (current === null ? current : null));
      return;
    }
    const height = thumbHeightFor(clientHeight, scrollHeight);
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
    setThumb((current) =>
      current !== null && current.top === top && current.height === height
        ? current
        : { top, height },
    );
  }, []);

  // After layout rather than in an effect: the thumb's height is a fraction of a
  // scrollHeight that only exists once the rows are laid out, and a thumb that
  // appeared one frame late would be a thumb that jumps on first scroll.
  //
  // No dependency array, which reads like an oversight and is the opposite: it
  // is what catches a content height that changed during a render of THIS
  // subtree, before anything can be observed.
  //
  // It was flagged as a forced synchronous layout on every sidebar render, which
  // it is. What made that expensive was the resize grip writing the width to the
  // store on every pointermove, re-rendering this subtree once per mouse sample;
  // the grip now moves the pane in CSS and renders nothing until release
  // (`sidebar-resize-handle.tsx`), so what is left here is one element read per
  // real render, holding a correctness guarantee nothing else offers. Kept
  // deliberately.
  React.useLayoutEffect(measure);

  // The sizes React does not render: the window resizing, the grip dragging the
  // pane wider, the pane's own height changing under the chrome band. During a
  // drag this is now the ONLY thing that fires, and it fires inside the frame's
  // own layout pass — a read of fresh geometry rather than a request for a new
  // one.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // And the CONTENT's height, which the scrollport's own box cannot report —
    // a scrollport does not resize when the rows inside it grow. The layout
    // effect above was documented as covering this and does not: sessions
    // arrive on `ActiveSessions`'s own store subscription, so the list grows
    // inside a child that re-renders alone, and a parent that never re-rendered
    // never re-measured. Caught in the browser rather than in types: the panel
    // stood with a 75px thumb on a list whose real fraction was 30px, and
    // stayed wrong until the first scroll happened to call `measure` for it.
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure]);

  React.useEffect(
    () => () => {
      window.clearTimeout(fadeRef.current ?? undefined);
      const frame = dragRef.current?.frame ?? null;
      if (frame !== null) window.cancelAnimationFrame(frame);
    },
    [],
  );

  /** Raises the thumb and restarts its fade. Idempotent while it is already up. */
  function markScrolling(): void {
    setScrolling(true);
    window.clearTimeout(fadeRef.current ?? undefined);
    fadeRef.current = window.setTimeout(() => setScrolling(false), FADE_MS);
  }

  function handleScroll(): void {
    const drag = dragRef.current;
    if (drag === null) {
      measure();
      markScrolling();
      return;
    }
    // Our own write, coming back to us. The thumb is already where the pointer
    // put it, so the only thing left for React during a drag is which ends are
    // cut — and that follows from numbers cached at the press rather than from
    // the DOM. `setEdges` bails when nothing changed, so a whole drag commits at
    // most twice: once leaving the top, once reaching the bottom.
    const scrollTop = (drag.top / drag.travel) * drag.maxScroll;
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop >= drag.maxScroll - 1;
    setEdges((current) =>
      current.atTop === atTop && current.atBottom === atBottom ? current : { atTop, atBottom },
    );
    markScrolling();
  }

  function handleThumbDown(event: React.PointerEvent<HTMLDivElement>): void {
    const element = scrollRef.current;
    if (event.button !== 0 || element === null) return;
    // Keeps the drag from starting a text selection or stealing focus from the
    // row the reader was on.
    event.preventDefault();
    const { clientHeight, scrollHeight, scrollTop } = element;
    // The thumb travels the scrollport minus its own height while the content
    // travels its whole overflow. Both are settled the moment the press lands.
    const travel = clientHeight - thumbHeightFor(clientHeight, scrollHeight);
    const maxScroll = scrollHeight - clientHeight;
    if (travel <= 0 || maxScroll <= 0) return;
    const startTop = (scrollTop / maxScroll) * travel;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTop,
      travel,
      maxScroll,
      top: startTop,
      frame: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  /**
   * THE DRAG DOES NOT GO THROUGH REACT — the same rule the resize grip is built
   * on (`sidebar-resize-handle.tsx`), and for the same measured reason.
   *
   * It read `clientHeight`/`scrollHeight` per sample and wrote `scrollTop`,
   * which fired `handleScroll` → `measure()` (three more reads) → a fresh
   * `{top, height}` → a render → the layout effect measuring again. Two forced
   * layouts and one commit per pointer sample, on a pane that a mouse samples at
   * up to 1kHz: exactly the pattern the grip was rewritten to remove, arriving
   * back on the surface next door.
   *
   * Now the geometry is cached at the press, the pointer only updates a number,
   * and one rAF per frame writes the thumb's `top` and the scrollport's
   * `scrollTop`. Coalescing costs nothing that could have mattered — the pointer
   * cannot be in two places within one frame, so only a frame's last sample
   * could ever have decided where the thumb goes.
   */
  function handleThumbMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag.top = Math.min(drag.travel, Math.max(0, drag.startTop + (event.clientY - drag.startY)));
    if (drag.frame !== null) return;
    drag.frame = window.requestAnimationFrame(() => {
      drag.frame = null;
      applyDrag(drag.top, drag.travel, drag.maxScroll);
    });
  }

  function applyDrag(top: number, travel: number, maxScroll: number): void {
    const element = scrollRef.current;
    if (element === null) return;
    if (thumbRef.current !== null) thumbRef.current.style.top = `${top}px`;
    element.scrollTop = (top / travel) * maxScroll;
  }

  function endThumbDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    // Land the last sample before React is allowed back in: `setDragging` below
    // schedules the render whose layout effect re-measures, and it has to
    // measure where the pointer left the pane rather than one frame short of it.
    applyDrag(drag.top, drag.travel, drag.maxScroll);
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div className="group/scroll relative flex min-h-0 flex-1 flex-col">
      <SidebarContent
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ maskImage: edgeMask(edges) }}
        className={cn("overflow-x-hidden [&::-webkit-scrollbar]:hidden", className)}
      >
        {children}
      </SidebarContent>
      {thumb !== null ? (
        <div
          ref={thumbRef}
          aria-hidden
          data-slot="sidebar-scroll-thumb"
          onPointerDown={handleThumbDown}
          onPointerMove={handleThumbMove}
          onPointerUp={endThumbDrag}
          onPointerCancel={endThumbDrag}
          style={{
            top: thumb.top,
            height: thumb.height,
            width: THUMB_WIDTH,
            right: (THUMB_CHANNEL - THUMB_WIDTH) / 2,
          }}
          className={cn(
            // z-10 clears the rows, and that is all a z-index can do here — the
            // grip is out of reach at any value (see the note at the top).
            "absolute z-10 cursor-default rounded-full bg-border-strong transition-opacity duration-200 ease-out motion-reduce:transition-none",
            // Pointer-events rides with the opacity, never apart from it.
            scrolling || dragging
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover/scroll:pointer-events-auto group-hover/scroll:opacity-70",
          )}
        />
      ) : null}
    </div>
  );
}
