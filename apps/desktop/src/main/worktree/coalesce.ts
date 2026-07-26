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
 */

/** Runs `task` under the coalescing rule for `key`. */
export type Coalescer = <T>(key: string, task: () => Promise<T>) => Promise<T>;

export function createCoalescer(): Coalescer {
  const inFlight = new Map<string, Promise<unknown>>();
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
      const started: Promise<T> = task().then(
        (value) => {
          if (inFlight.get(key) === started) inFlight.delete(key);
          return value;
        },
        (error: unknown) => {
          if (inFlight.get(key) === started) inFlight.delete(key);
          throw error;
        },
      );
      inFlight.set(key, started);
      return started;
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

  /** Moves a queued follow-up into the in-flight slot. */
  const promote = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    queued.delete(key);
    return run(key, task);
  };

  return run;
}
