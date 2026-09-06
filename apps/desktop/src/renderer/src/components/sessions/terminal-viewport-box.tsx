import * as React from "react";

import {
  subscribeTerminalViewports,
  terminalViewportSnapshot,
  type TerminalViewport,
} from "@renderer/components/split/terminal-viewport-registry";

/**
 * The host half of the terminal keep-alive seam: a box that follows a pane's
 * anchor without either of them ever unmounting the terminal between them.
 *
 * Lifted out of `ticket-terminal-host.tsx` (where it was `TicketTerminalBox`)
 * when split view made both surfaces need it: Home's project Sessions used to
 * be `absolute inset-0` over the whole plane, which is only correct while a
 * surface has exactly one plane. Now every terminal on either surface is
 * positioned over the anchor its pane published, through this one component.
 */

/** The published boxes, subscribed. Re-renders on the SET changing, not on a move. */
export function useTerminalViewports(): ReadonlyMap<string, TerminalViewport> {
  return React.useSyncExternalStore(subscribeTerminalViewports, terminalViewportSnapshot);
}

/**
 * Positions `box` exactly over `anchor`. Both are measured with
 * getBoundingClientRect (viewport space, so both are scaled equally by the
 * content row's CSS `zoom`); the delta is de-zoomed with the factor recovered
 * from the anchor's own scaled-vs-layout width, and size uses layout px
 * (offsetWidth/Height) so the box isn't scaled a second time by its own zoomed
 * ancestor.
 */
function positionOver(box: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const parent = box.offsetParent instanceof HTMLElement ? box.offsetParent : null;
  const parentRect = parent?.getBoundingClientRect();
  const zoom = anchor.offsetWidth > 0 ? anchorRect.width / anchor.offsetWidth : 1;
  const left = ((parentRect ? anchorRect.left - parentRect.left : anchorRect.left) / zoom).toFixed(
    2,
  );
  const top = ((parentRect ? anchorRect.top - parentRect.top : anchorRect.top) / zoom).toFixed(2);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${anchor.offsetWidth}px`;
  box.style.height = `${anchor.offsetHeight}px`;
}

/**
 * One terminal's positioned box. When `anchor` is set the box is shown and
 * rect-synced to it (kept in sync via ResizeObservers on the anchor and the
 * box's own offset parent, plus window resize); when null the box is hidden
 * but its child terminal stays mounted (keep-alive).
 */
export function TerminalViewportBox({
  anchor,
  onPointerDownCapture,
  children,
}: {
  anchor: HTMLElement | null;
  /**
   * A pointer landed anywhere in this box — the terminal canvas included.
   *
   * The box is a positioned SIBLING of the pane grid, not a child of any
   * pane's cell, so the cell's own pointer-down capture never sees clicks
   * into a live terminal; a host that must keep pane focus honest raises it
   * from here instead (VC-202 validation, V1). Capture-phase for the same
   * reason the cell's is: the terminal below takes the event for its own
   * engine focus, and it must keep it.
   */
  onPointerDownCapture?: (event: React.PointerEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    if (anchor === null) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    const sync = () => positionOver(box, anchor);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(anchor);
    if (box.offsetParent instanceof HTMLElement) observer.observe(box.offsetParent);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [anchor]);

  // z-10 lifts the terminal above the pane's placeholder and whatever content
  // scrolls under it; it is only ever shown at the anchor's exact box, so it
  // never covers a neighbouring pane or the rail.
  return (
    <div
      ref={boxRef}
      data-slot="terminal-viewport-box"
      className="absolute z-10"
      style={{ display: "none" }}
      onPointerDownCapture={onPointerDownCapture}
    >
      {children}
    </div>
  );
}
