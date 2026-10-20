import { useEffect, useState } from "react";

/** Hide immediately; show only after the condition holds for the whole delay.
 * Initial visibility is used by a turn that begins without any other progress. */
export function useDelayedPresence(active: boolean, delayMs: number, initiallyVisible = false) {
  const [ready, setReady] = useState(initiallyVisible);
  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }
    const timer = window.setTimeout(() => setReady(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && ready;
}
