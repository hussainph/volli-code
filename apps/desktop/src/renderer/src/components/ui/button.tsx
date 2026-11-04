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
  // Flat glass: no bevel, no inset catch, no drop shadow, on any variant.
  // Solid actions (`default`, `destructive`) are opaque fills; every other
  // variant is a translucent glass tint with a hairline edge. Hover changes
  // the fill and a press changes it a step more; nothing scales or shifts.
  "inline-flex min-w-0 max-w-full shrink-0 items-center justify-center gap-2 text-sm font-medium whitespace-normal break-words transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-out outline-none motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Keep the solved fill opaque on hover: a 90% wash loses AA on light
        // surfaces. Hover and press darken it instead, which only ever adds
        // contrast to the white label (`globals.css`, `--color-primary-*`).
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-press",
        // Destructive body ink is pale in dark mode; an action instead takes
        // the shared deep-red control pair, darkened the same way.
        destructive:
          "bg-control-destructive text-control-destructive-foreground hover:bg-control-destructive-hover active:bg-control-destructive-press",
        // The glass ladder (`globals.css`): 1 rest, 2 hover, 3 press, 4 the
        // selected/strongest step. Secondary sits one step above outline.
        outline:
          "border border-glass-edge bg-glass-1 text-foreground hover:bg-glass-2 active:bg-glass-3",
        secondary:
          "border border-glass-edge bg-glass-2 text-foreground hover:bg-glass-3 active:bg-glass-4",
        ghost: "hover:bg-glass-2 hover:text-foreground active:bg-glass-3",
        // The chosen member of a closed set (`ui/segmented.tsx`): the solid
        // thumb on the segmented track, beside bare ghost siblings. Not an
        // action — re-pressing it is a no-op by contract — so it neither
        // hovers nor answers a press.
        selected: "bg-primary text-primary-foreground",
        // --primary-text, not --primary: a link variant is read, not clicked
        // as a colored area, so it takes the accent's body-copy lightness.
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      // Insets track height, not icon presence; long labels grow vertically.
      // Each inset leaves room for the 1px border Outline and Secondary draw:
      // 20px of label line, two insets and two borders must fit the token, or
      // a bordered button outgrows the icon button fused beside it.
      //
      // The corner is the size's own role radius (`--radius-button-*`,
      // globals.css), so how round each rung reads retunes in one line.
      size: {
        default: `${CONTROL_SIZE.default} h-auto min-h-control-default rounded-button py-0.5 text-ui`,
        xs: `${CONTROL_SIZE.xs} h-auto min-h-control-xs rounded-button-xs px-control-pad-default py-0 gap-1 text-ui [&_svg:not([class*='size-'])]:size-3`,
        sm: `${CONTROL_SIZE.sm} h-auto min-h-control-sm rounded-button-sm py-px gap-1 text-ui [&_svg:not([class*='size-'])]:size-3.5`,
        lg: `${CONTROL_SIZE.lg} h-auto min-h-control-lg rounded-button-lg py-1`,
        icon: "size-control-default rounded-button",
        "icon-xs": "size-control-xs rounded-button-xs [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-control-sm rounded-button-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-control-lg rounded-button-lg",
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
