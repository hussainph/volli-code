import type * as React from "react";
import { ChevronDownIcon } from "@renderer/components/ui/icon";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

/** A stable label column beside a wrapping value, for compact property lists. */
export function InspectorRow({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<"li"> & { label: string }) {
  return (
    <li
      {...props}
      className={cn(
        "grid grid-cols-[4rem_minmax(0,1fr)] min-h-9 items-start gap-3 px-2 py-1.5",
        className,
      )}
    >
      <span className="flex h-control-sm items-center text-ui text-muted-foreground">{label}</span>
      <span className="flex min-h-control-sm min-w-0 items-center">{children}</span>
    </li>
  );
}

/** Borderless at rest, one disclosure, the same height as a property chip. */
export function InspectorPopup({ children, className, ...props }: React.ComponentProps<"button">) {
  return (
    <Button
      {...props}
      variant="inspector"
      size="sm"
      className={cn("max-w-full justify-start gap-1.5 px-1.5 font-normal", className)}
    >
      {children}
      <ChevronDownIcon
        aria-hidden
        strokeWidth={2.25}
        className="size-3 shrink-0 text-muted-foreground"
      />
    </Button>
  );
}
