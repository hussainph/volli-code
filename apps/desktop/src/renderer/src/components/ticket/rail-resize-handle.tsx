import * as React from "react";

import { RAIL_DEFAULT_WIDTH, useUiStore } from "@renderer/stores/ui";

/**
 * Drag grip on the details rail's INNER (left) edge. The rail is anchored to the
 * right of the ticket view and grows leftward, so this mirrors the left sidebar's
 * outer-edge handle: the grip hugs the opposite edge and a leftward drag GROWS the
 * rail instead of shrinking it. Double-click resets to the default width. The rail
 * has no width transition, so — unlike the sidebar handle — there's nothing to
 * suspend during the drag, hence no `onResizingChange`.
 */
export function RailResizeHandle() {
  const setRailWidth = useUiStore((s) => s.setRailWidth);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Keeps the drag from starting a text selection or stealing focus.
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: useUiStore.getState().railWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    // The rail anchors to the right edge and grows leftward, so a leftward drag
    // (clientX decreasing) must INCREASE the width — hence the negated delta,
    // the mirror of the sidebar handle's `startWidth + delta`. clientX is
    // viewport px, but the rail renders inside the zoomed content row
    // (app-shell.tsx), where CSS px are multiplied by uiScale — divide the delta
    // back out or the edge outruns the pointer at zoom ≠ 1.
    const scale = useUiStore.getState().uiScale;
    setRailWidth(drag.startWidth - (event.clientX - drag.startX) / scale);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current || event.pointerId !== dragRef.current.pointerId) return;
    dragRef.current = null;
  }

  return (
    // Absolute over the aside's left edge (its positioning context), hugging the
    // full height. The rail's content sits behind px-4 padding, so the 6px grip
    // never overlaps an interactive control.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details rail"
      data-slot="rail-resize-handle"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setRailWidth(RAIL_DEFAULT_WIDTH)}
      className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize select-none after:absolute after:inset-y-0 after:left-0 after:w-[2px] after:bg-transparent after:transition-colors hover:after:bg-sidebar-border active:after:bg-sidebar-ring"
    />
  );
}
