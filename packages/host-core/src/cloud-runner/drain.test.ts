import { describe, expect, it, vi } from "vite-plus/test";

import type { SessionEvent } from "@volli/shared";

import {
  createFactDrain,
  DRAIN_LIMITS,
  type AcceptCall,
  type DrainCursor,
  type DrainCursorStore,
  type DrainLedger,
} from "./drain";
import { createMutationGate } from "./flow";

const OWNER = "owner-1";

function event(sessionId: string, sequence: number, size = 0): SessionEvent {
  return {
    id: `${sessionId}:e${sequence}`,
    sessionId,
    sequence,
    occurredAt: sequence,
    recordedAt: sequence,
    attachmentId: null,
    commandId: null,
    provenance: { kind: "test" },
    payload: { kind: "note.recorded", text: "x".repeat(size) },
  } as unknown as SessionEvent;
}

function memoryLedger() {
  const sessions = new Map<string, SessionEvent[]>();
  const ledger: DrainLedger = {
    listEvents: ({ sessionId, afterSequence, limit }) =>
      (sessions.get(sessionId) ?? []).filter((e) => e.sequence > afterSequence).slice(0, limit),
    latestEventSequence: (sessionId) => sessions.get(sessionId)?.length ?? 0,
  };
  return {
    ledger,
    append(sessionId: string, count = 1, size = 0) {
      const list = sessions.get(sessionId) ?? [];
      for (let n = 0; n < count; n += 1) list.push(event(sessionId, list.length + 1, size));
      sessions.set(sessionId, list);
    },
  };
}

function memoryCursors(initial: DrainCursor[] = []) {
  const rows = new Map(initial.map((cursor) => [cursor.sessionId, cursor]));
  const saves: DrainCursor[] = [];
  const store: DrainCursorStore = {
    list: () => [...rows.values()],
    get: (sessionId) => rows.get(sessionId) ?? null,
    save: (cursor) => {
      saves.push(cursor);
      rows.set(cursor.sessionId, cursor);
    },
  };
  return { store, rows, saves };
}

const refusal = (code: string, acceptedThrough: number) =>
  Object.assign(new Error(code), { data: { code, message: code, acceptedThrough } });

/**
 * The `sessions.accept` contract (A3 §3.4) in memory: contiguous by
 * sequence, duplicates matched by id and envelope, `conflict` on a mismatch,
 * `out_of_order` past the head, `fenced` on another generation.
 */
function fakeBackend() {
  const heads = new Map<string, number>();
  const stored = new Map<string, string>();
  const generations = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const perSession = new Map<string, number>();
  let maxPerSession = 0;
  let calls = 0;
  const faults: ((args: { sessionId: string }) => Error | null)[] = [];
  let hold: Promise<void> | null = null;
  const order: number[] = [];

  const accept: AcceptCall = async (args) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    perSession.set(args.sessionId, (perSession.get(args.sessionId) ?? 0) + 1);
    maxPerSession = Math.max(maxPerSession, perSession.get(args.sessionId)!);
    try {
      if (hold) await hold;
      await Promise.resolve();
      const fault = faults.shift()?.(args) ?? null;
      if (fault) throw fault;
      const head = heads.get(args.sessionId) ?? 0;
      const generation = generations.get(args.sessionId) ?? 1;
      if (args.generation !== generation) throw refusal("fenced", head);
      let duplicates = 0;
      let next = head;
      for (const text of args.events) {
        const value = JSON.parse(text) as { id: string; sequence: number };
        order.push(value.sequence);
        if (value.sequence <= next) {
          if (stored.get(`${args.sessionId}:${value.sequence}`) !== text)
            throw refusal("conflict", next);
          duplicates += 1;
          continue;
        }
        // S1's birth rule: a Session the backend has not seen starts at its fact 1.
        if (next === 0 && value.sequence !== 1) throw refusal("unknown_session", 0);
        if (value.sequence !== next + 1) throw refusal("out_of_order", next);
        stored.set(`${args.sessionId}:${value.sequence}`, text);
        next = value.sequence;
      }
      heads.set(args.sessionId, next);
      return { acceptedThrough: next, duplicates, quarantined: 0 };
    } finally {
      inFlight -= 1;
      perSession.set(args.sessionId, perSession.get(args.sessionId)! - 1);
    }
  };
  return {
    accept,
    heads,
    generations,
    faults,
    order,
    stats: () => ({ maxInFlight, maxPerSession, calls }),
    holdAll() {
      let release!: () => void;
      hold = new Promise((done) => (release = done));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

function drainOver(
  backend: ReturnType<typeof fakeBackend>,
  ledger: DrainLedger,
  cursors: DrainCursorStore,
  extra: Partial<Parameters<typeof createFactDrain>[0]> & {
    gateLimits?: { maxInFlight: number; maxBytes: number };
  } = {},
) {
  // One gate in front of the backend, as the backend link puts it.
  const gate = extra.gateLimits ? createMutationGate(extra.gateLimits) : createMutationGate();
  const accept = extra.accept ?? backend.accept;
  delete extra.gateLimits;
  return createFactDrain({
    ledger,
    cursors,
    ownerUserId: OWNER,
    setTimer: (run) => {
      queueMicrotask(run);
      return 1;
    },
    clearTimer: () => {},
    random: () => 0.5,
    ...extra,
    accept: (args, options) =>
      gate.run(options.priority, options.bytes, () => accept(args, options)),
  });
}

describe("the fact drain", () => {
  it("sends a live Session's facts one per mutation, in order, and persists the cursor", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    drain.start();
    drain.adopt("s1");
    append("s1", 3);
    drain.nudge("s1");
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(3);
    expect(rows.get("s1")).toMatchObject({
      acceptedThrough: 3,
      ownerUserId: OWNER,
      generation: 1,
      blocked: null,
    });
    expect(backend.order).toEqual([1, 2, 3]);
    expect(drain.status()).toEqual({ sessions: 1, waiting: 0, blocked: 0 });
  });

  it("catches up a backlog in bounded batches", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    append("s1", 250);
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(250);
    // 250 events in batches of ≤ 100, not 250 mutations.
    expect(backend.stats().calls).toBeLessThanOrEqual(10);
  });

  it("splits a batch at the byte budget", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const sizes: number[] = [];
    const drain = drainOver(backend, ledger, store, {
      accept: (args, options) => {
        sizes.push(options.bytes);
        return backend.accept(args, options);
      },
    });
    append("s1", 40, 10_000);
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(40);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(DRAIN_LIMITS.batchBytes);
  });

  it("restarts from the persisted cursor after a crash, and resends are duplicates", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const cursors = memoryCursors();
    append("s1", 5);
    const first = drainOver(backend, ledger, cursors.store);
    first.adopt("s1");
    first.start();
    await first.idle();
    // The process dies after the backend accepted more than the cursor says.
    cursors.rows.set("s1", { ...cursors.rows.get("s1")!, acceptedThrough: 2 });
    append("s1", 2);
    const second = drainOver(backend, ledger, cursors.store);
    second.start();
    await second.idle();
    expect(backend.heads.get("s1")).toBe(7);
    expect(cursors.rows.get("s1")?.acceptedThrough).toBe(7);
  });

  it("rides out an outage, resending from the cursor with a capped backoff", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const delays: number[] = [];
    const drain = drainOver(backend, ledger, store, {
      onRetry: (_s, _e, delay) => delays.push(delay),
    });
    for (let n = 0; n < 12; n += 1) backend.faults.push(() => new Error("socket closed"));
    append("s1", 3);
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(3);
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(DRAIN_LIMITS.retryMaxMs);
    expect(delays[0]).toBe(188);
  });

  it("follows the backend's head on out_of_order (a reordered or lost send)", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const cursors = memoryCursors([
      { sessionId: "s1", ownerUserId: OWNER, generation: 1, acceptedThrough: 4, blocked: null },
    ]);
    // The backend has only 2 (say, the cursor was restored from elsewhere).
    append("s1", 6);
    backend.heads.set("s1", 2);
    const drain = drainOver(backend, ledger, cursors.store);
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(6);
    expect(cursors.rows.get("s1")?.acceptedThrough).toBe(6);
  });

  it("converges when the transport runs pipelined sends out of order", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const queued: (() => void)[] = [];
    const drain = drainOver(backend, ledger, store, {
      // Hold every send, then run them newest first.
      accept: (args, options) =>
        new Promise((resolve, reject) => {
          queued.push(() => backend.accept(args, options).then(resolve, reject));
        }),
    });
    drain.start();
    drain.adopt("s1");
    append("s1", 6);
    drain.nudge("s1");
    for (let round = 0; round < 50 && (backend.heads.get("s1") ?? 0) < 6; round += 1) {
      await new Promise((done) => setTimeout(done, 0));
      const batch = queued.splice(0).toReversed();
      for (const run of batch) run();
    }
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(6);
    expect(rows.get("s1")?.acceptedThrough).toBe(6);
  });

  it("keeps the per-Session and per-connection caps under load", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    drain.start();
    const release = backend.holdAll();
    for (let n = 0; n < 10; n += 1) {
      const sessionId = `s${n}`;
      drain.adopt(sessionId);
      append(sessionId, 8);
      drain.nudge(sessionId);
    }
    await new Promise((done) => setTimeout(done, 5));
    release();
    await drain.idle();
    expect(backend.stats().maxInFlight).toBeLessThanOrEqual(32);
    expect(backend.stats().maxPerSession).toBeLessThanOrEqual(DRAIN_LIMITS.perSession);
    for (let n = 0; n < 10; n += 1) expect(backend.heads.get(`s${n}`)).toBe(8);
  });

  it("stops a Session's drain, visibly, on a refusal retrying cannot fix", async () => {
    for (const code of [
      "fenced",
      "conflict",
      "not_your_runner",
      "unknown_session",
      "not_found",
      "revoked",
      "not_a_runner",
      "preview_access_required",
      "parent_not_found",
      "corrupt_history",
      "corrupt_state",
      "corrupt_board",
      "invalid_job",
      "id_taken",
    ]) {
      const backend = fakeBackend();
      const { ledger, append } = memoryLedger();
      const { store, rows } = memoryCursors();
      const blocked: string[] = [];
      const drain = drainOver(backend, ledger, store, {
        onBlocked: (_s, block) => blocked.push(block.code),
      });
      backend.faults.push(() => refusal(code, 0));
      append("s1", 2);
      drain.adopt("s1");
      drain.start();
      await drain.idle();
      expect(blocked).toEqual([code]);
      expect(rows.get("s1")?.blocked).toMatchObject({ code });
      expect(drain.status().blocked).toBe(1);
      // A later nudge does nothing until someone recovers it.
      append("s1");
      drain.nudge("s1");
      await drain.idle();
      expect(backend.heads.get("s1") ?? 0).toBe(0);
      drain.retry("s1");
      await drain.idle();
      expect(backend.heads.get("s1")).toBe(3);
      expect(rows.get("s1")?.blocked).toBeNull();
    }
  });

  it("a fenced runner is fenced: another generation's claim is refused", async () => {
    const backend = fakeBackend();
    backend.generations.set("s1", 2);
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    append("s1");
    drain.adopt("s1", 1);
    drain.start();
    await drain.idle();
    expect(rows.get("s1")?.blocked?.code).toBe("fenced");
  });

  it("a batch the backend refuses goes again one fact at a time; a fact it never takes stops the drain", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    let calls = 0;
    const drain = drainOver(backend, ledger, store, {
      accept: (args, options) => {
        calls += 1;
        if (args.events.some((text) => text.includes('"sequence":15,'))) {
          return Promise.reject(
            refusal(args.events.length > 1 ? "batch_too_large" : "event_too_large", 0),
          );
        }
        return backend.accept(args, options);
      },
    });
    append("s1", 30);
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(14);
    expect(rows.get("s1")?.blocked?.code).toBe("event_too_large");
    // One refused batch, then one fact at a time through it: no retry storm.
    expect(calls).toBeLessThanOrEqual(16);
  });

  it.each([
    "unauthenticated",
    "accept_failed",
    "fold_failed",
    "runner_unavailable",
    "future_refusal",
  ])("retries transient %s without advancing the cursor or discarding facts", async (code) => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const retryHeads: number[] = [];
    const drain = drainOver(backend, ledger, store, {
      onRetry: (sessionId) => retryHeads.push(rows.get(sessionId)!.acceptedThrough),
    });
    backend.faults.push(() => refusal(code, 99)); // A rejection is never an acknowledgement.
    append("s1");
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(retryHeads).toEqual([0]);
    expect(backend.heads.get("s1")).toBe(1);
    expect(rows.get("s1")?.acceptedThrough).toBe(1);
    expect(rows.get("s1")?.blocked).toBeNull();
  });

  it("stops at a gap in the ledger rather than sending past it", async () => {
    const backend = fakeBackend();
    const { store } = memoryCursors();
    const events = [event("s1", 1), event("s1", 3)];
    const ledger: DrainLedger = {
      listEvents: ({ afterSequence, limit }) =>
        events.filter((e) => e.sequence > afterSequence).slice(0, limit),
      latestEventSequence: () => 3,
    };
    const drain = drainOver(backend, ledger, store);
    drain.adopt("s1");
    drain.start();
    await new Promise((done) => setTimeout(done, 5));
    expect(backend.heads.get("s1")).toBe(1);
    expect(drain.status().waiting).toBe(2);
    drain.stop();
  });

  it("ignores what names no Session it drains", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors([
      {
        sessionId: "theirs",
        ownerUserId: "someone-else",
        generation: 1,
        acceptedThrough: 0,
        blocked: null,
      },
    ]);
    append("theirs");
    const drain = drainOver(backend, ledger, store);
    drain.start();
    drain.adopt("theirs");
    drain.nudge("nobody");
    drain.retry("nobody");
    drain.adopt("mine");
    drain.retry("mine");
    await drain.idle();
    expect(backend.stats().calls).toBe(0);
  });

  it("drains only this owner's cursor rows", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors([
      {
        sessionId: "theirs",
        ownerUserId: "someone-else",
        generation: 1,
        acceptedThrough: 0,
        blocked: null,
      },
    ]);
    append("theirs", 2);
    const drain = drainOver(backend, ledger, store);
    drain.start();
    await drain.idle();
    expect(backend.stats().calls).toBe(0);
  });

  it("never blocks the caller, and sends nothing until started", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    drain.adopt("s1");
    append("s1", 2);
    expect(drain.nudge("s1")).toBeUndefined();
    await new Promise((done) => setTimeout(done, 1));
    expect(backend.stats().calls).toBe(0);
    drain.resumeAll();
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(2);
    drain.stop();
    append("s1");
    drain.nudge("s1");
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(2);
  });

  it("adopting an existing Session keeps its cursor", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors([
      { sessionId: "s1", ownerUserId: OWNER, generation: 3, acceptedThrough: 0, blocked: null },
    ]);
    backend.generations.set("s1", 3);
    append("s1");
    const drain = drainOver(backend, ledger, store);
    drain.start();
    drain.adopt("s1");
    await drain.idle();
    expect(rows.get("s1")?.generation).toBe(3);
    expect(backend.heads.get("s1")).toBe(1);
  });

  it("resumeAll cancels a pending backoff and tries again now", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const timers: (() => void)[] = [];
    const cleared: unknown[] = [];
    const drain = drainOver(backend, ledger, store, {
      setTimer: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimer: (handle) => cleared.push(handle),
    });
    backend.faults.push(() => new Error("down"));
    append("s1");
    drain.adopt("s1");
    drain.start();
    await new Promise((done) => setTimeout(done, 1));
    expect(timers).toHaveLength(1);
    drain.resumeAll();
    await drain.idle();
    expect(cleared).toEqual([1]);
    expect(backend.heads.get("s1")).toBe(1);
    drain.stop();
  });

  it("never lets the gate put one Session's facts out of order, even saturated", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const refusals: string[] = [];
    const drain = drainOver(backend, ledger, store, {
      gateLimits: { maxInFlight: 2, maxBytes: 4_000 },
      accept: (args, options) =>
        backend.accept(args, options).catch((error: unknown) => {
          refusals.push((error as { data: { code: string } }).data.code);
          throw error;
        }),
    });
    drain.start();
    for (let n = 0; n < 4; n += 1) {
      drain.adopt(`s${n}`);
      append(`s${n}`, 30, 300);
      drain.nudge(`s${n}`);
    }
    await new Promise((done) => setTimeout(done, 1));
    // Live facts arrive while every Session is still catching up.
    for (let n = 0; n < 4; n += 1) {
      append(`s${n}`, 3);
      drain.nudge(`s${n}`);
    }
    await drain.idle();
    for (let n = 0; n < 4; n += 1) expect(backend.heads.get(`s${n}`)).toBe(33);
    expect(refusals).toEqual([]);
  });

  it("a newer claim on a fenced Session ends the fence and drains at the new generation", async () => {
    const backend = fakeBackend();
    backend.generations.set("s1", 2);
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    append("s1", 2);
    drain.adopt("s1", 1);
    drain.start();
    await drain.idle();
    expect(rows.get("s1")?.blocked?.code).toBe("fenced");
    drain.adopt("s1", 1);
    await drain.idle();
    expect(rows.get("s1")?.blocked?.code).toBe("fenced");
    drain.adopt("s1", 2);
    await drain.idle();
    expect(rows.get("s1")).toMatchObject({ generation: 2, blocked: null, acceptedThrough: 2 });
  });

  it("a newer claim keeps any other fault", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors([
      {
        sessionId: "s1",
        ownerUserId: OWNER,
        generation: 1,
        acceptedThrough: 0,
        blocked: { code: "conflict", message: "x", at: 1 },
      },
    ]);
    append("s1");
    const drain = drainOver(backend, ledger, store);
    drain.start();
    drain.adopt("s1", 2);
    await drain.idle();
    expect(rows.get("s1")).toMatchObject({ generation: 2, blocked: { code: "conflict" } });
  });

  it("says a stored fault again after a restart, and reports what the backend accepted", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const blocked = { code: "conflict", message: "forked", at: 1 };
    const { store } = memoryCursors([
      { sessionId: "bad", ownerUserId: OWNER, generation: 1, acceptedThrough: 0, blocked },
      { sessionId: "ok", ownerUserId: OWNER, generation: 1, acceptedThrough: 0, blocked: null },
    ]);
    append("ok", 2);
    const announced: string[] = [];
    const accepted: number[] = [];
    const drain = drainOver(backend, ledger, store, {
      onBlocked: (sessionId, block) => announced.push(`${sessionId}:${block.code}`),
      onAccepted: (_sessionId, through) => accepted.push(through),
    });
    drain.start();
    await drain.idle();
    expect(announced).toEqual(["bad:conflict"]);
    expect(accepted).toEqual([1, 2]);
  });

  it("treats a failed ledger or cursor write as transient", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const cursors = memoryCursors();
    let failReads = 1;
    let failSaves = 0;
    const flaky: DrainLedger = {
      listEvents: (query) => {
        if (failReads-- > 0) throw new Error("SQLITE_BUSY");
        return ledger.listEvents(query);
      },
      latestEventSequence: ledger.latestEventSequence,
    };
    const store: DrainCursorStore = {
      ...cursors.store,
      save: (cursor) => {
        if (failSaves-- > 0) throw new Error("disk full");
        cursors.store.save(cursor);
      },
    };
    const retries: unknown[] = [];
    const drain = drainOver(backend, flaky, store, { onRetry: (_s, error) => retries.push(error) });
    append("s1", 2);
    drain.adopt("s1");
    failSaves = 1;
    drain.start();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(2);
    expect(cursors.rows.get("s1")?.acceptedThrough).toBe(2);
    expect(retries.length).toBeGreaterThanOrEqual(2);
  });

  it("arms no retry once stopped; a restart resends from the cursor", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const timers: unknown[] = [];
    let finish!: () => void;
    const drain = drainOver(backend, ledger, store, {
      setTimer: (run) => {
        timers.push(run);
        return timers.length;
      },
      accept: () =>
        new Promise((_resolve, reject) => {
          finish = () => reject(new Error("socket closed"));
        }),
    });
    append("s1");
    drain.adopt("s1");
    drain.start();
    await new Promise((done) => setTimeout(done, 1));
    drain.stop();
    finish();
    await drain.idle();
    expect(timers).toEqual([]);
  });

  it("reads only the backend's own refusals; anything else is transient", async () => {
    for (const thrown of [
      "boom",
      { data: "x" },
      { data: { message: "no code" } },
      { data: { code: "out_of_order" } },
    ]) {
      const backend = fakeBackend();
      const { ledger, append } = memoryLedger();
      const { store, rows } = memoryCursors();
      const drain = drainOver(backend, ledger, store);
      backend.faults.push(() => thrown as unknown as Error);
      append("s1");
      drain.adopt("s1");
      drain.start();
      await drain.idle();
      expect(backend.heads.get("s1")).toBe(1);
      expect(rows.get("s1")?.blocked).toBeNull();
    }
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store, rows } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    backend.faults.push(() => Object.assign(new Error("x"), { data: { code: "fenced" } }));
    append("s1");
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(rows.get("s1")?.blocked).toMatchObject({ code: "fenced", message: "fenced" });
  });

  it("pipelines at most perSession live facts for one Session", async () => {
    const backend = fakeBackend();
    const { ledger, append } = memoryLedger();
    const { store } = memoryCursors();
    const drain = drainOver(backend, ledger, store);
    drain.start();
    drain.adopt("s1");
    const release = backend.holdAll();
    append("s1", 6);
    drain.nudge("s1");
    await new Promise((done) => setTimeout(done, 1));
    append("s1", 6);
    drain.nudge("s1");
    await new Promise((done) => setTimeout(done, 1));
    expect(backend.stats().maxPerSession).toBe(DRAIN_LIMITS.perSession);
    release();
    await drain.idle();
    expect(backend.heads.get("s1")).toBe(12);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const backend = fakeBackend();
      const { ledger, append } = memoryLedger();
      const { store } = memoryCursors();
      const drain = createFactDrain({
        ledger,
        cursors: store,
        accept: backend.accept,
        ownerUserId: OWNER,
      });
      backend.faults.push(() => new Error("down"));
      append("s1");
      drain.adopt("s1");
      drain.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(backend.heads.get("s1")).toBe(1);
      backend.faults.push(() => new Error("down"));
      append("s1");
      drain.nudge("s1");
      await vi.advanceTimersByTimeAsync(0);
      drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the drain's wire", () => {
  it("sends each event as the ledger codec's JSON text", async () => {
    const backend = fakeBackend();
    const { store } = memoryCursors();
    const sent: string[] = [];
    const bare = { ...event("s1", 1) } as Partial<SessionEvent>;
    delete bare.attachmentId;
    delete bare.commandId;
    const ledger: DrainLedger = {
      listEvents: ({ afterSequence }) => (afterSequence === 0 ? [bare as SessionEvent] : []),
      latestEventSequence: () => 1,
    };
    const drain = drainOver(backend, ledger, store, {
      accept: (args, options) => {
        sent.push(...args.events);
        return backend.accept(args, options);
      },
    });
    drain.adopt("s1");
    drain.start();
    await drain.idle();
    expect(JSON.parse(sent[0]!)).toEqual({
      id: "s1:e1",
      sessionId: "s1",
      sequence: 1,
      occurredAt: 1,
      recordedAt: 1,
      attachmentId: null,
      commandId: null,
      provenance: { kind: "test" },
      payload: { kind: "note.recorded", text: "" },
    });
  });
});
