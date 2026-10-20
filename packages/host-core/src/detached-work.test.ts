/** The host's detached-work drain: settlement-ordered, never early, never failing. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDetachedWorkTracker } from "./detached-work";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Runs every queued microtask and continuation; a turn of the loop, not a timer. */
function settleQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDetachedWorkTracker", () => {
  it("drains at once when nothing is enrolled", async () => {
    const tracker = createDetachedWorkTracker();
    expect(tracker.pending).toBe(0);
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("holds the drain until enrolled work settles, and forgets it afterwards", async () => {
    const tracker = createDetachedWorkTracker();
    const work = deferred();
    const events: string[] = [];
    tracker.track(work.promise.then(() => void events.push("work settled")));
    expect(tracker.pending).toBe(1);
    const drained = tracker.drain().then(() => void events.push("drained"));
    await settleQueue();
    expect(events).toEqual([]);
    expect(tracker.pending).toBe(1);
    work.resolve();
    await drained;
    expect(events).toEqual(["work settled", "drained"]);
    expect(tracker.pending).toBe(0);
  });

  it("waits for work enrolled while the drain is waiting, from inside or outside the work", async () => {
    const tracker = createDetachedWorkTracker();
    const first = deferred();
    const outside = deferred();
    const follow = deferred();
    const events: string[] = [];
    tracker.track(
      first.promise.then(() => {
        events.push("first settled");
        // A continuation that starts more detached work as it finishes.
        tracker.track(follow.promise.then(() => void events.push("follow-up settled")));
      }),
    );
    const drained = tracker.drain().then(() => void events.push("drained"));
    tracker.track(outside.promise.then(() => void events.push("outside settled")));
    expect(tracker.pending).toBe(2);
    first.resolve();
    await settleQueue();
    expect(events).toEqual(["first settled"]);
    expect(tracker.pending).toBe(2);
    outside.resolve();
    await settleQueue();
    expect(events).toEqual(["first settled", "outside settled"]);
    follow.resolve();
    await drained;
    expect(events).toEqual(["first settled", "outside settled", "follow-up settled", "drained"]);
    expect(tracker.pending).toBe(0);
  });

  it("settles every concurrent drain together and stays usable after one", async () => {
    const tracker = createDetachedWorkTracker();
    const work = deferred();
    tracker.track(work.promise);
    const events: string[] = [];
    const a = tracker.drain().then(() => void events.push("a"));
    const b = tracker.drain().then(() => void events.push("b"));
    await settleQueue();
    expect(events).toEqual([]);
    work.resolve();
    await Promise.all([a, b]);
    expect(events.toSorted()).toEqual(["a", "b"]);

    const later = deferred();
    tracker.track(later.promise);
    expect(tracker.pending).toBe(1);
    const again = tracker.drain().then(() => void events.push("again"));
    await settleQueue();
    expect(events).not.toContain("again");
    later.resolve();
    await again;
    expect(tracker.pending).toBe(0);
  });

  it("reports a rejection the work left unhandled, without failing the drain", async () => {
    const reportFailure = vi.fn();
    const tracker = createDetachedWorkTracker({ reportFailure });
    const work = deferred();
    const failure = new Error("unhandled");
    tracker.track(work.promise);
    const drained = tracker.drain();
    work.reject(failure);
    await expect(drained).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(tracker.pending).toBe(0);
  });

  it("logs an unhandled rejection by default", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tracker = createDetachedWorkTracker();
    const failure = new Error("unhandled");
    tracker.track(Promise.reject(failure));
    await tracker.drain();
    expect(log).toHaveBeenCalledExactlyOnceWith("[detached-work] detached work failed", {
      error: expect.objectContaining({ name: "Error", message: "unhandled" }),
    });
  });

  it("keeps a throwing failure reporter from failing the drain", async () => {
    const tracker = createDetachedWorkTracker({
      reportFailure: () => {
        throw new Error("reporter broke");
      },
    });
    const work = deferred();
    tracker.track(work.promise);
    const drained = tracker.drain();
    work.reject(new Error("unhandled"));
    await expect(drained).resolves.toBeUndefined();
    expect(tracker.pending).toBe(0);
  });
});
