import type * as React from "react";

/**
 * A surface's TOP STRIP, across the whole bar (VC-614): the ordinary tabs and
 * one chip per tab group. It is no longer cut into per-pane segments — a shown
 * group's panes each draw their own strip in the grid below — so the surface's
 * one actions cluster always sits in the window's right corner, over the rail.
 */
export function SplitViewTabBar({ children }: { children: React.ReactNode }) {
  return (
    <div data-slot="split-view-tab-bar" className="flex min-w-0 shrink-0 flex-col bg-rail">
      {children}
    </div>
  );
}
