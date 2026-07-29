import * as React from "react";

import { useUiStore } from "@renderer/stores/ui";

/** Travel under which a press is a click (deselect) rather than a pan. */
const PAN_SLOP = 4;

interface PanState {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
  /** True once the pointer has moved past {@link PAN_SLOP}. */
  moved: boolean;
}

/**
 * Whether this pointerdown should start a board canvas pan.
 *
 * - Primary button: only on the canvas background itself (gaps, padding below
 *   the height-capped columns) — never on cards/columns, so dnd-kit stays free.
 * - Middle button: anywhere on the canvas (classic mouse pan; does not compete
 *   with card DnD, which is primary-button only).
 */
export function isBoardCanvasPanTarget(
  target: EventTarget | null,
  currentTarget: EventTarget,
  button: number,
): boolean {
  if (button === 1) return true;
  if (button !== 0) return false;
  return target === currentTarget;
}

/**
 * Drag-to-pan + wheel helpers for the board's horizontal canvas.
 *
 * Left-drag the empty canvas (or middle-drag anywhere) to scroll columns into
 * view — the mouse alternative to trackpad sideways scrolling. Shift+wheel and
 * wheel on the canvas background remap to horizontal scroll; wheel over a
 * column body still scrolls that column vertically.
 *
 * Wheel uses a non-passive native listener: React's JSX `onWheel` is passive,
 * so `preventDefault` would be a no-op and the page/column would still scroll.
 *
 * `enabled` must flip with the board/list view toggle — the canvas unmounts in
 * list view, so the listener re-binds when the kanban canvas remounts.
 */
export function useBoardCanvasPan(onBackgroundClick?: () => void, enabled = true) {
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const panRef = React.useRef<PanState | null>(null);
  const [panning, setPanning] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) return;
    const root = canvasRef.current;
    if (root === null) return;

    const onWheel = (event: WheelEvent) => {
      // Trackpad already emits deltaX for sideways gestures — leave those alone.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      // Shift+wheel is the common mouse convention for horizontal scroll.
      if (event.shiftKey) {
        event.preventDefault();
        root.scrollLeft += event.deltaY;
        return;
      }

      // Wheel on the empty canvas (below/between columns) pans horizontally so a
      // mouse wheel reaches off-screen columns without hunting the scrollbar.
      if (event.target === root) {
        event.preventDefault();
        root.scrollLeft += event.deltaY;
      }
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [enabled]);

  const onPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isBoardCanvasPanTarget(event.target, event.currentTarget, event.button)) return;
    // Middle-click autoscroll is a browser default we don't want on a pan surface.
    // Also kill text-selection while a primary-button pan starts.
    event.preventDefault();
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || event.pointerId !== pan.pointerId) return;
    // clientX is viewport px; scrollLeft lives inside the CSS-`zoom`'d content
    // row (app-shell.tsx) — divide the delta by uiScale so the canvas tracks
    // the pointer at zoom ≠ 1 (same contract as sidebar-resize-handle).
    const scale = useUiStore.getState().uiScale;
    const dx = (event.clientX - pan.startX) / scale;
    if (!pan.moved && Math.abs(dx) < PAN_SLOP) return;
    if (!pan.moved) {
      pan.moved = true;
      setPanning(true);
    }
    event.currentTarget.scrollLeft = pan.startScrollLeft - dx;
  }, []);

  const endPan = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (!pan || event.pointerId !== pan.pointerId) return;
      const wasClick = !pan.moved && event.button === 0 && event.target === event.currentTarget;
      panRef.current = null;
      setPanning(false);
      if (wasClick) onBackgroundClick?.();
    },
    [onBackgroundClick],
  );

  return {
    panning,
    canvasRef,
    canvasProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
    } satisfies React.HTMLAttributes<HTMLDivElement>,
  };
}
