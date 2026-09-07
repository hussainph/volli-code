/**
 * The click (VC-295 rule 6).
 *
 * An alert that says "VC-12 is waiting on you" and then, when clicked, leaves
 * you looking at whatever was already on screen is worse than no alert: it
 * spends the interruption and gives nothing back. So a click does two things,
 * in this order — bring Volli forward, then hand the target to a window that
 * can route to it.
 *
 * ── MAIN CHOOSES THE WINDOW; THE RENDERER CHOOSES THE ROUTE ───────────────
 * What "open the Session and reveal its question" means is renderer knowledge
 * (which store adopts a chat, which tab id it lives under, whether that
 * question is still open). Main only decides WHERE that decision runs, which is
 * a window question: the focused one if there is one, the first live one
 * otherwise, restored if it was minimized.
 *
 * ── THE PARKED TARGET ─────────────────────────────────────────────────────
 * macOS keeps the app alive with every window closed, and the alert that most
 * needs a click is exactly the one that arrives then. Sending into a window
 * that is still booting would land before the renderer has subscribed, so a
 * click with no window PARKS the target and asks for a window; the renderer
 * collects it as it registers its listener ({@link NotificationActivation.takePending}).
 * One slot, newest wins: two clicks before a window exists means the person
 * chose the second thing, and replaying both would fight over the same view.
 *
 * Every failure is swallowed. This runs from a native event handler with no
 * caller to return an error to, and a throw here would be an unhandled
 * rejection in main rather than anything a person could act on.
 */
import type { NotificationTarget } from "@volli/shared";

/** The window facts a click needs — `BrowserWindow` satisfies it structurally. */
export interface ActivationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  /** Delivers the target to this window's renderer. */
  send(target: NotificationTarget): void;
}

export interface NotificationActivationPorts {
  windows(): readonly ActivationWindow[];
  /** `app.focus({ steal: true })` — brings Volli in front of whatever is there. */
  focusApp(): void;
  /** Opens a window when none exists. */
  openWindow(): void;
  /** Diagnostics seam. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

export interface NotificationActivation {
  /** Handles one click. `null` brings Volli forward and routes nowhere. */
  activate(target: NotificationTarget | null): void;
  /** The target parked for a window that did not exist yet, taken once. */
  takePending(): NotificationTarget | null;
}

export function createNotificationActivation(
  ports: NotificationActivationPorts,
): NotificationActivation {
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("[volli] notification click:", error));
  let pending: NotificationTarget | null = null;

  return {
    activate(target) {
      try {
        const live = ports.windows().filter((window) => !window.isDestroyed());
        const window = live.find((candidate) => candidate.isFocused()) ?? live[0];
        ports.focusApp();
        if (window === undefined) {
          pending = target;
          ports.openWindow();
          return;
        }
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (target !== null) window.send(target);
      } catch (error) {
        onError(error);
      }
    },
    takePending() {
      const target = pending;
      pending = null;
      return target;
    },
  };
}
