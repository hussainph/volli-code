import { describe, expect, it } from "vite-plus/test";
import type { Result, WorktreeChangedEvent } from "@volli/shared";

import { subscribeWorktreeChanges, type WorktreeChangeWatchApi } from "./worktree-change-watch";

interface FakeApi extends WorktreeChangeWatchApi {
  readonly watched: string[];
  readonly unwatched: string[];
  /** Resolves the pending `watchChangeSet` promise for the given ticket. */
  settleWatch(ticketId: string, result: Result): void;
  emit(event: WorktreeChangedEvent): void;
  listenerCount(): number;
}

function fakeApi(): FakeApi {
  const watched: string[] = [];
  const unwatched: string[] = [];
  const pending = new Map<string, (result: Result) => void>();
  const listeners = new Set<(event: WorktreeChangedEvent) => void>();

  return {
    watched,
    unwatched,
    watchChangeSet(ticketId: string): Promise<Result> {
      watched.push(ticketId);
      return new Promise<Result>((resolve) => pending.set(ticketId, resolve));
    },
    unwatchChangeSet(ticketId: string): Promise<Result> {
      unwatched.push(ticketId);
      return Promise.resolve({ ok: true });
    },
    onChanged(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    settleWatch(ticketId, result) {
      pending.get(ticketId)?.(result);
      pending.delete(ticketId);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function handlers() {
  const changes: number[] = [];
  const errors: string[] = [];
  return {
    changes,
    errors,
    onChanged: () => changes.push(1),
    onWatchError: (message: string) => errors.push(message),
  };
}

describe("subscribeWorktreeChanges", () => {
  it("forwards only this ticket's change events", () => {
    const api = fakeApi();
    const spy = handlers();

    subscribeWorktreeChanges(api, "t1", spy);
    api.emit({ ticketId: "t2" });
    expect(spy.changes).toHaveLength(0);

    api.emit({ ticketId: "t1" });
    expect(spy.changes).toHaveLength(1);
  });

  it("unwatches and stops forwarding on teardown", () => {
    const api = fakeApi();
    const spy = handlers();

    const teardown = subscribeWorktreeChanges(api, "t1", spy);
    teardown();

    expect(api.unwatched).toEqual(["t1"]);
    expect(api.listenerCount()).toBe(0);
    api.emit({ ticketId: "t1" });
    expect(spy.changes).toHaveLength(0);
  });

  it("does not unwatch a remount when a torn-down watch resolves late", async () => {
    const api = fakeApi();
    const first = handlers();
    const second = handlers();

    // Mount, tear down before the watch call resolves, then remount — the
    // React 18 StrictMode / fast-ticket-switch shape.
    const teardown = subscribeWorktreeChanges(api, "t1", first);
    teardown();
    subscribeWorktreeChanges(api, "t1", second);

    // The FIRST subscription's watch now resolves. Main keys watches by
    // (window, ticketId), so a second unwatch here would kill the remount's.
    api.settleWatch("t1", { ok: true });
    await Promise.resolve();

    expect(api.unwatched).toEqual(["t1"]);
    api.emit({ ticketId: "t1" });
    expect(second.changes).toHaveLength(1);
  });

  it("reports a failed watch, and stays quiet once torn down", async () => {
    const api = fakeApi();
    const live = handlers();
    const gone = handlers();

    subscribeWorktreeChanges(api, "t1", live);
    api.settleWatch("t1", { ok: false, error: "ENOSPC" });
    await Promise.resolve();
    expect(live.errors).toEqual(["ENOSPC"]);

    const teardown = subscribeWorktreeChanges(api, "t2", gone);
    teardown();
    api.settleWatch("t2", { ok: false, error: "too late" });
    await Promise.resolve();
    expect(gone.errors).toEqual([]);
  });
});
