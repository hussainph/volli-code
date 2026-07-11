import * as React from "react";

import { useSidebar } from "@renderer/components/ui/sidebar";
import { SIDEBAR_DEFAULT_WIDTH, useUiStore } from "@renderer/stores/ui";

interface SidebarResizeHandleProps {
  /** Mirrored to `data-resizing` on the SidebarProvider so the sidebar's
   * width transition is suspended while the grip is being dragged. */
  onResizingChange(resizing: boolean): void;
}

/**
 * Drag grip on the sidebar's outer edge: resizes the primary panel (the rail
 * is fixed-width, so all delta goes to the panel). Double-click resets to the
 * default width. Not rendered while collapsed — the icon strip isn't resizable.
 */
export function SidebarResizeHandle({ onResizingChange }: SidebarResizeHandleProps) {
  const { state } = useSidebar();
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );

  if (state === "collapsed") return null;

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Keeps the drag from starting a text selection or stealing focus.
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: useUiStore.getState().sidebarWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizingChange(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    // clientX is viewport px, but --sidebar-width renders inside the zoomed
    // content row (app-shell.tsx), where CSS px are multiplied by uiScale —
    // divide the delta back out or the edge outruns the pointer at zoom ≠ 1.
    const scale = useUiStore.getState().uiScale;
    setSidebarWidth(drag.startWidth + (event.clientX - drag.startX) / scale);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
    dragRef.current = null;
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
