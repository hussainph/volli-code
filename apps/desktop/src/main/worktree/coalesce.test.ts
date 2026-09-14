import { describe, expect, it } from "vite-plus/test";

import { WATCH_DEBOUNCE_MS } from "./change-set-watch";
import { createCoalescer, RAIL_READ_SHARE_WINDOW_MS } from "./coalesce";

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

/**
 * The mount-burst rule (VC-369). Two rail surfaces asking for the same ticket's
 * status in the same frame are reacting to ONE event, so the second must share
 * the first's run rather than queue a second full spawn set behind it.
 */
describe("createCoalescer with a share window", () => {
  it("shares one in-flight run with callers arriving inside the window", async () => {
    let now = 1_000;
    const coalesce = createCoalescer({ shareWindowMs: 50, now: () => now });
    const work = controllable();

    const first = coalesce("t1", work.task);
    now += 5; // the second rail surface mounts a few ms later
    const second = coalesce("t1", work.task);

    expect(work.starts()).toBe(1);
    work.settle(0, "one read");
    expect(await first).toBe("one read");
    expect(await second).toBe("one read");
  });

  it("still gives a caller past the window a fresh run", async () => {
    let now = 1_000;
    const coalesce = createCoalescer({ shareWindowMs: 50, now: () => now });
    const work = controllable();

    const first = coalesce("t1", work.task);
    now += 300; // a debounced watch event, well past the window
    const second = coalesce("t1", work.task);

    work.settle(0, "stale");
    expect(await first).toBe("stale");
    await flush();

    expect(work.starts()).toBe(2);
    work.settle(1, "fresh");
    expect(await second).toBe("fresh");
  });

  /**
   * The invariant the whole share window rests on. A caller reacting to a
   * filesystem change cannot arrive until its burst has cleared the watch
   * debounce, so it must never land inside the window — which is only true
   * while the window stays well under the debounce. If someone lowers the
   * debounce (or widens the window), sharing could start handing a
   * change-driven caller a run that began BEFORE the change it is reacting to,
   * and this is the assertion that stops that landing silently.
   */
  it("keeps the rail window far below the watch debounce that makes it safe", () => {
    expect(RAIL_READ_SHARE_WINDOW_MS).toBeGreaterThan(0);
    expect(RAIL_READ_SHARE_WINDOW_MS * 4).toBeLessThanOrEqual(WATCH_DEBOUNCE_MS);
  });

  it("defaults to no window, so the Change Set rule is unchanged", async () => {
    const coalesce = createCoalescer();
    const work = controllable();

    const first = coalesce("t1", work.task);
    const second = coalesce("t1", work.task);

    work.settle(0, "stale");
    expect(await first).toBe("stale");
    await flush();
    expect(work.starts()).toBe(2);
    work.settle(1, "fresh");
    expect(await second).toBe("fresh");
  });
});
