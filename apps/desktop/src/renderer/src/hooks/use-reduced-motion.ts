import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// One MediaQueryList shared by every caller — the flag is global to the
// window, and this hook mounts once per ticket card, so per-instance
// `matchMedia` objects would multiply with board size and churn on remount.
// Lazily created so importing the module never touches `window`.
let mediaQuery: MediaQueryList | undefined;

function getMediaQuery(): MediaQueryList {
  mediaQuery ??= window.matchMedia(QUERY);
  return mediaQuery;
}

function subscribe(onChange: () => void): () => void {
  const query = getMediaQuery();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return getMediaQuery().matches;
}

/** Live `prefers-reduced-motion` flag; drives JS-side animation opt-outs. */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot);
}
