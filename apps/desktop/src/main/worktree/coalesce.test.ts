import { describe, expect, it } from "vite-plus/test";

import { createCoalescer } from "./coalesce";

/** A task whose completion the test controls, counting how often it started. */
function controllable() {
  const resolvers: ((value: string) => void)[] = [];
  const rejecters: ((error: Error) => void)[] = [];
  let starts = 0;
  const task = () => {
    starts += 1;
    return new Promise<string>((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
  };
  return {
    task,
    starts: () => starts,
    settle: (index: number, value: string) => resolvers[index]?.(value),
    fail: (index: number, error: Error) => rejecters[index]?.(error),
  };
}

/** Lets every already-queued microtask drain. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createCoalescer", () => {
  it("runs a single task per key while one is in flight", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const first = coalesce("t1", work.task);
    coalesce("t1", work.task);
    coalesce("t1", work.task);
    expect(work.starts()).toBe(1);

    work.settle(0, "a");
    expect(await first).toBe("a");
  });

  it("gives mid-flight callers a fresh follow-up run, not the stale result", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const first = coalesce("t1", work.task);
    const second = coalesce("t1", work.task);
    const third = coalesce("t1", work.task);

    work.settle(0, "stale");
    expect(await first).toBe("stale");
    await flush();

    // Exactly one follow-up, shared by both late callers.
    expect(work.starts()).toBe(2);
    work.settle(1, "fresh");
    expect(await second).toBe("fresh");
    expect(await third).toBe("fresh");
  });

  it("keys are independent", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const a = coalesce("t1", work.task);
    const b = coalesce("t2", work.task);
    expect(work.starts()).toBe(2);

    work.settle(0, "a");
    work.settle(1, "b");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  it("propagates a failure to its own caller and still runs the follow-up", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const first = coalesce("t1", work.task);
    const second = coalesce("t1", work.task);

    work.fail(0, new Error("git exploded"));
    await expect(first).rejects.toThrow("git exploded");
    await flush();

    expect(work.starts()).toBe(2);
    work.settle(1, "recovered");
    expect(await second).toBe("recovered");
  });

  it("starts a fresh run once the key has fully drained", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const first = coalesce("t1", work.task);
    work.settle(0, "a");
    await first;
    await flush();

    const later = coalesce("t1", work.task);
    expect(work.starts()).toBe(2);
    work.settle(1, "b");
    expect(await later).toBe("b");
  });
});
