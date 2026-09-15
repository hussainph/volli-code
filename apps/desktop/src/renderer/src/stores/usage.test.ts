import type { SessionUsageReport } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createUsageStore, usageKey, USAGE_WINDOW_MS, useUsageStore } from "./usage";

/** The settle signal a caller is reading under — opaque to the store. */
const SIGNAL = "ready,idle";

function report(over: Partial<SessionUsageReport> = {}): SessionUsageReport {
  return {
    total: {
      requestCount: 2,
      tokenRequestCount: 2,
      pricedRequestCount: 2,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      knownCostUsd: 1,
      costCoverage: "complete",
      costBasis: "catalog-estimate",
      cachedInputShare: 0.84,
    },
    groups: [],
    history: { meteredFrom: 0, complete: true },
    meteredSessionCount: 2,
    ...over,
  };
}

function stubReport(result: unknown) {
  const read = vi.fn().mockResolvedValue(result);
  Object.assign(globalThis, { window: { api: { sessions: { usageReport: read } } } });
  return read;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.useRealTimers();
});

describe("usageKey", () => {
  it("separates the same scope asked over different windows", () => {
    // Conflating them would show whichever landed last under whichever label
    // the surface happened to be displaying.
    const scope = { kind: "project", projectId: "p1" } as const;
    expect(usageKey(scope, 7, undefined)).not.toBe(usageKey(scope, 30, undefined));
    expect(usageKey(scope, undefined, undefined)).not.toBe(usageKey(scope, 30, undefined));
  });

  it("separates the same scope and window asked with different groupings", () => {
    const scope = { kind: "ticket", ticketId: "t1" } as const;
    expect(usageKey(scope, undefined, "model")).not.toBe(usageKey(scope, undefined, "session"));
  });

  it("distinguishes every scope arm, including two arms holding the same id", () => {
    expect(usageKey({ kind: "all" }, undefined, undefined)).toBe(
      usageKey({ kind: "all" }, undefined, undefined),
    );
    // A project and a ticket that happen to share an id string are different
    // questions, and a key that folded them would answer one with the other.
    expect(usageKey({ kind: "project", projectId: "x" }, undefined, undefined)).not.toBe(
      usageKey({ kind: "ticket", ticketId: "x" }, undefined, undefined),
    );
    expect(usageKey({ kind: "session", sessionId: "x" }, undefined, undefined)).not.toBe(
      usageKey({ kind: "ticket", ticketId: "x" }, undefined, undefined),
    );
  });
});

describe("refresh", () => {
  it("holds the report main answered with, tagged with the signal it was read under", async () => {
    stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "ready",
      report: report(),
      signal: SIGNAL,
    });
  });

  // A rollup that cannot be read is a block that does not appear — the error is
  // kept on the entry rather than toasted, because a toast about SQLite over a
  // rail someone is working in would be the loudest thing on screen for the
  // least useful reason.
  it("records main's refusal on the entry", async () => {
    stubReport({ ok: false, error: "projection unavailable" });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "error",
      error: "projection unavailable",
    });
  });

  it("records a thrown bridge failure on the same arm", async () => {
    const read = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { sessions: { usageReport: read } } } });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "error",
      error: "bridge gone",
    });
  });

  it("announces loading only on the FIRST read, so a figure never blinks out", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();
    const key = usageKey({ kind: "all" }, undefined, undefined);

    const first = store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);
    expect(store.getState().byQuery[key]).toEqual({ status: "loading" });
    await first;

    // A settled turn moves the signal, so the second read happens while the
    // figure already on screen holds its place.
    const second = store.getState().refresh({ scope: { kind: "all" } }, "ready,working");
    expect(store.getState().byQuery[key]).toEqual({
      status: "ready",
      report: report(),
      signal: SIGNAL,
    });
    await second;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between callers that collide on a frame", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await Promise.all([
      store.getState().refresh({ scope: { kind: "all" } }, SIGNAL),
      store.getState().refresh({ scope: { kind: "all" } }, SIGNAL),
      store.getState().refresh({ scope: { kind: "all" } }, SIGNAL),
    ]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("resolves the window's lower bound at read time, not when a caller was built", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" }, windowMs: 1000 }, SIGNAL);
    expect(read).toHaveBeenCalledWith({
      scope: { kind: "all" },
      sinceMs: Date.parse("2026-08-01T00:00:00Z") - 1000,
      groupBy: undefined,
    });

    // A rolling window moves with the clock; a bound captured at mount would
    // quietly age as the app stayed open. (A moved signal, so the second read
    // is not skipped as current.)
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    await store.getState().refresh({ scope: { kind: "all" }, windowMs: 1000 }, "ready,working");
    expect(read).toHaveBeenLastCalledWith({
      scope: { kind: "all" },
      sinceMs: Date.parse("2026-08-02T00:00:00Z") - 1000,
      groupBy: undefined,
    });
  });

  it("sends no lower bound at all for the lifetime window", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" }, windowMs: undefined }, SIGNAL);

    expect(read).toHaveBeenCalledWith({
      scope: { kind: "all" },
      sinceMs: undefined,
      groupBy: undefined,
    });
  });

  it("passes the grouping through", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store
      .getState()
      .refresh({ scope: { kind: "ticket", ticketId: "t1" }, groupBy: "model" }, SIGNAL);

    expect(read).toHaveBeenCalledWith({
      scope: { kind: "ticket", ticketId: "t1" },
      sinceMs: undefined,
      groupBy: "model",
    });
  });
});

/**
 * What the settle signal buys (VC-373): a cached answer still under the signal
 * it was read at IS the answer — usage only moves on a settle, and a settle
 * moves the signal — so a rail flip that nothing settled behind repaints
 * without an indexed read. A signal that moved re-reads while keeping the old
 * figure on screen, and a failure is never cached.
 */
describe("the settle signal", () => {
  it("answers from cache when the signal has not moved", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);
    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("re-reads the question as soon as the signal moves", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);
    await store.getState().refresh({ scope: { kind: "all" } }, "ready,working,idle");

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous answer on screen while a moved-signal read is in flight", async () => {
    const first = report({ meteredSessionCount: 1 });
    const second = report({ meteredSessionCount: 2 });
    // A deferred so the second read can be held open while the store is
    // inspected mid-flight; that in-flight moment is the whole assertion.
    let release: ((value: unknown) => void) | undefined;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, report: first })
      .mockImplementationOnce(() => held);
    Object.assign(globalThis, { window: { api: { sessions: { usageReport: read } } } });
    const store = createUsageStore();
    const key = usageKey({ kind: "all" }, undefined, undefined);

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);
    const second_read = store.getState().refresh({ scope: { kind: "all" } }, "ready,working,idle");

    // Not "loading": the old figure holds the space until the new one lands.
    expect(store.getState().byQuery[key]).toEqual({
      status: "ready",
      report: first,
      signal: SIGNAL,
    });
    release!({ ok: true, report: second });
    await second_read;
    expect(store.getState().byQuery[key]).toEqual({
      status: "ready",
      report: second,
      signal: "ready,working,idle",
    });
  });

  it("retries a question that failed, rather than caching the failure", async () => {
    const read = stubReport({ ok: false, error: "nope" });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);
    await store.getState().refresh({ scope: { kind: "all" } }, SIGNAL);

    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("USAGE_WINDOW_MS", () => {
  it("maps the offered windows, with lifetime as an absent bound", () => {
    expect(USAGE_WINDOW_MS["7d"]).toBe(7 * 24 * 60 * 60 * 1000);
    expect(USAGE_WINDOW_MS["30d"]).toBe(30 * 24 * 60 * 60 * 1000);
    // Not a very old timestamp: picking an epoch to stand for "forever" would
    // silently drop whatever happened before it.
    expect(USAGE_WINDOW_MS.all).toBeUndefined();
  });
});

describe("the shared instance", () => {
  it("is a store", () => {
    expect(typeof useUsageStore.getState().refresh).toBe("function");
  });
});
