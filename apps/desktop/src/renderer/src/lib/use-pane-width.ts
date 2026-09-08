/**
 * How wide the box a component is standing in actually is (VC-288).
 *
 * Every "narrow" rule in this app used to be a window rule, and split view is
 * what made that wrong: two panes share one window, so the window's width says
 * nothing about the room either of them has. A media query cannot see it and
 * neither can a resize handler — a divider drag, a rail opening, a split and an
 * unsplit all change a pane's width without changing the window's at all.
 *
 * `ResizeObserver` is the one thing that hears all five, which is why this is a
 * measurement rather than a breakpoint. Where a rule can be expressed in CSS a
 * container query is still the cheaper answer (`@container`); this exists for
 * the rules that have to be a NUMBER in JavaScript — the diff's fit, which is
 * an option passed to Monaco rather than a class.
 *
 * `null` until the first measurement, and never 0-as-narrow: the frame before
 * the observer has reported, and a pane inside a `display: none` ancestor, are
 * both "not known yet", and a caller that read them as "narrow" would flash the
 * narrow drawing into a pane that is not.
 */
import * as React from "react";

/**
 * The measured content width of `ref`'s element, in CSS px, or `null` before
 * the first measurement.
 *
 * Measured in a layout effect so the first real width lands before paint, and
 * re-measured on every resize of that element for the lifetime of the mount.
 * `deps` re-attaches the observer when the ref points at a DIFFERENT element
 * than it did — a component whose measured box only exists in some of its
 * states has to say when that box arrives, because a ref changing is not a
 * render React can see.
 */
export function usePaneWidth(
  ref: React.RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
): number | null {
  const [width, setWidth] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    // Guarded: jsdom ships no `ResizeObserver`, and a hook that threw on mount
    // without one would take every component that measures itself out of the
    // test suite. The first measurement still lands, so a caller in that
    // environment gets one honest width rather than none.
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // The ref itself is stable; what the caller is declaring here is when the
    // element behind it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return width;
}
