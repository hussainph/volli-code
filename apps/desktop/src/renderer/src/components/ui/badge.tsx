/**
 * The small chip: a word, a number or a machine-chosen name, set a step below
 * the row it sits in.
 *
 * This primitive shipped with no call sites and then quietly went wrong. It was
 * authored at `px-2 py-0.5 text-xs` (22px) and swept to `px-2 py-1 text-ui`
 * (30px) when the type scale folded `text-xs` away — a size nothing chose and
 * nothing noticed, because a component nobody renders cannot look wrong.
 * Meanwhile eleven sites drew this object by hand, and the two the owner
 * refined (`pages/harness-picker.tsx`'s origin chip and
 * `theme/theme-combo-box.tsx`'s) both landed on `px-2 py-1 text-label`. That is
 * the base now: the box the dead primitive already had, at the step the live
 * app actually draws.
 *
 * THE BASE IS NOT A BOX. Padding, radius, border and type token all live in the
 * variants, because two of the variants are not boxes — see the note on
 * `count`. All the base says is that a chip is one line, sized to its content,
 * and aligned with whatever sits beside it.
 *
 * Every variant here has a live consumer. `default`, `ghost` and `link` had
 * none and are gone, along with the anchor-hover and `aria-invalid` states a
 * chip in this app never enters — a variant nobody renders is a size free to
 * drift for a year in silence, which is the failure this file already had once.
 */

import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@renderer/lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap", {
  variants: {
    variant: {
      outline: "rounded-full border border-border px-2 py-1 text-label text-muted-foreground",
      secondary: "rounded-full bg-muted px-2 py-1 text-label text-foreground",
      // The chip that IS the answer rather than a fact about it. The border
      // stays on `--primary` (a fill) while the ink drops to `--primary-text`,
      // the accent solved for text — `theme/theme-combo-box.tsx` worked that
      // pair out and is the site this variant came from.
      accent: "rounded-full border border-primary/30 px-2 py-1 text-label text-primary-text",
      // Full-strength fill with the ink solved against it, for the reason
      // spelled out on `ui/button.tsx`'s destructive variant.
      destructive: "rounded-full bg-destructive px-2 py-1 text-label text-destructive-foreground",

      // THE TWO COUNTS. "How many are in here" is drawn two ways, and both are
      // decisions rather than drift.
      //
      // On the board a count trails a `text-ui` column title as bare muted
      // mono at the title's own step: five filled chips across a wide surface
      // read as five badges, not as five counts.
      count: "font-mono text-ui text-muted-foreground",
      // In the ticket rail it is a filled pill at `text-label`, because it
      // ends a section eyebrow with nothing else on the line to bound it.
      // `ticket/ticket-sessions-panel.tsx` records that call, having copied
      // `ticket/ticket-changes-panel.tsx`'s pill byte-for-byte to make it.
      //
      // Both are `font-mono` for the same reason: a number that changes must
      // not move the text beside it. Which is why `mono` is not how you reach
      // either one.
      "count-pill": "rounded-full bg-accent px-1 font-mono text-label text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

function Badge({
  className,
  variant,
  mono = false,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & {
    /**
     * For a chip whose content is an identifier the machine chose — a hook
     * event name, a path, a hash. The count variants are mono already.
     */
    mono?: boolean;
  }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant ?? "outline"}
      className={cn(badgeVariants({ variant }), mono && "font-mono", className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
