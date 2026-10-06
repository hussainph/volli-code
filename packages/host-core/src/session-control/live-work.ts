/**
 * What this host is doing right now that a quit would cut short (VC-577).
 *
 * The desktop's menu-bar mode asks one question at ⌘Q — "is there live work?"
 * — and the answer has to come from the HOST, not from a window: by the time
 * `before-quit` fires the renderer may already be tearing down, and in
 * menu-bar mode there is no renderer at all. The question must also be
 * answered SYNCHRONOUSLY (`before-quit` takes its verdict inside the event),
 * so this is a projection kept current by the writes that change it rather
 * than a read that folds Sessions on demand.
 *
 * ── WHAT COUNTS ───────────────────────────────────────────────────────────
 * - **A turn**: a Session whose latest fold says `turnActive` AND that holds
 *   an open executor binding in this process. That is exactly the busy rule
 *   `countOpenAgentTurns` applies for the update dialog, so the Tray's count
 *   and the install dialog's count can never disagree about one machine.
 * - **A background shell** that is still running.
 *
 * Armed Automations are deliberately NOT live work: an armed schedule alone
 * does not keep a host resident (VC-577 ruling; a later setting may).
 *
 * ── WHERE IT LISTENS ──────────────────────────────────────────────────────
 * Sessions through the activity watch's `observe` port — the one choke point
 * every durable Session write in this process passes through (the same seat
 * `session-read-watch.ts` takes). Shells through the shell host's own state
 * feed, which the composition root forwards here. Nothing here imports a
 * window, a transport or Electron: a headless host can ask the same question
 * before it drains.
 *
 * ── FAILURES ──────────────────────────────────────────────────────────────
 * Observers ride the write path, so nothing here throws into it: a listener
 * that throws is reported and the next listener still hears the change.
 */
import type { SessionProjection } from "@volli/shared";

/** The host's live work, as one value a quit decision can read synchronously. */
export interface HostLiveWork {
  /** Sessions with a turn open on an executor binding this process holds. */
  readonly turns: number;
  /** Background shells still running. */
  readonly shells: number;
}

/** No work at all — what a fresh host and a drained one both report. */
export const NO_LIVE_WORK: HostLiveWork = Object.freeze({ turns: 0, shells: 0 });

/** Whether anything is running that a quit would cut short. */
export function hasLiveWork(work: HostLiveWork): boolean {
  return work.turns > 0 || work.shells > 0;
}

export interface HostLiveWorkPorts {
  /**
   * The Sessions holding an open executor binding right now. Asked on every
   * read rather than mirrored, because a binding can close without a fold
   * this watch would see.
   */
  openSessionIds(): ReadonlySet<string>;
  /** Diagnostics seam. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

export interface HostLiveWorkWatch {
  /** One folded Session, from the activity watch. Synchronous and total. */
  observeSession(projection: Pick<SessionProjection, "session" | "turnActive">): void;
  /** One background shell's state, from the shell host's feed. */
  observeShell(shell: { readonly shellId: string; readonly state: "running" | "exited" }): void;
  /** A shell the shell host forgot (its Session's attachment ended). */
  forgetShell(shellId: string): void;
  /** The live work right now. Cheap and synchronous: a quit gate calls it. */
  current(): HostLiveWork;
  /**
   * Hear every change of {@link current} that an observation caused. Not
   * called for a binding that closed on its own; a caller that must not miss
   * that re-reads {@link current} on its own clock too.
   */
  subscribe(listener: (work: HostLiveWork) => void): () => void;
}

export function createHostLiveWork(ports: HostLiveWorkPorts): HostLiveWorkWatch {
  const onError = ports.onError ?? ((error: unknown) => console.warn("[volli] live work:", error));
  /** Sessions whose latest fold has a turn open — bound or not; the read intersects. */
  const turnsOpen = new Set<string>();
  const shellsRunning = new Set<string>();
  const listeners = new Set<(work: HostLiveWork) => void>();
  let announced = NO_LIVE_WORK;

  function current(): HostLiveWork {
    let turns = 0;
    if (turnsOpen.size > 0) {
      const bound = ports.openSessionIds();
      for (const sessionId of turnsOpen) if (bound.has(sessionId)) turns += 1;
    }
    return { turns, shells: shellsRunning.size };
  }

  function announce(): void {
    let work: HostLiveWork;
    try {
      work = current();
    } catch (error) {
      onError(error);
      return;
    }
    if (work.turns === announced.turns && work.shells === announced.shells) return;
    announced = work;
    for (const listener of listeners) {
      try {
        listener(work);
      } catch (error) {
        onError(error);
      }
    }
  }

  return {
    observeSession(projection) {
      const sessionId = projection.session.id;
      if (projection.turnActive) turnsOpen.add(sessionId);
      else turnsOpen.delete(sessionId);
      announce();
    },
    observeShell(shell) {
      if (shell.state === "running") shellsRunning.add(shell.shellId);
      else shellsRunning.delete(shell.shellId);
      announce();
    },
    forgetShell(shellId) {
      shellsRunning.delete(shellId);
      announce();
    },
    current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
