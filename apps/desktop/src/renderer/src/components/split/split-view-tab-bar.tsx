import type * as React from "react";
import type {
  ResolvedSplitView,
  ResolvedSplitViewNode,
  ResolvedSplitViewPane,
} from "@volli/shared";

import { cn } from "@renderer/lib/utils";

import { SplitViewDivider } from "./split-view-divider";
import { splitFirstChildStyle, type SplitViewGridProps } from "./split-view-grid";

interface SplitViewTabBarProps {
  view: ResolvedSplitView;
  /** Only the last strip carries the surface-wide actions. */
  renderStrip(pane: ResolvedSplitViewPane, last: boolean): React.ReactNode;
  onResizeSplit: SplitViewGridProps["onResizeSplit"];
  /** A press landed in this pane's segment of the bar — see {@link SplitViewGridProps.onFocusPane}. */
  onFocusPane: SplitViewGridProps["onFocusPane"];
  /** The rail narrows the plane, but the last strip still spans its top edge. */
  railWidth?: number;
}

/**
 * The main tab bar is the top edge of the pane tree, not a parent of its tabs.
 * A right split divides this bar at the same ratio as the content. A down split
 * contributes only its first child here; its lower panes draw strips in the grid.
 *
 * Layout is measured over the plane's width (excluding the rail). Only the last
 * leaf extends over the rail, so every divider lines up with the content below
 * while the surface's single actions cluster stays in the window's right corner.
 *
 * A segment RAISES PANE FOCUS the way the plane's cell does, for the same
 * reason: a pane is one region that happens to be drawn in two boxes, and a
 * press anywhere in its half of the bar means "I am working here". Without it
 * the two halves disagree — clicking a pane's tabs would move focus (the
 * activation does that) while clicking the space beside them would not.
 */
export function SplitViewTabBar({ railWidth = 0, ...props }: SplitViewTabBarProps) {
  return (
    <div
      data-slot="split-view-tab-bar"
      className="flex min-w-0 shrink-0 bg-rail"
      style={{ paddingRight: railWidth }}
    >
      <TabBarNode {...props} node={props.view.root} railWidth={railWidth} last />
    </div>
  );
}

function TabBarNode({
  node,
  last,
  railWidth,
  ...props
}: SplitViewTabBarProps & {
  node: ResolvedSplitViewNode;
  last: boolean;
  railWidth: number;
}) {
  if (node.kind === "pane") {
    // An empty pane still holds its share of the bar, so the segments go on
    // lining up with the plane — but an empty named tablist is a band of chrome
    // about no tabs. It draws one only when it has tabs, or when it is the last
    // segment and therefore carries the surface's actions. Drawing none, it
    // still owes the bar its bottom edge, which is normally the strip's own
    // border — and owes it from here rather than always, because a folder tab
    // fuses with the plane by covering that border with its own fill (`-mb-px`)
    // and a second line under the strip is the one thing that would show.
    const strip = last || node.tabIds.length > 0;
    return (
      <div
        data-slot="split-view-tab-pane"
        data-pane-id={node.id}
        // Even an empty top-edge pane shares the main bar's height.
        className={cn(
          "flex min-w-0 flex-1 flex-col [&>[data-slot=tab-strip]]:flex-1",
          !strip && "border-b border-border",
        )}
        style={last ? { marginRight: -railWidth } : undefined}
        onPointerDownCapture={(event) => {
          // Capture, and for the same reason the cell captures: what was
          // pressed may stop the event on its way up. The one exclusion is the
          // trailing actions cluster, which is drawn in this segment but acts
          // on the SURFACE and opens into whichever pane is focused — moving
          // focus here first would make "+" always open in the last pane.
          if (event.target instanceof Element && event.target.closest("[data-slot=tab-actions]")) {
            return;
          }
          props.onFocusPane(node.id);
        }}
      >
        {strip ? props.renderStrip(node, last) : null}
      </div>
    );
  }
  if (node.direction === "column") {
    return <TabBarNode {...props} node={node.first} railWidth={railWidth} last={last} />;
  }
  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0" style={splitFirstChildStyle(node.ratio)}>
        <TabBarNode {...props} node={node.first} railWidth={railWidth} last={false} />
      </div>
      <SplitViewDivider
        direction="row"
        ratio={node.ratio}
        presentational
        onChange={(ratio) => props.onResizeSplit(node.id, ratio)}
      />
      <div className="flex min-w-0 flex-1">
        <TabBarNode {...props} node={node.second} railWidth={railWidth} last={last} />
      </div>
    </div>
  );
}
