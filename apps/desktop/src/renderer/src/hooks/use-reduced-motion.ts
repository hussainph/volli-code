import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// One MediaQueryList shared by every caller — the flag is global to the
// window, and this hook mounts once per ticket card, so per-instance
// `matchMedia` objects would multiply with board size and churn on remount.
// Lazily created so importing the module never touches `window`.
let mediaQuery: MediaQueryList | undefined;

function getMediaQuery(): MediaQueryList | undefined {
  if (typeof window.matchMedia !== "function") return undefined;
  mediaQuery ??= window.matchMedia(QUERY);
  return mediaQuery;
}

/** Shared live subscription for imperative animation owners as well as React. */
export function subscribeMotionPreference(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const query = getMediaQuery();
  query?.addEventListener("change", onChange);
  window.addEventListener("volli-motion-change", onChange);
  return () => {
    query?.removeEventListener("change", onChange);
    window.removeEventListener("volli-motion-change", onChange);
  };
}

/** Theme brightness may ease under OS reduce, but app Motion off means instant. */
export function motionPreferenceSnapshot(): { appOff: boolean; systemReduce: boolean } {
  return {
    appOff: typeof document !== "undefined" && document.documentElement?.dataset?.motion === "off",
    systemReduce: typeof window !== "undefined" && getMediaQuery()?.matches === true,
  };
}

function getSnapshot(): boolean {
  const preference = motionPreferenceSnapshot();
  return preference.appOff || preference.systemReduce;
}

/** Live system + app Motion preference; drives JS-side animation opt-outs. */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribeMotionPreference, getSnapshot, () => true);
}

/**
 * The same flag, read outside a render — for a gesture that decides how to
 * move at the moment it moves (a tab strip scrolling a clipped tab into view).
 *
 * Not a second source of truth: it is the hook's own snapshot without the
 * subscription, which is what a one-shot decision actually needs. Reading it
 * this way also keeps `window` out of the render path entirely, so a component
 * that only animates in an effect can still be rendered to a string — the
 * whole renderer test suite does exactly that.
 */
export function prefersReducedMotion(): boolean {
  return typeof window === "undefined" ? false : getSnapshot();
}
