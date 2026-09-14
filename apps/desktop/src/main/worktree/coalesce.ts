/**
 * Per-key coalescing for the Change Set snapshot (CONCEPT #47).
 *
 * A busy agent worktree fires filesystem events in bursts; the debounce
 * collapses each burst into one `worktree-changed`, but several windows,
 * several panels, and a mount-time load can still all ask for the same
 * ticket's snapshot at once — and each of those spawns five git commands over
 * the whole tree.
 *
 * So per key: at most one run in flight, and at most one follow-up queued
 * behind it. The follow-up is what keeps this honest — a caller arriving
 * mid-flight must NOT be handed the in-flight result, because that computation
 * started before the change the caller is reacting to. It waits for a
 * genuinely fresh run instead, and every caller arriving during that same
 * flight shares it.
 *
 * ## The share window (VC-369)
 *
 * That follow-up rule is right for a caller reacting to a NEW change, and wrong
 * for the two rail surfaces that mount together: `ticket-repository-summary` and
 * `ticket-changes-panel` each ask for the same ticket's status in the same
 * frame, reacting to ONE event, and the rule above charged the second one a
 * whole extra spawn set. `shareWindowMs` names how close to a run's START a
 * caller must arrive to be considered part of the same burst and share it.
 *
 * It stays honest because the window is far below the watch debounce
 * (`WATCH_DEBOUNCE_MS` = 250ms): a caller reacting to a filesystem change
 * arrives at least a debounce after the burst that produced the previous run,
 * so it never lands inside the window and always gets its fresh follow-up. The
 * default of 0 is exactly the old behaviour, which is what the Change Set keeps.
 */

/** Runs `task` under the coalescing rule for `key`. */
export type Coalescer = <T>(key: string, task: () => Promise<T>) => Promise<T>;

export interface CoalescerOptions {
  /**
   * How long after a run starts other callers may still join it instead of
   * queueing a fresh follow-up. 0 (the default) preserves the strict
   * always-fresh rule the Change Set relies on.
   */
  readonly shareWindowMs?: number;
  /** The clock, injectable so the suite drives the window rather than sleeping. */
  readonly now?: () => number;
}

export function createCoalescer(options: CoalescerOptions = {}): Coalescer {
  const shareWindowMs = options.shareWindowMs ?? 0;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<unknown>>();
  const startedAt = new Map<string, number>();
  const queued = new Map<string, Promise<unknown>>();

  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    // Checked BEFORE `inFlight`: between an in-flight run settling and its
    // follow-up actually starting there is a microtask window where the key
    // looks idle, and a caller landing in it must still join the follow-up
    // rather than open a second concurrent run.
    const pending = queued.get(key);
    if (pending !== undefined) return pending as Promise<T>;

    const current = inFlight.get(key);
    if (current === undefined) {
      const startTime = now();
      const started: Promise<T> = task().then(
        (value) => {
          if (inFlight.get(key) === started) forget(key, started);
          return value;
        },
        (error: unknown) => {
          if (inFlight.get(key) === started) forget(key, started);
          throw error;
        },
      );
      inFlight.set(key, started);
      startedAt.set(key, startTime);
      return started;
    }

    // Same burst as the run already going: share it rather than paying for a
    // second identical read (VC-369).
    // Strictly inside the window, so the default of 0 never shares: two callers
    // landing in the same millisecond must still get the Change Set's fresh
    // follow-up rule.
    const begun = startedAt.get(key);
    if (begun !== undefined && now() - begun < shareWindowMs) {
      return current as Promise<T>;
    }

    // Chain off settlement, INCLUDING failure: one failed snapshot must not
    // strand the callers waiting behind it.
    const followUp = current.then(
      () => promote(key, task),
      () => promote(key, task),
    );
    queued.set(key, followUp);
    return followUp;
  };

  /** Drops a settled run's in-flight record and its start stamp together. */
  const forget = (key: string, settled: Promise<unknown>): void => {
    if (inFlight.get(key) !== settled) return;
    inFlight.delete(key);
    startedAt.delete(key);
  };

  /** Moves a queued follow-up into the in-flight slot. */
  const promote = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    queued.delete(key);
    return run(key, task);
  };

  return run;
}
