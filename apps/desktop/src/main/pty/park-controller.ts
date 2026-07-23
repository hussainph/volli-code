// The warm-park controller (issue #51's WARM tier, extracted from the former
// monolithic pty.ts per issue #99). It owns the four intertwined pieces of the
// duty cycle — park (SIGSTOP a whole tree), wake (SIGCONT it in reverse), the
// once-per-sweep breathe window that keeps a frozen tree from silently missing
// work, and the staged auto-park sweep plus its recurring interval. Every
// guard, re-check-after-await, and comment here moved verbatim from the manager;
// the pure eligibility verdicts still live in @volli/shared.
//
// The controller never touches node-pty, electron, or the db. It reaches the
// manager's live session state through a shared ReadonlyMap of {@link
// ParkableSession} — the SAME mutable objects the manager holds, which is what
// keeps wake-before-write/kill coherent across the two modules — plus two
// injected side-effect hooks (flush buffered output, push park state to the
// window). That directness is what lets it be unit-tested with a fake inspector
// and hand-built sessions, no PtyManager required.

import { breatheShouldWake, isParkCandidate, treeIsCpuQuiet } from "@volli/shared";
import type { TerminalIoResult } from "@volli/shared";
import type { ParkConfig, ProcessInspector } from "../park";

/** The park-relevant view of a live session. Structurally satisfied by the
 *  manager's Session (same mutable objects — the controller and manager share
 *  state through them, which is what keeps wake-before-write/kill coherent). */
export interface ParkableSession {
  readonly pty: { readonly pid: number };
  parkedPids: number[] | null;
  parkedManually: boolean;
  quietCpuSamples: number;
  visible: boolean;
  keepAwake: boolean;
  lastActivityAt: number;
}

export interface ParkControllerDeps {
  config: ParkConfig;
  inspector: ProcessInspector;
  /** The manager's live registry — the SAME Map instance, read-only here. */
  sessions: ReadonlyMap<string, ParkableSession>;
  /** Flush the session's buffered output before freezing its tree. */
  flush(sessionId: string): void;
  /** Push the session's current park/keep-awake state to its window. */
  pushParkState(sessionId: string): void;
}

/** Plain awaitable pause; the breathe window between SIGCONT and the verdict. */
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Owns the warm-park duty cycle for the manager's live sessions. Constructed
 * once per PtyManager from the injected inspector/parkConfig; the manager's
 * public park/wake/sweep/startParkSweep/stopParkSweep delegate straight here.
 */
export class ParkController {
  /** Recurring warm-park sweep handle; `null` until `start`. */
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep's async stages overlapping the next tick. */
  private sweeping = false;

  constructor(private readonly deps: ParkControllerDeps) {}

  /**
   * Parks a session: SIGSTOP its whole process tree so macOS compresses/pages
   * its memory (issue #51 warm tier). Auto-park (`manual: false`) refuses a
   * visible or kept-awake session — the belt-and-braces half of the safety
   * rule (the sweep already gated on idle + CPU-quiet + no LISTEN socket).
   * Manual park bypasses those guards. Stops parent FIRST then descendants, then
   * re-collects to catch any child that spawned mid-stop (bounded to 3 rounds).
   *
   * `activityBaseline` is the `lastActivityAt` the caller's eligibility verdict
   * was based on. The verdict is a snapshot — PTY output or input can land
   * during the sweep's async inspection stages (or ours below) — so an auto
   * park re-checks it before every SIGSTOP round and refuses if the session
   * resumed work. Defaults to the session's activity at entry.
   */
  async park(
    sessionId: string,
    opts: { manual: boolean; activityBaseline?: number },
  ): Promise<TerminalIoResult> {
    if (!this.deps.config.enabled) {
      // Refusing (rather than silently "succeeding") keeps a manual Park Now
      // honest on platforms without SIGSTOP or under VOLLI_PARK_DISABLE.
      return { ok: false, error: "Session parking is disabled" };
    }
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    if (session.parkedPids !== null) {
      // A Park Now on an already-parked session upgrades it to a manual
      // freeze — explicit intent exempts it from the breathe duty cycle.
      if (opts.manual) session.parkedManually = true;
      return { ok: true };
    }
    const activityBaseline = opts.activityBaseline ?? session.lastActivityAt;
    // The auto-park guards, re-checked after every await below (not just at
    // entry): visibility/pin flips and fresh activity can all land while the
    // inspector calls are in flight, and a session that resumed work must
    // never be frozen — the hard safety rule.
    const autoParkBlocked = (): string | null => {
      if (opts.manual) return null;
      if (session.visible || session.keepAwake) return "Session is visible or kept awake";
      if (session.lastActivityAt > activityBaseline) return "Session became active while parking";
      return null;
    };
    const entryBlock = autoParkBlocked();
    if (entryBlock !== null) return { ok: false, error: entryBlock };
    // The session can be killed (or its window destroyed) across any of the
    // awaits below. kill()'s CONT-before-kill runs off `parkedPids`, which is
    // only assigned at the end — so a kill landing mid-park would SIGHUP an
    // already-stopped tree, and SIGHUP *pends* on a stopped process: the tree
    // would leak frozen. Every await is followed by this liveness re-check,
    // and a mid-park death CONTs whatever was stopped so the pending kill
    // signals can act.
    const stillParking = (): boolean =>
      this.deps.sessions.get(sessionId) === session && session.parkedPids === null;
    const rootPid = session.pty.pid;
    const initial = await this.deps.inspector.descendants(rootPid);
    if (!stillParking()) return { ok: false, error: "Session ended while parking" };
    const preStopBlock = autoParkBlocked();
    if (preStopBlock !== null) return { ok: false, error: preStopBlock };
    // Flush pending output before freezing — the renderer must not be left
    // waiting on bytes the stopped shell can no longer push.
    this.deps.flush(sessionId);
    // Stop parent first so it can't fork new children we haven't seen, then its
    // descendants in listed order.
    const stopOrder = [rootPid, ...initial];
    const stopped = new Set<number>(stopOrder);
    const abortPark = (error: string): TerminalIoResult => {
      for (const pid of stopOrder.toReversed()) this.deps.inspector.signal(pid, "SIGCONT");
      return { ok: false, error };
    };
    for (const pid of stopOrder) this.deps.inspector.signal(pid, "SIGSTOP");
    // A child may have spawned between listing and its parent's stop; re-scan and
    // stop any newcomer until the tree is stable (bounded so a fork bomb can't
    // spin the sweep forever).
    for (let round = 0; round < 3; round += 1) {
      let rescan: number[];
      try {
        rescan = await this.deps.inspector.descendants(rootPid);
      } catch (error) {
        // A failed rescan must never leak a half-stopped tree: CONT what we
        // stopped, then let the failure propagate to the caller's logging.
        abortPark("");
        throw error;
      }
      if (!stillParking()) return abortPark("Session ended while parking");
      // Output buffered before the SIGSTOP can still drain during the rescan
      // awaits — a session that just showed work must not be left frozen.
      const midStopBlock = autoParkBlocked();
      if (midStopBlock !== null) return abortPark(midStopBlock);
      const fresh = rescan.filter((pid) => !stopped.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        this.deps.inspector.signal(pid, "SIGSTOP");
        stopOrder.push(pid);
        stopped.add(pid);
      }
    }
    session.parkedPids = stopOrder;
    session.parkedManually = opts.manual;
    this.deps.pushParkState(sessionId);
    return { ok: true };
  }

  /**
   * Wakes a parked session: SIGCONT its tree in REVERSE of the stop order
   * (children before parent). Synchronous so before-quit teardown can call it
   * off the stored pid list. A running session is a no-op.
   */
  wake(sessionId: string): TerminalIoResult {
    const session = this.deps.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    const parkedPids = session.parkedPids;
    if (parkedPids === null) return { ok: true };
    for (const pid of parkedPids.toReversed()) this.deps.inspector.signal(pid, "SIGCONT");
    session.parkedPids = null;
    session.parkedManually = false;
    session.quietCpuSamples = 0;
    session.lastActivityAt = Date.now();
    this.deps.pushParkState(sessionId);
    return { ok: true };
  }

  /**
   * Stage 0 of the sweep — the no-silent-failure duty cycle. A frozen process
   * cannot tell us it has pending work (an expired timer, a file-watch event,
   * data queued on a socket), so once per sweep every auto-parked session
   * breathes: its tree is CONT'd for `breatheWindowMs`, then re-frozen unless
   * the window surfaced real work (output/input, CPU, a fresh child, a new
   * listener — the pure verdict in @volli/shared's breatheShouldWake). Worst
   * case, background work runs one sweep interval late instead of never.
   * Manual Park Now freezes are exempt: explicit intent stays frozen until an
   * explicit wake.
   *
   * `parkedPids` deliberately stays set across the window — SIGCONT is
   * idempotent, so any wake path landing mid-breathe (input, visibility, Keep
   * Awake, kill's CONT-before-kill) works unchanged, and the renderer's
   * parked badge never flickers. Liveness is re-checked after every await;
   * the re-freeze goes through park() so its mid-park death races and
   * fork-rescan rounds stay handled in exactly one place.
   */
  private async breathe(): Promise<void> {
    const breathing: Array<{ id: string; session: ParkableSession; activityAtStart: number }> = [];
    for (const [id, session] of this.deps.sessions) {
      if (session.parkedPids === null || session.parkedManually) continue;
      breathing.push({ id, session, activityAtStart: session.lastActivityAt });
      for (const pid of session.parkedPids.toReversed()) this.deps.inspector.signal(pid, "SIGCONT");
    }
    if (breathing.length === 0) return;
    await delay(this.deps.config.breatheWindowMs);

    // One descendants walk per still-parked tree, then one ps and one lsof
    // across the union. A session killed or explicitly woken during the window
    // is no longer ours to touch.
    const stillBreathing = (id: string, session: ParkableSession): boolean =>
      this.deps.sessions.get(id) === session && session.parkedPids !== null;
    try {
      const trees: Array<{
        id: string;
        session: ParkableSession;
        activityAtStart: number;
        pids: number[];
      }> = [];
      for (const { id, session, activityAtStart } of breathing) {
        if (!stillBreathing(id, session)) continue;
        const pids = [session.pty.pid, ...(await this.deps.inspector.descendants(session.pty.pid))];
        trees.push({ id, session, activityAtStart, pids });
      }
      if (trees.length === 0) return;
      const union = new Set<number>();
      for (const { pids } of trees) for (const pid of pids) union.add(pid);
      const cpuByPid = await this.deps.inspector.cpuPercents([...union]);
      const listeners = await this.deps.inspector.listeningPids([...union]);

      for (const { id, session, activityAtStart, pids } of trees) {
        // Re-check after the sampling awaits — a kill or wake may have landed.
        if (!stillBreathing(id, session)) continue;
        const stopped = new Set(session.parkedPids);
        const shouldWake = breatheShouldWake({
          activityAtStart,
          activityAtEnd: session.lastActivityAt,
          cpuQuiet: treeIsCpuQuiet(cpuByPid, pids, this.deps.config.cpuBusyPercent),
          treeGrew: pids.some((pid) => !stopped.has(pid)),
          hasListener: pids.some((pid) => listeners.has(pid)),
        });
        // A Park Now that landed mid-window wins over the verdict: re-freeze,
        // preserving the manual exemption.
        if (shouldWake && !session.parkedManually) {
          this.wake(id);
        } else {
          const manual = session.parkedManually;
          session.parkedPids = null;
          const refrozen = await this.park(id, { manual, activityBaseline: activityAtStart });
          if (
            !refrozen.ok &&
            this.deps.sessions.get(id) === session &&
            session.parkedPids === null
          ) {
            // The re-freeze was refused — activity or a pin/visibility flip
            // landed mid-park. The session stays awake; sync the renderer's
            // badge (nothing else pushes on this path) and make it re-earn
            // its quiet streak from scratch.
            session.quietCpuSamples = 0;
            this.deps.pushParkState(id);
          }
        }
      }
    } catch (error) {
      // Inspection failed mid-cycle: these trees were just CONT'd and we can
      // no longer judge them. Fail open — waking every one still marked parked
      // beats re-freezing unjudged, possibly-working sessions. A session whose
      // re-freeze threw mid-park is already CONT'd and unmarked; it just needs
      // its renderer badge synced.
      for (const { id, session } of breathing) {
        if (stillBreathing(id, session)) this.wake(id);
        else if (this.deps.sessions.get(id) === session) this.deps.pushParkState(id);
      }
      throw error;
    }
  }

  /**
   * One warm-park sweep. Stage 0 breathes every auto-parked session (see
   * {@link breathe}), then three staged gates over running sessions, each
   * cheaper-first: (1) the synchronous idle/visible/keep-awake eligibility
   * check; (2) two consecutive CPU-quiet samples across the whole tree (one
   * `ps` call for every candidate's union of pids); (3) no TCP LISTEN socket
   * anywhere in the tree (one `lsof` call) — a quiet dev server must never be
   * frozen, since inbound requests would hang. Survivors are auto-parked. A
   * boolean flag drops a tick that arrives while the previous sweep's async
   * stages are still running.
   */
  async sweep(now = Date.now()): Promise<void> {
    if (!this.deps.config.enabled) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.breathe();
      // Stage 1: cheap eligibility. A session that fails it loses its quiet
      // streak. `activityAt` snapshots the idle clock the verdict is based on —
      // stage 4's park() refuses any session whose clock advanced past it
      // while stages 2–3 were in flight.
      const candidates: Array<{ id: string; session: ParkableSession; activityAt: number }> = [];
      for (const [id, session] of this.deps.sessions) {
        const eligible = isParkCandidate(
          {
            parked: session.parkedPids !== null,
            visible: session.visible,
            keepAwake: session.keepAwake,
            lastActivityAt: session.lastActivityAt,
          },
          now,
          this.deps.config.idleThresholdMs,
        );
        if (eligible) candidates.push({ id, session, activityAt: session.lastActivityAt });
        else session.quietCpuSamples = 0;
      }
      if (candidates.length === 0) return;

      // Stage 2: one CPU sample across the union of every candidate's tree.
      const withTrees: Array<{
        id: string;
        session: ParkableSession;
        activityAt: number;
        pids: number[];
      }> = [];
      const cpuUnion = new Set<number>();
      for (const { id, session, activityAt } of candidates) {
        const pids = [session.pty.pid, ...(await this.deps.inspector.descendants(session.pty.pid))];
        withTrees.push({ id, session, activityAt, pids });
        for (const pid of pids) cpuUnion.add(pid);
      }
      const cpuByPid = await this.deps.inspector.cpuPercents([...cpuUnion]);
      const quietEnough: Array<{ id: string; activityAt: number; pids: number[] }> = [];
      for (const { id, session, activityAt, pids } of withTrees) {
        if (treeIsCpuQuiet(cpuByPid, pids, this.deps.config.cpuBusyPercent)) {
          session.quietCpuSamples += 1;
          if (session.quietCpuSamples >= this.deps.config.quietSamplesRequired) {
            quietEnough.push({ id, activityAt, pids });
          }
        } else {
          session.quietCpuSamples = 0;
        }
      }
      if (quietEnough.length === 0) return;

      // Stage 3: one LISTEN-socket check across their union; a tree with any
      // listener is left for next sweep (counter untouched) rather than frozen.
      const listenUnion = new Set<number>();
      for (const { pids } of quietEnough) for (const pid of pids) listenUnion.add(pid);
      const listeners = await this.deps.inspector.listeningPids([...listenUnion]);
      for (const { id, activityAt, pids } of quietEnough) {
        if (pids.some((pid) => listeners.has(pid))) continue;
        await this.park(id, { manual: false, activityBaseline: activityAt });
      }
    } catch (error) {
      // Inspection is best-effort: a failed pgrep/ps/lsof degrades to "nothing
      // parks this sweep" (breathe already woke anything it couldn't judge) —
      // never an unhandled rejection, never a session left wrongly frozen.
      console.error("[park] sweep failed; no sessions parked this sweep:", error);
    } finally {
      this.sweeping = false;
    }
  }

  /** Starts the recurring sweep (no-op when disabled or already running). */
  start(): void {
    if (!this.deps.config.enabled) return;
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.deps.config.sweepIntervalMs);
    // Never let the sweep keep the process alive at quit.
    this.sweepTimer.unref();
  }

  /** Stops the recurring sweep. */
  stop(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
