import * as React from "react";

import { cn } from "@renderer/lib/utils";
import { FIELD_INVALID } from "@renderer/components/ui/field-classes";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // A floor, not a height: `field-sizing-content` grows the box with what
        // is typed, and the floor is one control tall plus its own padding.
        "flex field-sizing-content min-h-9 w-full rounded-control border border-border bg-transparent px-4 py-1 text-ui shadow-raised transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-border/30",
        FIELD_INVALID,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
