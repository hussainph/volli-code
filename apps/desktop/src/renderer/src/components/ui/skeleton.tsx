/**
 * The pulsing bar a first read draws in place of the thing it is fetching.
 *
 * `motion-reduce:animate-none` is the whole reason this primitive sat unused.
 * Both hand-rolled copies in the app remembered the gate and this file did not,
 * so adopting it was a regression rather than a merge — the one shape of dead
 * code that stays dead, because every author who reached for it found it worse
 * than what they could write themselves.
 *
 * `bg-accent/70` is likewise what the live app draws, at both hand-rolls. There
 * is no tone axis: the audit that scoped this merge asked for one against
 * `bg-sidebar-accent/70`, and that token no longer exists — the alias collapse
 * left only `--sidebar-accent-veil`, which is a hover fill and not a surface.
 * One fill, until a second surface actually needs one.
 *
 * A skeleton carries NO geometry. Height, width and margins are the caller's,
 * because a placeholder's only job is to hold the exact box its content will
 * take — a default here would be wrong at every site that has to override it.
 */

import type * as React from "react";

import { cn } from "@renderer/lib/utils";

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
  return (
    <Component
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent/70 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
