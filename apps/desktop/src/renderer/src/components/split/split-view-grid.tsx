import * as React from "react";
import type {
  ResolvedSplitViewNode,
  ResolvedSplitViewPane,
  ResolvedSplitView,
} from "@volli/shared";

import { SplitViewDivider } from "@renderer/components/split/split-view-divider";
import { paneCellLabel } from "@renderer/components/split/split-tab-partition";
import { cn } from "@renderer/lib/utils";

/**
 * THE PLANE OF A TABBED SURFACE, split into panes (VC-202 §3).
 *
 * One grid draws both cases, and that is the whole compatibility argument: an
 * UNSPLIT surface resolves to a single pane, which this renders as one cell
 * with no ring, no inner strip and no divider — the plane it always was. There
 * is no "split rendering path" to fall out of sync with the ordinary one.
 *
 * The caller keeps everything that is about tabs: which pane draws which strip
 * ({@link SplitViewGridProps.renderStrip}, null for the primary pane, whose
 * strip is the surface's own full-width one) and what a pane's front tab
 * renders as ({@link SplitViewGridProps.renderContent}). This file owns the
 * geometry, the focus boundary and the ring — nothing else.
 *
 * FOCUS IS A POINTER-DOWN IN THE CELL, captured. Capture because the thing
 * clicked is usually a terminal canvas, a Monaco editor or a chat composer,
 * each of which stops or re-targets the event on its way up; the pane must
 * learn about the click without taking it away from them. It never calls
 * `.focus()` itself either — pointer-down inside an element already lands DOM
 * focus there, and moving it again would fight the surface that was clicked.
 *
 * The ring is the terminal split's exact vocabulary (`session-split-layout.tsx`)
 * because it means the same thing one scope up: `ring-primary/50` on the pane
 * whose front tab the rail is reading, `ring-border/50` on the others. It is
 * drawn only while there is more than one pane — a ring around the only pane
 * would be chrome about a choice nobody has made.
 */
export interface SplitViewGridProps {
  view: ResolvedSplitView;
  /** The pane's own tab strip, or null for the primary (the surface's is its). */
  renderStrip(pane: ResolvedSplitViewPane): React.ReactNode;
  /** What the pane's front tab draws — or its empty-pane menu. */
  renderContent(pane: ResolvedSplitViewPane): React.ReactNode;
  /** A click landed in this pane. */
  onFocusPane(paneId: string): void;
  /** A divider moved: the branch it divides, and the first child's new share. */
  onResizeSplit(splitId: string, ratio: number): void;
}

export function SplitViewGrid({
  view,
  renderStrip,
  renderContent,
  onFocusPane,
  onResizeSplit,
}: SplitViewGridProps) {
  return (
    <SplitViewNodeView
      node={view.root}
      focusedPaneId={view.focusedPaneId}
      paneCount={view.panes.length}
      renderStrip={renderStrip}
      renderContent={renderContent}
      onFocusPane={onFocusPane}
      onResizeSplit={onResizeSplit}
    />
  );
}

interface SplitViewNodeProps extends Omit<SplitViewGridProps, "view"> {
  node: ResolvedSplitViewNode;
  focusedPaneId: string;
  paneCount: number;
}

function SplitViewNodeView(props: SplitViewNodeProps) {
  const { node } = props;
  if (node.kind === "pane") return <SplitViewCell {...props} pane={node} />;

  const row = node.direction === "row";
  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", row ? "flex-row" : "flex-col")}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        // Split the 6px divider cost evenly, so a 0.5 ratio is visually equal —
        // the terminal split's own arithmetic, for the same 1.5rem grip.
        style={{ flex: `0 0 calc(${node.ratio * 100}% - 3px)` }}
      >
        <SplitViewNodeView {...props} node={node.first} />
      </div>
      <SplitViewDivider
        direction={node.direction}
        ratio={node.ratio}
        onChange={(ratio) => props.onResizeSplit(node.id, ratio)}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitViewNodeView {...props} node={node.second} />
      </div>
    </div>
  );
}

function SplitViewCell({
  pane,
  focusedPaneId,
  paneCount,
  renderStrip,
  renderContent,
  onFocusPane,
}: SplitViewNodeProps & { pane: ResolvedSplitViewPane }) {
  const split = paneCount > 1;
  return (
    <div
      data-slot="split-view-pane"
      data-pane-id={pane.id}
      data-focused={split && pane.id === focusedPaneId ? "true" : undefined}
      // Named only while there is more than one: an unsplit surface's plane is
      // not "pane 1 of 1", it is the plane.
      aria-label={split ? paneCellLabel(pane, paneCount) : undefined}
      onPointerDownCapture={() => onFocusPane(pane.id)}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        split &&
          (pane.id === focusedPaneId
            ? "ring-1 ring-primary/50 ring-inset"
            : "ring-1 ring-border/50 ring-inset"),
      )}
    >
      {renderStrip(pane)}
      {renderContent(pane)}
    </div>
  );
}
