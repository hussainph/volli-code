import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

function TooltipProvider({
  delayDuration = 400,
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

/**
 * A LABEL, and therefore never hoverable. Radix keeps tooltip content
 * hoverable by default — a grace so a pointer can travel onto rich content —
 * and this app has no rich tooltips (`TooltipContent` below holds one line and
 * contains nothing). What the default DID do was hurt: over a column of 20px
 * row actions, a label opening 6px above one action lands on the action above
 * it, so moving up the column meant the pointer hit live tooltip text between
 * every row — I-beam, close, next label opens over the next row, arrow, I-beam…
 * a cursor flicker the Activity Island's cards caught live (VC-249). With
 * hoverable content off the label closes the instant its trigger is left, and
 * with `pointer-events-none` on the content (below) the pointer never sees it
 * at all. A caller that genuinely needs the grace can still pass
 * `disableHoverableContent={false}`; nothing in the app does.
 */
function Tooltip({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/** The small pointer uses the same surface and edge ink as its label. */
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
          // Repeat hovers are one gesture: Radix's instant-open state skips
          // both the wait and the entrance. Labels never move their target.
          "material-floating pointer-events-none z-50 w-fit max-w-[calc(100vw-2rem)] break-words origin-(--radix-tooltip-content-transform-origin) animate-in rounded-control border border-border bg-popover px-2 py-1 text-ui text-balance text-foreground shadow-overlay duration-(--duration-menu-in) ease-(--ease-out) select-none fade-in-0 motion-reduce:animate-none! data-[state=closed]:duration-(--duration-menu-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=instant-open]:animate-none",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          data-slot="tooltip-arrow"
          width={8}
          height={4}
          className="fill-popover stroke-border-strong"
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
