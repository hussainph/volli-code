/** Pointer inspection, without an entrance on a high-frequency navigation path. */
import type * as React from "react";
import { HoverCard as Primitive } from "radix-ui";
import { cn } from "@renderer/lib/utils";

export const HoverCard = Primitive.Root;
export const HoverCardTrigger = Primitive.Trigger;
export function HoverCardContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="hover-card-content"
        sideOffset={sideOffset}
        className={cn(
          "material-floating z-50 w-80 rounded-menu p-1 text-ui text-foreground",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
