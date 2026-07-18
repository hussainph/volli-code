import * as React from "react";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible";
import { cn } from "@renderer/lib/utils";

/**
 * A bottom-pinned drawer for the ticket detail's right rail: border-t seam,
 * quiet uppercase header with a rotating caret, animated height. "History" and
 * "Details" stack as siblings of this one primitive so the rail reads as one
 * set of drawers rather than ad-hoc collapsibles.
 */
export function RailDrawer({
  label,
  count,
  open,
  onOpenChange,
  className,
  children,
  ...props
}: {
  label: string;
  /** Optional muted count rendered before the caret (e.g. history size). */
  count?: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange">) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn("shrink-0 border-t border-sidebar-border", className)}
      {...props}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-label font-medium text-muted-foreground uppercase transition-colors duration-150 ease-out hover:text-foreground"
        >
          {label}
          <span className="flex items-center gap-2">
            {count !== undefined ? <span>{count}</span> : null}
            <CaretRightIcon
              weight="bold"
              className={cn(
                "size-3 transition-transform duration-150 ease-out",
                open && "rotate-90",
              )}
            />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
