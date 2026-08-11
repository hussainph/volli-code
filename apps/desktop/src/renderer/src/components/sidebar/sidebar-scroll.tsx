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

/** Where the thumb sits, in the scrollport's own pixels. */
interface ThumbGeometry {
  top: number;
  height: number;
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
  const fadeRef = React.useRef<number | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
  } | null>(null);
  const [thumb, setThumb] = React.useState<ThumbGeometry | null>(null);
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
    const { clientHeight, scrollHeight, scrollTop } = element;
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
  React.useLayoutEffect(measure);

  // The sizes React does not render: the window resizing, the grip dragging the
  // pane wider, the pane's own height changing under the chrome band.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  React.useEffect(() => () => window.clearTimeout(fadeRef.current ?? undefined), []);

  function handleScroll(): void {
    measure();
    setScrolling(true);
    window.clearTimeout(fadeRef.current ?? undefined);
    fadeRef.current = window.setTimeout(() => setScrolling(false), FADE_MS);
  }

  function handleThumbDown(event: React.PointerEvent<HTMLDivElement>): void {
    const element = scrollRef.current;
    if (event.button !== 0 || element === null) return;
    // Keeps the drag from starting a text selection or stealing focus from the
    // row the reader was on.
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: element.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function handleThumbMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    const element = scrollRef.current;
    if (drag === null || element === null || event.pointerId !== drag.pointerId) return;
    const { clientHeight, scrollHeight } = element;
    // The thumb travels the scrollport minus its own height while the content
    // travels its whole overflow, so the pointer's delta scales by their ratio.
    const travel = clientHeight - thumbHeightFor(clientHeight, scrollHeight);
    if (travel <= 0) return;
    const ratio = (scrollHeight - clientHeight) / travel;
    element.scrollTop = drag.startScrollTop + (event.clientY - drag.startY) * ratio;
  }

  function endThumbDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null || event.pointerId !== dragRef.current.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div className="group/scroll relative flex min-h-0 flex-1 flex-col">
      <SidebarContent
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn("overflow-x-hidden [&::-webkit-scrollbar]:hidden", className)}
      >
        {children}
      </SidebarContent>
      {thumb !== null ? (
        <div
          aria-hidden
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
            "absolute z-10 cursor-default rounded-full bg-border-strong transition-opacity duration-200 ease-out motion-reduce:transition-none",
            scrolling || dragging ? "opacity-100" : "opacity-0 group-hover/scroll:opacity-70",
          )}
        />
      ) : null}
    </div>
  );
}
