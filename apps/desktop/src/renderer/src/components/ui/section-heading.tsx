/**
 * The section eyebrow — 11px caps in the mute, over whatever it introduces.
 *
 * One drawing, nine hand-written copies, four HTML elements and three weights
 * before this file. The element spread was the part that was not merely
 * repetition: `h2`, `h3`, `p` and `span` tell a screen reader that four
 * different things are on screen where the eye reads one. `as` is therefore a
 * SEMANTIC axis and changes nothing visual — a rail section that belongs in the
 * document outline takes `h2`, a settings nav label that does not takes `p`,
 * and both draw the same line.
 *
 * The weight is `font-medium` with no prop to move it. Four sites already said
 * so, including the refined sidebar band header the rest of the app is being
 * measured against; the sites that drew regular did it by omission, and 11px
 * caps in `text-muted-foreground` are already the quietest ink on a surface
 * without also being the lightest stroke.
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN is the row. Every one of the nine sites
 * wraps the eyebrow differently — `h-6` beside a count and a filter menu in the
 * sidebar, `justify-between` over an action in the rail, `px-2 pb-2 pt-1` at
 * the top of a settings nav, nothing at all on the board's collapsed rail. A
 * container here would be overridden more often than it was used, so the row
 * stays at the site and only the ink comes through the primitive.
 */

import type * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * The eyebrow, as a class string, for the surfaces that cannot mount a
 * component — see {@link SECTION_HEADING_CMDK}. The component below is this
 * constant plus an element choice, so the two can never drift apart.
 */
export const SECTION_HEADING = "text-label font-medium uppercase text-muted-foreground";

/**
 * {@link SECTION_HEADING} again, aimed through a descendant selector, because
 * cmdk renders its own group heading element and a className on the group is
 * the only way to reach it.
 *
 * Written out rather than derived from the constant above: Tailwind resolves
 * utilities by scanning source text, so a prefix applied at runtime would emit
 * no CSS at all. Any edit to one of these two has to be made to both.
 */
export const SECTION_HEADING_CMDK =
  "[&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground";

export function SectionHeading({
  as: Component = "h2",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  /** The element the DOCUMENT needs. Purely semantic — every value draws the same. */
  as?: "h2" | "h3" | "p" | "span";
}) {
  return <Component className={cn(SECTION_HEADING, className)} {...props} />;
}
