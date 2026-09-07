/**
 * How a value too long for the box it is drawn in gets read anyway (VC-288).
 *
 * The app truncates a lot, and truncation is usually right: a venue path, a
 * branch name, a model name and a tab label are all arbitrarily long values
 * drawn in a pane whose width a person chose for the CONTENT, not for them. The
 * bug is never the ellipsis. It is that the whole value then lived on a
 * `title` or on a tooltip hung off a `<span>` — a reveal a pointer can ask for
 * and a keyboard cannot, at exactly the widths where the clipping bites.
 *
 * TWO SHAPES, because a truncated value sits in one of two situations:
 *
 *  - it is drawn in something INERT (a caption chip, a rail row). Nothing there
 *    is focusable, so the reveal has to bring its own focus stop: that is
 *    {@link ValueReveal}, a button that goes nowhere, because the reveal IS the
 *    act. It carries the untruncated value as its accessible name, so a screen
 *    reader never has to open anything, and being in the tab order is what
 *    makes Radix open the tooltip on focus as well as on hover.
 *  - it is drawn inside something ALREADY focusable (a tab, a control). Adding
 *    a second stop there would be a nested interactive element and one more
 *    press between a person and the thing they were reaching for, so the reveal
 *    rides the control that is already there: that is {@link useClippedReveal},
 *    which opens the tooltip on the element's own hover and focus and only when
 *    the text is genuinely clipped.
 *
 * The measurement is what keeps the second shape quiet. A tab whose label fits
 * has nothing to reveal, and a tooltip that opened over every tab in a strip
 * would be noise a person learns to ignore — which is how a reveal that matters
 * gets missed.
 */
import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

/**
 * Sub-pixel slack, for the same reason `tab-scroll.ts` carries one: at 125% and
 * 150% zoom a browser hands back fractional layout metrics, and an element
 * drawing everything it holds can still report a `scrollWidth` a quarter-pixel
 * past its `clientWidth`.
 */
const CLIP_EPSILON = 1;

/** Whether `element` is drawing less than it holds. */
export function isTextClipped(element: HTMLElement | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  return element.scrollWidth - element.clientWidth > CLIP_EPSILON;
}

/**
 * Tooltip state for a value inside something that is already a focus stop.
 *
 * Spread onto a `Tooltip`; point `ref` at the element that does the
 * truncating. Radix still owns the gesture — hover with the group's delay,
 * focus with none — and this only ever says no: an open is refused when the
 * text is whole, and it is measured at the moment of the request rather than
 * on a resize, because that is the one moment the answer is needed and the
 * cheapest place to ask for it.
 */
export function useClippedReveal(ref: React.RefObject<HTMLElement | null>): {
  open: boolean;
  onOpenChange(next: boolean): void;
} {
  const [open, setOpen] = React.useState(false);
  return {
    open,
    onOpenChange: (next: boolean) => setOpen(next && isTextClipped(ref.current)),
  };
}

/**
 * A truncated value and the focus stop that reveals it.
 *
 * `cursor-default`, because a pointer should not be promised a destination this
 * control does not have, and `type="button"` so a reveal inside a form cannot
 * submit it.
 */
export function ValueReveal({
  /** What the value IS — `Worktree`, `Branch` — leading the accessible name. */
  term,
  /** The untruncated value: the reveal's whole reason to exist. */
  full,
  /** The tooltip's own words, where the term would read oddly repeated. */
  reveal,
  side = "bottom",
  className,
  contentClassName,
  children,
}: {
  term: string;
  full: string;
  reveal?: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="value-reveal"
          // The alternatives were both worse. `tabIndex` on a span puts a stop
          // in the tab order that AT announces as nothing in particular, and
          // wrapping a 60-character value turns a caption into a paragraph.
          aria-label={`${term} · ${full}`}
          className={cn(
            "cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className={cn("font-mono", contentClassName)}>
        {reveal ?? `${term} · ${full}`}
      </TooltipContent>
    </Tooltip>
  );
}
