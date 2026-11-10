import type * as React from "react";

import { cn } from "@renderer/lib/utils";

/** A pane's identity and controls, separate from its input surface. */
export function PaneHeader({
  identity,
  title,
  actions,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  identity: React.ReactNode;
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="pane-header"
      className={cn(
        "group/pane-header flex h-control-default min-w-0 shrink-0 items-center gap-1.5 border-b border-border bg-background px-1 text-ui text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="flex size-control-xs shrink-0 items-center justify-center" aria-hidden>
        {identity}
      </span>
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      {actions === undefined ? null : (
        <div
          data-slot="pane-header-actions"
          className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/pane-header:opacity-100 group-hover/pane:opacity-100 group-focus-within/pane-header:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {actions}
        </div>
      )}
    </div>
  );
}
