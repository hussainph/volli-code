/** A stale queue mutation, recognizable across ledger and protocol boundaries. */
export const QUEUE_REVISION_CONFLICT: unique symbol = Symbol.for("@volli/queue-revision-conflict");

export interface QueueRevisionConflict {
  readonly [QUEUE_REVISION_CONFLICT]: true;
}

export class QueueRevisionConflictError extends Error implements QueueRevisionConflict {
  readonly [QUEUE_REVISION_CONFLICT] = true as const;

  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(`Queue revision changed: expected ${expectedRevision}, current ${currentRevision}`);
    this.name = "QueueRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

export function isQueueRevisionConflict(value: unknown): value is QueueRevisionConflict {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<QueueRevisionConflict>)[QUEUE_REVISION_CONFLICT] === true
  );
}
