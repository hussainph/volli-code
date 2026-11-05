/** Material and perimeter, independent of the application that fills them. */
import * as React from "react";
import { Slot } from "radix-ui";
import { attachGlassOptics } from "./glass-optics";
import { cn } from "@renderer/lib/utils";

export function GlassSurface({
  asChild = false,
  tint = false,
  className,
  tier = "pane",
  size = "pane",
  ref,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
  tint?: boolean;
  tier?: "pane" | "full";
  size?: "pane" | "control";
}) {
  const Component = asChild ? Slot.Root : "div";
  const bind = React.useCallback(
    (node: HTMLDivElement | null) => {
      const forwardedCleanup = typeof ref === "function" ? ref(node) : undefined;
      if (ref && typeof ref !== "function") ref.current = node;
      if (!node) return;
      const stop = tier === "full" ? attachGlassOptics(node) : undefined;
      return () => {
        stop?.();
        if (typeof forwardedCleanup === "function") forwardedCleanup();
        else if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref, tier],
  );
  return (
    <Component
      data-material="glass"
      data-glass-tier={tier}
      data-glass-size={size}
      data-tint={tint ? "true" : undefined}
      className={cn("glass rounded-floating", className)}
      {...props}
      ref={bind}
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
