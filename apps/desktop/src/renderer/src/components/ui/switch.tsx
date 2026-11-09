import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";

/**
 * A small Radix Switch, styled to the app's tokens (ember `primary` when on,
 * `input` track when off). Accepts an `aria-label` at the use site for its
 * accessible name — the composer's Worktree / Create-more toggles rely on it.
 */
function Switch(props: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return <MotionOriginRoot scope="switch">{() => <SwitchControl {...props} />}</MotionOriginRoot>;
}

function SwitchControl({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const motion = useMotionOriginProps("switch", props);
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "control-material [--control-fill:var(--border)] data-[state=checked]:[--control-fill:var(--primary)] native-switch peer inline-flex h-control-sm w-(--switch-width) shrink-0 items-center rounded-full border-0 shadow-control-pressed duration-(--duration-press) ease-out motion-reduce:transition-none outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-border",
        className,
      )}
      {...props}
      {...motion}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "control-material [--control-fill:var(--control-light-paper)] native-switch-thumb pointer-events-none block h-(--switch-thumb-height) w-(--switch-thumb-width) rounded-full [background-color:var(--control-light-paper)] shadow-control ring-0 transition-transform duration-(--duration-press) ease-out motion-reduce:transition-none data-[state=checked]:translate-x-(--switch-travel) data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
