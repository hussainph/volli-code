import { useSyncExternalStore } from "react";

/** One resize transaction fence, shared by heavyweight renderers. No frame ticks. */
const owners = new Set<object>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const paneResizeActive = () => owners.size > 0;
export function usePaneResizeActive(): boolean {
  return useSyncExternalStore(subscribe, paneResizeActive, () => false);
}
export function beginPaneResize(owner: object): () => void {
  const changed = !owners.has(owner);
  owners.add(owner);
  if (changed) for (const listener of listeners) listener();
  return () => {
    if (owners.delete(owner)) for (const listener of listeners) listener();
  };
}
export function onPaneResizeSettled(callback: () => void): () => void {
  return subscribe(() => {
    if (!paneResizeActive()) callback();
  });
}
/** Monaco opts out of automaticLayout and reports only settled geometry. */
export function observePaneLayout(element: HTMLElement, layout: () => void): () => void {
  const request = () => {
    if (!paneResizeActive()) layout();
  };
  const observer = new ResizeObserver(request);
  observer.observe(element);
  const off = onPaneResizeSettled(request);
  return () => {
    observer.disconnect();
    off();
  };
}
