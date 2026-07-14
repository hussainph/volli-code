/**
 * A tiny trailing-edge debouncer, extracted from the Doc-tab body autosave so
 * the timing logic is unit-testable in isolation (the component that owns it is
 * view glue, deliberately outside the coverage gate — see vite.config.ts). The
 * caller supplies a stable `run` that reads the latest value it needs (via a
 * ref/closure), and drives the timer imperatively:
 *
 * - `schedule()` — (re)start the idle timer; the last `schedule` within
 *   `delayMs` wins (the classic debounce).
 * - `flush()` — run NOW if a run is pending (blur / unmount / mode-flip), then
 *   clear the timer. A no-op when nothing is pending, so a flush after the
 *   timer already fired can't double-run.
 * - `cancel()` — drop a pending run without executing it.
 */
export interface Debouncer {
  /** Whether a scheduled run is waiting to fire. */
  readonly pending: boolean;
  /** (Re)start the idle timer; supersedes any earlier pending run. */
  schedule(): void;
  /** Run immediately if pending, otherwise do nothing; always clears the timer. */
  flush(): void;
  /** Drop a pending run without executing it. */
  cancel(): void;
}

export function createDebouncer(run: () => void, delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    get pending(): boolean {
      return timer !== null;
    },
    schedule(): void {
      clear();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    flush(): void {
      if (timer === null) return;
      clear();
      run();
    },
    cancel(): void {
      clear();
    },
  };
}
