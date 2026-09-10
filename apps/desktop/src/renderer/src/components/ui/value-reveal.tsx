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
 *
 * The second shape has a variant, for a value the focusable control does not
 * itself render: a Select trigger draws the selected ITEM's children, so the
 * value is a descendant of a control it knows nothing about. `within` names
 * that host, and the hook then listens where the focus actually lands (VC-288
 * re-review). It also answers the state that has no host at all — a host that
 * is `disabled` takes no focus and its subtree gets no pointer events, so the
 * value has to carry its own stop for exactly as long as that lasts.
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
 *
 * Pass `within` when the focus stop is an ANCESTOR rather than the element
 * itself. Focus does not travel down: `focusin` on the host bubbles up past
 * the value, never into it, so a Select trigger taking focus would otherwise
 * leave its own truncated value silent. See {@link HostedReveal.ownStop} for
 * the state where there is no usable host at all.
 */
export function useClippedReveal(
  ref: React.RefObject<HTMLElement | null>,
  options: { readonly within?: string } = {},
): HostedReveal {
  const { within } = options;
  const [open, setOpen] = React.useState(false);
  // Whether the value has to be its own focus stop. `false` until a host is
  // found and asked, which is also the answer for every surface that passes no
  // `within` at all: there, the caller's own element is already the stop.
  const [ownStop, setOwnStop] = React.useState(false);
  // A press in flight. Clicking a Select trigger focuses it, and a reveal that
  // opened on THAT focus would draw a label over the list the same click just
  // opened. Radix's own trigger keeps this ref for the same reason; the host's
  // focus is not ours to interpret without it.
  const pressing = React.useRef(false);
  const reveal = React.useCallback(
    (next: boolean) => {
      setOpen(next && isTextClipped(ref.current));
    },
    [ref],
  );

  React.useEffect(() => {
    if (within === undefined) return;
    const value = ref.current;
    const host = value?.closest<HTMLElement>(within) ?? null;
    // No host: the same value drawn in the list row it was copied FROM, where
    // it wraps and has nothing to reveal.
    if (host === null || value === null) return;

    // A frozen host is a `<button disabled>`: out of the tab order, and its
    // whole subtree is skipped by pointer events too. Reading what the control
    // says must not depend on being allowed to change it, so the value borrows
    // a stop — and hands it back the moment the host can take focus again,
    // rather than leaving two stops on one control.
    const syncStop = () => {
      const frozen = host.hasAttribute("disabled");
      setOwnStop(frozen);
      // The thaw, with the keyboard standing on the stop that is about to go:
      // hand the focus to the host rather than dropping it on the body.
      if (!frozen && value.contains(document.activeElement)) host.focus();
    };
    syncStop();
    const frozenWatch = new MutationObserver(syncStop);
    frozenWatch.observe(host, { attributes: true, attributeFilter: ["disabled"] });

    const onFocusIn = () => {
      if (!pressing.current) reveal(true);
    };
    const onFocusOut = () => setOpen(false);
    const onPointerDown = () => {
      pressing.current = true;
    };
    const onPointerUp = () => {
      pressing.current = false;
    };
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    host.addEventListener("pointerdown", onPointerDown);
    // On the window, because a press that began on the host can end anywhere.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      frozenWatch.disconnect();
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [ref, reveal, within]);

  return { open, onOpenChange: reveal, ownStop };
}

/** What {@link useClippedReveal} hands back. */
export type HostedReveal = {
  /** The tooltip's open state, for a controlled `Tooltip`. */
  open: boolean;
  onOpenChange(next: boolean): void;
  /**
   * The value must carry `tabIndex={0}` itself: it sits inside a host that
   * cannot take focus (a disabled control), so nothing else near it can ask
   * for the reveal. `false` everywhere else — a second stop inside a working
   * control is a press a person did not ask for.
   */
  ownStop: boolean;
};

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
