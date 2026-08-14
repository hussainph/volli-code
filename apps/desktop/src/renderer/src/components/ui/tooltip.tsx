import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

function TooltipProvider({
  delayDuration = 500,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * No arrow, and therefore a real gap. The bubble is a one-line label that
 * already points at its trigger by hanging off it; a 10px rotated square is a
 * second shape to keep aligned, re-cornered and re-colored on four sides, and
 * it bought nothing the position was not already saying. With the arrow gone
 * the detachment has to be spelled: 6px, the same the popover takes, so a label
 * and a surface leaving the same rail read as one family.
 */
const TOOLTIP_SIDE_OFFSET = 6;

function TooltipContent({
  className,
  sideOffset = TOOLTIP_SIDE_OFFSET,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // The CONTROL rung, not the container one every other overlay takes.
          // A tooltip is a label, not a surface — it holds one line, never
          // contains anything, and at 28px tall the container's 20 would clamp
          // to a stadium and read as a toast. Its ELEVATION is the overlay tier
          // all the same: rung and lift answer different questions, and this
          // thing portals to the body and floats over the whole window exactly
          // like every other member of that tier.
          //
          // `animate-none!` is important on purpose: the reduced-motion gate
          // loses the specificity fight with `data-[state=closed]:animate-out`
          // without it. The full argument is on MENU_SURFACE_FADE in
          // `ui/menu-classes.ts`, which every overlay in this folder follows.
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-control bg-foreground px-3 py-1.5 text-xs text-balance text-background shadow-overlay ease-out fade-in-0 zoom-in-95 motion-reduce:animate-none! data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
