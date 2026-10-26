/**
 * The runner's inbox worker and job journal.
 *
 * The backend queues machine work for a runner as jobs (`runnerJobs`): claim
 * leases them, renew extends a lease, complete records an outcome. This
 * worker claims, runs each job with the executor registered for its kind,
 * keeps the lease alive while it runs, and reports the outcome.
 *
 * An outcome is a durable fact the runner owes the backend, so it goes into
 * the runner-local job journal BEFORE it is reported, and leaves the journal
 * only when `complete` answers (every answer is final for that outcome). A
 * crash between the two loses nothing: {@link InboxWorker.start} reports what
 * the journal still holds. Executing a re-leased job after a crash is the
 * executor's to make idempotent, by `job.id`; a job whose outcome the journal
 * already has is reported again, never run again.
 *
 * Jobs that share a `sessionId` run one at a time, in claim order (a
 * per-Session lane), so a cancel never overtakes the follow-up it cancels;
 * other jobs run side by side, up to {@link INBOX_LIMITS.concurrent}. A job
 * waiting its turn keeps its lease renewed, and does not run if the lease is
 * taken away meanwhile. A lane is only as live as its running job, so
 * executors honour their abort signal.
 *
 * Ready jobs are claimed when the backend's `runnerJobs.wake` subscription
 * says there are some (and when their `availableAt` comes due), with a poll
 * as the fallback where no subscription is given.
 *
 * A kind this build does not know completes as failed with
 * `unsupported_job_kind` (kinds are open on read), so an older runner reads
 * "update this runner" instead of crashing.
 */
import {
  INVALID_JOB_RESULT,
  jobResultProblem,
  unsupportedJobOutcome,
  type ClaimedJob,
  type JobLease,
  type JobOutcome,
} from "@volli/shared/cloud";

/** The lease a job runs under: what renew and complete must echo. */
export type JobLeaseRef = Pick<JobLease, "bootId" | "attempt">;

export type JobRenewAnswer =
  | { ok: true; lease: JobLease }
  | { ok: false; reason: "cancelled" | "fenced" | "gone" };

export type JobCompleteAnswer =
  | { ack: "recorded" | "duplicate"; status: string }
  | { ack: "superseded"; reason: string };

/** The three inbox mutations, as the backend link sends them. */
export interface InboxBackend {
  claim(args: { bootId: string; max: number }): Promise<ClaimedJob[]>;
  renew(args: {
    jobId: string;
    bootId: string;
    attempt: number;
    extendMs?: number;
  }): Promise<JobRenewAnswer>;
  complete(args: {
    jobId: string;
    bootId: string;
    attempt: number;
    outcome: JobOutcome;
  }): Promise<JobCompleteAnswer>;
}

/**
 * The outcome as the backend can take it. A `done` result the backend cannot
 * store (not plain JSON, a key it refuses, too large) could never be sent, and
 * would wait in the journal forever: it is reported as a permanent failure.
 */
function deliverable(outcome: JobOutcome): JobOutcome {
  if (outcome.status !== "done") return outcome;
  const problem = jobResultProblem(outcome.result);
  return problem === null
    ? outcome
    : { status: "failed", code: INVALID_JOB_RESULT, detail: problem, retryable: false };
}

/** One job the runner received, as the runner-local journal keeps it. */
export interface JobJournalEntry {
  jobId: string;
  kind: string;
  lease: JobLeaseRef;
  state: "running" | "done" | "failed";
  outcome: JobOutcome | null;
  receivedAt: number;
}

export interface JobJournalStore {
  get(jobId: string): JobJournalEntry | null;
  /** Durable before it returns. */
  save(entry: JobJournalEntry): void;
  /** Entries whose outcome the backend has not acknowledged. */
  unreported(): readonly JobJournalEntry[];
  /** The backend answered the outcome reported under this lease attempt: it is no longer owed. */
  remove(jobId: string, attempt: number): void;
}

export interface JobContext {
  /** Aborted when the backend cancels the job or another lease replaces this one. */
  signal: AbortSignal;
  /** Extend the lease beyond the automatic renewals (a long setup). */
  renew(extendMs?: number): Promise<boolean>;
}

export type JobExecutor = (claimed: ClaimedJob, context: JobContext) => Promise<JobOutcome>;

export const INBOX_LIMITS = {
  /** Jobs this runner runs at once. */
  concurrent: 4,
  /** A running job's lease is renewed this often (leases last 60 s). */
  renewEveryMs: 20_000,
  /** Without a wake subscription, ready jobs are claimed at least this often. */
  pollMs: 30_000,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
} as const;

/** What `runnerJobs.wake` answers: this runner's ready jobs, and when the next one comes due. */
export interface InboxWake {
  ready: number;
  nextAvailableAt: number | null;
}

export interface InboxWorkerOptions {
  /** The inbox mutations over the backend link (`inboxOverLink`), which gates them. */
  backend: InboxBackend;
  journal: JobJournalStore;
  /** Subscribes to `runnerJobs.wake` (`wakeOverLink`); without it the worker polls. */
  wake?(onChange: (wake: InboxWake) => void): () => void;
  /** This process's boot id (a UUID): the backend takes back an earlier boot's leases on claim. */
  bootId: string;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  onError?(error: unknown): void;
}

export interface InboxWorker {
  /** Runs `executor` for every job of `kind`. A kind registers once. */
  register(kind: string, executor: JobExecutor): void;
  /** Reports what the journal still owes, then claims. */
  start(): Promise<void>;
  /** Claims ready jobs now (the backend said there are some, or a wake). */
  claimNow(): Promise<void>;
  /** Renews every running job's lease now: the wake sequence calls this before claiming. */
  renewInFlight(): Promise<void>;
  /** Sync fences subscription/poll claims until reconnect has renewed existing leases. */
  pauseClaims?(): void;
  /** Lift that fence; the sync owner then explicitly claims. */
  resumeClaims?(): void;
  stop(): void;
  readonly running: number;
}

const ERROR_OUTCOME = (error: unknown): JobOutcome => ({
  status: "failed",
  code: "executor_error",
  detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  retryable: true,
});

export function createInboxWorker(options: InboxWorkerOptions): InboxWorker {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const executors = new Map<string, JobExecutor>();
  const running = new Map<
    string,
    { claimed: ClaimedJob; abort: AbortController; timer: unknown }
  >();
  /**
   * Per-Session lanes: jobs that share a `sessionId` run one at a time, in
   * claim order (a cancel never overtakes the follow-up it cancels). A lane
   * exists while one of its jobs runs; it holds the ones waiting their turn.
   */
  const lanes = new Map<string, (() => void)[]>();
  /** Report retries by `jobId:attempt`: an older lease's answer never touches a newer one's. */
  const reportRetries = new Map<string, { failures: number; timer: unknown }>();
  let stopped = true;
  let claimsPaused = false;
  let claiming: Promise<void> | null = null;
  /** A claim was asked for while one was in flight. */
  let claimAgain = false;
  let poll: unknown = null;
  let due: unknown = null;
  let unsubscribeWake: (() => void) | null = null;

  function onWake(wake: InboxWake) {
    clearTimer(due);
    due = null;
    if (wake.ready > 0) void claimNow();
    if (wake.nextAvailableAt !== null) {
      due = setTimer(
        () => {
          due = null;
          void claimNow();
        },
        Math.max(0, wake.nextAvailableAt - now()),
      );
    }
  }

  async function renewOne(jobId: string, extendMs?: number): Promise<boolean> {
    const entry = running.get(jobId);
    if (entry === undefined) return false;
    const { job, lease } = entry.claimed;
    try {
      const answer = await options.backend.renew({
        jobId: job.id,
        bootId: lease.bootId,
        attempt: lease.attempt,
        ...(extendMs ? { extendMs } : {}),
      });
      if (!answer.ok) entry.abort.abort(answer.reason);
      return answer.ok;
    } catch (error) {
      // Transient: the next renewal tries again; the lease outlives one miss.
      options.onError?.(error);
      return true;
    }
  }

  function report(entry: JobJournalEntry) {
    const key = `${entry.jobId}:${entry.lease.attempt}`;
    options.backend
      .complete({
        jobId: entry.jobId,
        bootId: entry.lease.bootId,
        attempt: entry.lease.attempt,
        outcome: entry.outcome!,
      })
      .then(
        () => {
          reportRetries.delete(key);
          options.journal.remove(entry.jobId, entry.lease.attempt);
        },
        (error: unknown) => {
          options.onError?.(error);
          // A malformed report is this runner's bug: retrying cannot fix it. It stays journaled.
          if ((error as { data?: { code?: unknown } } | null)?.data?.code === "invalid_request")
            return;
          // Stopped: the journal keeps it, and the next `start` reports it.
          if (stopped) return;
          const retry = reportRetries.get(key) ?? { failures: 0, timer: null };
          retry.failures += 1;
          const delay = Math.min(
            INBOX_LIMITS.retryMaxMs,
            INBOX_LIMITS.retryBaseMs * 2 ** (retry.failures - 1),
          );
          // `stop()` clears this timer, so it only fires while the worker runs.
          retry.timer = setTimer(() => {
            retry.timer = null;
            report(entry);
          }, delay);
          reportRetries.set(key, retry);
        },
      )
      .catch((error: unknown) => options.onError?.(error));
  }

  function finish(claimed: ClaimedJob, reported: JobOutcome) {
    const outcome = deliverable(reported);
    const entry = running.get(claimed.job.id);
    if (entry !== undefined) {
      clearTimer(entry.timer);
      running.delete(claimed.job.id);
    }
    const settled: JobJournalEntry = {
      jobId: claimed.job.id,
      kind: claimed.job.kind,
      lease: { bootId: claimed.lease.bootId, attempt: claimed.lease.attempt },
      state: outcome.status === "done" ? "done" : "failed",
      outcome,
      // `execute` journals every job it is given before it can finish.
      receivedAt: options.journal.get(claimed.job.id)!.receivedAt,
    };
    // Durable first: the outcome is owed from here on, whatever happens next.
    options.journal.save(settled);
    report(settled);
    if (!stopped) void claimNow();
  }

  function execute(claimed: ClaimedJob) {
    const { job, lease } = claimed;
    const known = options.journal.get(job.id);
    if (known?.outcome && known.lease.attempt === lease.attempt) {
      // Already done under this lease: report, never run twice.
      report(known);
      return;
    }
    options.journal.save({
      jobId: job.id,
      kind: job.kind,
      lease: { bootId: lease.bootId, attempt: lease.attempt },
      state: "running",
      outcome: known?.outcome ?? null,
      receivedAt: known?.receivedAt ?? now(),
    });
    if (known?.outcome) {
      // An outcome from an earlier lease of the same job: report it under this one.
      finish(claimed, known.outcome);
      return;
    }
    const executor = executors.get(job.kind);
    if (executor === undefined) {
      finish(claimed, unsupportedJobOutcome(job.kind));
      return;
    }
    const abort = new AbortController();
    const entry = { claimed, abort, timer: null as unknown };
    const tick = () => {
      entry.timer = setTimer(tick, INBOX_LIMITS.renewEveryMs);
      void renewOne(job.id);
    };
    // A job waiting its turn in its Session's lane is renewed like a running one.
    entry.timer = setTimer(tick, INBOX_LIMITS.renewEveryMs);
    running.set(job.id, entry);
    const lane = job.sessionId;
    if (lane !== null) {
      const waiting = lanes.get(lane);
      if (waiting !== undefined) {
        waiting.push(() => runJob(claimed, executor, abort));
        return;
      }
      lanes.set(lane, []);
    }
    runJob(claimed, executor, abort);
  }

  /** Runs one job, then lets the next job of its Session's lane start. */
  function runJob(claimed: ClaimedJob, executor: JobExecutor, abort: AbortController) {
    const { job } = claimed;
    let result: Promise<JobOutcome>;
    if (abort.signal.aborted) {
      // Its lease was taken away while it waited its turn: nothing to run.
      result = Promise.resolve({
        status: "failed",
        code: "lease_lost",
        detail: String(abort.signal.reason),
        retryable: false,
      });
    } else {
      try {
        result = executor(claimed, {
          signal: abort.signal,
          renew: (extendMs) => renewOne(job.id, extendMs),
        });
      } catch (error) {
        result = Promise.reject(error);
      }
    }
    result
      .then(
        (outcome) => finish(claimed, outcome),
        (error: unknown) => finish(claimed, ERROR_OUTCOME(error)),
      )
      .finally(() => {
        if (job.sessionId === null) return;
        const next = lanes.get(job.sessionId)!.shift();
        if (next === undefined) lanes.delete(job.sessionId);
        else next();
      })
      // A journal write failed: the lease runs out and the job comes back.
      .catch((error: unknown) => options.onError?.(error));
  }

  function claimNow(): Promise<void> {
    if (stopped || claimsPaused) return Promise.resolve();
    if (claiming !== null) {
      // A wake that lands while a claim is in flight may name jobs that claim
      // never saw, and the subscription will not say so again: claim once more.
      claimAgain = true;
      return claiming;
    }
    claiming = (async () => {
      try {
        do {
          claimAgain = false;
          // A stop or suspend may have landed while the last claim was in flight.
          if (stopped || claimsPaused) return;
          const room = INBOX_LIMITS.concurrent - running.size;
          if (room <= 0) return;
          const claimed = await options.backend.claim({ bootId: options.bootId, max: room });
          // An answer from the connection that just slept must not start work
          // ahead of the reconnect's lease renewal. These leases expire safely.
          if (stopped || claimsPaused) return;
          for (const job of claimed) if (!running.has(job.job.id)) execute(job);
        } while (claimAgain);
      } catch (error) {
        options.onError?.(error);
      } finally {
        claimAgain = false;
        claiming = null;
      }
    })();
    return claiming;
  }

  return {
    get running() {
      return running.size;
    },
    register(kind, executor) {
      if (executors.has(kind)) throw new Error(`An executor for ${kind} is already registered`);
      executors.set(kind, executor);
    },
    async start() {
      stopped = false;
      for (const entry of options.journal.unreported()) report(entry);
      if (options.wake !== undefined) {
        unsubscribeWake ??= options.wake(onWake);
      } else if (poll === null) {
        const tick = () => {
          poll = setTimer(tick, INBOX_LIMITS.pollMs);
          void claimNow();
        };
        poll = setTimer(tick, INBOX_LIMITS.pollMs);
      }
      await claimNow();
    },
    claimNow,
    pauseClaims: () => {
      claimsPaused = true;
    },
    resumeClaims: () => {
      claimsPaused = false;
    },
    async renewInFlight() {
      await Promise.all([...running.keys()].map((jobId) => renewOne(jobId)));
    },
    stop() {
      stopped = true;
      clearTimer(poll);
      poll = null;
      clearTimer(due);
      due = null;
      unsubscribeWake?.();
      unsubscribeWake = null;
      for (const entry of running.values()) clearTimer(entry.timer);
      for (const retry of reportRetries.values()) clearTimer(retry.timer);
    },
  };
}
