import * as React from "react";

/**
 * Tracks the window's macOS fullscreen state (seeded via IPC, then pushed
 * from main on enter/leave). Lets chrome-adjacent UI — like the rail's
 * traffic-light strip — reclaim space when the lights are hidden.
 */
export function useFullScreen() {
  const [fullScreen, setFullScreen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    // If a push event lands before the async seed resolves (the user toggles
    // fullscreen mid-round-trip), the seed carries the pre-transition value and
    // must not clobber the newer event-set state.
    let settledByEvent = false;
    window.api.window
      .isFullScreen()
      .then((value) => {
        if (!cancelled && !settledByEvent) setFullScreen(value);
      })
      // State read, not a mutation: on failure keep the windowed-mode default.
      .catch(() => {});
    const unsubscribe = window.api.window.onFullScreenChange((value) => {
      settledByEvent = true;
      setFullScreen(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return fullScreen;
}
