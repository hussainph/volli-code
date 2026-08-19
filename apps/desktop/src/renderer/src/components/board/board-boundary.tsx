/**
 * The board, contained — so a render fault costs the board and not the window.
 *
 * A React render error with no boundary in its path unmounts the ROOT: the
 * sidebar, the chrome, every live terminal pane's React shell, all of it, to a
 * white screen with the app still running behind it. That is what a
 * `Maximum update depth exceeded` (React error #185) out of dnd-kit's drag
 * measurement did in canary.8 — a fault confined to one card's drag took the
 * whole surface, and nothing on screen said why.
 *
 * The specific loop behind that one is fixed twice over (the sessions-store
 * read now hangs below the drag machinery — see session-activity-context.tsx —
 * and `useRects` no longer sets unchanged state, see
 * `patches/@dnd-kit__core@6.3.1.patch`). This boundary is not that fix and does
 * not stand in for it. It is the admission that a board is a big interactive
 * surface over a third-party drag library, and the NEXT such fault should cost
 * a retry rather than the session.
 *
 * ── WHY IT RESETS ON THE PROJECT ──────────────────────────────────────────
 * A caught board is a dead board until something says otherwise, and the honest
 * "otherwise" is the user going somewhere else and coming back. Keying the
 * verdict to `projectId` gives that for free: switching projects clears it, and
 * so does the explicit retry below. Without a reset the board would stay a
 * failure card for the rest of the session, which is the same over-reach at a
 * smaller scale.
 *
 * The retry re-renders the same subtree from scratch. If the cause is still
 * there it will fail again and land back here, which is the correct outcome —
 * it costs one render and tells the user something real, where a disabled
 * button would only tell them the app had given up.
 */
import * as React from "react";

import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { cn } from "@renderer/lib/utils";

interface BoardBoundaryProps {
  /** Resets the verdict when it changes — a different project is a different board. */
  projectId: string;
  children: React.ReactNode;
}

interface BoardBoundaryState {
  failed: boolean;
  /** The project the current verdict was reached on. A new one earns a retry. */
  projectId: string;
  /** Bumped by the retry button to force a fresh mount of the subtree. */
  attempt: number;
}

export class BoardBoundary extends React.Component<BoardBoundaryProps, BoardBoundaryState> {
  constructor(props: BoardBoundaryProps) {
    super(props);
    this.state = { failed: false, projectId: props.projectId, attempt: 0 };
  }

  static getDerivedStateFromError(): Partial<BoardBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoardBoundaryProps,
    state: BoardBoundaryState,
  ): Partial<BoardBoundaryState> | null {
    // Runs before every render, including the one React does after catching —
    // and there the project is unchanged, so the verdict survives to be drawn.
    if (props.projectId === state.projectId) return null;
    return { failed: false, projectId: props.projectId };
  }

  override componentDidCatch(error: unknown): void {
    // Never silent. This is the only trace a packaged build leaves of a fault
    // that used to be a white screen, and the message carries the React error
    // code that names the failure class.
    console.error("[board] render failed", error);
  }

  override render(): React.ReactNode {
    if (!this.state.failed) {
      // `key` is what makes the retry a remount rather than a re-render: the
      // subtree that failed is discarded, not asked to recover in place.
      return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    }

    return (
      <div className={cn("min-h-0 flex-1", EMPTY_PAGE)} data-board-boundary-fallback>
        <p className="text-sm text-muted-foreground">The board stopped responding.</p>
        <Button
          variant="ghost"
          className="border border-border"
          onClick={() =>
            this.setState((current) => ({
              failed: false,
              attempt: current.attempt + 1,
            }))
          }
        >
          Reload the board
        </Button>
      </div>
    );
  }
}
