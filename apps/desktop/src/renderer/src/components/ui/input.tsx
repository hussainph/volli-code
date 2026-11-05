import * as React from "react";
import { useControlShape, type ControlShape } from "./control-shape";

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
  variant = "regular",
  shape = "auto",
  ...props
}: React.ComponentProps<"input"> & {
  controlSize?: ControlSize;
  variant?: "regular" | "search";
  shape?: ControlShape;
}) {
  const shapeProps = useControlShape(
    shape,
    controlSize,
    variant === "search" || type === "search" ? "search" : "field",
  );
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      data-size={controlSize}
      {...shapeProps}
      className={cn(
        "w-full min-w-0 rounded-native-control text-ui outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed",
        CONTROL_SIZE[controlSize],
        FIELD_SURFACE,
        FIELD_INVALID,
        variant === "search" && "search-capsule",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
