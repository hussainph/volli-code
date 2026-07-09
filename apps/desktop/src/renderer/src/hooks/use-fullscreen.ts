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
    window.api.window
      .isFullScreen()
      .then((value) => {
        if (!cancelled) setFullScreen(value);
      })
      // State read, not a mutation: on failure keep the windowed-mode default.
      .catch(() => {});
    const unsubscribe = window.api.window.onFullScreenChange(setFullScreen);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return fullScreen;
}
