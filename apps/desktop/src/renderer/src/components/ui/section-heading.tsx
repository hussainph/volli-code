/** Shared sentence-case section headings. Layout stays with the caller. */
import type * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * Compact group header: names a group the user scans or folds (rail sections,
 * picker groups). A page or pane title is `as="h2"` instead. Menu and palette
 * group headers are not on this rung: `MENU_LABEL` sets them below the rows
 * they name (VC-1212).
 */
export const SECTION_HEADING = "text-ui font-semibold text-foreground";

export function SectionHeading({
  as = "h2",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  /** h2 titles, h3 compact group headers, inline span labels. Legacy `p` renders an h3. */
  as?: "h2" | "h3" | "p" | "span";
}) {
  const Component = as === "p" ? "h3" : as;
  return (
    <Component
      className={cn(
        as === "h2" && "text-heading font-semibold text-foreground",
        (as === "h3" || as === "p") && SECTION_HEADING,
        as === "span" && "text-ui font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
