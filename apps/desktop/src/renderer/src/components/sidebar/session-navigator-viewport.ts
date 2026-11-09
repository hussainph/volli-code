import * as React from "react";
import type { SessionNavigatorRow } from "./session-navigator-rows";

const OVERSCAN = 240;
/** Include focused rows independently: scrolling never unmounts the keyboard owner. */
export function navigatorViewportRows(
  rows: readonly SessionNavigatorRow[],
  top: number,
  bottom: number,
) {
  return rows.filter(
    (row) =>
      row.kind === "reach" ||
      row.focused ||
      (row.offset + row.height >= top - OVERSCAN && row.offset <= bottom + OVERSCAN),
  );
}

export function useSessionNavigatorViewport() {
  const ref = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLElement | null>(null);
  const [view, setView] = React.useState({ top: 0, bottom: 800 });
  const update = React.useCallback(() => {
    const root = ref.current,
      scroll = scrollRef.current;
    if (!root || !scroll || scroll.clientHeight === 0) return;
    const top = scroll.getBoundingClientRect().top - root.getBoundingClientRect().top;
    setView((old) =>
      old.top === top && old.bottom === top + scroll.clientHeight
        ? old
        : { top, bottom: top + scroll.clientHeight },
    );
  }, []);
  React.useLayoutEffect(() => {
    const scroll = ref.current?.closest<HTMLElement>('[data-slot="sidebar-content"]');
    if (!scroll) {
      setView({ top: 0, bottom: Infinity });
      return;
    }
    scrollRef.current = scroll;
    update();
    scroll.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      observer?.disconnect();
      scrollRef.current = null;
    };
  }, [update]);
  const reveal = React.useCallback(
    (row: SessionNavigatorRow) => {
      const root = ref.current,
        scroll = scrollRef.current;
      if (!root || !scroll) return;
      const top = scroll.getBoundingClientRect().top - root.getBoundingClientRect().top;
      if (row.offset < top) scroll.scrollTop += row.offset - top;
      else if (row.offset + row.height > top + scroll.clientHeight)
        scroll.scrollTop += row.offset + row.height - top - scroll.clientHeight;
      update();
    },
    [update],
  );
  return { ref, view, reveal };
}
