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
