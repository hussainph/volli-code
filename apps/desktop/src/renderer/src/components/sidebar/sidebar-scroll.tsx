import { scrollEdgeMask } from "@renderer/components/ui/scroll-edge-mask";
/**
 * The sidebar's scrollport, with its cut ends faded.
 *
 * It used to draw its own scroll thumb, because the global `::-webkit-scrollbar`
 * bar took 10px out of the pane whenever the list overflowed and shoved every
 * row's right edge inward. Native bars are now off everywhere and the app's one
 * overlay thumb (`lib/scroll-thumb`) takes no width, so this keeps only what is
 * the sidebar's own: the edge fade, which shows only where the list is cut.
 */
import * as React from "react";

import { SidebarContent } from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";

/** Which ends of the list are flush against their own edge, and so uncut. */
interface ScrollEdges {
  atTop: boolean;
  atBottom: boolean;
}

export function SidebarScrollArea({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = React.useState<ScrollEdges>({ atTop: true, atBottom: true });

  /**
   * Idempotent on purpose: the layout effect below runs after EVERY render,
   * including the one this setter causes, so returning the same object when
   * nothing moved is what lets React bail out.
   */
  const measure = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const { clientHeight, scrollHeight, scrollTop } = element;
    // Sub-pixel scrollHeights mean the bottom never reaches equality exactly, so
    // the last pixel would keep a fade the reader has already scrolled past.
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
    setEdges((current) =>
      current.atTop === atTop && current.atBottom === atBottom ? current : { atTop, atBottom },
    );
  }, []);

  // After layout, with no dependency array: a content height that changed
  // during a render of THIS subtree is caught before anything can be observed.
  React.useLayoutEffect(measure);

  // The sizes React does not render: the window resizing, the grip dragging the
  // pane, and the CONTENT's height, which the scrollport's own box cannot
  // report — sessions arrive on `ActiveSessions`'s own store subscription, so
  // the list grows inside a child that re-renders alone.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <SidebarContent
      ref={scrollRef}
      onScroll={measure}
      style={{ maskImage: scrollEdgeMask(edges) }}
      className={cn("overflow-x-hidden", className)}
    >
      {children}
    </SidebarContent>
  );
}
