import type { VenueSnapshot } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createVenueStore, useVenueStore, venueKey } from "./venue";

function snapshot(over: Partial<VenueSnapshot> = {}): VenueSnapshot {
  return {
    kind: "worktree",
    path: "/worktrees/VC-81",
    branch: "volli/VC-81-auto-title",
    files: { committed: 4, modified: 2, added: 1, untracked: 3 },
    diff: { added: 214, removed: 63, base: "main" },
    ...over,
  };
}

function stubSnapshot(result: unknown) {
  const read = vi.fn().mockResolvedValue(result);
  Object.assign(globalThis, { window: { api: { venue: { snapshot: read } } } });
  return read;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("venueKey", () => {
  it("keys by scope, so every Session in one tree shares a reading", () => {
    expect(venueKey("p1", "t1")).toBe(venueKey("p1", "t1"));
    expect(venueKey("p1", null)).not.toBe(venueKey("p1", "t1"));
    expect(venueKey("p1", null)).not.toBe(venueKey("p2", null));
  });
});

describe("refresh", () => {
  it("holds the reading main answered with", async () => {
    stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await store.getState().refresh("p1", "t1");

    expect(store.getState().byScope[venueKey("p1", "t1")]).toEqual({
      status: "ready",
      venue: snapshot(),
    });
  });

  it("announces the first read as loading, so a surface can wait rather than guess", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const read = vi.fn().mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );
    Object.assign(globalThis, { window: { api: { venue: { snapshot: read } } } });
    const store = createVenueStore();

    const pending = store.getState().refresh("p1", null);
    expect(store.getState().byScope[venueKey("p1", null)]).toEqual({ status: "loading" });

    resolve?.({ ok: true, venue: snapshot({ kind: "main-checkout", diff: null }) });
    await pending;
    expect(store.getState().byScope[venueKey("p1", null)]).toMatchObject({ status: "ready" });
  });

  it("keeps the reading on screen while a later one is in flight", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, venue: snapshot() })
      .mockImplementationOnce(() => new Promise(() => {}));
    Object.assign(globalThis, { window: { api: { venue: { snapshot: read } } } });
    const store = createVenueStore();

    await store.getState().refresh("p1", "t1");
    void store.getState().refresh("p1", "t1");

    // No blink back to `loading`: the drawing would vanish and return identical.
    expect(store.getState().byScope[venueKey("p1", "t1")]).toMatchObject({ status: "ready" });
  });

  it("folds two surfaces reading one scope on the same frame into a single read", async () => {
    const read = stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await Promise.all([store.getState().refresh("p1", "t1"), store.getState().refresh("p1", "t1")]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again on a later call — the tree moves while nobody is asking", async () => {
    const read = stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await store.getState().refresh("p1", "t1");
    await store.getState().refresh("p1", "t1");

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a refused read's own message rather than emptying the scope", async () => {
    stubSnapshot({ ok: false, error: "fatal: not a git repository" });
    const store = createVenueStore();

    await store.getState().refresh("p1", null);

    expect(store.getState().byScope[venueKey("p1", null)]).toEqual({
      status: "error",
      error: "fatal: not a git repository",
    });
  });

  it("treats a thrown read the same way as a refused one", async () => {
    const read = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { venue: { snapshot: read } } } });
    const store = createVenueStore();

    await store.getState().refresh("p1", null);

    expect(store.getState().byScope[venueKey("p1", null)]).toEqual({
      status: "error",
      error: "bridge gone",
    });
  });
});

describe("ensure", () => {
  it("reads a scope once, however many surfaces ask", async () => {
    const read = stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await store.getState().ensure("p1", "t1");
    await store.getState().ensure("p1", "t1");

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("folds two surfaces mounting on one frame into a single read", async () => {
    const read = stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await Promise.all([store.getState().ensure("p1", "t1"), store.getState().ensure("p1", "t1")]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads each scope on its own", async () => {
    const read = stubSnapshot({ ok: true, venue: snapshot() });
    const store = createVenueStore();

    await store.getState().ensure("p1", "t1");
    await store.getState().ensure("p1", null);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("p1", null);
  });

  it("does not re-read a scope whose read failed — the entry is an answer too", async () => {
    const read = stubSnapshot({ ok: false, error: "fatal: not a git repository" });
    const store = createVenueStore();

    await store.getState().ensure("p1", null);
    await store.getState().ensure("p1", null);

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("the app-wide singleton", () => {
  it("starts empty", () => {
    expect(useVenueStore.getState().byScope).toEqual({});
  });
});
