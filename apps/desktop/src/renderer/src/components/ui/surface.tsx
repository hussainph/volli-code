/** Material and perimeter, independent of the application that fills them. */
import type * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@renderer/lib/utils";

export function GlassSurface({
  asChild = false,
  tint = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean; tint?: boolean }) {
  const Component = asChild ? Slot.Root : "div";
  return (
    <Component
      data-material="glass"
      data-tint={tint ? "true" : undefined}
      className={cn("glass rounded-floating", className)}
      {...props}
    />
  );
}

export function PaperSurface({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : "div";
  return (
    <Component
      data-material="paper"
      className={cn("material-solid rounded-floating", className)}
      {...props}
    />
  );
}
