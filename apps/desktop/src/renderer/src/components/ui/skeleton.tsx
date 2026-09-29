/**
 * The pulsing bar a first read draws in place of the thing it is fetching.
 *
 * The recipe lives in `globals.css` (VC-383): this stable data slot and
 * Monaco's loading host read the same fill, radius, pulse, and reduced-motion
 * gate through `--skeleton-*` properties. Keeping the material there means the
 * pseudo-elements Monaco requires cannot drift from React-owned bars.
 *
 * A skeleton carries NO geometry. Height, width and margins are the caller's,
 * because a placeholder's only job is to hold the exact box its content will
 * take — a default here would be wrong at every site that has to override it.
 */

import type * as React from "react";

function Skeleton({
  as: Component = "div",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  /**
   * `span` for a placeholder inside phrasing content — a bar standing in for a
   * line of text inside a button or a label cannot be a `div`.
   */
  as?: "div" | "span";
}) {
  return <Component data-slot="skeleton" className={className} {...props} />;
}

export { Skeleton };
