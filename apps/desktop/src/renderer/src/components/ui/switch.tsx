import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * A small Radix Switch, styled to the app's tokens (ember `primary` when on,
 * the strongest glass step when off). Accepts an `aria-label` at the use site for its
 * accessible name — the composer's Worktree / Create-more toggles rely on it.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-glass-edge transition-colors duration-150 ease-out motion-reduce:transition-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-glass-4",
        className,
      )}
      {...props}
    >
      {/* The thumb is light paper in both appearances, so on light paper an
          off track left it nearly invisible. The glass hairline draws its
          edge there, flat, where a drop shadow used to. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-3 rounded-full [background-color:var(--control-light-paper)] ring-1 ring-glass-edge transition-transform duration-150 ease-out motion-reduce:transition-none data-[state=checked]:translate-x-[calc(100%+1px)] data-[state=unchecked]:translate-x-px",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
