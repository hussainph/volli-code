import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * A small Radix Switch, styled to the app's tokens (ember `primary` when on,
 * `input` track when off). Accepts an `aria-label` at the use site for its
 * accessible name — the composer's Worktree / Create-more toggles rely on it.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-colors duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-3 rounded-full bg-background shadow-sm ring-0 transition-transform duration-150 ease-out data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
