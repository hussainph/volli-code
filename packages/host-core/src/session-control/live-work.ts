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
 * - **A turn**: a Session whose committed facts say a turn is open AND that
 *   holds an open executor binding in this process — `countOpenAgentTurns`'
 *   busy rule, answered from the facts as they commit instead of a fold.
 * - **A turn about to start**: work the runtime has accepted whose turn has
 *   not opened yet (`HostedSessionRuntime.pendingTurnStarts`) — a message on
 *   its way to the executor, a host-owned follow-up release in flight.
 * - **A background shell** that is still running.
 *
 * Armed Automations are deliberately NOT live work: an armed schedule alone
 * does not keep a host resident (VC-577 ruling; a later setting may).
 *
 * ── WHERE IT LISTENS ──────────────────────────────────────────────────────
 * Turn facts through the activity watch's `observeEvent` port — the one choke
 * point every durable Session write in this process passes through, called
 * synchronously as each write resolves rather than on the coalesced fold. The
 * fold (`observeSession`) only seeds a Session this process has not yet seen
 * a turn fact for, so a slow fold can never overwrite a newer write.
 *
 * ── THE IDLE-EXIT LATCH ───────────────────────────────────────────────────
 * {@link HostLiveWorkWatch.tryBeginIdleExit} reads the count and, when it is
 * zero, takes the runtime's start latch in the same synchronous call: JS runs
 * one thing at a time, so no start can land between "nothing is live" and
 * "nothing may start". A start after it is refused before any effect. Shells through the shell host's own state
 * feed, which the composition root forwards here. Nothing here imports a
 * window, a transport or Electron: a headless host can ask the same question
 * before it drains.
 *
 * ── FAILURES ──────────────────────────────────────────────────────────────
 * Observers ride the write path, so nothing here throws into it: a listener
 * that throws is reported and the next listener still hears the change.
 */
import type { SessionEvent, SessionProjection } from "@volli/shared";

import { hostLogger } from "../log/root";

const liveWorkLog = hostLogger("live-work");

/** The host's live work, as one value a quit decision can read synchronously. */
export interface HostLiveWork {
  /** Sessions with a turn open on an executor binding this process holds, or about to start one. */
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

/**
 * What one committed fact does to `turnActive` — the projection fold's own
 * rule (`foldSessionProjection` in `@volli/shared`), and nothing else: a
 * start opens the turn, its end or the end of the executor closes it, and
 * every other fact leaves it where it was.
 */
export function turnActiveAfter(kind: SessionEvent["payload"]["kind"]): boolean | null {
  switch (kind) {
    case "turn.started":
      return true;
    case "turn.completed":
    case "turn.interrupted":
    case "attachment.closed":
    case "attachment.failed":
      return false;
    default:
      return null;
  }
}

export interface HostLiveWorkPorts {
  /**
   * The Sessions holding an open executor binding right now. Asked on every
   * read rather than mirrored, because a binding can close without a fold
   * this watch would see.
   */
  openSessionIds(): ReadonlySet<string>;
  /**
   * Sessions with a turn start accepted but not yet opened
   * (`HostedSessionRuntime.pendingTurnStarts`). Absent: none (no runtime).
   */
  pendingStartSessionIds?(): ReadonlySet<string>;
  /** The runtime's start latch (`holdTurnStarts` / `releaseTurnStarts`). Absent: nothing to hold. */
  starts?: { hold(): void; release(): void };
  /** Diagnostics seam. Defaults to the host log (`live-work`). */
  onError?: (error: unknown) => void;
}

export interface HostLiveWorkWatch {
  /** One committed fact, from the activity watch, as its write resolves. Synchronous and total. */
  observeEvent(event: Pick<SessionEvent, "sessionId" | "sequence" | "payload">): void;
  /**
   * One folded Session, from the activity watch. Only seeds a Session no
   * committed fact has been observed for in this process: a fold reads before
   * it reports, so it can be older than a write {@link observeEvent} has seen.
   */
  observeSession(projection: Pick<SessionProjection, "session" | "turnActive">): void;
  /** One background shell's state, from the shell host's feed. */
  observeShell(shell: { readonly shellId: string; readonly state: "running" | "exited" }): void;
  /** A shell the shell host forgot (its Session's attachment ended). */
  forgetShell(shellId: string): void;
  /** The live work right now. Cheap and synchronous: a quit gate calls it. */
  current(): HostLiveWork;
  /**
   * The idle-exit barrier: when nothing is live, take the runtime's start
   * latch and answer true — atomically, in one synchronous call. When work is
   * live, change nothing and answer false. True again while already latched.
   */
  tryBeginIdleExit(): boolean;
  /** Lift a latch {@link tryBeginIdleExit} took (an exit that did not happen). No-op otherwise. */
  abandonIdleExit(): void;
  /** Whether the idle-exit latch is up. */
  exiting(): boolean;
  /**
   * Hear every change of {@link current} that an observation caused. Not
   * called for a binding that closed on its own or a start that settled; a
   * caller that must not miss those re-reads {@link current} on its own clock.
   */
  subscribe(listener: (work: HostLiveWork) => void): () => void;
}

export function createHostLiveWork(ports: HostLiveWorkPorts): HostLiveWorkWatch {
  const onError =
    ports.onError ?? ((error: unknown) => liveWorkLog.warn("live work listener failed", { error }));
  /** Sessions whose committed facts have a turn open — bound or not; the read intersects. */
  const turnsOpen = new Set<string>();
  /** The newest fact sequence applied per Session; its presence also retires the fold seed. */
  const appliedThrough = new Map<string, number>();
  const shellsRunning = new Set<string>();
  const listeners = new Set<(work: HostLiveWork) => void>();
  let announced = NO_LIVE_WORK;
  let latched = false;

  function current(): HostLiveWork {
    const pending = ports.pendingStartSessionIds?.();
    let turns = pending?.size ?? 0;
    if (turnsOpen.size > 0) {
      const bound = ports.openSessionIds();
      for (const sessionId of turnsOpen) {
        if (bound.has(sessionId) && pending?.has(sessionId) !== true) turns += 1;
      }
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

  function setTurn(sessionId: string, active: boolean): void {
    if (active) turnsOpen.add(sessionId);
    else turnsOpen.delete(sessionId);
  }

  return {
    observeEvent(event) {
      const active = turnActiveAfter(event.payload.kind);
      if (active === null) return;
      // `observe` answers a repeated id with the ORIGINAL event; replaying an
      // old start over a newer end would latch a finished turn open.
      const through = appliedThrough.get(event.sessionId);
      if (through !== undefined && event.sequence <= through) return;
      appliedThrough.set(event.sessionId, event.sequence);
      setTurn(event.sessionId, active);
      announce();
    },
    observeSession(projection) {
      const sessionId = projection.session.id;
      if (appliedThrough.has(sessionId)) return;
      setTurn(sessionId, projection.turnActive);
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
    tryBeginIdleExit() {
      if (latched) return true;
      if (hasLiveWork(current())) return false;
      ports.starts?.hold();
      latched = true;
      return true;
    },
    abandonIdleExit() {
      if (!latched) return;
      latched = false;
      ports.starts?.release();
    },
    exiting: () => latched,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
