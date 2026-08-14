import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@renderer/lib/utils";
import { Separator } from "@renderer/components/ui/separator";

/**
 * THE SEAM RULES, AND WHY EVERY ONE OF THEM IS WRITTEN TWICE.
 *
 * A group fuses its children into one pill by collapsing the radius and the
 * doubled border at each internal seam, in CSS rather than by cloning children
 * — the thing on either side of a seam is a Button the CALLER composed, and a
 * caller composes through wrappers the group never gets to see.
 *
 * A tooltip on a disabled button is exactly that wrapper, and not an avoidable
 * one: a disabled button emits no pointer events, so the trigger has to be a
 * span around it (`ticket/ticket-repository-summary.tsx`), and Radix's
 * `asChild` renders that span as the group's direct child. Every `>` rule then
 * lands on the span — which has no radius and no border to collapse — while the
 * button inside keeps its own `rounded-full`, and the pill visibly shatters at
 * that one seam. Hence the twin one level deeper, naming the button by its
 * `data-slot`: the pair together says "a wrapper is allowed here".
 *
 * The twin steps over a direct child that is itself a group, because a nested
 * ButtonGroup is a SEPARATE pill — that is what the `gap-2` in the base is for
 * — and reaching into it would flatten the outer edge of every button it holds.
 *
 * Written as literal tokens in a list rather than composed from a shared
 * fragment: Tailwind scans this file as text, so a class assembled at runtime
 * is a class that never gets generated.
 */
const HORIZONTAL_FUSION = [
  "[&>*:not(:first-child)]:rounded-l-none",
  "[&>*:not(:first-child)]:border-l-0",
  "[&>*:not(:last-child)]:rounded-r-none",
  "[&>*:not(:first-child):not([data-slot=button-group])>[data-slot=button]]:rounded-l-none",
  "[&>*:not(:first-child):not([data-slot=button-group])>[data-slot=button]]:border-l-0",
  "[&>*:not(:last-child):not([data-slot=button-group])>[data-slot=button]]:rounded-r-none",
].join(" ");

const VERTICAL_FUSION = [
  "flex-col",
  "[&>*:not(:first-child)]:rounded-t-none",
  "[&>*:not(:first-child)]:border-t-0",
  "[&>*:not(:last-child)]:rounded-b-none",
  "[&>*:not(:first-child):not([data-slot=button-group])>[data-slot=button]]:rounded-t-none",
  "[&>*:not(:first-child):not([data-slot=button-group])>[data-slot=button]]:border-t-0",
  "[&>*:not(:last-child):not([data-slot=button-group])>[data-slot=button]]:rounded-b-none",
].join(" ");

const buttonGroupVariants = cva(
  // `[&_[data-slot=button]]:focus-visible:*` is the same wrapper blindness in
  // its other costume: with the seams collapsed, a focused button's ring is
  // drawn under its neighbour's border unless that button is lifted, and
  // `[&>*]:focus-visible` cannot lift one that a span is standing in front of.
  // Any depth, no nested-group guard: a focused button belongs above its
  // neighbours in every group it is in.
  "flex w-fit items-stretch has-[>[data-slot=button-group]]:gap-2 [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 [&_[data-slot=button]]:focus-visible:relative [&_[data-slot=button]]:focus-visible:z-10 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-md [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal: HORIZONTAL_FUSION,
        vertical: VERTICAL_FUSION,
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  },
);

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  );
}

function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted px-4 text-sm font-medium shadow-raised [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "relative m-0! self-stretch bg-border data-[orientation=vertical]:h-auto",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants };
