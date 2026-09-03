import * as React from "react";

import { cn } from "@renderer/lib/utils";
import { SPLIT_VIEW_MAX_RATIO, SPLIT_VIEW_MIN_RATIO, type SplitViewDirection } from "@volli/shared";

/**
 * The grip between two surface panes (VC-202).
 *
 * A deliberate LIFT of `sessions/session-split-layout.tsx`'s `SplitDivider`,
 * not an import of it: the app has one splitting grammar (right/down splits, an
 * active-pane ring, a hairline grip that colours on hover), and a surface split
 * that felt different from the terminal split inside it would be two grammars
 * wearing one word. What is copied is the MECHANICS, which are subtle enough
 * that re-deriving them is how they drift:
 *
 *  • ONE RATIO PER FRAME. Every write re-renders the pane tree, and inside these
 *    panes sit editors, chat transcripts and terminals that reflow — a terminal
 *    pane additionally sends a PTY resize over IPC per write. A trackpad samples
 *    past 120Hz; the pointer cannot be in two places within one frame, so only a
 *    frame's last sample could ever have decided where the divider lands.
 *  • The parent rect is read PER FRAME rather than cached at the press: this box
 *    is not the drag's to own, and a rail toggle or a full-screen shortcut can
 *    resize it mid-drag.
 *  • The frame a released drag was waiting on is landed by hand, or the panes
 *    settle one sample short of the cursor.
 *
 * What differs is the floor: a surface pane holds a strip, an editor or a board,
 * so it may not be squeezed to a terminal's 96px. {@link MIN_PANE_PX} is 240 —
 * the width at which a folder tab plus its close is still legible.
 *
 * The terminal's own copy stays where it is. Unifying them is a follow-up worth
 * doing calmly; doing it in the same change that first split a surface would
 * have put every live PTY in the app behind one refactor.
 */

/** No pane of a surface split is squeezed below this. */
const MIN_PANE_PX = 240;

export interface SplitViewDividerProps {
  /** `row` divides left/right (a vertical grip); `column` divides top/bottom. */
  direction: SplitViewDirection;
  /** The first pane's current share, for the keyboard's relative steps. */
  ratio: number;
  onChange(ratio: number): void;
}

export function SplitViewDivider({ direction, ratio, onChange }: SplitViewDividerProps) {
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

  const ratioFromPointer = (parent: HTMLElement, clientX: number, clientY: number): number => {
    const rect = parent.getBoundingClientRect();
    const total = vertical ? rect.width : rect.height;
    const position = vertical ? clientX - rect.left : clientY - rect.top;
    // The clamp is a share, so it has to be recomputed against the box: 240px
    // is a third of a narrow window and a tenth of a wide one. 0.45 is the
    // floor's own floor — below that a box is too small for two panes at all,
    // and the divider stops trying to hold a size it cannot.
    const minRatio = Math.min(0.45, MIN_PANE_PX / Math.max(total, 1));
    return Math.min(1 - minRatio, Math.max(minRatio, position / Math.max(total, 1)));
  };

  function endDrag(event: React.PointerEvent<HTMLDivElement>, release: boolean): void {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (release) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.frame === null) return;
    window.cancelAnimationFrame(drag.frame);
    onChange(ratioFromPointer(drag.parent, drag.x, drag.y));
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={vertical ? "Resize left and right panes" : "Resize top and bottom panes"}
      // Where it stands, as a percentage of the model's own clamp — the px
      // floor is a live-layout fact AT cannot usefully be told, but 15–85 and
      // the current share are stable answers to "how far can this go".
      aria-valuemin={Math.round(SPLIT_VIEW_MIN_RATIO * 100)}
      aria-valuemax={Math.round(SPLIT_VIEW_MAX_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
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
        onChange(ratio + (increment ? 0.03 : -0.03));
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
