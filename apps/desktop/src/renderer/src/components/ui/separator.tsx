import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "vertical" ? "h-auto min-h-4 w-px self-stretch" : "h-px w-full",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
