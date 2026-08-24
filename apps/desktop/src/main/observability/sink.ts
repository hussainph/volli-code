/**
 * The bounded seam between an agent turn and an exporter (VC-119, Phase 2).
 *
 * Phase 1 proved a sink cannot break a run. This is what keeps that true once a
 * sink starts doing real work: `record()` puts one event into a fixed-size
 * queue and returns, and every expensive thing — mapping, span construction,
 * HTTP — happens later, on a scheduled turn of the event loop, with no path
 * back to the caller.
 *
 * **A full queue drops, and says so.** The alternative is back-pressure, which
 * on this path means a model stream or a tool call waiting on a collector. The
 * loss is not silent: it is counted and reported through the `dropped` event the
 * shared vocabulary already reserves for exactly this.
 *
 * **The drop report itself cannot be dropped.** Counters live outside the queue
 * and are converted into events at the head of the next batch, so the one
 * measurement that explains a gap is the one measurement guaranteed to survive
 * it.
 *
 * **Nothing here rejects.** `record()` catches everything, including a throwing
 * clock and a throwing exporter; the drain is scheduled with no promise anybody
 * holds. The only thing a failure can cost is a measurement.
 */

import type { DroppedEvent, ObservabilityEvent, ObservabilitySink } from "@volli/shared";

/**
 * One event and when it was seen.
 *
 * The timestamp is taken in `record()`, not at drain: an event's duration is
 * measured backwards from the moment it settled, and stamping it after a queue
 * wait would shift every span by however long the queue was busy.
 */
export interface RecordedObservabilityEvent {
  readonly event: ObservabilityEvent;
  readonly recordedAt: number;
}

/** Where a drained batch goes. Implemented by the OTLP adapter, faked in tests. */
export interface ObservabilityExporter {
  /**
   * Hand a batch onward without blocking. Called off the agent path and never
   * awaited; a throw is caught by the sink and counted as a `sink-error` drop.
   */
  export(batch: readonly RecordedObservabilityEvent[]): void;
  /** Push whatever is buffered downstream, giving up after `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
  /** Release the transport. Called once, during controlled shutdown. */
  shutdown(timeoutMs: number): Promise<void>;
}

/**
 * How many events may wait at once.
 *
 * Sized for the burst a single busy turn produces (one attempt envelope, a
 * handful of tool events, a turn) multiplied by the Sessions a person actually
 * runs at once, with room to spare — a queue this deep only fills when the
 * exporter has stopped draining entirely, which is precisely when dropping is
 * the correct answer.
 */
export const DEFAULT_QUEUE_CAPACITY = 1024;

/**
 * A fixed-size FIFO that counts what it could not hold.
 *
 * Drop-newest rather than drop-oldest: when a collector has stalled, the events
 * already queued are the ones nearest the cause, and evicting them to make room
 * for later ones would throw away the evidence.
 */
export class BoundedEventQueue {
  readonly #capacity: number;
  #entries: RecordedObservabilityEvent[] = [];
  #dropped = new Map<DroppedEvent["reason"], number>();

  constructor(capacity: number = DEFAULT_QUEUE_CAPACITY) {
    this.#capacity = Math.max(1, Math.trunc(capacity));
  }

  get size(): number {
    return this.#entries.length;
  }

  /** True when the entry was taken; false when the queue was already full. */
  offer(entry: RecordedObservabilityEvent): boolean {
    if (this.#entries.length >= this.#capacity) {
      this.countDrop("queue-full", 1);
      return false;
    }
    this.#entries.push(entry);
    return true;
  }

  /** Records a loss that happened outside the queue — an exporter that threw. */
  countDrop(reason: DroppedEvent["reason"], count: number): void {
    if (count <= 0) return;
    this.#dropped.set(reason, (this.#dropped.get(reason) ?? 0) + count);
  }

  /**
   * Everything waiting, with the drop reports first.
   *
   * Reports lead the batch so a reader meets the explanation before the gap it
   * explains, and the counters are cleared by the same call that hands them
   * over — a batch that then fails to export re-counts its own loss as
   * `sink-error` rather than double-counting the original reason.
   */
  drain(recordedAt: number): readonly RecordedObservabilityEvent[] {
    const reports = [...this.#dropped].map(
      ([reason, count]): RecordedObservabilityEvent => ({
        event: { kind: "dropped", reason, count },
        recordedAt,
      }),
    );
    this.#dropped = new Map();
    const entries = this.#entries;
    this.#entries = [];
    return [...reports, ...entries];
  }
}

/** Schedules the drain off the caller's stack. Injected so tests need no timers. */
export type DrainScheduler = (drain: () => void) => void;

export interface QueuedObservabilitySinkOptions {
  exporter: ObservabilityExporter;
  capacity?: number;
  now?: () => number;
  /**
   * Defaults to `setImmediate`, which is the first point after the current
   * stack unwinds and after any pending I/O callback — later than a microtask
   * on purpose, so a drain can never run inside the turn that queued it.
   */
  schedule?: DrainScheduler;
}

/**
 * The sink an attachment is handed when export is on.
 *
 * One drain is in flight at a time: `record()` schedules only when nothing is
 * already scheduled, so a burst of two hundred events costs one scheduled
 * callback rather than two hundred.
 */
export class QueuedObservabilitySink implements ObservabilitySink {
  readonly #queue: BoundedEventQueue;
  readonly #exporter: ObservabilityExporter;
  readonly #now: () => number;
  readonly #schedule: DrainScheduler;
  #drainScheduled = false;
  #closed = false;

  constructor(options: QueuedObservabilitySinkOptions) {
    this.#queue = new BoundedEventQueue(options.capacity);
    this.#exporter = options.exporter;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? ((drain) => void setImmediate(drain));
  }

  /**
   * The agent path's only entry point, and the only method that must be fast.
   *
   * Everything is inside one `try`: a clock that throws, a queue that throws,
   * and a scheduler that refuses all cost the measurement and nothing else.
   * There is no rethrow and no return value, because the caller — a tee inside
   * the runtime's ordered delivery queue — has nothing it could usefully do
   * with either.
   */
  record(event: ObservabilityEvent): void {
    if (this.#closed) return;
    try {
      this.#queue.offer({ event, recordedAt: this.#now() });
      this.#scheduleDrain();
    } catch {
      // A lost measurement, never a lost turn.
    }
  }

  /**
   * Push everything waiting and wait for the transport, up to `timeoutMs`.
   *
   * The only method that returns a promise anybody awaits, and it is called from
   * exactly one place: controlled app shutdown. Nothing on the agent path may
   * call it, which is why it is not part of {@link ObservabilitySink}.
   */
  async flush(timeoutMs: number): Promise<void> {
    this.#drain();
    await this.#exporter.flush(timeoutMs);
  }

  /**
   * Last drain, then release the transport. The sink stops accepting first, so
   * an event recorded by a Session still closing behind us cannot re-fill a
   * queue nothing will drain again.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#drain();
    await this.#exporter.shutdown(timeoutMs);
  }

  /** Test seam: how many events are waiting, and nothing else. */
  get pending(): number {
    return this.#queue.size;
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    this.#schedule(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  /**
   * Hand one batch to the exporter.
   *
   * An exporter that throws costs the batch, and the loss is counted under
   * `sink-error` so the next batch reports it. Re-queueing instead would turn a
   * broken collector into an ever-growing retry list, which is the back-pressure
   * this whole module exists to avoid.
   */
  #drain(): void {
    let batch: readonly RecordedObservabilityEvent[] = [];
    try {
      batch = this.#queue.drain(this.#now());
      if (batch.length === 0) return;
      this.#exporter.export(batch);
    } catch {
      this.#queue.countDrop("sink-error", batch.length);
    }
  }
}
