import type { WorkingCopySnapshot } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createWorkingCopyStore, useWorkingCopyStore, workingCopyKey } from "./working-copy";
import { remoteProject } from "./remote-project.test-support";

function snapshot(over: Partial<WorkingCopySnapshot> = {}): WorkingCopySnapshot {
  return {
    kind: "worktree",
    path: "/worktrees/VC-81",
    branch: "volli/VC-81-auto-title",
    files: { committed: 4, modified: 2, added: 1, untracked: 3 },
    diff: { added: 214, removed: 63, base: "main" },
    ...over,
  };
}

/** A `measured` answer, as main sends one. */
function measured(over: Partial<WorkingCopySnapshot> = {}) {
  return { ok: true, reading: { state: "measured", workingCopy: snapshot(over) } };
}

/** Main's answer for a ticket whose isolated checkout does not exist yet. */
const PENDING = { ok: true, reading: { state: "pending" } };

function stubSnapshot(result: unknown) {
  const read = vi.fn().mockResolvedValue(result);
  Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
  return read;
}

/** A read whose answer this test settles by hand — the delayed-materialization shape. */
function deferredSnapshot() {
  const settlers: ((result: unknown) => void)[] = [];
  const read = vi.fn().mockImplementation(
    () =>
      new Promise((settle) => {
        settlers.push(settle);
      }),
  );
  Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
  return { read, settlers };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("workingCopyKey", () => {
  it("keys by scope, so every Session in one tree shares a reading", () => {
    expect(workingCopyKey("p1", "t1")).toBe(workingCopyKey("p1", "t1"));
    expect(workingCopyKey("p1", null)).not.toBe(workingCopyKey("p1", "t1"));
    expect(workingCopyKey("p1", null)).not.toBe(workingCopyKey("p2", null));
  });
});

describe("refresh", () => {
  it("holds the reading main answered with", async () => {
    stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", "t1");

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({
      status: "ready",
      workingCopy: snapshot(),
    });
  });

  it("holds RESOLVING for a ticket whose checkout does not exist yet (VC-286)", async () => {
    stubSnapshot(PENDING);
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", "t1");

    // Never a working copy: a worktree-scoped ticket mid-materialization has no tree,
    // and the main checkout is not a stand-in for the one it will get.
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "resolving" });
  });

  it("announces the first read as loading, so a surface can wait rather than guess", async () => {
    const { settlers } = deferredSnapshot();
    const store = createWorkingCopyStore();

    const pending = store.getState().refresh("p1", null);
    expect(store.getState().byScope[workingCopyKey("p1", null)]).toEqual({ status: "loading" });

    settlers[0]?.(measured({ kind: "main-checkout", diff: null }));
    await pending;
    expect(store.getState().byScope[workingCopyKey("p1", null)]).toMatchObject({ status: "ready" });
  });

  it("keeps the reading on screen while a later one is in flight", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(measured())
      .mockImplementationOnce(() => new Promise(() => {}));
    Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", "t1");
    void store.getState().refresh("p1", "t1");

    // No blink back to `loading`: the drawing would vanish and return identical.
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toMatchObject({ status: "ready" });
  });

  it("folds two surfaces reading one scope on the same frame into a single read", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await Promise.all([store.getState().refresh("p1", "t1"), store.getState().refresh("p1", "t1")]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again on a later call — the tree moves while nobody is asking", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", "t1");
    await store.getState().refresh("p1", "t1");

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a refused read's own message rather than emptying the scope", async () => {
    stubSnapshot({ ok: false, error: "fatal: not a git repository" });
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", null);

    expect(store.getState().byScope[workingCopyKey("p1", null)]).toEqual({
      status: "error",
      error: "fatal: not a git repository",
    });
  });

  it("treats a thrown read the same way as a refused one", async () => {
    const read = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", null);

    expect(store.getState().byScope[workingCopyKey("p1", null)]).toEqual({
      status: "error",
      error: "bridge gone",
    });
  });
});

describe("ensure", () => {
  it("reads a scope once, however many surfaces ask", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await store.getState().ensure("p1", "t1");
    await store.getState().ensure("p1", "t1");

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("folds two surfaces mounting on one frame into a single read", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await Promise.all([store.getState().ensure("p1", "t1"), store.getState().ensure("p1", "t1")]);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a scope whose reading was discarded — a void entry is not an answer", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();
    await store.getState().ensure("p1", "t1");

    store.getState().invalidateTickets("t1");
    await store.getState().ensure("p1", "t1");

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads each scope on its own", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();

    await store.getState().ensure("p1", "t1");
    await store.getState().ensure("p1", null);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("p1", null);
  });

  it("does not re-read a scope whose read failed — the entry is an answer too", async () => {
    const read = stubSnapshot({ ok: false, error: "fatal: not a git repository" });
    const store = createWorkingCopyStore();

    await store.getState().ensure("p1", null);
    await store.getState().ensure("p1", null);

    expect(read).toHaveBeenCalledTimes(1);
  });
});

/**
 * VC-286: a cached reading belongs to the checkout it was taken in. When a
 * worktree is materialized, removed or recreated, that checkout is a different
 * one — or not there at all — and the old reading is not a slower version of
 * the new one, it is a different question's answer.
 */
describe("invalidateTickets", () => {
  it("drops a ticket's reading at once, rather than leaving it up until a new one lands", async () => {
    stubSnapshot(measured());
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", "t1");

    store.getState().invalidateTickets("t1");

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "loading" });
  });

  it("leaves the project's own working copy alone — Home's card is about the main checkout", async () => {
    stubSnapshot(measured({ kind: "main-checkout", diff: null }));
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", null);
    await store.getState().refresh("p1", "t1");

    store.getState().invalidateTickets("t1");

    expect(store.getState().byScope[workingCopyKey("p1", null)]).toMatchObject({ status: "ready" });
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "loading" });
  });

  it("leaves another ticket's reading alone", async () => {
    stubSnapshot(measured());
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", "t1");
    await store.getState().refresh("p1", "t2");

    store.getState().invalidateTickets("t2");

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toMatchObject({ status: "ready" });
    expect(store.getState().byScope[workingCopyKey("p1", "t2")]).toEqual({ status: "loading" });
  });

  it("drops every ticket's reading when the change names none — the conservative arm", async () => {
    stubSnapshot(measured());
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", "t1");
    await store.getState().refresh("p2", "t2");
    await store.getState().refresh("p1", null);

    store.getState().invalidateTickets();

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "loading" });
    expect(store.getState().byScope[workingCopyKey("p2", "t2")]).toEqual({ status: "loading" });
    expect(store.getState().byScope[workingCopyKey("p1", null)]).toMatchObject({ status: "ready" });
  });

  it("never invents a reading for a scope nobody has asked about", () => {
    stubSnapshot(measured());
    const store = createWorkingCopyStore();

    store.getState().invalidateTickets("t1");

    expect(store.getState().byScope).toEqual({});
  });

  it("refuses a read that was already in flight when the checkout changed", async () => {
    const { settlers } = deferredSnapshot();
    const store = createWorkingCopyStore();
    const stale = store.getState().refresh("p1", "t1");

    store.getState().invalidateTickets("t1");
    // The main checkout, read a moment before the worktree existed: the exact
    // answer that used to caption a ticket chat `Main checkout`.
    settlers[0]?.(measured({ kind: "main-checkout", path: "/repo", diff: null }));
    await stale;

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "loading" });
  });

  it("lets the read that started AFTER the change land", async () => {
    const { settlers } = deferredSnapshot();
    const store = createWorkingCopyStore();
    const stale = store.getState().refresh("p1", "t1");
    store.getState().invalidateTickets("t1");

    const fresh = store.getState().refresh("p1", "t1");
    settlers[1]?.(measured({ path: "/worktrees/VC-286" }));
    settlers[0]?.(measured({ kind: "main-checkout", path: "/repo", diff: null }));
    await Promise.all([stale, fresh]);

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({
      status: "ready",
      workingCopy: snapshot({ path: "/worktrees/VC-286" }),
    });
  });
});

describe("refreshStale", () => {
  it("re-reads what was discarded, and nothing else", async () => {
    const read = stubSnapshot(measured());
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", null);
    await store.getState().refresh("p1", "t1");
    read.mockClear();

    store.getState().invalidateTickets("t1");
    await store.getState().refreshStale();

    expect(read.mock.calls).toEqual([["p1", "t1"]]);
  });

  it("walks the materialization through resolving to the worktree it ends in", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(measured({ path: "/worktrees/VC-286" }));
    Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
    const store = createWorkingCopyStore();

    await store.getState().refresh("p1", "t1");
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "resolving" });

    store.getState().invalidateTickets("t1");
    await store.getState().refreshStale();

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({
      status: "ready",
      workingCopy: snapshot({ path: "/worktrees/VC-286" }),
    });
  });

  it("returns a removed worktree to resolving rather than to the checkout that is gone", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(measured({ path: "/worktrees/VC-286" }))
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(measured({ path: "/worktrees/VC-286-again" }));
    Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", "t1");

    store.getState().invalidateTickets("t1");
    await store.getState().refreshStale();
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "resolving" });

    store.getState().invalidateTickets("t1");
    await store.getState().refreshStale();
    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({
      status: "ready",
      workingCopy: snapshot({ path: "/worktrees/VC-286-again" }),
    });
  });

  it("keeps a failed creation at resolving rather than falling back to the main checkout", async () => {
    const read = vi.fn().mockResolvedValue(PENDING);
    Object.assign(globalThis, { window: { api: { workingCopy: { snapshot: read } } } });
    const store = createWorkingCopyStore();
    await store.getState().refresh("p1", "t1");

    store.getState().invalidateTickets("t1");
    await store.getState().refreshStale();

    expect(store.getState().byScope[workingCopyKey("p1", "t1")]).toEqual({ status: "resolving" });
  });

  it("leaves a scope with a read already in flight to that read", async () => {
    const { read, settlers } = deferredSnapshot();
    const store = createWorkingCopyStore();
    const pending = store.getState().refresh("p1", "t1");

    await store.getState().refreshStale();

    expect(read).toHaveBeenCalledTimes(1);
    settlers[0]?.(measured());
    await pending;
  });
});

describe("the app-wide singleton", () => {
  it("starts empty", () => {
    expect(useWorkingCopyStore.getState().byScope).toEqual({});
  });
});

// VC-711: a remote project's checkout is on its host; this Mac measures none.
describe("a remote project", () => {
  it("says where its working copy is not available, asking this Mac nothing", async () => {
    const read = stubSnapshot(measured());
    const undo = remoteProject("r1");
    try {
      const store = createWorkingCopyStore();
      await store.getState().refresh("r1", "t1");
      expect(store.getState().byScope[workingCopyKey("r1", "t1")]).toEqual({
        status: "error",
        error: "Not available on box yet",
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      undo();
    }
  });
});
