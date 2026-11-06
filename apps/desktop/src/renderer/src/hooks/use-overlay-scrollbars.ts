import { useEffect } from "react";

/** One window listener, not one listener/subscription for every scroller.
 * A thumb is visible only during a scroll burst or hover. Attribute writes
 * happen once per burst; streaming scroll events only retarget the idle timer.
 */
export function useOverlayScrollbars() {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const scroll = (event: Event) => {
      const target = event.target instanceof Element ? event.target : document.scrollingElement;
      if (target === null) return;
      const old = timers.get(target);
      if (old === undefined) target.setAttribute("data-scrolling", "");
      else clearTimeout(old);
      timers.set(
        target,
        setTimeout(() => {
          timers.delete(target);
          target.removeAttribute("data-scrolling");
        }, 700),
      );
    };
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", scroll, { capture: true });
      for (const [target, timer] of timers) {
        clearTimeout(timer);
        target.removeAttribute("data-scrolling");
      }
    };
  }, []);
}
