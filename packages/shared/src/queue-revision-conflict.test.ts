import { describe, expect, it } from "vite-plus/test";
import {
  QUEUE_REVISION_CONFLICT,
  QueueRevisionConflictError,
  isQueueRevisionConflict,
} from "./queue-revision-conflict";

describe("the queue revision conflict brand", () => {
  it("recognizes only a branded stale mutation across module copies", () => {
    class StaleQueue extends Error {
      readonly [QUEUE_REVISION_CONFLICT] = true as const;
    }
    const error = new QueueRevisionConflictError(1, 2);
    expect(error).toMatchObject({
      name: "QueueRevisionConflictError",
      expectedRevision: 1,
      currentRevision: 2,
      message: "Queue revision changed: expected 1, current 2",
    });
    expect(isQueueRevisionConflict(error)).toBe(true);
    expect(isQueueRevisionConflict(new StaleQueue("stale"))).toBe(true);
    expect(isQueueRevisionConflict({ [QUEUE_REVISION_CONFLICT]: true })).toBe(true);
    expect(QUEUE_REVISION_CONFLICT).toBe(Symbol.for("@volli/queue-revision-conflict"));
    for (const value of [
      null,
      "stale",
      new Error("stale"),
      {},
      { [QUEUE_REVISION_CONFLICT]: false },
    ]) {
      expect(isQueueRevisionConflict(value)).toBe(false);
    }
  });
});
