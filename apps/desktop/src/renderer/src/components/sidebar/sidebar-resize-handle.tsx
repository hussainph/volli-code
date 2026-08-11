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
  } | null>(null);

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
    drag.shell.style.setProperty(LIVE_WIDTH_PROPERTY, `${drag.width}px`);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
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
      className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize select-none after:absolute after:inset-y-0 after:right-0 after:w-[2px] after:bg-transparent after:transition-colors hover:after:bg-sidebar-border active:after:bg-sidebar-ring"
    />
  );
}
