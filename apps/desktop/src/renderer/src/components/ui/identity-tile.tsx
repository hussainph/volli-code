import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/utils";

/** A centred identity, not an action. Colour is supplied by the scope's tokens. */
export function IdentityTile({
  className,
  size = "default",
  ...props
}: ComponentProps<"span"> & { size?: "sm" | "default" }) {
  return (
    <span
      data-slot="identity-tile"
      data-size={size}
      className={cn("identity-tile", className)}
      {...props}
    />
  );
}
