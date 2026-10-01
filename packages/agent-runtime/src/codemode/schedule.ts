/**
 * When a script's nested calls may run, and how long a run may take (VC-471).
 *
 * A script can issue many calls at once with `Promise.all`. Three rules decide
 * what actually happens, and each is enforced here rather than trusted to the
 * script:
 *
 * - **One judgement at a time.** Every nested call is judged — schema, then the
 *   Session's authority gate — before it may run, and only one is judged at a
 *   time, in the order the script issued them. The gate is where a call can
 *   park on a person, so this is what makes "never several approval prompts at
 *   once" structural: there is no second judgement in progress to raise one.
 *   Pi's own parallel mode makes the same choice for the same reason.
 * - **Only reads overlap.** A call to a tool the host marked as able to
 *   overlap (`read`, the web tools, Browser reads, MCP reads the host audited
 *   for VC-454) shares the run with others like it, up to the frozen
 *   concurrency limit. Every other call — `bash`, `edit`, `write`, verbs,
 *   unmarked MCP tools — runs alone, after everything before it settled and
 *   before anything after it starts. VC-245 measured that concurrent `bash` is
 *   where a worktree gets corrupted and where almost none of the time saving
 *   was, so it is never offered.
 * - **Admission is first-in, first-out.** A read issued after a `write` waits
 *   for the write, so a script observes its own effects in the order it wrote
 *   them.
 *
 * The clock is the run's own deadline. It counts only active time: while a
 * call is being judged, the clock is stopped, because judgement is where a
 * person may be answering a question and a script that pauses on a person
 * must not time out because the person took a minute.
 */

/** A first-in, first-out lock for one holder at a time. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Run `work` once every earlier holder has finished, whatever they did. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

interface Waiter {
  shared: boolean;
  admit: () => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

/**
 * Execution slots: any number of shared holders up to a limit, or one
 * exclusive holder, admitted strictly in arrival order.
 */
export class ExecutionSlots {
  readonly #limit: number;
  #shared = 0;
  #exclusive = false;
  #queue: Waiter[] = [];
  /** The most holders ever in at once; read by tests and the benchmark. */
  peak = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  /**
   * Wait for a slot, run `work` in it, and give the slot back.
   *
   * A waiter whose signal aborts leaves the queue without running and without
   * holding anything, so a cancelled script's queued calls never start.
   */
  async run<T>(
    shared: boolean,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.#acquire(shared, signal);
    try {
      return await work();
    } finally {
      if (shared) this.#shared -= 1;
      else this.#exclusive = false;
      this.#pump();
    }
  }

  #acquire(shared: boolean, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        shared,
        signal,
        admit: () => {
          signal?.removeEventListener("abort", waiter.onAbort);
          resolve();
        },
        onAbort: () => {
          this.#queue = this.#queue.filter((queued) => queued !== waiter);
          reject(abortError(signal!));
          this.#pump();
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      if (head.shared) {
        if (this.#exclusive || this.#shared >= this.#limit) return;
        this.#shared += 1;
      } else {
        if (this.#exclusive || this.#shared > 0) return;
        this.#exclusive = true;
      }
      this.#queue.shift();
      this.peak = Math.max(this.peak, this.#exclusive ? 1 : this.#shared);
      head.admit();
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("The run was cancelled.");
}

/**
 * The run's active-time deadline: a budget that only drains while the run is
 * not paused, and that calls `expire` once when it is spent.
 */
export class RunClock {
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #expire: () => void;
  #spentMs = 0;
  #runningSince: number | undefined;
  #pauses = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #done = false;
  /** Time spent paused, for the result's record of how long a person was waited on. */
  pausedMs = 0;
  #pausedSince: number | undefined;

  constructor(budgetMs: number, now: () => number, expire: () => void) {
    this.#budgetMs = budgetMs;
    this.#now = now;
    this.#expire = expire;
    this.#start();
  }

  /** Stop the clock until a matching {@link resume}. Pauses nest. */
  pause(): void {
    if (this.#done) return;
    this.#pauses += 1;
    if (this.#pauses > 1) return;
    this.#stop();
    this.#pausedSince = this.#now();
  }

  resume(): void {
    if (this.#done || this.#pauses === 0) return;
    this.#pauses -= 1;
    if (this.#pauses > 0) return;
    this.pausedMs += this.#now() - this.#pausedSince!;
    this.#pausedSince = undefined;
    this.#start();
  }

  /** Active time spent so far. */
  get spentMs(): number {
    return (
      this.#spentMs + (this.#runningSince === undefined ? 0 : this.#now() - this.#runningSince)
    );
  }

  dispose(): void {
    this.#done = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #start(): void {
    this.#runningSince = this.#now();
    const remaining = Math.max(0, this.#budgetMs - this.#spentMs);
    this.#timer = setTimeout(() => {
      this.#done = true;
      this.#expire();
    }, remaining);
  }

  #stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#spentMs += this.#now() - this.#runningSince!;
    this.#runningSince = undefined;
  }
}
