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
  /**
   * The Sessions showing in focused, live windows right now (VC-30).
   *
   * The same reading as {@link ActiveTargetRegistry.focusedTargets}, narrowed
   * to Session ids, because that is the shape both read rules want: the unread
   * edge asks "is this one of them" and A1 asks "which ones are these now".
   * Deriving it here rather than at each caller keeps one definition of what
   * counts as in front — a ticket in front is not the Session beside it.
   */
  focusedSessionIds(): ReadonlySet<string>;
  /**
   * Electron's focus moved — a window gained or lost it, or one appeared or
   * went away (VC-30 A1).
   *
   * Focus is not this registry's to observe: it belongs to `app`, which only
   * the runtime holds. So the runtime tells it, and this re-reads the pairing
   * and announces if the answer moved. Without it, returning to a window that
   * is already showing a finished chat would never clear its dot — nothing
   * about what that window SHOWS changed, only whether anybody is looking.
   */
  noteFocusChanged(): void;
}

export function createActiveTargetRegistry(ports: {
  windows(): readonly ActiveTargetWindow[];
  /**
   * The focused Session set, whenever it CHANGES (VC-30 A1). Announced on a
   * change only: marking a Session read is idempotent, but publishing its row
   * to every window is not free, and every window focus would otherwise
   * re-announce the same answer.
   */
  onFocusedSessions?(sessionIds: ReadonlySet<string>): void;
}): ActiveTargetRegistry {
  const byWindow = new Map<number, NotificationTarget>();
  /**
   * The last announced set, as a stable key. A `Set` cannot be compared with
   * `===` and the set is a handful of ids at most, so the sorted join is the
   * cheapest honest comparison — and sorting is what keeps two windows
   * reported in either order from reading as a change.
   *
   * It starts at the EMPTY key rather than at "never announced", because empty
   * is the truth at boot: this registry is built before any window exists, so
   * nothing is in front of anybody yet and there is nothing to say about it.
   */
  let announced = "";

  function focusedTargets(): readonly NotificationTarget[] {
    const targets: NotificationTarget[] = [];
    for (const window of ports.windows()) {
      if (window.isDestroyed() || !window.isFocused()) continue;
      const target = byWindow.get(window.id);
      if (target !== undefined) targets.push(target);
    }
    return targets;
  }

  function focusedSessionIds(): ReadonlySet<string> {
    const sessionIds = new Set<string>();
    for (const target of focusedTargets()) {
      if (target.kind === "session") sessionIds.add(target.sessionId);
    }
    return sessionIds;
  }

  function announce(): void {
    const listener = ports.onFocusedSessions;
    if (listener === undefined) return;
    const sessionIds = focusedSessionIds();
    const key = [...sessionIds].toSorted().join("\u0000");
    if (key === announced) return;
    announced = key;
    listener(sessionIds);
  }

  return {
    report(windowId, target) {
      if (target === null) byWindow.delete(windowId);
      else byWindow.set(windowId, target);
      announce();
    },
    forget(windowId) {
      byWindow.delete(windowId);
      announce();
    },
    focusedTargets,
    focusedSessionIds,
    noteFocusChanged: announce,
  };
}
