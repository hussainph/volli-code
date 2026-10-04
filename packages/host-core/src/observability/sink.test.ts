import { describe, expect, it } from "vite-plus/test";
import type { ObservabilityEvent } from "@volli/shared";

import {
  BoundedEventQueue,
  DEFAULT_QUEUE_CAPACITY,
  QueuedObservabilitySink,
  type ObservabilityExporter,
  type RecordedObservabilityEvent,
} from "./sink";

const toolEvent = (runId: string): ObservabilityEvent => ({
  kind: "tool",
  activityKind: "read-file",
  outcome: "completed",
  runId,
});

/** An exporter that keeps every batch, and can be told to start throwing. */
class RecordingExporter implements ObservabilityExporter {
  batches: RecordedObservabilityEvent[][] = [];
  throwOnExport = false;
  flushed: number[] = [];
  shutdowns: number[] = [];

  export(batch: readonly RecordedObservabilityEvent[]): void {
    if (this.throwOnExport) throw new Error("collector unreachable");
    this.batches.push([...batch]);
  }

  async flush(timeoutMs: number): Promise<void> {
    this.flushed.push(timeoutMs);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    this.shutdowns.push(timeoutMs);
  }

  get events(): ObservabilityEvent[] {
    return this.batches.flat().map((entry) => entry.event);
  }
}

/** Runs the drain only when the test says so, so nothing depends on timers. */
function manualScheduler(): { schedule: (drain: () => void) => void; run: () => void } {
  let pending: (() => void) | null = null;
  return {
    schedule: (drain) => {
      pending = drain;
    },
    run: () => {
      const drain = pending;
      pending = null;
      drain?.();
    },
  };
}

describe("BoundedEventQueue", () => {
  it("takes entries up to its capacity and refuses the rest", () => {
    const queue = new BoundedEventQueue(2);
    expect(queue.offer({ event: toolEvent("a"), recordedAt: 1 })).toBe(true);
    expect(queue.offer({ event: toolEvent("b"), recordedAt: 2 })).toBe(true);
    expect(queue.offer({ event: toolEvent("c"), recordedAt: 3 })).toBe(false);
    expect(queue.size).toBe(2);
  });

  it("keeps the events nearest the cause and drops the newest", () => {
    const queue = new BoundedEventQueue(2);
    queue.offer({ event: toolEvent("first"), recordedAt: 1 });
    queue.offer({ event: toolEvent("second"), recordedAt: 2 });
    queue.offer({ event: toolEvent("third"), recordedAt: 3 });
    const drained = queue.drain(9).map((entry) => entry.event.runId);
    expect(drained).toEqual([undefined, "first", "second"]);
  });

  it("reports overflow through the shared `dropped` vocabulary, at the head of the batch", () => {
    const queue = new BoundedEventQueue(1);
    queue.offer({ event: toolEvent("kept"), recordedAt: 1 });
    queue.offer({ event: toolEvent("lost"), recordedAt: 2 });
    queue.offer({ event: toolEvent("lost"), recordedAt: 3 });
    const batch = queue.drain(10);
    expect(batch[0]).toEqual({
      event: { kind: "dropped", reason: "queue-full", count: 2 },
      recordedAt: 10,
    });
    expect(batch).toHaveLength(2);
  });

  it("clears its counters once they have been handed over", () => {
    const queue = new BoundedEventQueue(1);
    queue.offer({ event: toolEvent("kept"), recordedAt: 1 });
    queue.offer({ event: toolEvent("lost"), recordedAt: 2 });
    expect(queue.drain(5)).toHaveLength(2);
    expect(queue.drain(6)).toEqual([]);
  });

  it("counts a loss that happened outside the queue under its own reason", () => {
    const queue = new BoundedEventQueue(4);
    queue.countDrop("sink-error", 3);
    queue.countDrop("sink-error", 2);
    expect(queue.drain(7)).toEqual([
      { event: { kind: "dropped", reason: "sink-error", count: 5 }, recordedAt: 7 },
    ]);
  });

  it("ignores a non-positive drop count rather than reporting a loss of nothing", () => {
    const queue = new BoundedEventQueue(4);
    queue.countDrop("sink-error", 0);
    queue.countDrop("queue-full", -1);
    expect(queue.drain(1)).toEqual([]);
  });

  it("holds at least one entry however small a capacity it is given", () => {
    const queue = new BoundedEventQueue(0);
    expect(queue.offer({ event: toolEvent("a"), recordedAt: 1 })).toBe(true);
    expect(queue.offer({ event: toolEvent("b"), recordedAt: 2 })).toBe(false);
  });

  it("defaults to a capacity sized for a burst, not for a stalled collector", () => {
    const queue = new BoundedEventQueue();
    for (let i = 0; i < DEFAULT_QUEUE_CAPACITY; i += 1) {
      expect(queue.offer({ event: toolEvent(`e${i}`), recordedAt: i })).toBe(true);
    }
    expect(queue.offer({ event: toolEvent("over"), recordedAt: 0 })).toBe(false);
  });
});

describe("QueuedObservabilitySink", () => {
  it("does not export on the caller's stack", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    sink.record(toolEvent("run-1"));
    expect(exporter.batches).toEqual([]);
    expect(sink.pending).toBe(1);
    scheduler.run();
    expect(exporter.events).toEqual([toolEvent("run-1")]);
  });

  it("stamps an event when it is recorded, not when it is drained", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const clock = [100, 250];
    const sink = new QueuedObservabilitySink({
      exporter,
      schedule: scheduler.schedule,
      now: () => clock.shift() ?? 999,
    });
    sink.record(toolEvent("run-1"));
    scheduler.run();
    expect(exporter.batches[0]?.[0]?.recordedAt).toBe(100);
  });

  it("coalesces a burst into a single scheduled drain", () => {
    const exporter = new RecordingExporter();
    const scheduled: (() => void)[] = [];
    const sink = new QueuedObservabilitySink({
      exporter,
      schedule: (drain) => void scheduled.push(drain),
    });
    for (let i = 0; i < 50; i += 1) sink.record(toolEvent(`run-${i}`));
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(exporter.batches).toHaveLength(1);
    expect(exporter.batches[0]).toHaveLength(50);
  });

  it("schedules again after a drain has run", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    sink.record(toolEvent("a"));
    scheduler.run();
    sink.record(toolEvent("b"));
    scheduler.run();
    expect(exporter.events).toEqual([toolEvent("a"), toolEvent("b")]);
  });

  it("drops rather than back-pressures when the queue is full, and reports the loss", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({
      exporter,
      capacity: 2,
      schedule: scheduler.schedule,
    });
    for (let i = 0; i < 5; i += 1) sink.record(toolEvent(`run-${i}`));
    scheduler.run();
    expect(exporter.events).toEqual([
      { kind: "dropped", reason: "queue-full", count: 3 },
      toolEvent("run-0"),
      toolEvent("run-1"),
    ]);
  });

  it("counts an exporter that throws and reports it on the next batch", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    exporter.throwOnExport = true;
    sink.record(toolEvent("lost-1"));
    sink.record(toolEvent("lost-2"));
    scheduler.run();
    expect(exporter.batches).toEqual([]);

    exporter.throwOnExport = false;
    sink.record(toolEvent("kept"));
    scheduler.run();
    expect(exporter.events).toEqual([
      { kind: "dropped", reason: "sink-error", count: 2 },
      toolEvent("kept"),
    ]);
  });

  it("never lets a throwing clock or scheduler reach the caller", () => {
    const sink = new QueuedObservabilitySink({
      exporter: new RecordingExporter(),
      now: () => {
        throw new Error("broken clock");
      },
      schedule: () => {
        throw new Error("broken scheduler");
      },
    });
    expect(() => sink.record(toolEvent("run-1"))).not.toThrow();
  });

  it("exports nothing when there is nothing waiting", () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    sink.record(toolEvent("a"));
    scheduler.run();
    // A second drain with an empty queue must not push an empty batch.
    void sink.flush(10);
    expect(exporter.batches).toHaveLength(1);
  });

  it("flushes what is waiting and passes the caller's bound to the transport", async () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    sink.record(toolEvent("pending"));
    await sink.flush(2500);
    expect(exporter.events).toEqual([toolEvent("pending")]);
    expect(exporter.flushed).toEqual([2500]);
  });

  it("drains once more on shutdown and then stops accepting", async () => {
    const exporter = new RecordingExporter();
    const scheduler = manualScheduler();
    const sink = new QueuedObservabilitySink({ exporter, schedule: scheduler.schedule });
    sink.record(toolEvent("last"));
    await sink.shutdown(1000);
    expect(exporter.events).toEqual([toolEvent("last")]);
    expect(exporter.shutdowns).toEqual([1000]);

    sink.record(toolEvent("after-close"));
    expect(sink.pending).toBe(0);
    await sink.shutdown(1000);
    expect(exporter.shutdowns).toEqual([1000]);
  });

  it("drains on a real turn of the event loop when no scheduler is injected", async () => {
    const exporter = new RecordingExporter();
    const sink = new QueuedObservabilitySink({ exporter });
    sink.record(toolEvent("run-1"));
    expect(exporter.batches).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exporter.events).toEqual([toolEvent("run-1")]);
  });
});
