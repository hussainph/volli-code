import type { HostLogEntry, HostLogsBatch } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  batchOf,
  hostLinkLogSource,
  LOG_SOURCE_POLLING,
  localLogSource,
  registerRemoteLogSource,
  remoteLogSources,
  type LocalLogClient,
  type LogSourceHandlers,
  type LogSourceLink,
} from "./log-sources";

const entry = (cursor: string): HostLogEntry => ({
  cursor,
  record: { ts: "2026-10-07T00:00:00.000Z", level: "info", component: "c", msg: cursor },
});
const page = (cursor: string, gap = false): HostLogsBatch => ({
  entries: [entry(cursor)],
  gap,
  cursor,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  const lines: [string[], boolean][] = [];
  const statuses: [string, string | undefined][] = [];
  const handlers: LogSourceHandlers = {
    onLines: (entries, gap) => lines.push([entries.map(({ cursor }) => cursor), gap]),
    onStatus: (status, detail) => statuses.push([status, detail]),
  };
  return { lines, statuses, handlers };
}

describe("the viewer's sources", () => {
  it("reads a batch out of any frame envelope", () => {
    expect(batchOf(page("a"))).toEqual(page("a"));
    expect(batchOf({ id: "a", data: page("a") })).toEqual(page("a"));
    expect(batchOf({ id: "a" })).toBeNull();
    expect(batchOf(null)).toBeNull();
  });

  it("reads this Mac's recent page, then follows from its cursor", async () => {
    let push!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    const unsubscribe = vi.fn();
    const follow = vi.fn(
      (
        _input: { after?: string },
        handlers: { onData?(v: unknown): void; onError?(e: unknown): void },
      ) => {
        push = handlers.onData!;
        fail = handlers.onError!;
        return { unsubscribe };
      },
    );
    const client: LocalLogClient = {
      logs: { tail: { query: async () => page("i:1") }, follow: { subscribe: follow } },
    };
    const { lines, statuses, handlers } = recorder();
    const stop = localLogSource(() => client).start(handlers);
    await flush();
    expect(follow).toHaveBeenCalledWith({ after: "i:1" }, expect.anything());
    push({ id: "i:2", data: page("i:2", true) });
    push({ id: "nothing" });
    fail(new Error("bridge gone"));
    expect(lines).toEqual([
      [["i:1"], false],
      [["i:2"], true],
    ]);
    expect(statuses).toEqual([
      ["connecting", undefined],
      ["live", undefined],
      ["failed", "bridge gone"],
    ]);
    stop();
    expect(unsubscribe).toHaveBeenCalled();
    push(page("i:3"));
    fail("late");
    expect(lines).toHaveLength(2);
  });

  it("says a source failed when its first read fails, and ignores a read that lands after stop", async () => {
    const failing: LocalLogClient = {
      logs: {
        tail: { query: async () => Promise.reject("refused") },
        follow: { subscribe: () => ({ unsubscribe: () => undefined }) },
      },
    };
    const first = recorder();
    localLogSource(() => failing).start(first.handlers);
    await flush();
    expect(first.statuses.at(-1)).toEqual(["failed", "refused"]);

    const late = recorder();
    const stop = localLogSource(() => failing).start(late.handlers);
    stop();
    await flush();
    expect(late.statuses).toEqual([["connecting", undefined]]);
    const slow = recorder();
    const stopSlow = localLogSource(() => ({
      ...failing,
      logs: { ...failing.logs, tail: { query: async () => page("x") } },
    })).start(slow.handlers);
    stopSlow();
    await flush();
    expect(slow.lines).toEqual([]);
  });

  it("reads a remote host's log over its link's host.logs", async () => {
    let handlersOf!: Parameters<LogSourceLink["subscribe"]>[2];
    const calls: unknown[] = [];
    const link: LogSourceLink = {
      query: async (path, input) => {
        calls.push([path, input]);
        return page("r:1");
      },
      subscribe: (path, input, handlers) => {
        calls.push([path, input]);
        handlersOf = handlers;
        return { unsubscribe: () => undefined };
      },
    };
    const { lines, statuses, handlers } = recorder();
    const source = hostLinkLogSource({ id: "box", label: "Box", link });
    expect(source).toMatchObject({ id: "box", label: "Box" });
    const stop = source.start(handlers);
    await flush();
    handlersOf.onData(page("r:2"));
    handlersOf.onData("garbage");
    handlersOf.onResnapshot(new Error("resnapshot"));
    expect(calls).toEqual([
      ["logs.tail", { limit: 500 }],
      ["logs.follow", { after: "r:1" }],
    ]);
    expect(lines.map(([cursors]) => cursors)).toEqual([["r:1"], ["r:2"]]);
    expect(statuses.at(-1)).toEqual(["failed", "resnapshot"]);
    // Stop lets go of the pause before it starts again.
    stop();
  });

  it("registers remote hosts until their owner removes them", () => {
    const box = hostLinkLogSource({ id: "box", label: "Box", link: {} as LogSourceLink });
    const again = hostLinkLogSource({ id: "box", label: "Box 2", link: {} as LogSourceLink });
    const remove = registerRemoteLogSource(box);
    expect(remoteLogSources()).toEqual([box]);
    const removeAgain = registerRemoteLogSource(again);
    expect(remoteLogSources()).toEqual([again]);
    remove();
    expect(remoteLogSources()).toEqual([again]);
    removeAgain();
    expect(remoteLogSources()).toEqual([]);
  });
});

/* ---------------------------------------- one host, many links (VC-712) */

/** A scripted link: every call recorded, every answer the test's to give. */
function scriptedLink() {
  const queries: { input: unknown; resolve(value: unknown): void; reject(error: unknown): void }[] =
    [];
  const streams: {
    input: unknown;
    handlers: Parameters<LogSourceLink["subscribe"]>[2];
    unsubscribed: boolean;
  }[] = [];
  const link: LogSourceLink = {
    query: (_path, input) =>
      new Promise((resolve, reject) => queries.push({ input, resolve, reject })),
    subscribe: (_path, input, handlers) => {
      const stream = { input, handlers, unsubscribed: false };
      streams.push(stream);
      return { unsubscribe: () => void (stream.unsubscribed = true) };
    },
  };
  return { link, queries, streams, open: () => streams.filter((s) => !s.unsubscribed) };
}

/** A host's links the test moves, and timers it runs by hand. */
function hostLinks(initial: Record<string, ReturnType<typeof scriptedLink>>) {
  let ready = Object.entries(initial).map(([key, scripted]) => ({ key, link: scripted.link }));
  let waiting: { status: "connecting" | "live" | "failed"; detail?: string } = {
    status: "connecting",
    detail: "Reconnecting…",
  };
  const listeners = new Set<() => void>();
  const timers: { run(): void; ms: number; cleared: boolean }[] = [];
  return {
    links: {
      ready: () => ready,
      waiting: () => waiting,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    set(keys: string[], next: Record<string, ReturnType<typeof scriptedLink>> = initial) {
      ready = keys.map((key) => ({ key, link: next[key]!.link }));
      for (const listener of listeners) listener();
    },
    setWaiting(next: typeof waiting) {
      waiting = next;
      for (const listener of listeners) listener();
    },
    timers,
    timing: {
      setTimer: (run: () => void, ms: number) => {
        const timer = { run, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer: unknown) => void ((timer as { cleared: boolean }).cleared = true),
      pollMs: 10,
      pollsPerFollowRetry: 2,
      retryMs: 50,
    },
    /** Runs the newest timer still armed. */
    fire() {
      const timer = timers.findLast((entry) => !entry.cleared);
      if (timer === undefined) throw new Error("no timer armed");
      timer.cleared = true;
      timer.run();
    },
    listeners,
  };
}

const limitError = { code: "TOO_MANY_REQUESTS", reason: "subscription-limit", message: "full" };

describe("a remote host's log over its links (VC-712)", () => {
  it("tails, follows, and moves to the next ready link after its cursor when the one in use goes", async () => {
    const a = scriptedLink();
    const b = scriptedLink();
    const host = hostLinks({ a, b });
    const { lines, statuses, handlers } = recorder();
    const stop = hostLinkLogSource(
      { id: "box", label: "Box", links: host.links },
      host.timing,
    ).start(handlers);
    expect(a.queries.map(({ input }) => input)).toEqual([{ limit: 500 }]);
    a.queries[0]!.resolve(page("r:1", true));
    await flush();
    expect(a.streams.map(({ input }) => input)).toEqual([{ after: "r:1" }]);
    a.streams[0]!.handlers.onStarted?.();
    a.streams[0]!.handlers.onData({ id: "r:2", data: page("r:2") });
    a.streams[0]!.handlers.onData("noise");
    // An unrelated change keeps the link in use.
    host.set(["a", "b"]);
    expect(a.open()).toHaveLength(1);

    host.set(["b"]);
    expect(a.open()).toHaveLength(0);
    expect(b.queries).toEqual([]);
    expect(b.streams.map(({ input }) => input)).toEqual([{ after: "r:2" }]);
    // The old link's late frames are dropped.
    a.streams[0]!.handlers.onData(page("r:9"));
    b.streams[0]!.handlers.onData(page("r:3"));
    expect(lines).toEqual([
      [["r:1"], true],
      [["r:2"], false],
      [["r:3"], false],
    ]);
    expect(statuses).toEqual([
      ["connecting", undefined],
      ["live", undefined],
    ]);
    stop();
    expect(b.open()).toHaveLength(0);
    expect(host.listeners.size).toBe(0);
  });

  it("waits with the host's own words while no link is ready, and reads once one is", async () => {
    const a = scriptedLink();
    const host = hostLinks({ a });
    host.set([]);
    const { statuses, handlers } = recorder();
    const stop = hostLinkLogSource(
      { id: "box", label: "Box", links: host.links },
      host.timing,
    ).start(handlers);
    expect(statuses).toEqual([["connecting", "Reconnecting…"]]);
    host.setWaiting({ status: "failed", detail: "Box can’t be reached right now." });
    expect(statuses.at(-1)).toEqual(["failed", "Box can’t be reached right now."]);
    host.set(["a"]);
    expect(a.queries).toHaveLength(1);
    // Stopped before the answer: nothing after stop.
    stop();
    a.queries[0]!.resolve(page("r:1"));
    await flush();
    expect(a.streams).toEqual([]);
    // A change after stop does nothing.
    host.set([]);
  });

  it("tries the next link when a link's budget refuses the follow, then polls when every one is full (AM1)", async () => {
    const a = scriptedLink();
    const b = scriptedLink();
    const host = hostLinks({ a, b });
    const { lines, statuses, handlers } = recorder();
    hostLinkLogSource({ id: "box", label: "Box", links: host.links }, host.timing).start(
      handlers,
    );
    a.queries[0]!.resolve(page("r:1"));
    await flush();
    // The relay says it while it waits: the source leaves after that call returns.
    a.streams[0]!.handlers.onLimited?.(limitError);
    expect(a.open()).toHaveLength(1);
    await flush();
    expect(a.open()).toHaveLength(0);
    expect(b.streams.map(({ input }) => input)).toEqual([{ after: "r:1" }]);
    // A bare link says it as an error: every link is full now.
    b.streams[0]!.handlers.onError(Object.assign(new Error("full"), limitError));
    expect(b.open()).toHaveLength(0);
    expect(statuses.at(-1)).toEqual(["live", LOG_SOURCE_POLLING]);
    // It polls the first ready link after its cursor.
    expect(a.queries.map(({ input }) => input)).toEqual([
      { limit: 500 },
      { after: "r:1", limit: 500 },
    ]);
    a.queries[1]!.resolve(page("r:2"));
    await flush();
    host.fire();
    expect(a.queries.at(-1)!.input).toEqual({ after: "r:2", limit: 500 });
    a.queries.at(-1)!.reject(new Error("dropped"));
    await flush();
    expect(statuses.at(-1)).toEqual(["failed", "dropped"]);
    // The polls are spent: it asks for a stream again, on the first link.
    host.fire();
    expect(a.streams.at(-1)!.input).toEqual({ after: "r:2" });
    expect(statuses.at(-1)).toEqual(["live", undefined]);
    expect(lines.map(([cursors]) => cursors)).toEqual([["r:1"], ["r:2"]]);
  });

  it("streams again at once when, while polling, a link the budget has not refused comes up", async () => {
    const a = scriptedLink();
    const b = scriptedLink();
    const host = hostLinks({ a, b });
    host.set(["a"]);
    const { lines, handlers } = recorder();
    hostLinkLogSource({ id: "box", label: "Box", links: host.links }, host.timing).start(
      handlers,
    );
    a.queries[0]!.resolve(page("r:1"));
    await flush();
    a.streams[0]!.handlers.onError(Object.assign(new Error("full"), limitError));
    expect(a.queries).toHaveLength(2);
    // Another of the host's links comes up: it streams there, after its cursor.
    host.set(["a", "b"]);
    expect(b.streams.map(({ input }) => input)).toEqual([{ after: "r:1" }]);
    // The poll it left answers late: dropped.
    a.queries[1]!.resolve(page("r:5"));
    await flush();
    expect(lines.map(([cursors]) => cursors)).toEqual([["r:1"]]);
    // Both full: it polls again, and a change that frees nothing keeps it polling.
    b.streams[0]!.handlers.onError(Object.assign(new Error("full"), limitError));
    expect(a.queries).toHaveLength(3);
    host.set(["a", "b"]);
    expect(a.queries).toHaveLength(3);
    expect(b.streams).toHaveLength(1);
    // The link it polls goes: it polls the one left.
    host.set(["b"]);
    expect(b.queries.map(({ input }) => input)).toEqual([{ after: "r:1", limit: 500 }]);
  });

  it("says a failure on its dot and starts again after a pause", async () => {
    const a = scriptedLink();
    const host = hostLinks({ a });
    const { statuses, handlers } = recorder();
    hostLinkLogSource({ id: "box", label: "Box", links: host.links }, host.timing).start(
      handlers,
    );
    a.queries[0]!.reject(new Error("verb-refused"));
    await flush();
    expect(statuses.at(-1)).toEqual(["failed", "verb-refused"]);
    host.fire();
    a.queries[1]!.resolve("not a batch");
    await flush();
    expect(statuses.at(-1)).toEqual(["failed", "The host answered with no log"]);
    host.fire();
    a.queries[2]!.resolve(page("r:1"));
    await flush();
    a.streams[0]!.handlers.onResnapshot(new Error("resnapshot"));
    expect(statuses.at(-1)).toEqual(["failed", "resnapshot"]);
    host.fire();
    a.streams[1]!.handlers.onComplete?.();
    expect(statuses.at(-1)).toEqual(["failed", "The host stopped sending its log"]);
    host.fire();
    a.streams[2]!.handlers.onError(new Error("broke"));
    expect(statuses.at(-1)).toEqual(["failed", "broke"]);
    // Late callbacks of an attempt it left are dropped.
    a.streams[0]!.handlers.onStarted?.();
    a.streams[0]!.handlers.onError(new Error("late"));
    a.streams[0]!.handlers.onResnapshot(new Error("late"));
    a.streams[0]!.handlers.onComplete?.();
    a.streams[0]!.handlers.onLimited?.(limitError);
    await flush();
    expect(statuses.at(-1)).toEqual(["failed", "broke"]);
    host.fire();
    expect(a.streams).toHaveLength(4);
  });

  it("lets go of a stream a link answered after the source had already moved on", async () => {
    const a = scriptedLink();
    const host = hostLinks({ a });
    const { handlers } = recorder();
    // A link that reports the stream full inside its subscribe call.
    const eager: LogSourceLink = {
      query: a.link.query,
      subscribe: (path, input, streamHandlers) => {
        const subscription = a.link.subscribe(path, input, streamHandlers);
        streamHandlers.onError(Object.assign(new Error("full"), limitError));
        return subscription;
      },
    };
    const source = hostLinkLogSource(
      { id: "box", label: "Box", links: { ...host.links, ready: () => [{ key: "a", link: eager }] } },
      host.timing,
    );
    source.start(handlers);
    a.queries[0]!.resolve(page("r:1"));
    await flush();
    expect(a.streams[0]!.unsubscribed).toBe(true);
  });

  it("keeps polling past a timer for a poll it already left, and a late poll answer", async () => {
    const a = scriptedLink();
    const host = hostLinks({ a });
    const { lines, handlers } = recorder();
    const stop = hostLinkLogSource(
      { id: "box", label: "Box", links: host.links },
      host.timing,
    ).start(handlers);
    a.queries[0]!.resolve(page("r:1"));
    await flush();
    a.streams[0]!.handlers.onError(Object.assign(new Error("full"), limitError));
    a.queries[1]!.resolve("not a batch");
    await flush();
    host.fire();
    // Stopped while a poll and a tail are out: neither answer lands.
    stop();
    a.queries[2]!.reject(new Error("late"));
    await flush();
    expect(lines).toHaveLength(1);

    const late = recorder();
    const stopLate = hostLinkLogSource(
      { id: "box", label: "Box", links: host.links },
      host.timing,
    ).start(late.handlers);
    stopLate();
    a.queries[3]!.reject(new Error("late"));
    await flush();
    expect(late.statuses).toEqual([["connecting", undefined]]);
  });
});
