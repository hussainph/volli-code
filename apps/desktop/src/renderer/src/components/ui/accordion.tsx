"use client";

import * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * A list where one item is open at a time.
 *
 * The height animation is Radix's `--radix-accordion-content-height` against
 * the `accordion-down` / `accordion-up` keyframes `tw-animate-css` already
 * ships (`globals.css` imports it), so no keyframe is written here. It runs on
 * `height`, which is a layout property and normally the wrong thing to animate
 * — but the whole point of this control is that the surface around it RESIZES,
 * so the layout pass is the effect rather than its cost. The item is the only
 * thing on screen changing size, and the surface it grows inside is a popover
 * with nothing below it to push around.
 *
 * `motion-reduce:animate-none!` carries its `!` for the reason spelled out on
 * `MENU_SURFACE_FADE` in `ui/menu-classes.ts`: the gate loses the specificity
 * fight with `data-[state=open]:animate-*` without it.
 */
function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-border/50 last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "flex flex-1 items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none!"
      {...props}
    >
      <div className={cn("px-2 pb-2", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
