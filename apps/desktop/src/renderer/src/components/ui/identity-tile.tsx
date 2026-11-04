import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/utils";

/** A centred identity, not an action. Colour is supplied by the scope's tokens. */
export function IdentityTile({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="identity-tile" className={cn("identity-tile", className)} {...props} />;
}
