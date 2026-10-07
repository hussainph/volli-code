/**
 * The window's side of the Workspace link relay (VC-711): a remote project's
 * link as the adapters take one. Calls go straight to main's relay; a
 * subscription keeps going across a loss (resubscribing after its last
 * tracked id once the project's link reads ready) and across a full link
 * (waiting for a slot, AM1), and ends only on what its subscriber must hear.
 * `host-link-relay.real-link.test.ts` (main) runs it over a real link.
 */
import type { HostLinkSubscriptionHandlers } from "@volli/host-protocol/client-link";
import { readHostError } from "@volli/host-protocol";
import type { HostLinkRelayEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createHostConnectionStore, useHostConnectionStore } from "../stores/host-connection";
import type { HostLinkView } from "../stores/host-connection";
import {
  hostConnectionLinkState,
  isLinkReady,
  relayHostLink,
  type RelayHostLinkRpc,
  type RelayLinkStateSource,
} from "./relay-host-link";

const rpcClient = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./session-rpc-ipc-link", () => ({ sessionRpcClient: () => rpcClient.current }));

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
const OPEN: HostLinkView = { status: "open" };
const DOWN: HostLinkView = { status: "reconnecting" };

interface Opened {
  input: Record<string, unknown>;
  options: Record<string, unknown>;
  onData(event: HostLinkRelayEvent | { kind: "newer" }): void;
  onError(error: unknown): void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeRpc() {
  const opened: Opened[] = [];
  const rpc = {
    hostLink: {
      query: { query: vi.fn(async (input: unknown) => ({ queried: input })) },
      mutate: { mutate: vi.fn(async (input: unknown) => ({ mutated: input })) },
      subscribe: {
        subscribe: vi.fn((input: Record<string, unknown>, options: Record<string, unknown>) => {
          const unsubscribe = vi.fn();
          opened.push({
            input,
            options,
            onData: options["onData"] as Opened["onData"],
            onError: options["onError"] as Opened["onError"],
            unsubscribe,
          });
          return { unsubscribe };
        }),
      },
    },
  };
  return { rpc: rpc as unknown as RelayHostLinkRpc, raw: rpc, opened };
}

function fakeState(initial: HostLinkView = OPEN) {
  let view = initial;
  const listeners = new Set<() => void>();
  const source: RelayLinkStateSource = {
    getState: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    source,
    listeners,
    set(next: HostLinkView) {
      view = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

/** Timers the case runs by hand. */
function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimer: (run: () => void, ms: number) => {
      next += 1;
      pending.set(next, { run, ms });
      return next;
    },
    clearTimer: (timer: unknown) => void pending.delete(timer as number),
    fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { run }] of due) run();
      return due.map(([, { ms }]) => ms);
    },
  };
}

function recorder() {
  const seen: unknown[] = [];
  const handlers: HostLinkSubscriptionHandlers = {
    onStarted: () => void seen.push("started"),
    onData: (data, tracked) => void seen.push(tracked === undefined ? { data } : { data, tracked }),
    onResnapshot: (error) => void seen.push({ resnapshot: error }),
    onError: (error) => void seen.push({ error: readHostError(error) }),
    onComplete: () => void seen.push("complete"),
  };
  return { seen, handlers };
}

const unreachable = { code: "SERVICE_UNAVAILABLE", message: "gone", reason: "host-unreachable" };
const full = { code: "TOO_MANY_REQUESTS", message: "full", reason: "subscription-limit" };

afterEach(() => {
  vi.useRealTimers();
  rpcClient.current = null;
});

describe("relayed calls", () => {
  it("names the Workspace, the operation and its input, and carries the call's trace", async () => {
    const { rpc, raw } = fakeRpc();
    const link = relayHostLink(WORKSPACE, { rpc, state: fakeState().source });
    expect(link.workspaceId).toBe(WORKSPACE);
    expect(await link.query("board.snapshot", { projectId: WORKSPACE })).toEqual({
      queried: { workspaceId: WORKSPACE, path: "board.snapshot", input: { projectId: WORKSPACE } },
    });
    await link.mutate("board.setPriority", { priority: 1 }, { trace: TRACE });
    expect(raw.hostLink.query.query).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, path: "board.snapshot", input: { projectId: WORKSPACE } },
      {},
    );
    expect(raw.hostLink.mutate.mutate).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, path: "board.setPriority", input: { priority: 1 } },
      { context: { trace: TRACE } },
    );
  });

  it("reaches main through the window's own client by default", async () => {
    const { rpc } = fakeRpc();
    rpcClient.current = rpc;
    const link = relayHostLink(WORKSPACE, { state: fakeState().source });
    expect(await link.query("board.roster", undefined)).toMatchObject({
      queried: { path: "board.roster" },
    });
  });
});

describe("its state", () => {
  it("reads open or version-skewed as ready, and nothing else", () => {
    expect(isLinkReady(OPEN)).toBe(true);
    expect(isLinkReady({ status: "version-skewed", availableVersion: "1.2.3" })).toBe(true);
    for (const view of [
      DOWN,
      { status: "connecting" },
      { status: "offline", since: 0, retryAt: null },
      { status: "incompatible", reason: "fenced" },
    ] as HostLinkView[]) {
      expect(isLinkReady(view)).toBe(false);
    }
  });

  it("tells a listener when the project's link changes, and only then", () => {
    const state = fakeState();
    const link = relayHostLink(WORKSPACE, { rpc: fakeRpc().rpc, state: state.source });
    const heard: HostLinkView[] = [];
    const stop = link.subscribeState((view) => void heard.push(view));
    state.set(OPEN);
    state.set(DOWN);
    state.set(DOWN);
    expect(link.getState()).toBe(DOWN);
    stop();
    state.set(OPEN);
    expect(heard).toEqual([DOWN]);
  });

  it("reads the app's host-connection store when given no state", () => {
    const link = relayHostLink(WORKSPACE, { rpc: fakeRpc().rpc });
    expect(link.getState()).toEqual({ status: "open" });
  });

  it("is the host-connection store's view of the project's own link by default", () => {
    const store = createHostConnectionStore();
    expect(store.getState().projects).toEqual({});
    const source = hostConnectionLinkState(WORKSPACE);
    // Unclaimed: This Mac's, open.
    expect(source.getState()).toEqual({ status: "open" });
    const heard = vi.fn();
    const stop = source.subscribe(heard);
    let snapshot = {
      hosts: [
        {
          id: "box",
          name: "Box",
          local: false,
          os: "linux" as const,
          version: null,
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
      ],
      projects: { [WORKSPACE]: { hostId: "box", link: DOWN as HostLinkView } },
    };
    const changes = new Set<() => void>();
    const detach = useHostConnectionStore.getState().attach({
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        changes.add(listener);
        return () => void changes.delete(listener);
      },
      retry() {},
      updateHost() {},
      cancelScheduledUpdate() {},
      signIn() {},
    });
    expect(source.getState()).toBe(DOWN);
    expect(heard).toHaveBeenCalled();
    snapshot = { ...snapshot, projects: { [WORKSPACE]: { hostId: "box", link: OPEN } } };
    for (const change of changes) change();
    expect(source.getState()).toBe(OPEN);
    detach();
    stop();
  });
});

describe("a relayed subscription", () => {
  it("passes starts, emissions with their tracked ids, a resume cursor and the trace", () => {
    const { rpc, opened } = fakeRpc();
    const link = relayHostLink(WORKSPACE, { rpc, state: fakeState().source });
    const { seen, handlers } = recorder();
    link.subscribe("board.changes", { projectId: "p" }, handlers, {
      lastEventId: "40",
      trace: TRACE,
    });
    expect(opened[0]!.input).toEqual({
      workspaceId: WORKSPACE,
      path: "board.changes",
      input: { projectId: "p" },
      lastEventId: "40",
    });
    expect(opened[0]!.options["context"]).toEqual({ trace: TRACE });
    opened[0]!.onData({ kind: "started" });
    opened[0]!.onData({ kind: "data", data: { n: 1 }, id: "41" });
    opened[0]!.onData({ kind: "data", data: "untracked" });
    // A kind a newer main says is skipped.
    opened[0]!.onData({ kind: "newer" });
    expect(seen).toEqual([
      "started",
      { data: { n: 1 }, tracked: { id: "41" } },
      { data: "untracked" },
    ]);
  });

  it("resumes after a loss from its last id, once the link reads ready, and never hears the loss", () => {
    const { rpc, opened } = fakeRpc();
    const state = fakeState();
    const timers = manualTimers();
    const link = relayHostLink(WORKSPACE, {
      rpc,
      state: state.source,
      resumeDelaysMs: [10, 20],
      ...timers,
    });
    const { seen, handlers } = recorder();
    link.subscribe("board.changes", {}, handlers);
    expect(opened[0]!.input).not.toHaveProperty("lastEventId");
    opened[0]!.onData({ kind: "data", data: 1, id: "7" });
    opened[0]!.onData({ kind: "lost", error: unreachable });
    expect(opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    // The store has not caught up: still ready. It tries after the pause.
    expect(timers.fire()).toEqual([10]);
    expect(opened[1]!.input).toMatchObject({ lastEventId: "7" });
    // Lost again at once: a longer pause, and now the link reads down.
    opened[1]!.onData({ kind: "lost", error: unreachable });
    state.set(DOWN);
    expect(timers.fire()).toEqual([20]);
    expect(opened).toHaveLength(2);
    expect(state.listeners.size).toBe(1);
    // Anything the old stream still says is not this subscription's.
    opened[0]!.onData({ kind: "data", data: "stale", id: "1" });
    opened[1]!.onError(new Error("stale"));
    state.set({ status: "connecting" });
    expect(opened).toHaveLength(2);
    state.set(OPEN);
    expect(state.listeners.size).toBe(0);
    expect(opened[2]!.input).toMatchObject({ lastEventId: "7" });
    // Progress resets the pause.
    opened[2]!.onData({ kind: "started" });
    opened[2]!.onData({ kind: "lost", error: unreachable });
    expect(timers.fire()).toEqual([10]);
    expect(seen).toEqual([{ data: 1, tracked: { id: "7" } }, "started"]);
  });

  it("waits for a ready link before it opens at all", () => {
    const { rpc, opened } = fakeRpc();
    const state = fakeState(DOWN);
    const link = relayHostLink(WORKSPACE, { rpc, state: state.source });
    const subscription = link.subscribe("board.changes", {}, recorder().handlers);
    expect(opened).toHaveLength(0);
    state.set(OPEN);
    expect(opened).toHaveLength(1);
    // Unsubscribed while waiting: nothing opens when it comes back.
    const waiting = link.subscribe("logs.follow", {}, recorder().handlers);
    expect(opened).toHaveLength(2);
    state.set(DOWN);
    subscription.unsubscribe();
    waiting.unsubscribe();
    expect(opened[0]!.unsubscribe).toHaveBeenCalledOnce();
  });

  it("lets go of a waiting subscription that ends before its link is back", () => {
    const { rpc, opened } = fakeRpc();
    const state = fakeState(DOWN);
    const link = relayHostLink(WORKSPACE, { rpc, state: state.source });
    const subscription = link.subscribe("board.changes", {}, recorder().handlers);
    // The listener a store keeps calling after it was let go reaches nothing.
    const [listener] = [...state.listeners];
    subscription.unsubscribe();
    expect(state.listeners.size).toBe(0);
    state.set(OPEN);
    listener!();
    expect(opened).toHaveLength(0);
  });

  // VC-711 review B1: a view told its stream is waiting may close itself from
  // inside the callback. Nothing may then wait for a slot, or open on the host.
  it("opens nothing again when the view cancels inside onStreamLimited", () => {
    const { rpc, opened } = fakeRpc();
    const timers = manualTimers();
    let subscription!: { unsubscribe(): void };
    const limited = vi.fn(() => {
      subscription.unsubscribe();
      // Re-entrant twice over: cancelling is idempotent.
      subscription.unsubscribe();
    });
    const link = relayHostLink(WORKSPACE, {
      rpc,
      state: fakeState().source,
      resumeDelaysMs: [10],
      onStreamLimited: limited,
      ...timers,
    });
    subscription = link.subscribe("session.subscribe", { sessionId: "s" }, recorder().handlers);
    opened[0]!.onData({ kind: "error", error: full });
    expect(limited).toHaveBeenCalledOnce();
    expect(opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(timers.pending.size).toBe(0);
    expect(timers.fire()).toEqual([]);
    expect(opened).toHaveLength(1);
  });

  it("opens nothing for a subscription cancelled while it waited, whatever wakes it", () => {
    const { rpc, opened } = fakeRpc();
    const timers = manualTimers();
    const state = fakeState();
    const link = relayHostLink(WORKSPACE, {
      rpc,
      state: state.source,
      resumeDelaysMs: [10],
      ...timers,
    });
    // A lost stream whose handler cancels it: the pause it was given never opens.
    let subscription!: { unsubscribe(): void };
    subscription = link.subscribe(
      "board.changes",
      {},
      {
        onData() {},
        onResnapshot() {},
        onError() {},
        onStarted: () => subscription.unsubscribe(),
      },
    );
    opened[0]!.onData({ kind: "data", data: 1, id: "1" });
    opened[0]!.onData({ kind: "lost", error: unreachable });
    const [pending] = [...timers.pending.values()];
    subscription.unsubscribe();
    // A timer a platform had already queued still runs: it must open nothing.
    pending!.run();
    expect(opened).toHaveLength(1);
    // An overflow from a stream that ended inside its own handler reopens nothing.
    const second = link.subscribe(
      "board.changes",
      {},
      {
        onData: () => second.unsubscribe(),
        onResnapshot() {},
        onError() {},
      },
    );
    opened[1]!.onData({ kind: "data", data: 1, id: "1" });
    opened[1]!.onError({
      data: {
        hostError: { code: "TOO_MANY_REQUESTS", message: "x", reason: "subscription-overflow" },
      },
    });
    expect(opened).toHaveLength(2);
  });

  it("waits out a full link (AM1), says so, and resumes when a slot frees", () => {
    const { rpc, opened } = fakeRpc();
    const timers = manualTimers();
    const limited = vi.fn();
    const link = relayHostLink(WORKSPACE, {
      rpc,
      state: fakeState().source,
      resumeDelaysMs: [10],
      onStreamLimited: limited,
      ...timers,
    });
    const { seen, handlers } = recorder();
    link.subscribe("session.subscribe", { sessionId: "s" }, handlers);
    opened[0]!.onData({ kind: "error", error: full });
    expect(limited).toHaveBeenCalledWith({
      path: "session.subscribe",
      error: { code: "TOO_MANY_REQUESTS", message: "full", reason: "subscription-limit" },
    });
    expect(timers.fire()).toEqual([10]);
    opened[1]!.onData({ kind: "error", error: full });
    expect(timers.fire()).toEqual([10]);
    expect(opened).toHaveLength(3);
    expect(seen).toEqual([]);
    // Without a listener for it, it waits all the same.
    const quiet = relayHostLink(WORKSPACE, { rpc, state: fakeState().source, ...timers });
    quiet.subscribe("logs.follow", {}, recorder().handlers);
    opened[3]!.onData({ kind: "error", error: full });
    expect(timers.pending.size).toBe(1);
  });

  it("ends on a resnapshot, a failure, or a clean end, and says each one", () => {
    const { rpc, opened } = fakeRpc();
    const link = relayHostLink(WORKSPACE, { rpc, state: fakeState().source });
    const runs = [0, 1, 2].map(() => {
      const run = recorder();
      link.subscribe("board.changes", {}, run.handlers);
      return run;
    });
    const resnapshot = {
      code: "PRECONDITION_FAILED",
      message: "again",
      reason: "subscription-resnapshot-required",
    };
    opened[0]!.onData({ kind: "resnapshot", error: resnapshot });
    opened[1]!.onData({
      kind: "error",
      error: { code: "NOT_FOUND", message: "no", reason: "nope" },
    });
    opened[2]!.onData({ kind: "complete" });
    expect(runs.map(({ seen }) => seen)).toEqual([
      [{ resnapshot }],
      // A reason this build does not know is left out; the code stays.
      [{ error: { code: "NOT_FOUND", message: "no" } }],
      ["complete"],
    ]);
    for (const stream of opened) expect(stream.unsubscribe).toHaveBeenCalledOnce();
    opened[2]!.onData({ kind: "data", data: "after" });
    expect(runs[2]!.seen).toEqual(["complete"]);
  });

  it("resumes an overflow that made progress, and surfaces one that made none, or any failure", () => {
    const { rpc, opened } = fakeRpc();
    const link = relayHostLink(WORKSPACE, { rpc, state: fakeState().source });
    const { seen, handlers } = recorder();
    link.subscribe("board.changes", {}, handlers);
    const overflow = {
      message: "behind",
      data: {
        code: "TOO_MANY_REQUESTS",
        hostError: {
          code: "TOO_MANY_REQUESTS",
          message: "behind",
          reason: "subscription-overflow",
        },
      },
    };
    opened[0]!.onData({ kind: "data", data: 1, id: "3" });
    opened[0]!.onError(overflow);
    expect(opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(opened[1]!.input).toMatchObject({ lastEventId: "3" });
    opened[1]!.onError(overflow);
    expect(seen.at(-1)).toEqual({ error: overflow.data.hostError });
    const other = recorder();
    link.subscribe("board.changes", {}, other.handlers);
    opened[2]!.onError(new Error("operation unavailable"));
    expect(other.seen).toEqual([
      { error: { code: "INTERNAL_SERVER_ERROR", message: "operation unavailable" } },
    ]);
  });

  it("uses the platform's timers by default", () => {
    vi.useFakeTimers();
    const { rpc, opened } = fakeRpc();
    const link = relayHostLink(WORKSPACE, { rpc, state: fakeState().source });
    const subscription = link.subscribe("board.changes", {}, recorder().handlers);
    opened[0]!.onData({ kind: "lost", error: unreachable });
    vi.advanceTimersByTime(250);
    expect(opened).toHaveLength(2);
    opened[1]!.onData({ kind: "lost", error: unreachable });
    subscription.unsubscribe();
    vi.advanceTimersByTime(10_000);
    expect(opened).toHaveLength(2);
  });
});
