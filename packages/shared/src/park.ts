// Warm-park eligibility logic (issue #51's three-tier session lifecycle).
//
// #51 grades an idle terminal session across three tiers: HOT (live PTY,
// fully resident), WARM (this module — the process tree is SIGSTOP'd so macOS
// compresses/pages its memory, ~350MB → ~35MB, and SIGCONT wakes it in
// ~117ms), and COLD (killed, resumed later from the harness transcript). This
// module holds only the pure, Node-free decision logic for the WARM tier: the
// cheap synchronous eligibility gate and the CPU-quiet check the main-process
// sweep layers process inspection on top of. Everything here is deterministic
// and unit-tested; the actual signalling lives in apps/desktop/src/main/park.ts.
//
// HARD SAFETY RULE: never park a working session. These gates are one half of
// the belt-and-braces guard set (the sweep adds CPU-quiet sampling and a
// LISTEN-socket check) — all mandatory.

/** Quiet time a session must sit idle before it becomes park-eligible. */
export const PARK_IDLE_THRESHOLD_MS = 5 * 60_000;
/** How often the main-process sweep runs. */
export const PARK_SWEEP_INTERVAL_MS = 60_000;
/** A `ps` pcpu at or above this (percent) marks a pid busy — not quiet. */
export const PARK_CPU_BUSY_PERCENT = 0.5;
/** Consecutive CPU-quiet sweeps a candidate must clear before it is parked. */
export const PARK_QUIET_SAMPLES_REQUIRED = 2;
/**
 * How long a breathing session runs before the stay-parked verdict. Long
 * enough for the resumed event loop to drain everything that piled up while
 * frozen (expired timers, queued file-watch events, buffered socket data) and
 * show observable work; short enough that a truly idle tree's touched pages
 * stay a rounding error against the parked-memory win.
 */
export const PARK_BREATHE_WINDOW_MS = 1_000;

/** The per-session state the eligibility gate reads. */
export interface ParkCandidateState {
  parked: boolean;
  /** Renderer-reported: the session's pane is currently on screen. */
  visible: boolean;
  /** User pin excluding the session from auto-park. */
  keepAwake: boolean;
  /** Last PTY output OR user input, epoch ms. */
  lastActivityAt: number;
}

/**
 * Cheap synchronous eligibility gate (stage 1 of the sweep): a session is a
 * park candidate only when it is not already parked, not visible, not pinned
 * awake, and has been quiet for at least `idleThresholdMs`.
 */
export function isParkCandidate(
  state: ParkCandidateState,
  now: number,
  idleThresholdMs: number,
): boolean {
  if (state.parked || state.visible || state.keepAwake) return false;
  return now - state.lastActivityAt >= idleThresholdMs;
}

/**
 * What the sweep observed about a parked session across one breathe window
 * (SIGCONT → run for {@link PARK_BREATHE_WINDOW_MS} → verdict). Breathing is
 * the no-silent-failure guarantee of the warm tier: a frozen process can't
 * tell us it has work, so once per sweep it gets a window to show us.
 */
export interface BreatheObservation {
  /** `lastActivityAt` snapshotted just before the tree was CONT'd. */
  activityAtStart: number;
  /** `lastActivityAt` after the window (PTY output or input advance it). */
  activityAtEnd: number;
  /** Whole-tree CPU-quiet verdict sampled after the window. */
  cpuQuiet: boolean;
  /** A pid appeared that was not in the stopped tree (work forked a child). */
  treeGrew: boolean;
  /** A TCP LISTEN socket appeared in the tree (something started serving). */
  hasListener: boolean;
}

/**
 * The breathe verdict: true when the window surfaced real work — output,
 * CPU, a fresh child, or a new listener — so the session must stay awake
 * rather than be re-frozen. Each signal covers a class the park gates can't
 * see while frozen: watchers rebuilding, timers firing, I/O-blocked work that
 * is momentarily CPU-quiet (it forks or prints), and late-started servers.
 */
export function breatheShouldWake(obs: BreatheObservation): boolean {
  return (
    obs.activityAtEnd > obs.activityAtStart || !obs.cpuQuiet || obs.treeGrew || obs.hasListener
  );
}

/**
 * True when every pid in the tree is below `busyPercent`. A pid missing from
 * `cpuByPid` counts as quiet — it exited between listing and sampling, which is
 * exactly the state we want to park.
 */
export function treeIsCpuQuiet(
  cpuByPid: ReadonlyMap<number, number>,
  pids: readonly number[],
  busyPercent: number,
): boolean {
  for (const pid of pids) {
    const cpu = cpuByPid.get(pid);
    if (cpu !== undefined && cpu >= busyPercent) return false;
  }
  return true;
}
