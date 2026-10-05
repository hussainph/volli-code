const UNUSED_OBSERVER_FEATURE = "DeclarativePerformanceObserver";

interface ChromiumCommandLine {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
}

/** Apply before ready/session creation, in packaged and development launches. */
export function disableUnusedBrowserFeatures(commandLine: ChromiumCommandLine): void {
  // Chromium 152 eagerly initializes this experimental HTTP performance-report
  // store even when no page opts in. Its BEST_EFFORT/BLOCK_SHUTDOWN SQLite task
  // can hold native exit in journal fsync (VC-635). Volli does not use the
  // observer; disable its browser feature, not persistence or shutdown barriers.
  // A renderer-only disable-blink-features switch would still create the store.
  const disabled = commandLine.getSwitchValue("disable-features");
  if (disabled.split(",").some((feature) => feature.trim() === UNUSED_OBSERVER_FEATURE)) return;
  commandLine.appendSwitch(
    "disable-features",
    disabled ? `${disabled},${UNUSED_OBSERVER_FEATURE}` : UNUSED_OBSERVER_FEATURE,
  );
}
