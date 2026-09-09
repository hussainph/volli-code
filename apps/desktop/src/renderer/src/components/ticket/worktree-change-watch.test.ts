import { describe, expect, it } from "vite-plus/test";
import type {
  Result,
  WorktreeChangedEvent,
  WorktreeWatchErrorEvent,
} from "../../../../ipc/contract";

import {
  subscribeWorktreeChanges,
  type WorktreeChangeWatchApi,
  type WorktreeChangeWatchFocus,
} from "./worktree-change-watch";

interface FakeApi extends WorktreeChangeWatchApi {
  readonly watched: string[];
  readonly paused: string[];
  readonly resumed: string[];
  readonly unwatched: string[];
  /** Resolves the pending `watchChangeSet` promise for the given ticket. */
  settleWatch(ticketId: string, result: Result): void;
  emit(event: WorktreeChangedEvent): void;
  emitWatchError(event: WorktreeWatchErrorEvent): void;
  listenerCount(): number;
}

function fakeApi(): FakeApi {
  const watched: string[] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  const unwatched: string[] = [];
  const pending = new Map<string, (result: Result) => void>();
  const listeners = new Set<(event: WorktreeChangedEvent) => void>();
  const errorListeners = new Set<(event: WorktreeWatchErrorEvent) => void>();

  return {
    watched,
    paused,
    resumed,
    unwatched,
    watchChangeSet(ticketId: string): Promise<Result> {
      watched.push(ticketId);
      return new Promise<Result>((resolve) => pending.set(ticketId, resolve));
    },
    pauseChangeSet(ticketId: string): Promise<Result> {
      paused.push(ticketId);
      return Promise.resolve({ ok: true });
    },
    resumeChangeSet(ticketId: string): Promise<Result> {
      resumed.push(ticketId);
      return Promise.resolve({ ok: true });
    },
    unwatchChangeSet(ticketId: string): Promise<Result> {
      unwatched.push(ticketId);
      return Promise.resolve({ ok: true });
    },
    onChanged(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    onWatchError(callback) {
      errorListeners.add(callback);
      return () => errorListeners.delete(callback);
    },
    settleWatch(ticketId, result) {
      pending.get(ticketId)?.(result);
      pending.delete(ticketId);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    emitWatchError(event) {
      for (const listener of errorListeners) listener(event);
    },
    listenerCount: () => listeners.size + errorListeners.size,
  };
}

function fakeFocus(initiallyFocused = true): WorktreeChangeWatchFocus & {
  setFocused(focused: boolean): void;
} {
  let focused = initiallyFocused;
  const listeners = new Set<(next: boolean) => void>();
  return {
    isFocused: () => focused,
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    setFocused(next) {
      focused = next;
      for (const listener of listeners) listener(next);
    },
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

  it("pauses in the background, drops events there, and resumes on focus", async () => {
    const api = fakeApi();
    const focus = fakeFocus();
    const spy = handlers();

    subscribeWorktreeChanges(api, "t1", spy, focus);
    api.settleWatch("t1", { ok: true });
    await Promise.resolve();

    focus.setFocused(false);
    await Promise.resolve();
    expect(api.paused).toEqual(["t1"]);

    api.emit({ ticketId: "t1" });
    expect(spy.changes).toHaveLength(0);

    focus.setFocused(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.resumed).toEqual(["t1"]);
  });

  it("reports a pause failure once instead of retrying it in a loop", async () => {
    const api = fakeApi();
    api.pauseChangeSet = () => Promise.resolve({ ok: false, error: "pause failed" });
    const focus = fakeFocus();
    const spy = handlers();

    subscribeWorktreeChanges(api, "t1", spy, focus);
    api.settleWatch("t1", { ok: true });
    await Promise.resolve();
    focus.setFocused(false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spy.errors).toEqual(["pause failed"]);
  });

  it("starts a mounted background window paused after the watch is ready", async () => {
    const api = fakeApi();
    const focus = fakeFocus(false);

    subscribeWorktreeChanges(api, "t1", handlers(), focus);
    api.settleWatch("t1", { ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.paused).toEqual(["t1"]);
  });

  it("reports a watcher fault for this ticket only", () => {
    const api = fakeApi();
    const spy = handlers();

    subscribeWorktreeChanges(api, "t1", spy);
    api.emitWatchError({ ticketId: "t2", error: "someone else's problem" });
    expect(spy.errors).toEqual([]);

    api.emitWatchError({ ticketId: "t1", error: "EMFILE" });
    expect(spy.errors).toEqual(["EMFILE"]);
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
