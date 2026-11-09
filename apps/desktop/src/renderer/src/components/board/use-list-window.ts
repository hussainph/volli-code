import * as React from "react";
import {
  boundedWindow,
  columnWindow,
  mergeColumnWindows,
  type ColumnWindow,
} from "./column-window";

/** The list's fixed h-9 rows; the full status/drop model is never sliced. */
export function useListWindow(input: {
  scroller: React.RefObject<HTMLDivElement | null>;
  list: React.RefObject<HTMLDivElement | null>;
  count: number;
  revealIndex: number;
  dragActive: boolean;
}) {
  const { scroller, list, count, revealIndex, dragActive } = input;
  const [range, setRange] = React.useState<ColumnWindow>({ first: 0, last: Math.min(40, count) });
  const update = React.useCallback(() => {
    const scroll = scroller.current,
      body = list.current;
    if (!scroll || !body) return;
    const top = scroll.getBoundingClientRect().top - body.getBoundingClientRect().top;
    const next = columnWindow({
      count,
      scrollTop: Math.max(0, top),
      viewportHeight: scroll.clientHeight,
      rowStride: 36,
    });
    setRange((old) => {
      const value = dragActive ? mergeColumnWindows(old, next) : next;
      return value.first === old.first && value.last === old.last ? old : value;
    });
  }, [count, dragActive, scroller, list]);
  React.useLayoutEffect(() => {
    update();
    const scroll = scroller.current;
    if (!scroll) return;
    scroll.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scroller, update]);
  React.useLayoutEffect(() => {
    const scroll = scroller.current,
      body = list.current;
    if (!scroll || !body || revealIndex < 0 || revealIndex >= count) return;
    const top =
      body.getBoundingClientRect().top - scroll.getBoundingClientRect().top + revealIndex * 36;
    if (top < 0) scroll.scrollTop += top;
    else if (top + 36 > scroll.clientHeight) scroll.scrollTop += top + 36 - scroll.clientHeight;
    update();
  }, [count, revealIndex, scroller, list, update]);
  return boundedWindow(range, count);
}
