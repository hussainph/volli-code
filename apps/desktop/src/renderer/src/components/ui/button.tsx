import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { CONTROL_SIZE } from "@renderer/components/ui/field-classes";

import { cn } from "@renderer/lib/utils";

const buttonVariants = cva(
  // Focus is an opaque, surface-solved token. Diluting it to 45% discarded
  // its contrast floor. The offset separates the ring from a filled control.
  // Text fields carry their caret instead (`ui/field-classes.ts`).
  //
  // A press sinks the shared bevel; it never scales or shifts the target.
  "inline-flex min-w-0 max-w-full shrink-0 items-center justify-center gap-2 rounded-control text-sm font-medium whitespace-normal break-words transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-out outline-none motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Keep the solved fill opaque on hover: a 90% wash loses AA on light
        // surfaces. Elevation supplies hover feedback without changing ink.
        default:
          "control-material [--control-fill:var(--primary)] bg-primary text-primary-foreground shadow-control hover:shadow-control-hover active:shadow-control-pressed",
        // Destructive body ink is pale in dark mode; an action instead takes
        // the shared deep-red control pair, with the same bevel as its peers.
        destructive:
          "control-material [--control-fill:var(--color-control-destructive)] bg-control-destructive text-control-destructive-foreground shadow-control hover:shadow-control-hover active:shadow-control-pressed",
        outline:
          "control-material border border-border-strong bg-card text-foreground shadow-control hover:bg-accent hover:[--control-fill:var(--accent)] hover:shadow-control-hover active:shadow-control-pressed",
        secondary:
          "control-material [--control-fill:var(--color-control-secondary)] border border-border-strong bg-control-secondary text-foreground shadow-control hover:shadow-control-hover active:shadow-control-pressed",
        ghost: "hover:bg-accent hover:text-foreground",
        // --primary-text, not --primary: a link variant is read, not clicked
        // as a colored area, so it takes the accent's body-copy lightness.
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      // Insets track height, not icon presence; long labels grow vertically.
      // Each inset leaves room for the 1px border Outline and Secondary draw:
      // 20px of label line, two insets and two borders must fit the token, or
      // a bordered button outgrows the icon button fused beside it.
      size: {
        default: `${CONTROL_SIZE.default} h-auto min-h-control-default py-0.5 text-ui`,
        xs: `${CONTROL_SIZE.xs} h-auto min-h-control-xs px-control-pad-default py-0 gap-1 text-ui [&_svg:not([class*='size-'])]:size-3`,
        sm: `${CONTROL_SIZE.sm} h-auto min-h-control-sm py-px gap-1 text-ui [&_svg:not([class*='size-'])]:size-3.5`,
        lg: `${CONTROL_SIZE.lg} h-auto min-h-control-lg py-1`,
        icon: "size-control-default",
        "icon-xs": "size-control-xs [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-control-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-control-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  // Radix triggers replace data-slot through asChild. A stable marker lets
  // joined controls recognize the actual action underneath.
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      data-control="button"
    />
  );
}

export { Button, buttonVariants };
