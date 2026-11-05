import * as React from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// One MediaQueryList shared by every caller — the flag is global to the
// window, and hot lists may mount many callers, so per-instance
// `matchMedia` objects would multiply with board size and churn on remount.
// Lazily created so importing the module never touches `window`.
let mediaQuery: MediaQueryList | undefined;

function getMediaQuery(): MediaQueryList | undefined {
  if (typeof window.matchMedia !== "function") return undefined;
  mediaQuery ??= window.matchMedia(QUERY);
  return mediaQuery;
}

const subscribers = new Set<() => void>();
function notifyMotionPreference(): void {
  for (const subscriber of subscribers) subscriber();
}

/** One OS/app listener pair, installed only while an animation owner subscribes. */
export function subscribeMotionPreference(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const query = getMediaQuery();
  // A distinct entry allows two owners to subscribe the same callback safely.
  const notify = () => onChange();
  if (subscribers.size === 0) {
    query?.addEventListener("change", notifyMotionPreference);
    window.addEventListener("volli-motion-change", notifyMotionPreference);
  }
  subscribers.add(notify);
  return () => {
    if (!subscribers.delete(notify) || subscribers.size !== 0) return;
    query?.removeEventListener("change", notifyMotionPreference);
    window.removeEventListener("volli-motion-change", notifyMotionPreference);
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
