import * as React from "react";

import { cn } from "@renderer/lib/utils";
import { SPLIT_VIEW_MAX_RATIO, SPLIT_VIEW_MIN_RATIO, type SplitViewDirection } from "@volli/shared";

/**
 * The grip between two panes — of a surface split (`split-view-grid.tsx`,
 * `split-view-tab-bar.tsx`) and of the terminal split inside a terminal pane
 * (`sessions/session-split-layout.tsx`). The app has one splitting grammar
 * (right/down splits, an active-pane ring, a hairline grip that colours on
 * hover), and one grip draws every seam of it. The mechanics every caller
 * relies on:
 *
 *  • ONE RATIO PER FRAME. Every write re-renders the pane tree, and inside these
 *    panes sit editors, chat transcripts and terminals that reflow — a terminal
 *    pane additionally refits its engine and sends a PTY resize over IPC per
 *    write, for both sides of the split and again for every pane of a nested
 *    one. A trackpad samples past 120Hz; the pointer cannot be in two places
 *    within one frame, so only a frame's last sample could ever have decided
 *    where the divider lands.
 *  • The parent rect is read PER WRITE rather than cached at the press: this
 *    box is not the drag's to own, and a rail toggle or a full-screen shortcut
 *    can resize it mid-drag.
 *  • The frame a released drag was waiting on is landed by hand, or the panes
 *    settle one sample short of the cursor.
 *  • The keyboard holds the SAME px floor the pointer does, and the model's own
 *    range besides. A 3% step is a share, and a share of a wide box is many
 *    pixels: unclamped, a few presses would walk a pane below the size no drag
 *    can reach.
 *
 * What a caller supplies is its floor, its model's clamp and its name. A
 * surface pane holds a strip, an editor or a board, so by default it may not be
 * squeezed below {@link SURFACE_MIN_PANE_PX} — the width at which a folder tab
 * plus its close is still legible — and AT is told the surface model's range.
 * The terminal split passes its own 96px floor and the sessions store's range.
 */

/** No pane of a surface split is squeezed below this. */
const SURFACE_MIN_PANE_PX = 240;

/** The surface split model's own clamp — what AT is told by default. */
const SURFACE_VALUE_RANGE = [SPLIT_VIEW_MIN_RATIO, SPLIT_VIEW_MAX_RATIO] as const;

/** One arrow-key press moves the divider by this share of the box. */
const KEYBOARD_STEP = 0.03;

export interface SplitViewDividerProps {
  /** `row` divides left/right (a vertical grip); `column` divides top/bottom. */
  direction: SplitViewDirection;
  /** The first pane's current share, for the keyboard's relative steps. */
  ratio: number;
  onChange(ratio: number): void;
  /** Neither pane is squeezed below this, by pointer or keyboard. Default 240. */
  minPanePx?: number;
  /**
   * The share the owning MODEL clamps to, as `[min, max]` — what AT is told the
   * range is. Defaults to the surface split's own clamp.
   */
  valueRange?: readonly [min: number, max: number];
  /** Overrides the default "Resize left and right panes"-style name. */
  label?: string;
  /**
   * Draw the grip, but keep it out of the accessibility tree and the tab order.
   *
   * SINCE VC-333 a row split has TWO grips on one seam — the main tab bar's and
   * the plane's — and they drive the same ratio through the same split id. To a
   * pointer that is a convenience: the seam is draggable along its whole
   * height. To AT and to the keyboard it would be a lie, announcing two
   * dividers and costing two identical tab stops where the user sees one
   * boundary. So the bar's copy is presentational and the plane's is the one
   * that speaks — the plane being the thing the ratio is actually about.
   */
  presentational?: boolean;
  style?: React.CSSProperties;
}

export function SplitViewDivider({
  direction,
  ratio,
  onChange,
  minPanePx = SURFACE_MIN_PANE_PX,
  valueRange = SURFACE_VALUE_RANGE,
  label,
  presentational = false,
  style,
}: SplitViewDividerProps) {
  const vertical = direction === "row";
  const dragRef = React.useRef<{
    pointerId: number;
    parent: HTMLElement;
    x: number;
    y: number;
    frame: number | null;
  } | null>(null);

  React.useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (drag !== null && drag.frame !== null) window.cancelAnimationFrame(drag.frame);
      dragRef.current = null;
    };
  }, []);

  /** The box's size along the split axis, read now — never cached. */
  const measure = (parent: HTMLElement): { start: number; total: number } => {
    const rect = parent.getBoundingClientRect();
    return vertical
      ? { start: rect.left, total: Math.max(rect.width, 1) }
      : { start: rect.top, total: Math.max(rect.height, 1) };
  };

  // The clamp is a share, so it has to be recomputed against the box: 240px is
  // a third of a narrow window and a tenth of a wide one. 0.45 is the floor's
  // own floor — below that a box is too small for two panes at all, and the
  // divider stops trying to hold a size it cannot.
  const clampToFloor = (next: number, total: number): number => {
    const minRatio = Math.min(0.45, minPanePx / total);
    return Math.min(1 - minRatio, Math.max(minRatio, next));
  };

  const ratioFromPointer = (parent: HTMLElement, clientX: number, clientY: number): number => {
    const { start, total } = measure(parent);
    return clampToFloor(((vertical ? clientX : clientY) - start) / total, total);
  };

  function endDrag(event: React.PointerEvent<HTMLDivElement>, release: boolean): void {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (release) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.frame === null) return;
    // The frame the last sample was waiting on will never run. Land it here, or
    // the panes settle one sample short of where the pointer was released —
    // visible as a divider that stops just shy of the cursor.
    window.cancelAnimationFrame(drag.frame);
    onChange(ratioFromPointer(drag.parent, drag.x, drag.y));
  }

  return (
    <div
      style={style}
      role={presentational ? "presentation" : "separator"}
      aria-hidden={presentational || undefined}
      aria-orientation={presentational ? undefined : vertical ? "vertical" : "horizontal"}
      aria-label={
        presentational
          ? undefined
          : (label ?? (vertical ? "Resize left and right panes" : "Resize top and bottom panes"))
      }
      // Where it stands, as a percentage of the model's own clamp — the px
      // floor is a live-layout fact AT cannot usefully be told, but the model's
      // range and the current share are stable answers to "how far can this go".
      aria-valuemin={presentational ? undefined : Math.round(valueRange[0] * 100)}
      aria-valuemax={presentational ? undefined : Math.round(valueRange[1] * 100)}
      aria-valuenow={presentational ? undefined : Math.round(ratio * 100)}
      tabIndex={presentational ? -1 : 0}
      data-slot="split-view-divider"
      className={cn(
        "group relative z-10 shrink-0 bg-transparent outline-none focus-visible:ring-1 focus-visible:ring-primary",
        vertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
      )}
      onPointerDown={(event) => {
        const parent = event.currentTarget.parentElement;
        if (parent === null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          parent,
          x: event.clientX,
          y: event.clientY,
          frame: null,
        };
        // The press itself jumps the divider to the pointer, unthrottled: it is
        // one write, and waiting a frame for it would read as lag on the click.
        onChange(ratioFromPointer(parent, event.clientX, event.clientY));
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (drag.frame !== null) return;
        drag.frame = window.requestAnimationFrame(() => {
          drag.frame = null;
          onChange(ratioFromPointer(drag.parent, drag.x, drag.y));
        });
      }}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onKeyDown={(event) => {
        const decrement = vertical ? event.key === "ArrowLeft" : event.key === "ArrowUp";
        const increment = vertical ? event.key === "ArrowRight" : event.key === "ArrowDown";
        if (!decrement && !increment) return;
        event.preventDefault();
        const parent = event.currentTarget.parentElement;
        const next = ratio + (increment ? KEYBOARD_STEP : -KEYBOARD_STEP);
        const floored = parent === null ? next : clampToFloor(next, measure(parent).total);
        const clamped = Math.min(valueRange[1], Math.max(valueRange[0], floored));
        // A press never moves the divider against its own arrow, and one that
        // cannot move it writes nothing — at either limit a held key would
        // otherwise refit every pane (and resize every PTY) per repeat for a
        // ratio that never changes.
        if (increment ? clamped <= ratio : clamped >= ratio) return;
        onChange(clamped);
      }}
    >
      <span
        className={cn(
          "absolute bg-border transition-colors duration-150 group-hover:bg-primary/70 group-focus-visible:bg-primary",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
