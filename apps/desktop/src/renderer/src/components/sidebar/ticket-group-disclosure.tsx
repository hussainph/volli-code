import * as React from "react";

import { SidebarMenuItem, SidebarMenuSub } from "@renderer/components/ui/sidebar";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";

/** The sidebar ticket envelope is the sole measured-height disclosure. Keep
 * only the exiting children resident; every keyboard/programmatic change snaps. */
export function TicketGroupDisclosure({
  open,
  id,
  header,
  children,
  className,
}: {
  open: boolean;
  id: string;
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const pointer = React.useRef(false);
  const previous = React.useRef(open);
  const [present, setPresent] = React.useState(open);
  const animation = React.useRef<Animation | null>(null);
  React.useLayoutEffect(() => {
    const changed = previous.current !== open;
    const wasOpen = previous.current;
    previous.current = open;
    const body = bodyRef.current;
    if (body === null) return;
    const bounds = animation.current === null ? null : body.getBoundingClientRect();
    const zoom = bounds !== null && body.offsetWidth > 0 ? bounds.width / body.offsetWidth : 1;
    const from =
      animation.current === null ? (wasOpen ? body.scrollHeight : 0) : (bounds?.height ?? 0) / zoom;
    const liveOpacity = Number.parseFloat(getComputedStyle(body).opacity);
    const opacity =
      animation.current !== null && Number.isFinite(liveOpacity) ? liveOpacity : wasOpen ? 1 : 0;
    animation.current?.cancel();
    animation.current = null;
    if (!changed || reduced || !pointer.current || typeof body.animate !== "function") {
      pointer.current = false;
      setPresent(open);
      return;
    }
    pointer.current = false;
    setPresent(true);
    const journey = body.animate(
      [
        { height: `${from}px`, opacity },
        { height: `${open ? body.scrollHeight : 0}px`, opacity: open ? 1 : 0 },
      ],
      { duration: open ? 200 : 160, easing: GLASS_MOTION.easeOutCss, fill: "both" },
    );
    animation.current = journey;
    journey.onfinish = () => {
      if (animation.current !== journey) return;
      journey.cancel();
      animation.current = null;
      setPresent(open);
    };
  }, [open, reduced]);
  React.useEffect(() => () => animation.current?.cancel(), []);
  return (
    <SidebarMenuItem
      className="session-envelope rounded-card"
      data-motion-origin="keyboard"
      onClickCapture={(event) => {
        event.currentTarget.dataset.motionOrigin = event.detail > 0 ? "pointer" : "keyboard";
        pointer.current =
          event.detail > 0 &&
          event.target instanceof Element &&
          event.target.closest("button")?.getAttribute("aria-controls") === id;
      }}
      onKeyDownCapture={(event) => {
        event.currentTarget.dataset.motionOrigin = "keyboard";
        pointer.current = false;
      }}
    >
      {header}
      <div ref={bodyRef} className="overflow-hidden" inert={!open} aria-hidden={!open || undefined}>
        {open || present ? (
          <SidebarMenuSub id={id} className={className}>
            {children}
          </SidebarMenuSub>
        ) : null}
      </div>
    </SidebarMenuItem>
  );
}
