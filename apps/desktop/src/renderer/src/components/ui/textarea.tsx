import * as React from "react";

import { cn } from "@renderer/lib/utils";
import { FIELD_INVALID, FIELD_SURFACE } from "@renderer/components/ui/field-classes";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // A floor, not a height: `field-sizing-content` grows the box with what
        // is typed, and the floor is one control tall plus its own padding.
        "flex field-sizing-content min-h-control-lg w-full rounded-control px-control-pad-default py-1 text-ui outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
        FIELD_SURFACE,
        FIELD_INVALID,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
