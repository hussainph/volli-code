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
 * The caller keeps everything that is about tabs: each pane's strip
 * ({@link SplitViewGridProps.renderStrip}, drawn here only below a down split;
 * the top-edge panes share `SplitViewTabBar`) and what a pane's front tab
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
  /** Browser chrome stays resident while the selected pair changes. */
  retainedTabIds?: readonly string[];
  /** A lower pane's tab strip, or null when it holds no tabs. */
  renderStrip(pane: ResolvedSplitViewPane): React.ReactNode;
  /** What the pane's front tab draws — or its empty-pane menu. */
  renderContent(pane: ResolvedSplitViewPane): React.ReactNode;
  /**
   * Anything drawn OVER the pane's content and under nothing: the drop zones
   * (VC-202 §4). Rendered inside the content box rather than the whole cell, so
   * a pane's own strip is never covered by them — a pointer on a strip is a
   * reorder, and that gesture must reach the strip.
   */
  renderOverlay?(pane: ResolvedSplitViewPane): React.ReactNode;
  /** A click landed in this pane. */
  onFocusPane(paneId: string): void;
  /** A divider moved: the branch it divides, and the first child's new share. */
  onResizeSplit(splitId: string, ratio: number): void;
}

/**
 * The pane a DOM node sits in, read off the cell's own `data-pane-id`.
 *
 * The seam for surfaces that must raise pane focus from OUTSIDE the grid's
 * subtree: a live terminal is not a child of its pane's cell — it is a viewport
 * box positioned OVER the pane's anchor (the keep-alive seam) — so the cell's
 * own pointer-down capture never sees a click into it. The box's host climbs
 * from the anchor it published instead, and this is the climb, kept beside the
 * attribute so the two cannot drift. `null` outside any pane — zen's
 * full-bleed anchor included, which is what makes "fire it always" safe.
 */
export function paneIdForElement(element: Element | null): string | null {
  return element?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;
}

export function SplitViewGrid({
  view,
  renderStrip,
  renderContent,
  renderOverlay,
  onFocusPane,
  onResizeSplit,
  retainedTabIds,
}: SplitViewGridProps) {
  if (retainedTabIds !== undefined) {
    return (
      <PairPlane
        view={view}
        retainedTabIds={retainedTabIds}
        renderStrip={renderStrip}
        renderContent={renderContent}
        renderOverlay={renderOverlay}
        onFocusPane={onFocusPane}
        onResizeSplit={onResizeSplit}
      />
    );
  }
  return (
    <SplitViewNodeView
      node={view.root}
      focusedPaneId={view.focusedPaneId}
      paneCount={view.panes.length}
      topEdge
      renderStrip={renderStrip}
      renderContent={renderContent}
      renderOverlay={renderOverlay}
      onFocusPane={onFocusPane}
      onResizeSplit={onResizeSplit}
    />
  );
}

interface SplitViewNodeProps extends Omit<SplitViewGridProps, "view"> {
  node: ResolvedSplitViewNode;
  focusedPaneId: string;
  paneCount: number;
  topEdge: boolean;
}

/** Shared by the main tab bar and the plane: split the 6px grip cost evenly. */
export function splitFirstChildStyle(ratio: number): React.CSSProperties {
  return { flex: `0 0 calc(${ratio * 100}% - 3px)` };
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
        style={splitFirstChildStyle(node.ratio)}
      >
        <SplitViewNodeView {...props} node={node.first} />
      </div>
      <SplitViewDivider
        direction={node.direction}
        ratio={node.ratio}
        onChange={(ratio) => props.onResizeSplit(node.id, ratio)}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitViewNodeView {...props} node={node.second} topEdge={props.topEdge && row} />
      </div>
    </div>
  );
}

function SplitViewCell({
  pane,
  focusedPaneId,
  paneCount,
  topEdge,
  renderStrip,
  renderContent,
  renderOverlay,
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
      {topEdge ? null : renderStrip(pane)}
      {/* The content box, and the one thing allowed to cover it. A box of its
          own rather than the cell, so an overlay's `inset-0` means "the pane's
          content" and not "the content and the strip above it". */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {renderContent(pane)}
        {renderOverlay?.(pane)}
      </div>
    </div>
  );
}

/**
 * Pair members are siblings keyed by tab identity, not children of a layout
 * branch. Changing geometry therefore never recreates a BrowserPane controller.
 * Terminals keep using their resident viewport anchors.
 */
const NO_RETAINED_TABS: readonly string[] = [];

function PairPlane({
  view,
  retainedTabIds = NO_RETAINED_TABS,
  renderContent,
  renderOverlay,
  onFocusPane,
  onResizeSplit,
}: SplitViewGridProps) {
  const branch = view.root.kind === "split" ? view.root : null;
  const row = branch?.direction !== "column";
  const tracks =
    branch === null
      ? "minmax(0, 1fr)"
      : `minmax(0, ${branch.ratio}fr) 6px minmax(0, ${1 - branch.ratio}fr)`;
  const entries = new Map<string, ResolvedSplitViewPane>();
  for (const tabId of retainedTabIds) {
    entries.set(tabId, {
      kind: "pane",
      id: `retained:${tabId}`,
      tabIds: [tabId],
      activeTabId: tabId,
      index: -1,
      isPrimary: false,
    });
  }
  for (const pane of view.panes) entries.set(pane.activeTabId ?? `empty:${pane.id}`, pane);
  return (
    <div
      data-slot="pair-plane"
      className="relative grid min-h-0 min-w-0 flex-1 overflow-hidden"
      style={row ? { gridTemplateColumns: tracks } : { gridTemplateRows: tracks }}
    >
      {[...entries]
        .toSorted(([, left], [, right]) => {
          const a = view.panes.indexOf(left);
          const b = view.panes.indexOf(right);
          return (a < 0 ? Number.MAX_SAFE_INTEGER : a) - (b < 0 ? Number.MAX_SAFE_INTEGER : b);
        })
        .map(([key, pane]) => {
          const index = view.panes.indexOf(pane);
          const shown = index !== -1;
          const split = branch !== null;
          return (
            <div
              key={key}
              data-slot="split-view-pane"
              data-pane-id={shown ? pane.id : undefined}
              data-focused={shown && split && pane.id === view.focusedPaneId ? "true" : undefined}
              aria-label={shown && split ? paneCellLabel(pane, view.panes.length) : undefined}
              aria-hidden={!shown || undefined}
              onPointerDownCapture={() => {
                if (shown) onFocusPane(pane.id);
              }}
              style={{
                display: shown ? undefined : "none",
                ...(row
                  ? { gridColumn: index * 2 + 1, gridRow: 1 }
                  : { gridRow: index * 2 + 1, gridColumn: 1 }),
              }}
              className={cn(
                "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
                shown &&
                  split &&
                  (pane.id === view.focusedPaneId
                    ? "ring-1 ring-primary/50 ring-inset"
                    : "ring-1 ring-border/50 ring-inset"),
              )}
            >
              {renderContent(pane)}
              {shown ? renderOverlay?.(pane) : null}
            </div>
          );
        })}
      {branch === null ? null : (
        <SplitViewDivider
          key="pair-divider"
          direction={branch.direction}
          ratio={branch.ratio}
          style={row ? { gridColumn: 2, gridRow: 1 } : { gridRow: 2, gridColumn: 1 }}
          onChange={(ratio) => onResizeSplit(branch.id, ratio)}
        />
      )}
    </div>
  );
}
