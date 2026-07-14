interface ResolutionMediaQueryList {
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

interface DisplayWindow {
  readonly devicePixelRatio: number;
  matchMedia(query: string): ResolutionMediaQueryList;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

/**
 * Watch the display scale independently of layout size.
 *
 * A ResizeObserver does not fire when a window moves between monitors but its
 * CSS-pixel dimensions stay unchanged. Resolution media queries do; they need
 * to be rebuilt after every change because each query matches one DPR only.
 * The resize listener is a fallback for presentation/display transitions that
 * update devicePixelRatio while keeping the old media-query object quiet.
 */
export function watchDevicePixelRatio(target: DisplayWindow, onChange: () => void): () => void {
  let observedRatio = target.devicePixelRatio;
  let mediaQuery: ResolutionMediaQueryList | null = null;

  const armResolutionQuery = (): void => {
    mediaQuery?.removeEventListener("change", handlePotentialChange);
    mediaQuery = target.matchMedia(`(resolution: ${observedRatio}dppx)`);
    mediaQuery.addEventListener("change", handlePotentialChange);
  };

  const handlePotentialChange = (): void => {
    const nextRatio = target.devicePixelRatio;
    if (nextRatio === observedRatio) return;
    observedRatio = nextRatio;
    armResolutionQuery();
    onChange();
  };

  armResolutionQuery();
  target.addEventListener("resize", handlePotentialChange);

  return () => {
    mediaQuery?.removeEventListener("change", handlePotentialChange);
    target.removeEventListener("resize", handlePotentialChange);
  };
}
