import type * as React from "react";
import { useDroppable } from "@dnd-kit/core";

import { useSplitDnd } from "./split-dnd";
import { TOP_STRIP_DROP_ID } from "./split-drop";

/**
 * A surface's TOP STRIP, across the whole bar (VC-614): the ordinary tabs and
 * one chip per tab group. It is no longer cut into per-pane segments — a shown
 * group's panes each draw their own strip in the grid below — so the surface's
 * one actions cluster always sits in the window's right corner, over the rail.
 *
 * Inside a surface's drag context the bar is itself a drop target: a pane's
 * tab let go anywhere on it leaves its group, even where no ordinary tab is
 * left to drop it beside.
 */
export function SplitViewTabBar({ children }: { children: React.ReactNode }) {
  return useSplitDnd() === null ? (
    <div data-slot="split-view-tab-bar" className={BAR}>
      {children}
    </div>
  ) : (
    <DroppableTabBar>{children}</DroppableTabBar>
  );
}

const BAR = "flex min-w-0 shrink-0 flex-col bg-rail";

function DroppableTabBar({ children }: { children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: TOP_STRIP_DROP_ID });
  return (
    <div ref={setNodeRef} data-slot="split-view-tab-bar" className={BAR}>
      {children}
    </div>
  );
}
