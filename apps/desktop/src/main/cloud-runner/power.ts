/**
 * The power policy of a Volli Cloud launch (VC-895): while any turn runs on
 * this Mac, hold an idle-sleep assertion (`prevent-app-suspension`), window
 * or not, so a runner never idles to sleep mid-turn; release it at zero
 * turns. Background shells do not hold it (menu-bar mode's rule). A lid
 * close still sleeps the Mac on battery: that is the honest "waiting for
 * <Mac>" case.
 *
 * It replaces menu-bar mode's own hold in a cloud launch (that one holds
 * only while windowless); a local launch keeps menu-bar mode's, unchanged.
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

/**
 * How often the count is re-read: the feed does not announce a binding that
 * closed on its own, so a turn's end can arrive only on this clock.
 */
export const POWER_RECHECK_MS = 30_000;

/** Holds `blocker` while `liveWork` has turns. Returns the stop, which releases it. */
export function holdWhileTurnsRun(
  liveWork: LiveWorkFeed,
  blocker: RunnerPowerBlocker,
  timers: {
    setInterval(run: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  } = {
    setInterval: (run, ms) => {
      const handle = setInterval(run, ms);
      handle.unref?.();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  },
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

/** A blocker that does nothing: menu-bar mode's, in a launch where this policy owns the assertion. */
export const NO_POWER_BLOCKER: RunnerPowerBlocker = { hold: () => {}, release: () => {} };
