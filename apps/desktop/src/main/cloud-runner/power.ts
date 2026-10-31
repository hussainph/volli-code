/**
 * The power policy of a Volli Cloud launch (VC-895, VC-1037).
 *
 * ── TURNS ─────────────────────────────────────────────────────────────────
 * While any turn runs on this Mac, hold an idle-sleep assertion
 * (`prevent-app-suspension`), window or not, so a runner never idles to sleep
 * mid-turn; release it at zero turns. Background shells do not hold it
 * (menu-bar mode's rule). A lid close still sleeps the Mac on battery: that
 * is the honest "waiting for <Mac>" case. This hold is independent of the
 * Keep-working switch: it is what a cloud launch did before the switch
 * existed, and turning the switch off must not lose a running turn.
 *
 * ── KEEPING THE MAC WORKING (VC-1037) ─────────────────────────────────────
 * "Keep this Mac working as a runner" asks for a second, longer hold: while
 * the switch is on AND this Mac has wall power, hold the same assertion so an
 * idle in-between can never sleep it out from under the backend. On battery
 * nothing is held — a laptop someone carried away must still sleep — and the
 * next AC reading takes it back. Neither hold replaces menu-bar mode's own
 * (that one holds only while windowless); a local launch keeps menu-bar
 * mode's, unchanged.
 */
import type { HostLiveWork } from "@volli/host-core/sessions";

export interface RunnerPowerBlocker {
  hold(): void;
  release(): void;
}

export interface LiveWorkFeed {
  current(): HostLiveWork;
  subscribe(listener: (work: HostLiveWork) => void): () => void;
}

/** The clock a hold uses, injected so a test can drive it. */
export interface PowerHoldTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_POWER_TIMERS: PowerHoldTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * How often the count is re-read: the feed does not announce a binding that
 * closed on its own, so a turn's end can arrive only on this clock.
 */
export const POWER_RECHECK_MS = 30_000;

/** Holds `blocker` while `liveWork` has turns. Returns the stop, which releases it. */
export function holdWhileTurnsRun(
  liveWork: LiveWorkFeed,
  blocker: RunnerPowerBlocker,
  timers: PowerHoldTimers = DEFAULT_POWER_TIMERS,
): () => void {
  let held = false;
  const apply = (work: HostLiveWork) => {
    const hold = work.turns > 0;
    if (hold === held) return;
    held = hold;
    if (hold) blocker.hold();
    else blocker.release();
  };
  apply(liveWork.current());
  const off = liveWork.subscribe(apply);
  const recheck = timers.setInterval(() => apply(liveWork.current()), POWER_RECHECK_MS);
  return () => {
    off();
    timers.clearInterval(recheck);
    if (held) blocker.release();
    held = false;
  };
}

// ── keeping this Mac working as a runner ────────────────────────────────────

/**
 * Where this Mac's power comes from, as C1's `capabilities.power.source`
 * names it. `unknown` is an unread machine (no `powerMonitor` answer yet, or
 * a platform that cannot tell), never a guess at "probably AC".
 */
export type RunnerPowerSource = "ac" | "battery" | "unknown";

/**
 * The two facts the Keep-working switch decides with: the switch itself, and
 * the wall. Main reads both (the stored preference through
 * `runnerStaysAvailable`, the source through `powerMonitor`); this module owns
 * what they mean.
 */
export interface RunnerPowerFacts {
  /** The Keep-working switch, already resolved by `runnerStaysAvailable`. */
  enabled: boolean;
  /** Wall power, battery, or not read. */
  source: RunnerPowerSource;
}

/** The facts a launch with nothing wired reads: no switch, no power claim. */
export const NO_RUNNER_POWER_FACTS: RunnerPowerFacts = { enabled: false, source: "unknown" };

/**
 * C1's `capabilities.power` (BYO-2 owns the shared type; this is its shape
 * until that lands, and the one line the report adds today). `alwaysOn` is
 * the person's Keep-working switch, which defaults on — not whether a hold is
 * currently in force, and never a promise about the wall.
 */
export interface RunnerPowerCapability {
  source: RunnerPowerSource;
  alwaysOn: boolean;
}

export function runnerPowerCapability(facts: RunnerPowerFacts): RunnerPowerCapability {
  return { source: facts.source, alwaysOn: facts.enabled };
}

/**
 * Whether the Keep-working assertion belongs on right now: a Mac asked to
 * stay available, and one that is plugged in. Battery or an unread source
 * holds nothing — a laptop someone carried away must still sleep.
 */
export function residencyHoldWanted(facts: RunnerPowerFacts): boolean {
  return facts.enabled && facts.source === "ac";
}

/**
 * How often the switch and the wall are re-read. `powerMonitor` announces
 * `on-ac`/`on-battery`, and main refreshes on those; the clock exists for the
 * switch, which is written by a window and has no host-side event.
 */
export const RESIDENCY_RECHECK_MS = 30_000;

export interface RunnerResidencyHold {
  /** Re-read the facts and hold or release. Idempotent; main calls it on power changes. */
  refresh(): void;
  /** Release the assertion and stop the clock. */
  stop(): void;
}

/**
 * Holds `blocker` while the Mac is asked to keep working and has wall power.
 * A read that fails releases rather than holds: an unreadable switch is not
 * a reason to keep a Mac awake.
 */
export function createRunnerResidencyHold(
  read: () => RunnerPowerFacts,
  blocker: RunnerPowerBlocker,
  timers: PowerHoldTimers = DEFAULT_POWER_TIMERS,
): RunnerResidencyHold {
  let held = false;
  let stopped = false;
  const wanted = (): boolean => {
    try {
      return residencyHoldWanted(read());
    } catch {
      return false;
    }
  };
  const apply = () => {
    if (stopped) return;
    const hold = wanted();
    if (hold === held) return;
    held = hold;
    if (hold) blocker.hold();
    else blocker.release();
  };
  apply();
  const recheck = timers.setInterval(apply, RESIDENCY_RECHECK_MS);
  return {
    refresh: apply,
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(recheck);
      if (held) blocker.release();
      held = false;
    },
  };
}

/** A blocker that does nothing: menu-bar mode's, in a launch where this policy owns the assertion. */
export const NO_POWER_BLOCKER: RunnerPowerBlocker = { hold: () => {}, release: () => {} };
