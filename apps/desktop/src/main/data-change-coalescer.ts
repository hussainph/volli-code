/**
 * Folding a burst of invalidations into one.
 *
 * Every `broadcastDataChanged` receipt costs the renderer a full
 * `refreshPlanningData()` bootstrap out of SQLite, and roughly fifteen mutation
 * sites call it — several of them inside one synchronous handler. Fifteen
 * notices do not make the answer fifteen times fresher; they start fifteen
 * competing recovery reads, and they arrive exactly when the machine is
 * busiest. One conservatively merged notice preserves the same recovery
 * guarantee.
 *
 * A FACTORY OVER A SINK, on `pty/output.ts`'s pattern, and the shape is the
 * decision rather than a flourish. A process-global window is fine only while
 * there is exactly one consumer; the moment a second subscriber exists — a
 * remote Session client, a second window with its own cadence — one global
 * timer folds one consumer's burst into another consumer's latency, and no
 * amount of tuning makes a shared window per-connection. Each coalescer owns
 * its own pending scope and its own timer, and `broadcast.ts` holds the one
 * whose sink is "every live BrowserWindow".
 *
 * What it deliberately does NOT copy from `output.ts` is the ack-based flow
 * control. That pipeline carries unbounded bytes, so a fast producer can queue
 * IPC faster than a renderer can drain it. This one carries a fixed-size notice
 * whose merge is idempotent: the queue can never hold more than one, so the
 * coalescing IS the backpressure.
 *
 * No Electron import here on purpose — the fan-out is the caller's sink, which
 * is what lets this file be a plain unit under the coverage gate.
 */
import type { DataChangedEvent } from "../ipc/contract";

/**
 * One half-frame at 60Hz: long enough to fold a synchronous mutation burst into
 * one recovery read, short enough that a socket-originated change still appears
 * in the next painted frame. The same window `pty/output.ts` uses to turn raw
 * chunks into one IPC send.
 */
export const DATA_CHANGED_BATCH_WINDOW_MS = 8;

/** The best scope a caller can name; `entity` is stamped by the fan-out. */
export type DataChangeScope = Omit<DataChangedEvent, "entity">;

/** Where a coalesced invalidation is delivered. */
export interface DataChangeSink {
  send(change: DataChangeScope): void;
}

export interface DataChangeCoalescer {
  /** Queue an invalidation toward the next flush, merging it with any pending one. */
  queue(change: DataChangeScope): void;
  /** Deliver the pending invalidation now, if there is one. Idempotent. */
  flush(): void;
  /**
   * Drop the pending invalidation and its timer WITHOUT delivering. Idempotent.
   * Teardown and test isolation; a caller that wants the notice calls `flush`.
   */
  dispose(): void;
}

/**
 * Merge two invalidations without ever claiming a scope narrower than either
 * input. A missing or different ticket/project becomes untargeted, so every
 * relevant surface refreshes. `worktree` is the one load-bearing kind: it
 * invalidates cached venue readings, so it survives a mixed-kind batch even at
 * the cost of one harmless extra venue refresh. Other mixed kinds may collapse
 * to no hint, because every reader already re-hydrates the board wholesale.
 */
export function mergeDataChange(current: DataChangeScope, next: DataChangeScope): DataChangeScope {
  const ticketId =
    current.ticketId !== undefined && current.ticketId === next.ticketId
      ? current.ticketId
      : undefined;
  const projectId =
    current.projectId !== undefined && current.projectId === next.projectId
      ? current.projectId
      : undefined;
  const kind =
    current.kind === "worktree" || next.kind === "worktree"
      ? "worktree"
      : current.kind !== undefined && current.kind === next.kind
        ? current.kind
        : undefined;
  return {
    ...(ticketId === undefined ? {} : { ticketId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(kind === undefined ? {} : { kind }),
  };
}

/** Builds one coalescing window over `sink`. All of its state lives in this closure. */
export function createDataChangeCoalescer(sink: DataChangeSink): DataChangeCoalescer {
  let pending: DataChangeScope | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = (): void => {
    clearTimer();
    const change = pending;
    pending = null;
    if (change === null) return;
    // AFTER the queue is cleared: a sink that mutates and re-enters must queue
    // a fresh window rather than land inside the one being drained.
    sink.send(change);
  };

  return {
    queue(change: DataChangeScope): void {
      // The pending scope, not the timer handle, is what says a window is open.
      // A handle is only ever evidence of a scheduling attempt: a test that
      // swaps its fake clock for a real one leaves one behind that can never
      // fire, and trusting it would silently swallow the next invalidation.
      const open = pending;
      if (open !== null) {
        pending = mergeDataChange(open, change);
        return;
      }
      pending = { ...change };
      clearTimer();
      timer = setTimeout(flush, DATA_CHANGED_BATCH_WINDOW_MS);
    },
    flush,
    dispose(): void {
      clearTimer();
      pending = null;
    },
  };
}
