import * as React from "react";

import { SessionSplitLayout } from "@renderer/components/sessions/session-split-layout";
import { createTerminalSplit } from "@renderer/components/sessions/session-create";
import { useSessionsStore, type SessionContainer } from "@renderer/stores/sessions";
import { closeTerminalPane } from "@renderer/terminal/session-lifecycle";

/**
 * The bridge between the ticket detail's session plane (a measured placeholder,
 * see ticket-session-plane.tsx) and the always-mounted overlay that actually
 * hosts the ticket's live terminals. The plane publishes which ticket + session
 * tab is active and the DOM box to overlay; the overlay reads it and rect-syncs
 * the hosted terminal onto that box. Kept OUTSIDE React state (a plain external
 * store) so the plane can republish on every layout tick without re-rendering
 * the overlay tree.
 */
interface ViewportTarget {
  ticketId: string;
  sessionId: string;
  /** The placeholder element in the ticket plane to overlay the terminal onto. */
  anchor: HTMLElement;
}

let currentTarget: ViewportTarget | null = null;
const targetListeners = new Set<() => void>();

/** Publish (or clear, with null) the active ticket-session viewport. Called by the ticket plane. */
export function setTicketSessionViewport(next: ViewportTarget | null): void {
  currentTarget = next;
  for (const listener of targetListeners) listener();
}

function subscribeViewport(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => {
    targetListeners.delete(listener);
  };
}

function getViewportSnapshot(): ViewportTarget | null {
  return currentTarget;
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
 * The resident host for EVERY ticket session's live terminal. Rendered by the
 * always-mounted sessions layer (never inside the ticket detail), so ticket
 * terminals survive navigating ticket ↔ board — the core keep-alive invariant.
 * Every ticket tab across every ticket is mounted here; only the one matching
 * the published viewport is shown and positioned over the ticket plane. Others
 * stay mounted and paused (their engines outlive their being off-screen).
 */
export function TicketTerminalOverlay({
  byOwner,
  onShortcut,
}: {
  byOwner: Record<string, SessionContainer>;
  onShortcut(event: React.KeyboardEvent<HTMLDivElement>): void;
}) {
  const target = React.useSyncExternalStore(subscribeViewport, getViewportSnapshot);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const setSplitRatio = useSessionsStore((state) => state.setSplitRatio);

  return (
    <>
      {Object.entries(byOwner).flatMap(([ownerId, container]) =>
        container.tabs
          .filter((tab) => tab.scope.kind === "ticket")
          .map((tab) => {
            const active = target?.ticketId === ownerId && target?.sessionId === tab.sessionId;
            const scope = tab.scope;
            return (
              <TicketTerminalBox key={tab.sessionId} anchor={active ? target.anchor : null}>
                <div className="absolute inset-0" onKeyDownCapture={onShortcut}>
                  <SessionSplitLayout
                    ownerId={ownerId}
                    tab={tab}
                    visible={active}
                    onActivate={(sessionId) => setActivePane(ownerId, tab.sessionId, sessionId)}
                    onSplit={(sessionId, direction) =>
                      void createTerminalSplit(scope, tab.sessionId, sessionId, direction)
                    }
                    onClose={(sessionId) => closeTerminalPane(ownerId, tab.sessionId, sessionId)}
                    onResize={(splitId, ratio) =>
                      setSplitRatio(ownerId, tab.sessionId, splitId, ratio)
                    }
                  />
                </div>
              </TicketTerminalBox>
            );
          }),
      )}
    </>
  );
}

/**
 * One ticket terminal's positioned box. When `anchor` is set the box is shown
 * and rect-synced to it (kept in sync via ResizeObservers on the anchor and the
 * overlay's own offset parent, plus window resize); when null the box is hidden
 * but its child terminal stays mounted (keep-alive).
 */
function TicketTerminalBox({
  anchor,
  children,
}: {
  anchor: HTMLElement | null;
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

  // z-10 lifts the terminal above the ticket plane's placeholder / doc content;
  // it is only ever shown at the plane's exact box, so it never covers the rail.
  return (
    <div ref={boxRef} className="absolute z-10" style={{ display: "none" }}>
      {children}
    </div>
  );
}
