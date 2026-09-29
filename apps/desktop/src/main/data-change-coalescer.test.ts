import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDataChangeCoalescer,
  DATA_CHANGED_BATCH_WINDOW_MS,
  type DataChangeScope,
  mergeDataChange,
} from "./data-change-coalescer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A sink that records what it was handed, in order. */
function recordingSink() {
  const sent: DataChangeScope[] = [];
  return { sent, send: (change: DataChangeScope) => void sent.push(change) };
}

describe("DATA_CHANGED_BATCH_WINDOW_MS", () => {
  it("is a fraction of a frame, not a delay a person could feel", () => {
    // Pinned as a NUMBER on purpose. Every test below advances the clock by
    // this constant, so a budget that quietly grew to half a second would keep
    // them all green while every socket-originated change arrived late.
    expect(DATA_CHANGED_BATCH_WINDOW_MS).toBe(8);
    expect(DATA_CHANGED_BATCH_WINDOW_MS).toBeLessThan(1000 / 60);
  });
});

describe("mergeDataChange", () => {
  it("keeps a scope both invalidations agree on", () => {
    expect(
      mergeDataChange(
        { ticketId: "t1", projectId: "p1", kind: "ticket" },
        { ticketId: "t1", projectId: "p1", kind: "ticket" },
      ),
    ).toEqual({ ticketId: "t1", projectId: "p1", kind: "ticket" });
  });

  it("widens a disagreement rather than picking a side", () => {
    expect(
      mergeDataChange({ ticketId: "t1", projectId: "p1" }, { ticketId: "t2", projectId: "p2" }),
    ).toEqual({});
  });

  it("widens against an untargeted invalidation in either order", () => {
    expect(mergeDataChange({}, { ticketId: "t1", kind: "ticket" })).toEqual({});
    expect(mergeDataChange({ ticketId: "t1", kind: "ticket" }, {})).toEqual({});
  });

  it("keeps a shared project when the tickets differ", () => {
    expect(
      mergeDataChange({ ticketId: "t1", projectId: "p1" }, { ticketId: "t2", projectId: "p1" }),
    ).toEqual({ projectId: "p1" });
  });

  it("keeps the worktree kind from either side, because a venue cache depends on it", () => {
    // The one load-bearing kind: a stale `resolving` venue never re-reads
    // without it, so one harmless extra venue refresh is the cheaper mistake.
    expect(mergeDataChange({ kind: "comment" }, { kind: "worktree" })).toEqual({
      kind: "worktree",
    });
    expect(mergeDataChange({ kind: "worktree" }, { kind: "session" })).toEqual({
      kind: "worktree",
    });
  });

  it("drops a mixed kind that no cache depends on", () => {
    expect(mergeDataChange({ kind: "comment" }, { kind: "session" })).toEqual({});
  });
});

describe("createDataChangeCoalescer", () => {
  it("folds a synchronous burst into one delivery", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    for (let mutation = 0; mutation < 15; mutation += 1) {
      coalescer.queue({ ticketId: "t1", projectId: "p1", kind: "ticket" });
    }
    expect(sink.sent).toEqual([]);

    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toEqual([{ ticketId: "t1", projectId: "p1", kind: "ticket" }]);
  });

  it("delivers within the frame window and not before", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({ kind: "ticket" });
    vi.advanceTimersByTime(7);
    expect(sink.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sink.sent).toHaveLength(1);
  });

  it("opens a fresh window after each flush", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({ kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    coalescer.queue({ kind: "comment" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(sink.sent).toEqual([{ kind: "ticket" }, { kind: "comment" }]);
  });

  it("never lets a later invalidation narrow an earlier one", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({});
    coalescer.queue({ ticketId: "t1", projectId: "p1", kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(sink.sent).toEqual([{}]);
  });

  it("keeps the worktree kind through a mixed batch, in either arrival order", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({ ticketId: "t1", kind: "worktree" });
    coalescer.queue({});
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(sink.sent).toEqual([{ kind: "worktree" }]);
  });

  it("copies the caller's scope, so mutating it afterwards cannot rewrite the batch", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);
    const change: DataChangeScope = { ticketId: "t1" };

    coalescer.queue(change);
    change.ticketId = "t2";
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(sink.sent).toEqual([{ ticketId: "t1" }]);
  });

  it("starts a NEW window for an invalidation the sink itself causes", () => {
    // Re-entrancy: a sink that mutates and broadcasts again must not land
    // inside the batch being drained, or the second notice is lost.
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer({
      send(change) {
        sink.send(change);
        if (sink.sent.length === 1) coalescer.queue({ kind: "session" });
      },
    });

    coalescer.queue({ kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toEqual([{ kind: "ticket" }]);

    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toEqual([{ kind: "ticket" }, { kind: "session" }]);
  });

  it("flushes on demand, and says nothing when there is nothing owed", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.flush();
    expect(sink.sent).toEqual([]);

    coalescer.queue({ kind: "ticket" });
    coalescer.flush();
    expect(sink.sent).toEqual([{ kind: "ticket" }]);

    // The timer the queue opened must be gone, not merely overtaken.
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toHaveLength(1);
  });

  it("disposes without delivering, and stays usable afterwards", () => {
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({ ticketId: "gone-with-its-test" });
    coalescer.dispose();
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toEqual([]);

    coalescer.dispose();
    coalescer.queue({ kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(sink.sent).toEqual([{ kind: "ticket" }]);
  });

  it("is rescued by dispose when the clock it scheduled against is thrown away", () => {
    // The isolation hazard in one test: a suite queues under fake timers, then
    // hands the process back a real clock. The handle left behind can never
    // fire, and the scope behind it can never drain on its own — which is why
    // `test-setup.ts` disposes after EVERY test rather than trusting a flush.
    const sink = recordingSink();
    const coalescer = createDataChangeCoalescer(sink);

    coalescer.queue({ ticketId: "belongs-to-the-previous-test" });
    vi.useRealTimers();

    coalescer.dispose();
    vi.useFakeTimers();
    coalescer.queue({ kind: "ticket" });
    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);

    expect(sink.sent).toEqual([{ kind: "ticket" }]);
  });

  it("gives each consumer its own window, so one burst is not another's latency", () => {
    // The reason this is a factory. A process-global timer folds one
    // subscriber's fifteen mutations into a second subscriber's wait, and no
    // tuning of a shared window can make it per-connection.
    const quiet = recordingSink();
    const busy = recordingSink();
    const quietSide = createDataChangeCoalescer(quiet);
    const busySide = createDataChangeCoalescer(busy);

    busySide.queue({ kind: "session" });
    quietSide.queue({ kind: "ticket" });
    quietSide.flush();

    expect(quiet.sent).toEqual([{ kind: "ticket" }]);
    expect(busy.sent).toEqual([]);

    vi.advanceTimersByTime(DATA_CHANGED_BATCH_WINDOW_MS);
    expect(busy.sent).toEqual([{ kind: "session" }]);
  });
});
