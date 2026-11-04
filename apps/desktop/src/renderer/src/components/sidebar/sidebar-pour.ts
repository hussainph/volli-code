import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import * as React from "react";

/**
 * A pointer-dismissed pane returns to its toolbar control. The live subtree is
 * never cloned or remounted; WAAPI overrides only its presentation. Keyboard,
 * reduced-motion and native-plane paths take the endpoint immediately.
 */
export function useSidebarPour({
  shown,
  instant,
  panelRef,
  bandRef,
}: {
  shown: boolean;
  instant: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  bandRef: React.RefObject<HTMLDivElement | null>;
}): boolean {
  const previous = React.useRef(shown);
  const animation = React.useRef<Animation | null>(null);
  const [pouring, setPouring] = React.useState(false);

  React.useLayoutEffect(() => {
    const wasShown = previous.current;
    previous.current = shown;
    const panel = panelRef.current;
    const trigger = bandRef.current?.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]');
    const stop = () => {
      animation.current?.cancel();
      animation.current = null;
      panel?.removeAttribute("data-pane-pouring");
      setPouring(false);
    };
    if (shown || instant) {
      if (shown) panel?.removeAttribute("data-keyboard-dismiss");
      stop();
      return;
    }
    if (!wasShown || panel === null || trigger == null) return;
    if (panel.hasAttribute("data-keyboard-dismiss") || typeof panel.animate !== "function") return;
    const parent = panel.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const rect = panel.getBoundingClientRect();
    const target = trigger.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const zoom = rect.width / panel.offsetWidth;
    const parentRect = parent.getBoundingClientRect();
    const left = parentRect.left + panel.offsetLeft * zoom;
    const top = parentRect.top + panel.offsetTop * zoom;
    const from = `translate(${(rect.left - left) / zoom}px, ${(rect.top - top) / zoom}px)`;
    const to = `translate(${(target.left - left) / zoom}px, ${(target.top - top) / zoom}px) scale(${target.width / rect.width}, ${target.height / rect.height})`;
    // All three gates are synchronous, before the compositor's first frame.
    panel.dataset.panePouring = "true";
    setPouring(true);
    const journey = panel.animate(
      [
        { translate: "none", transformOrigin: "0 0", transform: from, opacity: 1 },
        { translate: "none", transformOrigin: "0 0", transform: to, opacity: 0 },
      ],
      { duration: GLASS_MOTION.menuIn, easing: GLASS_MOTION.easeOutCss, fill: "both" },
    );
    animation.current = journey;
    journey.onfinish = () => {
      if (animation.current === journey) stop();
    };
  }, [shown, instant, panelRef, bandRef]);

  React.useEffect(() => () => animation.current?.cancel(), []);
  return pouring;
}
