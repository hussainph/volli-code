import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@renderer/lib/utils";

const buttonVariants = cva(
  // The keyboard ring: 2px at 45%, not shadcn's 3px at 50%. A control that is
  // already a filled pill needs the ring to name it, not to outweigh it — three
  // pixels of half-strength ember around a 20px icon button is more ink than the
  // button. Text fields answer focus differently and carry no ring at all
  // (`ui/field-classes.ts`).
  //
  // THE PRESS: `scale` is in the transition list and naming `transform` is not
  // enough. Tailwind v4 compiles `scale-*` to the standalone `scale` property,
  // not to a transform function — `.active\:scale-\[0\.97\]:active{scale:.97}`
  // — so a list naming only `transform` transitions a property the press never
  // touches, and the depress SNAPS with the declared 150ms doing nothing. The
  // reduced-motion fallback is `scale-100` for the same reason: `transform:
  // none` cannot cancel a `scale` declaration. `!` because the gate is one
  // class inside a media query, (0,1,0), against `:active`'s (0,1,1) — the
  // longer version of that argument is on MENU_SURFACE_FADE in
  // `ui/menu-classes.ts`.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,transform,scale] duration-150 ease-out outline-none active:scale-[0.97] motion-reduce:scale-100! focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // `--destructive-foreground`, not a literal white: the destructive red
        // is hue-locked, but the ink that reads on it is solved rather than
        // assumed, so the label follows whatever actually lands on that fill.
        //
        // FULL STRENGTH IN BOTH MODES. `dark:bg-destructive/60` used to sit
        // here to quiet a red that was frozen at #e5484d and therefore too
        // loud against a dark canvas. The fill is solved per appearance now —
        // pale on dark paper, deep on light — so the mode is already accounted
        // for in the colour, and a 60% wash would only break the one guarantee
        // the solve makes: the label is solved against THIS fill, not against
        // a diluted version of it. The ring keeps its `dark:` step, because a
        // halo is not a surface anything is read on.
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-raised hover:bg-accent hover:text-foreground dark:border-border dark:bg-border/30 dark:hover:bg-border/50",
        secondary: "bg-muted text-foreground hover:bg-muted/80",
        ghost: "hover:bg-accent hover:text-foreground dark:hover:bg-accent/50",
        // --primary-text, not --primary: a link variant is read, not clicked
        // as a colored area, so it takes the accent's body-copy lightness.
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      // Pill scale (DESIGN.md): the h-7 rounded-full chip is the app's control
      // idiom — default matches it; sm/xs step down, lg is the ceiling.
      size: {
        default: "h-7 px-3.5 text-ui has-[>svg]:px-3",
        xs: "h-5 gap-1 px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-6 gap-1.5 px-3 text-ui has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 px-4 has-[>svg]:px-3.5",
        icon: "size-7",
        "icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-8",
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

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
