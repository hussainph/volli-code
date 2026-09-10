/**
 * What each window is showing, so an alert for something already in front of
 * the person is not also shouted by the OS (VC-295 rule 5).
 *
 * ── WHY MAIN HOLDS IT ─────────────────────────────────────────────────────
 * The two halves of this question live in different processes. Only the
 * renderer knows WHAT is on screen (which Session's chat tab is in front, which
 * ticket is open); only main knows WHICH WINDOW IS FOCUSED — Chromium's
 * `document.hasFocus()` is not the same fact, and a renderer answering "am I
 * focused" from its own document is exactly how a second monitor or another
 * Space comes to silence an alert nobody can see.
 *
 * So the renderer pushes its target when it changes, main pairs it with
 * Electron's focus, and the delivery path asks for the pairing.
 *
 * ── SUPPRESSION IS THE NARROW SIDE OF EVERY DOUBT ─────────────────────────
 * A window that never reported is not counted. A window that is not focused is
 * not counted. A destroyed window's last answer is dropped rather than kept as
 * a ghost. Every one of those is the direction that DELIVERS the alert, because
 * the failure modes are not symmetric: a duplicate alert is a minor annoyance
 * next to a person never being told their agent is blocked.
 */
import type { NotificationTarget } from "@volli/shared";

/** The window facts this needs — a `BrowserWindow` satisfies it structurally. */
export interface ActiveTargetWindow {
  id: number;
  isFocused(): boolean;
  isDestroyed(): boolean;
}

export interface ActiveTargetRegistry {
  /** One window's current on-screen target; `null` when it is showing none. */
  report(windowId: number, target: NotificationTarget | null): void;
  /** Drops a closed window's answer. */
  forget(windowId: number): void;
  /** The targets showing in focused, live windows right now. */
  focusedTargets(): readonly NotificationTarget[];
}

export function createActiveTargetRegistry(ports: {
  windows(): readonly ActiveTargetWindow[];
}): ActiveTargetRegistry {
  const byWindow = new Map<number, NotificationTarget>();

  return {
    report(windowId, target) {
      if (target === null) byWindow.delete(windowId);
      else byWindow.set(windowId, target);
    },
    forget(windowId) {
      byWindow.delete(windowId);
    },
    focusedTargets() {
      const targets: NotificationTarget[] = [];
      for (const window of ports.windows()) {
        if (window.isDestroyed() || !window.isFocused()) continue;
        const target = byWindow.get(window.id);
        if (target !== undefined) targets.push(target);
      }
      return targets;
    },
  };
}
