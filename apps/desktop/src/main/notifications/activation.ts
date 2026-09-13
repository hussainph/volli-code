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
 * needs a click is exactly the one that arrives then. So a click with no window
 * PARKS the target and asks for a window; the renderer collects it as it
 * registers its listener ({@link NotificationActivation.takePending}). One
 * slot, newest wins: two clicks before a window exists means the person chose
 * the second thing, and replaying both would fight over the same view.
 *
 * ── AND A WINDOW IS NOT A LISTENER ────────────────────────────────────────
 * Round 2's correction. A window EXISTS long before its renderer subscribes —
 * the listener installs after `await boot()` — and a push into that gap is
 * silently dropped: the click did nothing, and the person is left looking at
 * whatever was already on screen, with no way to know an alert had a
 * destination. So a target is pushed only into a window whose renderer has
 * announced itself ({@link NotificationActivation.markRendererReady}, called
 * when it asks for the parked target), and everything else parks. The window is
 * still brought forward either way: the click asked for Volli, and that part
 * needs no renderer.
 *
 * ── THE WINDOW THAT RECEIVES IS THE WINDOW BROUGHT FORWARD ────────────────
 * Round 5's correction. Round 2 chose the two independently — the focused
 * window came forward, and a (possibly different) listening window was sent
 * the target — so with one window focused and still booting and another
 * minimized but subscribed, the click restored nothing and routed into the
 * minimized one: the person saw Volli come forward and land nowhere, while a
 * hidden window navigated on its own. A route nobody can see is a dropped
 * click with extra steps. So ONE window is chosen: the listening one (focused
 * first), which is restored, shown, focused AND sent to; only when none is
 * listening does the focused-or-first window come forward on its own and the
 * target park for whichever renderer subscribes next.
 *
 * A subscription is also not forever. A reload or a renderer crash discards
 * the page that subscribed while the window id lives on, so the host drops the
 * mark on those ({@link NotificationActivation.forgetRenderer}) and the next
 * click parks again until the fresh page asks. Without that, every click after
 * a reload would be pushed into a page that is no longer listening.
 *
 * Every failure is swallowed. This runs from a native event handler with no
 * caller to return an error to, and a throw here would be an unhandled
 * rejection in main rather than anything a person could act on.
 */
import type { NotificationTarget } from "@volli/shared";

/** The window facts a click needs — `BrowserWindow` satisfies it structurally. */
export interface ActivationWindow {
  /** Electron's window id — how a subscription is attributed to a window. */
  id: number;
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
  /** The target parked for a window that could not receive it yet, taken once. */
  takePending(): NotificationTarget | null;
  /**
   * This window's renderer is listening for clicks. Called when it asks for the
   * parked target, which is the one moment main can know it — a window's
   * existence says nothing about whether anything inside it has subscribed.
   */
  markRendererReady(windowId: number): void;
  /**
   * This window's renderer is gone or being replaced — a reload, a crash, a
   * navigation — so the page that subscribed is not the page that will be
   * there. The window itself stays a candidate for coming forward.
   */
  forgetRenderer(windowId: number): void;
  /** Drops a closed window's subscription. */
  forgetWindow(windowId: number): void;
}

/** The focused window among these, or the first — the same tie-break for both choices. */
function focusedFirst(candidates: readonly ActivationWindow[]): ActivationWindow | undefined {
  return candidates.find((candidate) => candidate.isFocused()) ?? candidates[0];
}

export function createNotificationActivation(
  ports: NotificationActivationPorts,
): NotificationActivation {
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("[volli] notification click:", error));
  let pending: NotificationTarget | null = null;
  /** The windows whose renderer has said it is listening. */
  const listening = new Set<number>();

  return {
    activate(target) {
      try {
        const live = ports.windows().filter((window) => !window.isDestroyed());
        // A target needs a listener, so with one the window that can route is
        // the window that comes forward — never two different windows. A
        // target-less click needs no listener and takes any live window.
        const ready = live.filter((candidate) => listening.has(candidate.id));
        const receiver = target === null ? undefined : focusedFirst(ready);
        const front = receiver ?? focusedFirst(live);
        ports.focusApp();
        if (front === undefined) {
          pending = target;
          ports.openWindow();
          return;
        }
        if (front.isMinimized()) front.restore();
        front.show();
        front.focus();
        if (target === null) return;
        // No listener yet: park it rather than push it into silence. The
        // renderer collects it the moment it subscribes.
        if (receiver === undefined) {
          pending = target;
          return;
        }
        receiver.send(target);
      } catch (error) {
        onError(error);
      }
    },
    takePending() {
      const target = pending;
      pending = null;
      return target;
    },
    markRendererReady(windowId) {
      listening.add(windowId);
    },
    forgetRenderer(windowId) {
      listening.delete(windowId);
    },
    forgetWindow(windowId) {
      listening.delete(windowId);
    },
  };
}
