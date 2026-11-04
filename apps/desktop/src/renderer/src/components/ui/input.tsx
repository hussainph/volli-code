import * as React from "react";

import { cn } from "@renderer/lib/utils";
import {
  CONTROL_SIZE,
  FIELD_INVALID,
  FIELD_SURFACE,
  type ControlSize,
} from "@renderer/components/ui/field-classes";

function Input({
  className,
  type,
  controlSize = "default",
  ...props
}: React.ComponentProps<"input"> & { controlSize?: ControlSize }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-w-0 rounded-input text-ui transition-[color,border-color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed",
        CONTROL_SIZE[controlSize],
        FIELD_SURFACE,
        FIELD_INVALID,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
