import * as React from "react";

import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, useUiStore } from "@renderer/stores/ui";

/**
 * The live override the drag writes: the same two-tier width the STORE holds,
 * not the panel's share of it. One quantity, one name — the shell already owns
 * the "minus the rail" arithmetic in one place and it stays there, so this
 * cannot drift into meaning the other number (it did once: the pane jumped 60px
 * on release, which is the rail's width and was exactly the tell).
 *
 * Two properties rather than one because they have two writers: React owns the
 * committed one and would clobber a single shared property on any unrelated
 * re-render mid-drag, snapping the pane back to where the store still thinks it
 * is. Nothing but this file ever writes this one.
 */
export const LIVE_WIDTH_PROPERTY = "--sidebar-live-width";

interface SidebarResizeHandleProps {
  /** Mirrored to `data-resizing` on the SidebarProvider so the sidebar's
   * width transition is suspended while the grip is being dragged. */
  onResizingChange(resizing: boolean): void;
}

/**
 * Drag grip on the sidebar panel's outer edge: resizes the panel (the rail is
 * fixed-width, so all delta goes to the panel). Double-click resets to the
 * default width.
 *
 * Rendered in every state now, and that follows from the panel having only one
 * width. It used to return `null` while collapsed, because collapsed meant an
 * icon strip and an icon strip is not resizable; collapsed now means the panel
 * is unpinned, and an unpinned panel is the same panel at the same width, so a
 * grip that disappeared there would make the pane resizable only while docked.
 * It lives inside the panel (app-shell.tsx), so while the panel is withdrawn it
 * is withdrawn and `inert` with it — there is nothing to hit at the window edge.
 *
 * THE DRAG DOES NOT GO THROUGH REACT, and at 150 tickets that is the difference
 * between a grip that tracks the pointer and one that does not. The width lives
 * at the root of the shell, so writing it to the store on every `pointermove`
 * re-rendered the entire tree — board, sidebar, content surface — once per mouse
 * sample, for the whole drag. Profiled on a 150-ticket board, one drag blocked
 * the main thread for ~1.6s; at the lab's 13 tickets it measured zero, which is
 * exactly why nobody saw it.
 *
 * So the drag writes ONE custom property and the store hears about it once, on
 * release. Every box sized off the panel already reads that property, so the
 * geometry follows in CSS with no reconciliation at all — and `pointerup`
 * commits the same number the property has been showing, so the value React
 * finally renders is the one already on screen and nothing moves at the seam.
 */
export function SidebarResizeHandle({ onResizingChange }: SidebarResizeHandleProps) {
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    shell: HTMLElement;
    width: number;
    frame: number | null;
  } | null>(null);

  // The override is written to the shell, which outlives this grip — so a grip
  // that goes away mid-drag leaves a property set with nothing left to clear
  // it, pinning the pane at the dragged width against whatever the store says.
  // `endDrag` is the normal path out; this is the one it cannot cover.
  React.useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (drag === null) return;
      if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
      drag.shell.style.removeProperty(LIVE_WIDTH_PROPERTY);
      dragRef.current = null;
    };
  }, []);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // The shell root owns the width tokens; found once per drag rather than
    // threaded down as a ref, because the grip is already inside it and the
    // alternative is a prop that exists only to re-say what the DOM knows.
    const shell = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
    if (shell === null) return;
    // Keeps the drag from starting a text selection or stealing focus.
    event.preventDefault();
    const startWidth = useUiStore.getState().sidebarWidth;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      shell,
      width: startWidth,
      frame: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizingChange(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    // clientX is viewport px, but the width tokens render inside the zoomed
    // content row (app-shell.tsx), where CSS px are multiplied by uiScale —
    // divide the delta back out or the edge outruns the pointer at zoom ≠ 1.
    const scale = useUiStore.getState().uiScale;
    // Clamped HERE rather than only on commit: the store's setter is what used
    // to hold the bounds, and taking the store out of the loop would otherwise
    // take the minimum and maximum with it — the pane would follow the pointer
    // past both edges all drag and snap back on release.
    drag.width = clampSidebarWidth(drag.startWidth + (event.clientX - drag.startX) / scale);
    // One write per FRAME, not per sample — the same rule the scroll thumb and
    // the edge zone next door already run on. This property sizes every box in
    // the sidebar, so each write is a relayout of the whole pane, and a
    // trackpad samples well past 120Hz: the extra ones were laying out frames
    // that never got shown. The pointer cannot be in two places within one
    // frame, so only a frame's last sample could ever decide where the edge is.
    if (drag.frame !== null) return;
    drag.frame = window.requestAnimationFrame(() => {
      drag.frame = null;
      drag.shell.style.setProperty(LIVE_WIDTH_PROPERTY, `${drag.width}px`);
    });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    // Drop the frame the last sample was waiting on: it would land after the
    // override is cleared and set it again with nobody left to clear it. No
    // sample is lost with it — `drag.width` below is that same last sample,
    // and it goes straight to the store instead.
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    // Commit BEFORE clearing the override: `setSidebarWidth` schedules a render
    // that React flushes at the end of this handler, so by the time anything
    // paints the committed token already holds the dragged width and the
    // override has nothing left to say. Clearing first would expose the stale
    // value for exactly as long as it takes React to catch up.
    setSidebarWidth(drag.width);
    drag.shell.style.removeProperty(LIVE_WIDTH_PROPERTY);
    onResizingChange(false);
  }

  return (
    // Absolute pulls it out of the sidebar's flex row; it anchors to the fixed
    // sidebar container, hugging the outer edge over the full height.
    //
    // 4px, not 6, and the two missing pixels are the whole point. The sidebar's
    // scrollbar thumb (`sidebar-scroll.tsx`) is drawn in the channel just inside
    // this edge, and its outer edge lands exactly 4px in from the panel's — in
    // both shell modes, because both numbers are the same two tokens. At 6px
    // this handle lay over the thumb's outer 2px and won every hit test there,
    // so aiming at the scrollbar where it is drawn resized the panel instead:
    // `elementFromPoint` at the thumb's own midpoint returned this element.
    //
    // Measured, and it did not respond to the obvious fix. Raising the thumb
    // above z-20 works only while the panel floats; pinned, `globals.css` gives
    // `[data-volli-sidebar]` the seam's `clip-path`, which forms a stacking
    // context on a NON-positioned element and drops the whole pane below every
    // positioned sibling. z-index 999 on the thumb still lost. Nothing inside
    // that subtree can out-stack this grip, so the boxes have to stop
    // overlapping instead — 4px + the thumb's 4px tile exactly, and the trade is
    // the owner's: a scrollbar you cannot grab is worse than a resize edge that
    // wants a little more aim. The visible hairline below is unmoved; 4px is
    // also what VS Code's sash and macOS window edges give you.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-slot="sidebar-resize-handle"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize select-none after:absolute after:inset-y-0 after:right-0 after:w-[2px] after:bg-transparent after:transition-colors hover:after:bg-sidebar-border active:after:bg-primary"
    />
  );
}
