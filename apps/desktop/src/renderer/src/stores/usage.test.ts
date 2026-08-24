import type { SessionUsageReport } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createUsageStore, usageKey, USAGE_WINDOW_MS, useUsageStore } from "./usage";

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
  it("holds the report main answered with", async () => {
    stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } });

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "ready",
      report: report(),
    });
  });

  // A rollup that cannot be read is a block that does not appear — the error is
  // kept on the entry rather than toasted, because a toast about SQLite over a
  // rail someone is working in would be the loudest thing on screen for the
  // least useful reason.
  it("records main's refusal on the entry", async () => {
    stubReport({ ok: false, error: "projection unavailable" });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } });

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "error",
      error: "projection unavailable",
    });
  });

  it("records a thrown bridge failure on the same arm", async () => {
    const read = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { sessions: { usageReport: read } } } });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" } });

    expect(store.getState().byQuery[usageKey({ kind: "all" }, undefined, undefined)]).toEqual({
      status: "error",
      error: "bridge gone",
    });
  });

  it("announces loading only on the FIRST read, so a figure never blinks out", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();
    const key = usageKey({ kind: "all" }, undefined, undefined);

    const first = store.getState().refresh({ scope: { kind: "all" } });
    expect(store.getState().byQuery[key]).toEqual({ status: "loading" });
    await first;

    // The second read leaves the figure already on screen in place.
    const second = store.getState().refresh({ scope: { kind: "all" } });
    expect(store.getState().byQuery[key]).toEqual({ status: "ready", report: report() });
    await second;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between callers that collide on a frame", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await Promise.all([
      store.getState().refresh({ scope: { kind: "all" } }),
      store.getState().refresh({ scope: { kind: "all" } }),
      store.getState().refresh({ scope: { kind: "all" } }),
    ]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("resolves the window's lower bound at read time, not when a caller was built", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" }, windowMs: 1000 });
    expect(read).toHaveBeenCalledWith({
      scope: { kind: "all" },
      sinceMs: Date.parse("2026-08-01T00:00:00Z") - 1000,
      groupBy: undefined,
    });

    // A rolling window moves with the clock; a bound captured at mount would
    // quietly age as the app stayed open.
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    await store.getState().refresh({ scope: { kind: "all" }, windowMs: 1000 });
    expect(read).toHaveBeenLastCalledWith({
      scope: { kind: "all" },
      sinceMs: Date.parse("2026-08-02T00:00:00Z") - 1000,
      groupBy: undefined,
    });
  });

  it("sends no lower bound at all for the lifetime window", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "all" }, windowMs: undefined });

    expect(read).toHaveBeenCalledWith({
      scope: { kind: "all" },
      sinceMs: undefined,
      groupBy: undefined,
    });
  });

  it("passes the grouping through", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().refresh({ scope: { kind: "ticket", ticketId: "t1" }, groupBy: "model" });

    expect(read).toHaveBeenCalledWith({
      scope: { kind: "ticket", ticketId: "t1" },
      sinceMs: undefined,
      groupBy: "model",
    });
  });
});

describe("ensure", () => {
  it("reads once and then answers from cache", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().ensure({ scope: { kind: "all" } });
    await store.getState().ensure({ scope: { kind: "all" } });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("still reads a different question", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().ensure({ scope: { kind: "all" } });
    await store.getState().ensure({ scope: { kind: "project", projectId: "p1" } });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a question that already failed until something invalidates it", async () => {
    const read = stubReport({ ok: false, error: "nope" });
    const store = createUsageStore();

    await store.getState().ensure({ scope: { kind: "all" } });
    await store.getState().ensure({ scope: { kind: "all" } });

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("invalidate", () => {
  it("drops every cached answer so the next ensure re-reads", async () => {
    const read = stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().ensure({ scope: { kind: "all" } });
    store.getState().invalidate();
    expect(store.getState().byQuery).toEqual({});

    await store.getState().ensure({ scope: { kind: "all" } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clears wholesale, because one settled turn moves three scopes at once", async () => {
    stubReport({ ok: true, report: report() });
    const store = createUsageStore();

    await store.getState().ensure({ scope: { kind: "all" } });
    await store.getState().ensure({ scope: { kind: "project", projectId: "p1" } });
    store.getState().invalidate();

    expect(store.getState().byQuery).toEqual({});
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
    expect(typeof useUsageStore.getState().ensure).toBe("function");
  });
});
