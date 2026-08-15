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
          //
          // THE GROUP'S SECOND TOOLTIP DOES NOT ANIMATE. `skipDelayDuration`
          // above already says a sweep along a toolbar is one gesture, not a
          // series of openings — Radix marks every re-open inside that window
          // `instant-open` instead of `delayed-open`, and until this class
          // existed nothing read the distinction: each hop replayed the whole
          // 150ms fade+zoom+slide, so the label the pointer had already arrived
          // at was still assembling itself. Instant is what the state name says
          // and what the grouping was for. The exit is untouched — `closed` and
          // `instant-open` are never both set — and this needs no `!`: the
          // variant compiles to (0,2,0) against the unconditional `animate-in`'s
          // (0,1,0), so it wins on specificity rather than on source order
          // (verified in the browser, not by reading Tailwind's output).
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-control bg-foreground px-4 py-1 text-ui text-balance text-background shadow-overlay ease-out fade-in-0 zoom-in-95 motion-reduce:animate-none! data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=instant-open]:animate-none",
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
