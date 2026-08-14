import * as React from "react";

import { cn } from "@renderer/lib/utils";
import { FIELD_INVALID } from "@renderer/components/ui/field-classes";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-control border border-border bg-transparent px-4 text-ui shadow-raised transition-[color,border-color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-border/30",
        FIELD_INVALID,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
