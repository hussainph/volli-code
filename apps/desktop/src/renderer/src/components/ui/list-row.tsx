/**
 * One row of a list: a mark, a name, optionally a line under it, optionally a
 * figure at the end, and — only where the row is a target — the mechanics that
 * make it one.
 *
 * THE BRANCH THIS FILE EXISTS FOR. A row is either activatable or it is not,
 * and the difference has to reach the DOM: an activatable row is a `<button>`
 * with a focus ring and a hover fill; an inert one is a `<div>` with neither. A
 * hover fill on a row nothing happens to is a lie the pointer tells, and
 * `ticket/ticket-sessions-panel.tsx` was the only one of the nine hand-rolled
 * rows that got this right — every other site either had no inert case or drew
 * one that hovered anyway. `onActivate: null` is that branch, spelled once.
 *
 * WHAT THE MERGE FIXED BY CONSTRUCTION: the ring. Three of the nine rows had no
 * `focus-visible` treatment at all, which for a `<button>` is a keyboard user
 * with no idea where they are. It lives on the activation target here, so a row
 * cannot be built without one.
 *
 * TWO ELEMENTS, ALWAYS. The shell carries the fill, the radius and the `group`;
 * the target carries the padding-free content, the ring and the caller's props.
 * They are separate because a row's hover-revealed actions are buttons, and a
 * button inside a button is not markup — so the actions must be the target's
 * SIBLING, and the fill must sit on something that contains both or the row
 * un-tints the moment the pointer reaches the actions it just revealed.
 *
 * WHAT STAYS WITH THE CALLER: the list element and its ARIA (`role="listbox"`
 * / `role="option"` belong to the list, not to a row), drag handles, context
 * menus, store reads, and every `data-*` an end-to-end test aims at — those
 * pass through to the activation target, which is the thing a test clicks.
 *
 * TWO DENSITIES, AND ONE HEIGHT PER DENSITY. `two-line` is 52px: two `text-ui`
 * line boxes and 12. It was 52 in the Diffs page and 56 in the Files page for
 * no reason either page could state — `docs/DESIGN.md` recorded the 52 as a
 * measured exception belonging to `ticket-changes-panel.tsx`, and it turned out
 * to belong to the object rather than to the page. `min-h-13` is that same 52
 * as a floor, and it binds for one case: a repository-root file has no parent
 * path, so its second line draws no box and the row would otherwise sit 20px
 * shorter than its neighbours.
 */
import type * as React from "react";

import { cn } from "@renderer/lib/utils";

export type ListRowDensity = "row" | "two-line";

const DENSITY: Record<ListRowDensity, string> = {
  row: "py-2",
  "two-line": "min-h-13 py-1.5",
};

export function ListRow({
  leading,
  primary,
  primaryTrailing,
  secondary,
  trailing,
  actions,
  onActivate,
  selected = false,
  density = "row",
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement> & {
  /**
   * Radix merges a trigger's listeners AND its ref onto the row when a caller
   * wraps one in `ContextMenuTrigger asChild`; a row that dropped either would
   * be a row whose right-click opens nothing.
   */
  ref?: React.Ref<HTMLElement>;
  /** The row's mark — a glyph, a status dot. Sized by the caller. */
  leading?: React.ReactNode;
  /** The name. Truncates; it is the only thing here allowed to grow. */
  primary: React.ReactNode;
  /**
   * Marks that ride the name's own line and must not move it — a recency badge,
   * a status word. Not `trailing`: these read as part of the name, and the row
   * is what separates them from the figure at the far end.
   */
  primaryTrailing?: React.ReactNode;
  /** The line under the name, a step quieter. Truncates. */
  secondary?: React.ReactNode;
  /** The figure at the end — a count, a stat pair, a chevron. Part of the target. */
  trailing?: React.ReactNode;
  /**
   * Controls with their own click targets, OUTSIDE the activation target. A
   * hover-revealed pair goes here; so does an always-visible one.
   */
  actions?: React.ReactNode;
  /** `null` where there is nothing to open — the row draws inert and is a `<div>`. */
  onActivate: (() => void) | null;
  selected?: boolean;
  density?: ListRowDensity;
}) {
  const activatable = onActivate !== null;

  // A STRING is typeset by the row; a NODE is the caller's own element and must
  // grow and truncate itself. Both text slots read this way, and it is the only
  // reason three of the four rows could adopt: the sessions roster swaps its
  // title for a rename field mid-row, and the archive list's name line is an id
  // beside a title while its meta line is a wrapping strip with a link in it.
  // Wrapping those in a truncating span would clip a field to nothing and
  // straighten a strip that is meant to wrap.
  const content = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          {typeof primary === "string" ? (
            // A two-line row's name outranks the line under it; a one-line row
            // has nothing to outrank.
            <span
              className={cn("min-w-0 truncate text-ui", density === "two-line" && "font-medium")}
            >
              {primary}
            </span>
          ) : (
            primary
          )}
          {primaryTrailing}
        </span>
        {secondary === undefined ? null : typeof secondary === "string" ? (
          <span className="block truncate text-ui text-muted-foreground/70">{secondary}</span>
        ) : (
          secondary
        )}
      </span>
      {trailing}
    </>
  );

  // `self-stretch` so the target fills the shell's vertical inset: it is what a
  // pointer and a right-click land on, and a target shorter than its own row
  // leaves a dead strip above and below every entry in the list.
  const target =
    "flex min-w-0 flex-1 items-center gap-2 self-stretch text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/45";

  return (
    <div
      className={cn(
        "group relative flex w-full items-center gap-2 rounded-lg border border-transparent px-2",
        DENSITY[density],
        selected
          ? "border-sidebar-border bg-accent/70"
          : activatable && "hover:border-sidebar-border hover:bg-accent/50",
        className,
      )}
    >
      {/* The rest props are element-agnostic HTML attributes plus whatever Radix
          merged in; the cast is which of the two elements they landed on, and
          nothing here reads them. */}
      {activatable ? (
        <button
          type="button"
          onClick={onActivate}
          className={target}
          {...(rest as React.ComponentProps<"button">)}
        >
          {content}
        </button>
      ) : (
        <div className={target} {...(rest as React.ComponentProps<"div">)}>
          {content}
        </div>
      )}
      {actions}
    </div>
  );
}
