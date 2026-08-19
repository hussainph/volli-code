import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createSessionStartsStore, useSessionStartsStore } from "./session-starts";

function stubStarts(result: unknown) {
  const starts = vi.fn().mockResolvedValue(result);
  Object.assign(globalThis, { window: { api: { sessions: { starts } } } });
  return starts;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("refresh", () => {
  it("holds the stamps main answered with", async () => {
    const starts = stubStarts({ ok: true, startedAt: [10, 20, 30] });
    const store = createSessionStartsStore();

    await store.getState().refresh(5);

    expect(starts).toHaveBeenCalledWith(5);
    expect(store.getState()).toMatchObject({ startedAt: [10, 20, 30], error: null });
  });

  it("clears an earlier failure once a read succeeds", async () => {
    const starts = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "db closed" })
      .mockResolvedValueOnce({ ok: true, startedAt: [1] });
    Object.assign(globalThis, { window: { api: { sessions: { starts } } } });
    const store = createSessionStartsStore();

    await store.getState().refresh(0);
    expect(store.getState().error).toBe("db closed");

    await store.getState().refresh(0);
    expect(store.getState()).toMatchObject({ startedAt: [1], error: null });
  });

  it("keeps the stamps it already has when a later read is refused", async () => {
    const starts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, startedAt: [1, 2] })
      .mockResolvedValueOnce({ ok: false, error: "db closed" });
    Object.assign(globalThis, { window: { api: { sessions: { starts } } } });
    const store = createSessionStartsStore();

    await store.getState().refresh(0);
    await store.getState().refresh(0);

    // The grid on screen is still the truest thing anyone has.
    expect(store.getState()).toMatchObject({ startedAt: [1, 2], error: "db closed" });
  });

  it("treats a thrown read the same way as a refused one", async () => {
    const starts = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { sessions: { starts } } } });
    const store = createSessionStartsStore();

    await store.getState().refresh(0);

    expect(store.getState()).toMatchObject({ startedAt: undefined, error: "bridge gone" });
  });

  it("folds concurrent reads into one", async () => {
    const starts = stubStarts({ ok: true, startedAt: [7] });
    const store = createSessionStartsStore();

    await Promise.all([store.getState().refresh(0), store.getState().refresh(0)]);

    expect(starts).toHaveBeenCalledTimes(1);
  });

  it("reads again on the next mount — a cached window would miss the Session just started", async () => {
    const starts = stubStarts({ ok: true, startedAt: [7] });
    const store = createSessionStartsStore();

    await store.getState().refresh(0);
    await store.getState().refresh(0);

    expect(starts).toHaveBeenCalledTimes(2);
  });
});

describe("the app-wide singleton", () => {
  it("starts with nothing read", () => {
    expect(useSessionStartsStore.getState()).toMatchObject({ startedAt: undefined, error: null });
  });
});
