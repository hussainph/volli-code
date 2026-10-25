import { describe, expect, it, vi } from "vite-plus/test";

import type { ClaimedJob, JobOutcome } from "@volli/shared/cloud";

import {
  createInboxWorker,
  INBOX_LIMITS,
  type InboxBackend,
  type JobJournalEntry,
  type JobJournalStore,
} from "./inbox";

const BOOT = "00000000-0000-4000-8000-000000000001";
const DONE: JobOutcome = { status: "done", result: { ok: true } };

function job(id: string, kind = "workingCopy.refresh", attempt = 1): ClaimedJob {
  return {
    job: {
      id,
      kind,
      runnerId: "r",
      projectId: "p",
      sessionId: null,
      ticketId: null,
      workingCopyId: null,
      commandId: null,
      payload: {},
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: BOOT, expiresAt: 60_000, attempt },
  } as unknown as ClaimedJob;
}

function memoryJournal(initial: JobJournalEntry[] = []) {
  const rows = new Map(initial.map((entry) => [entry.jobId, entry]));
  const store: JobJournalStore = {
    get: (jobId) => rows.get(jobId) ?? null,
    save: (entry) => void rows.set(entry.jobId, entry),
    unreported: () => [...rows.values()].filter((entry) => entry.outcome !== null),
    remove: (jobId, attempt) => {
      if (rows.get(jobId)?.lease.attempt === attempt) rows.delete(jobId);
    },
  };
  return { store, rows };
}

function fakeInbox(queue: ClaimedJob[][] = []) {
  const completes: { jobId: string; outcome: JobOutcome; attempt: number }[] = [];
  const renews: string[] = [];
  const failComplete: Error[] = [];
  const renewAnswers: Awaited<ReturnType<InboxBackend["renew"]>>[] = [];
  const backend: InboxBackend = {
    claim: vi.fn(async () => queue.shift() ?? []),
    renew: vi.fn(async ({ jobId }) => {
      renews.push(jobId);
      return (
        renewAnswers.shift() ?? {
          ok: true as const,
          lease: { bootId: BOOT, attempt: 1, expiresAt: 120_000 },
        }
      );
    }),
    complete: vi.fn(async ({ jobId, outcome, attempt }) => {
      const error = failComplete.shift();
      if (error) throw error;
      completes.push({ jobId, outcome, attempt });
      return { ack: "recorded" as const, status: outcome.status };
    }),
  };
  return { backend, completes, renews, failComplete, renewAnswers };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

function manualTimers() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void) => {
      timers.set(next, run);
      return next++;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    fireAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    get size() {
      return timers.size;
    },
  };
}

describe("the inbox worker", () => {
  it("claims, runs the registered executor, journals the outcome before reporting it, then forgets it", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    const timers = manualTimers();
    const order: string[] = [];
    const store: JobJournalStore = {
      ...journal.store,
      save(entry) {
        if (entry.outcome) order.push("journal");
        journal.store.save(entry);
      },
    };
    inbox.backend.complete = vi.fn(async () => {
      order.push("complete");
      return { ack: "recorded" as const, status: "done" };
    });
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: store,
      bootId: BOOT,
      ...timers,
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    expect(order).toEqual(["journal", "complete"]);
    expect(journal.rows.size).toBe(0);
    expect(inbox.backend.claim).toHaveBeenCalledWith({
      bootId: BOOT,
      max: INBOX_LIMITS.concurrent,
    });
    expect(() => worker.register("workingCopy.refresh", async () => DONE)).toThrow(
      /already registered/,
    );
    worker.stop();
  });

  it("an unknown kind completes as unsupported, and a throwing executor as a retryable failure", async () => {
    const inbox = fakeInbox([[job("j1", "future.kind"), job("j2"), job("j3")]]);
    const journal = memoryJournal();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...manualTimers(),
    });
    let calls = 0;
    worker.register("workingCopy.refresh", (claimed) => {
      calls += 1;
      if (claimed.job.id === "j3") throw "sync";
      return Promise.reject(new Error("boom"));
    });
    await worker.start();
    await flush();
    expect(calls).toBe(2);
    expect(inbox.completes.map((c) => [c.jobId, c.outcome])).toEqual([
      [
        "j1",
        expect.objectContaining({
          status: "failed",
          code: "unsupported_job_kind",
          retryable: false,
        }),
      ],
      ["j2", { status: "failed", code: "executor_error", detail: "boom", retryable: true }],
      ["j3", { status: "failed", code: "executor_error", detail: "sync", retryable: true }],
    ]);
  });

  it("reports a result the backend cannot store as a permanent failure, never as a send that loops", async () => {
    const inbox = fakeInbox([[job("j1"), job("j2")]]);
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...manualTimers(),
    });
    worker.register("workingCopy.refresh", async (claimed) =>
      claimed.job.id === "j1"
        ? { status: "done", result: { $schema: "https://json-schema.org/draft/2020-12/schema" } }
        : { status: "done", result: undefined },
    );
    await worker.start();
    await flush();
    expect(inbox.completes.map((c) => [c.jobId, c.outcome])).toEqual([
      [
        "j1",
        {
          status: "failed",
          code: "invalid_job_result",
          detail: "The result is not plain JSON.",
          retryable: false,
        },
      ],
      [
        "j2",
        {
          status: "failed",
          code: "invalid_job_result",
          detail: "The result is not plain JSON.",
          retryable: false,
        },
      ],
    ]);
    worker.stop();
  });

  it("keeps an unreported outcome through a crash and reports it on the next start", async () => {
    const journal = memoryJournal([
      {
        jobId: "j1",
        kind: "workingCopy.refresh",
        lease: { bootId: "old", attempt: 1 },
        state: "done",
        outcome: DONE,
        receivedAt: 1,
      },
      {
        jobId: "j2",
        kind: "workingCopy.refresh",
        lease: { bootId: "old", attempt: 1 },
        state: "running",
        outcome: null,
        receivedAt: 2,
      },
    ]);
    const inbox = fakeInbox();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...manualTimers(),
    });
    await worker.start();
    await flush();
    expect(inbox.completes).toEqual([{ jobId: "j1", outcome: DONE, attempt: 1 }]);
    expect([...journal.rows.keys()]).toEqual(["j2"]);
  });

  it("never runs a job twice: a re-leased job whose outcome it already has is reported, not run", async () => {
    const journal = memoryJournal([
      {
        jobId: "j1",
        kind: "workingCopy.refresh",
        lease: { bootId: "old", attempt: 1 },
        state: "done",
        outcome: DONE,
        receivedAt: 1,
      },
      {
        jobId: "j2",
        kind: "workingCopy.refresh",
        lease: { bootId: BOOT, attempt: 2 },
        state: "done",
        outcome: DONE,
        receivedAt: 1,
      },
    ]);
    const inbox = fakeInbox([
      [job("j1", "workingCopy.refresh", 2), job("j2", "workingCopy.refresh", 2)],
    ]);
    let answered = 0;
    inbox.backend.complete = vi.fn((args) => {
      inbox.completes.push(args);
      answered += 1;
      // The start-up reports are still unanswered when the claim re-leases the jobs.
      if (answered <= 2) return new Promise<never>(() => {});
      return Promise.resolve({ ack: "duplicate" as const, status: "done" });
    });
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...manualTimers(),
    });
    const executor = vi.fn(async () => DONE);
    worker.register("workingCopy.refresh", executor);
    await worker.claimNow();
    await worker.start();
    await flush();
    expect(executor).not.toHaveBeenCalled();
    expect(inbox.completes.findLast((c) => c.jobId === "j1")).toMatchObject({ attempt: 2 });
    expect(journal.rows.size).toBe(0);
  });

  it("retries a report the backend did not answer, with a capped backoff", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    inbox.failComplete.push(new Error("offline"), new Error("offline"));
    const journal = memoryJournal();
    const timers = manualTimers();
    const errors: unknown[] = [];
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...timers,
      onError: (e) => errors.push(e),
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    expect(journal.rows.size).toBe(1);
    timers.fireAll();
    await flush();
    timers.fireAll();
    await flush();
    expect(inbox.completes).toHaveLength(1);
    expect(journal.rows.size).toBe(0);
    expect(errors).toHaveLength(2);
    worker.stop();
  });

  it("does not retry reports after stop", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    inbox.failComplete.push(new Error("offline"));
    const journal = memoryJournal();
    const timers = manualTimers();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...timers,
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    worker.stop();
    timers.fireAll();
    await flush();
    expect(inbox.completes).toHaveLength(0);
    expect(journal.rows.size).toBe(1);
  });

  it("keeps a running job's lease alive, and aborts it when the backend takes it away", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    const timers = manualTimers();
    let signal!: AbortSignal;
    let finish!: (outcome: JobOutcome) => void;
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...timers,
    });
    worker.register("workingCopy.refresh", (_claimed, context) => {
      signal = context.signal;
      return new Promise((done) => (finish = done));
    });
    await worker.start();
    expect(worker.running).toBe(1);
    timers.fireAll();
    await flush();
    expect(inbox.renews).toEqual(["j1"]);
    // The next renewal, and the claim poll.
    expect(timers.size).toBe(2);
    inbox.renewAnswers.push({ ok: false, reason: "cancelled" });
    await worker.renewInFlight();
    expect(signal.aborted).toBe(true);
    finish({ status: "failed", code: "cancelled", detail: null, retryable: false });
    await flush();
    expect(worker.running).toBe(0);
  });

  it("an executor may renew for longer, and a failed renewal is not a lost lease", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    const errors: unknown[] = [];
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...manualTimers(),
      onError: (e) => errors.push(e),
    });
    const results: boolean[] = [];
    worker.register("workingCopy.refresh", async (_claimed, context) => {
      results.push(await context.renew(600_000));
      inbox.backend.renew = vi.fn(async () => {
        throw new Error("blip");
      });
      results.push(await context.renew());
      later = context;
      return DONE;
    });
    let later!: { renew(extendMs?: number): Promise<boolean> };
    await worker.start();
    await flush();
    expect(results).toEqual([true, true]);
    // Once the job is done, its lease is not this worker's to renew.
    await expect(later.renew()).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    // A renewal for a job no longer running answers false.
    await expect(worker.renewInFlight()).resolves.toBeUndefined();
  });

  it("claims only what it has room for, one claim at a time, and not while stopped or full", async () => {
    const inbox = fakeInbox();
    let holds: ((o: JobOutcome) => void)[] = [];
    inbox.backend.claim = vi.fn(async ({ max }) =>
      Array.from({ length: max }, (_, n) => job(`j${n}-${Math.random()}`)),
    );
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...manualTimers(),
    });
    worker.register("workingCopy.refresh", () => new Promise((done) => holds.push(done)));
    await worker.claimNow();
    expect(inbox.backend.claim).not.toHaveBeenCalled();
    await Promise.all([worker.start(), worker.claimNow()]);
    expect(worker.running).toBe(INBOX_LIMITS.concurrent);
    await worker.claimNow();
    expect(inbox.backend.claim).toHaveBeenCalledTimes(1);
    worker.stop();
    for (const done of holds) done(DONE);
    holds = [];
    await flush();
    expect(inbox.backend.claim).toHaveBeenCalledTimes(1);
  });

  it("a failed claim is logged and tried again later", async () => {
    const inbox = fakeInbox();
    const errors: unknown[] = [];
    inbox.backend.claim = vi.fn(async () => {
      throw new Error("offline");
    });
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      onError: (e) => errors.push(e),
    });
    await worker.start();
    expect(errors).toHaveLength(1);
    worker.stop();
  });

  it("a report failing after stop arms no retry; the journal keeps it for the next start", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    const timers = manualTimers();
    let fail!: () => void;
    inbox.backend.complete = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => (fail = () => reject(new Error("link closed")))),
    );
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...timers,
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    worker.stop();
    const armed = timers.size;
    fail();
    await flush();
    expect(timers.size).toBe(armed);
    expect(journal.rows.size).toBe(1);
  });

  it("does not loop on a report the backend calls malformed", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    inbox.failComplete.push(Object.assign(new Error("bad"), { data: { code: "invalid_request" } }));
    const journal = memoryJournal();
    const timers = manualTimers();
    const errors: unknown[] = [];
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: journal.store,
      bootId: BOOT,
      ...timers,
      onError: (e) => errors.push(e),
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    expect(errors).toHaveLength(1);
    expect(journal.rows.size).toBe(1);
    worker.stop();
  });

  it("an older lease's answer never removes a newer lease's outcome", async () => {
    const journal = memoryJournal([
      {
        jobId: "j1",
        kind: "workingCopy.refresh",
        lease: { bootId: BOOT, attempt: 2 },
        state: "done",
        outcome: DONE,
        receivedAt: 1,
      },
    ]);
    journal.store.remove("j1", 1);
    expect(journal.rows.size).toBe(1);
  });

  it("claims on a poll while it runs, and stops polling when stopped", async () => {
    const inbox = fakeInbox([[], [], [job("j1")]]);
    const timers = manualTimers();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...timers,
    });
    const executor = vi.fn(async () => DONE);
    worker.register("workingCopy.refresh", executor);
    await worker.start();
    await worker.start();
    expect(executor).not.toHaveBeenCalled();
    timers.fireAll();
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    worker.stop();
    expect(timers.size).toBe(0);
  });

  it("a journal that cannot be written is reported, not thrown", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    let writes = 0;
    const errors: unknown[] = [];
    const store: JobJournalStore = {
      ...journal.store,
      save(entry) {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
        journal.store.save(entry);
      },
    };
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: store,
      bootId: BOOT,
      ...manualTimers(),
      onError: (e) => errors.push(e),
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    expect(errors).toEqual([expect.objectContaining({ message: "disk full" })]);
    worker.stop();
  });

  it("a journal that cannot forget an answered outcome is reported, not thrown", async () => {
    const inbox = fakeInbox([[job("j1")]]);
    const journal = memoryJournal();
    const errors: unknown[] = [];
    const store: JobJournalStore = {
      ...journal.store,
      remove: () => {
        throw new Error("readonly");
      },
    };
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: store,
      bootId: BOOT,
      ...manualTimers(),
      onError: (e) => errors.push(e),
    });
    worker.register("workingCopy.refresh", async () => DONE);
    await worker.start();
    await flush();
    expect(errors).toEqual([expect.objectContaining({ message: "readonly" })]);
    worker.stop();
  });

  it("runs one Session's jobs one at a time in claim order, other jobs alongside", async () => {
    const session = (id: string, sessionId: string | null) => {
      const claimed = job(id);
      (claimed.job as { sessionId: string | null }).sessionId = sessionId;
      return claimed;
    };
    const inbox = fakeInbox([
      [session("a1", "s1"), session("a2", "s1"), session("b1", "s2"), session("x", null)],
    ]);
    const timers = manualTimers();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...timers,
    });
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    worker.register("workingCopy.refresh", (claimed) => {
      started.push(claimed.job.id);
      return new Promise((done) => finishers.set(claimed.job.id, () => done(DONE)));
    });
    await worker.start();
    expect(started).toEqual(["a1", "b1", "x"]);
    expect(worker.running).toBe(4);
    // The waiting job's lease is kept alive too.
    timers.fireAll();
    await flush();
    expect(inbox.renews.toSorted()).toEqual(["a1", "a2", "b1", "x"]);
    finishers.get("a1")!();
    await flush();
    expect(started).toEqual(["a1", "b1", "x", "a2"]);
    finishers.get("a2")!();
    finishers.get("b1")!();
    finishers.get("x")!();
    await flush();
    expect(worker.running).toBe(0);
    worker.stop();
  });

  it("a job whose lease is taken away while it waits in its lane does not run", async () => {
    const session = (id: string) => {
      const claimed = job(id);
      (claimed.job as { sessionId: string | null }).sessionId = "s1";
      return claimed;
    };
    const inbox = fakeInbox([[session("a1"), session("a2")]]);
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...manualTimers(),
    });
    const started: string[] = [];
    let finishA1!: () => void;
    worker.register("workingCopy.refresh", (claimed) => {
      started.push(claimed.job.id);
      return new Promise((done) => (finishA1 = () => done(DONE)));
    });
    await worker.start();
    inbox.renewAnswers.push(
      { ok: true, lease: { bootId: BOOT, attempt: 1, expiresAt: 1 } },
      { ok: false, reason: "cancelled" },
    );
    await worker.renewInFlight();
    finishA1();
    await flush();
    expect(started).toEqual(["a1"]);
    expect(
      inbox.completes.map((c) => [
        c.jobId,
        c.outcome.status === "failed" ? c.outcome.code : "done",
      ]),
    ).toEqual([
      ["a1", "done"],
      ["a2", "lease_lost"],
    ]);
    worker.stop();
  });

  it("claims when the wake subscription says jobs are ready or come due, instead of polling", async () => {
    const inbox = fakeInbox([[], [], [job("j1")], [], [job("j2")]]);
    const timers = manualTimers();
    let wake!: (value: { ready: number; nextAvailableAt: number | null }) => void;
    const off = vi.fn();
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...timers,
      now: () => 1_000,
      wake: (listener) => {
        wake = listener;
        return off;
      },
    });
    const executor = vi.fn(async () => DONE);
    worker.register("workingCopy.refresh", executor);
    await worker.start();
    await worker.start();
    // No poll timer: the subscription is the trigger.
    expect(timers.size).toBe(0);
    wake({ ready: 1, nextAvailableAt: null });
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    wake({ ready: 0, nextAvailableAt: 6_000 });
    wake({ ready: 0, nextAvailableAt: 9_000 });
    expect(timers.size).toBe(1);
    timers.fireAll();
    await flush();
    expect(executor).toHaveBeenCalledTimes(2);
    worker.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("claims again when a wake lands while a claim is in flight, so a notice is never stranded", async () => {
    const inbox = fakeInbox();
    let answer!: (jobs: ClaimedJob[]) => void;
    const answers = [
      () => new Promise<ClaimedJob[]>((done) => (answer = done)),
      async () => [job("notice", "session.notice")],
    ];
    inbox.backend.claim = vi.fn(() => answers.shift()?.() ?? Promise.resolve([]));
    let wake!: (value: { ready: number; nextAvailableAt: number | null }) => void;
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...manualTimers(),
      wake: (listener) => {
        wake = listener;
        return () => {};
      },
    });
    const executor = vi.fn(async () => DONE);
    worker.register("session.notice", executor);
    const started = worker.start();
    // The job is queued after the start's claim was read: its wake comes mid-claim.
    wake({ ready: 1, nextAvailableAt: null });
    answer([]);
    await started;
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    // The start's claim, the one more the wake asked for, and the one after the job finished.
    expect(inbox.backend.claim).toHaveBeenCalledTimes(3);
    worker.stop();
  });

  it.each(["stop", "pause"] as const)(
    "cancels a coalesced retry when an executor synchronously asks to %s",
    async (action) => {
      const inbox = fakeInbox([[job("notice", "session.notice")]]);
      const worker = createInboxWorker({
        backend: inbox.backend,
        journal: memoryJournal().store,
        bootId: BOOT,
        ...manualTimers(),
        wake: () => () => {},
      });
      worker.register("session.notice", async () => {
        void worker.claimNow();
        if (action === "stop") worker.stop();
        else worker.pauseClaims!();
        return DONE;
      });
      await worker.start();
      await flush();
      expect(inbox.backend.claim).toHaveBeenCalledOnce();
      worker.stop();
    },
  );

  it("does not claim again for a mid-claim wake once it has stopped", async () => {
    const inbox = fakeInbox();
    let answer!: (jobs: ClaimedJob[]) => void;
    inbox.backend.claim = vi.fn(() => new Promise<ClaimedJob[]>((done) => (answer = done)));
    const worker = createInboxWorker({
      backend: inbox.backend,
      journal: memoryJournal().store,
      bootId: BOOT,
      ...manualTimers(),
      wake: () => () => {},
    });
    const started = worker.start();
    void worker.claimNow();
    worker.stop();
    answer([]);
    await started;
    expect(inbox.backend.claim).toHaveBeenCalledOnce();
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const inbox = fakeInbox([[job("j1")]]);
      inbox.failComplete.push(new Error("offline"));
      const journal = memoryJournal();
      const worker = createInboxWorker({
        backend: inbox.backend,
        journal: journal.store,
        bootId: BOOT,
      });
      let finish!: (o: JobOutcome) => void;
      worker.register("workingCopy.refresh", () => new Promise((done) => (finish = done)));
      await worker.start();
      await vi.advanceTimersByTimeAsync(INBOX_LIMITS.renewEveryMs);
      expect(inbox.renews).toEqual(["j1"]);
      finish(DONE);
      await vi.advanceTimersByTimeAsync(INBOX_LIMITS.retryMaxMs);
      expect(journal.rows.size).toBe(0);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("fences wake/poll claims during sleep and ignores a claim answer crossing the fence", async () => {
  const backend = fakeInbox();
  const journal = memoryJournal();
  const timers = manualTimers();
  let wake: ((value: { ready: number; nextAvailableAt: number | null }) => void) | undefined;
  const worker = createInboxWorker({
    backend: backend.backend,
    journal: journal.store,
    bootId: BOOT,
    wake: (listener) => {
      wake = listener;
      return () => {};
    },
    ...timers,
  });
  const execute = vi.fn(async () => DONE);
  worker.register("workingCopy.refresh", execute);
  worker.pauseClaims!();
  await worker.start();
  wake!({ ready: 1, nextAvailableAt: 0 });
  timers.fireAll();
  await flush();
  expect(backend.backend.claim).not.toHaveBeenCalled();
  worker.resumeClaims!();
  let answer: ((jobs: ClaimedJob[]) => void) | undefined;
  backend.backend.claim = vi.fn(
    () =>
      new Promise<ClaimedJob[]>((done) => {
        answer = done;
      }),
  );
  const pending = worker.claimNow();
  // Upstream coalesces a mid-claim inbox wake into one more claim. A sleep
  // fence must also cancel that queued retry, not just the current answer.
  wake!({ ready: 1, nextAvailableAt: 0 });
  worker.pauseClaims!();
  answer!([job("crossed")]);
  await pending;
  expect(backend.backend.claim).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(journal.rows.size).toBe(0);
  worker.resumeClaims!();
  backend.backend.claim = vi.fn(async () => []);
  await worker.claimNow();
  expect(backend.backend.claim).toHaveBeenCalledOnce();
  worker.stop();
});
