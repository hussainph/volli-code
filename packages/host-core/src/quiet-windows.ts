export const QUIET_WINDOWS_ENV = "VOLLI_QUIET_WINDOWS";

export interface QuietWindowPolicy {
  readonly enabled: boolean;
  readonly useAccessoryActivation: boolean;
  readonly backgroundThrottling: boolean;
  readonly showInactive: boolean;
  readonly ignoreMouseEvents: boolean;
  readonly belowNormalWindowLevel: boolean;
  readonly focusable: boolean;
}

interface QuietApp {
  setActivationPolicy(policy: "accessory" | "prohibited"): void;
  dock?: { hide(): void };
}

interface QuietWindow {
  show(): void;
  showInactive(): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: "normal", relativeLevel: number): void;
}

/** The native-window policy selected for this process before any window exists. */
export function quietWindowPolicy(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): QuietWindowPolicy {
  const enabled = environment[QUIET_WINDOWS_ENV] === "1";
  return {
    enabled,
    useAccessoryActivation: enabled && platform === "darwin",
    backgroundThrottling: !enabled,
    showInactive: enabled,
    ignoreMouseEvents: enabled,
    belowNormalWindowLevel: enabled && platform === "darwin",
    focusable: !(enabled && platform === "darwin"),
  };
}

/** Apply the process-wide macOS policy before any BrowserWindow is created. */
export function applyQuietAppPolicy(app: QuietApp, policy: QuietWindowPolicy): void {
  if (!policy.useAccessoryActivation) return;
  app.setActivationPolicy("accessory");
  app.dock?.hide();
}

/** Prevent activation after the one compositor window has been revealed. */
export function sealQuietAppActivation(app: QuietApp, policy: QuietWindowPolicy): void {
  if (policy.useAccessoryActivation) app.setActivationPolicy("prohibited");
}

/** Reveal one app window without taking focus or intercepting the host pointer. */
export function revealWindow(window: QuietWindow, policy: QuietWindowPolicy): void {
  if (!policy.showInactive) {
    window.show();
    return;
  }

  if (policy.ignoreMouseEvents) window.setIgnoreMouseEvents(true);
  if (policy.belowNormalWindowLevel) {
    // Electron 44 / macOS 26 measured this relative NSWindow level below every
    // ordinary app window while leaving CDP input and screenshots unaffected.
    // showInactive() otherwise calls orderFrontRegardless and covers the screen.
    window.setAlwaysOnTop(true, "normal", -1);
  }
  window.showInactive();
}
