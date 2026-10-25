import { describe, expect, it, vi } from "vite-plus/test";

import {
  createBackendLink,
  LINK_RECONNECT,
  LinkResetError,
  type BackendConnection,
} from "./backend-link";
import { createMutationGate } from "./flow";

function fakeConnections() {
  const made: (BackendConnection & {
    up: boolean;
    closed: boolean;
    queries: Map<string, (value: unknown) => void>;
    setUp(up: boolean): void;
    reads: {
      name: string;
      args: unknown;
      settle(value: unknown): void;
      fail(error: unknown): void;
    }[];
    calls: {
      name: string;
      args: unknown;
      settle(value: unknown): void;
      fail(error: unknown): void;
    }[];
  })[] = [];
  let startUp = true;
  const connect = vi.fn((token: (o: { forceRefreshToken: boolean }) => Promise<string | null>) => {
    void token;
    let listener: ((up: boolean) => void) | null = null;
    const connection = {
      up: startUp,
      closed: false,
      calls: [] as {
        name: string;
        args: unknown;
        settle(value: unknown): void;
        fail(error: unknown): void;
      }[],
      setUp(up: boolean) {
        connection.up = up;
        listener?.(up);
      },
      reads: [] as {
        name: string;
        args: unknown;
        settle(value: unknown): void;
        fail(error: unknown): void;
      }[],
      query(name: string, args: Record<string, unknown>) {
        return new Promise((settle, fail) => connection.reads.push({ name, args, settle, fail }));
      },
      queries: new Map<string, (value: unknown) => void>(),
      onUpdate(name: string, _args: Record<string, unknown>, update: (value: unknown) => void) {
        connection.queries.set(name, update);
        return () => void connection.queries.delete(name);
      },
      mutation(name: string, args: Record<string, unknown>) {
        return new Promise((settle, fail) => connection.calls.push({ name, args, settle, fail }));
      },
      isConnected: () => connection.up,
      onConnectionChange(next: (up: boolean) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      close: async () => {
        connection.closed = true;
      },
    };
    made.push(connection);
    return connection;
  });
  return { connect, made, startDown: () => (startUp = false), startUp: () => (startUp = true) };
}

function manualClock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      timers.set(next, { at: now + ms, run });
      return next++;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const token = async () => "jwt";

describe("the backend link", () => {
  it("is connected when its connection is, and sends through the gate at control priority by default", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const gate = createMutationGate();
    const run = vi.spyOn(gate, "run");
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate,
      ...clock,
      random: () => 1,
    });
    expect(link.status).toEqual({ state: "connected" });
    const sent = link.call("runners:heartbeat", { bootId: "b" });
    expect(run).toHaveBeenCalledWith("control", expect.any(Number), expect.any(Function));
    connections.made[0]!.calls[0]!.settle({ ok: true });
    await expect(sent).resolves.toEqual({ ok: true });
    const plain = link.mutate("runners:reportState", { state: "online" });
    expect(run).toHaveBeenLastCalledWith("control", expect.any(Number), expect.any(Function));
    connections.made[0]!.calls[1]!.settle(null);
    await plain;
    const live = link.mutate("sessions:accept", { events: [] }, { priority: "live", bytes: 9 });
    expect(run).toHaveBeenLastCalledWith("live", 9, expect.any(Function));
    connections.made[0]!.calls[2]!.fail(new Error("refused"));
    await expect(live).rejects.toThrow("refused");
    expect(connections.connect).toHaveBeenCalledWith(token);
  });

  it("owns the reconnect: backs off 250 ms doubling, and replaces the connection once an outage passes 5 s", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const statuses: string[] = [];
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 1,
    });
    link.onStatus((status) => statuses.push(status.state));
    const stranded = link.call("runners:heartbeat", {});
    connections.startDown();
    connections.made[0]!.setUp(false);
    expect(link.status).toEqual({ state: "connecting" });
    clock.advance(LINK_RECONNECT.maxMs - 1);
    expect(connections.made).toHaveLength(1);
    clock.advance(LINK_RECONNECT.maxMs);
    expect(connections.made.length).toBeGreaterThan(1);
    expect(connections.made[0]!.closed).toBe(true);
    expect(link.status).toEqual({ state: "offline", since: 0 });
    await expect(stranded).rejects.toBeInstanceOf(LinkResetError);
    // Still down after the replacement: offline stays offline, and it keeps trying.
    clock.advance(LINK_RECONNECT.maxMs * 2);
    expect(statuses).toEqual(["connecting", "offline"]);
    connections.made.at(-1)!.setUp(true);
    expect(link.status).toEqual({ state: "connected" });
    expect(statuses).toEqual(["connecting", "offline", "connected"]);
    expect(clock.pending()).toBe(0);
  });

  it("a connection that comes back on its own is kept", () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 0,
    });
    connections.made[0]!.setUp(false);
    clock.advance(300);
    connections.made[0]!.up = true;
    clock.advance(10_000);
    expect(connections.made).toHaveLength(1);
    void link;
  });

  it("a fresh connection that is up at once ends the outage", () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 1,
    });
    connections.made[0]!.setUp(false);
    clock.advance(LINK_RECONNECT.maxMs * 3);
    expect(connections.made).toHaveLength(2);
    expect(link.status).toEqual({ state: "connected" });
  });

  it("reconnectNow replaces the connection at once, up or not (a half-open socket reads as up)", () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 1,
    });
    link.reconnectNow();
    expect(connections.made).toHaveLength(2);
    expect(link.status).toEqual({ state: "connected" });
    connections.startDown();
    connections.made[1]!.setUp(false);
    link.reconnectNow();
    expect(connections.made).toHaveLength(3);
    expect(clock.pending()).toBe(1);
  });

  it("gives each fresh connection its own grace, and keeps the outage's start", () => {
    const connections = fakeConnections();
    connections.startDown();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 1,
    });
    clock.advance(30_000);
    // Replaced about every 5 s, not on every check once the first 5 s passed.
    expect(connections.made.length).toBeLessThanOrEqual(7);
    expect(link.status).toEqual({ state: "offline", since: 0 });
  });

  it("a call admitted after close is refused, not sent to the closed client", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const gate = createMutationGate({ maxInFlight: 1, maxBytes: 1_000 });
    const link = createBackendLink({ connect: connections.connect, token, gate, ...clock });
    const first = link.call("a", {});
    const second = link.call("b", {});
    await link.close();
    await expect(first).rejects.toBeInstanceOf(LinkResetError);
    await expect(second).rejects.toBeInstanceOf(LinkResetError);
    expect(connections.made[0]!.calls.map((c) => c.name)).toEqual(["a"]);
  });

  it("starts connecting when its first connection is not up yet", () => {
    const connections = fakeConnections();
    connections.startDown();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
      random: () => 1,
    });
    expect(link.status).toEqual({ state: "connecting" });
    connections.made[0]!.setUp(true);
    expect(link.status).toEqual({ state: "connected" });
  });

  it("close strands what is pending, stops listening and refuses new calls", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
    });
    const unsubscribe = link.onStatus(() => {});
    unsubscribe();
    connections.made[0]!.setUp(false);
    const pending = link.call("x", {});
    await new Promise((done) => setTimeout(done, 0));
    await link.close();
    await expect(pending).rejects.toBeInstanceOf(LinkResetError);
    await expect(link.call("x", {})).rejects.toThrow(/closed/);
    expect(connections.made[0]!.closed).toBe(true);
    link.reconnectNow();
    expect(connections.made).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("a replaced connection that fails to close is still replaced", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
    });
    connections.made[0]!.close = () => Promise.reject(new Error("already closed"));
    connections.made[0]!.setUp(false);
    link.reconnectNow();
    expect(connections.made).toHaveLength(2);
    await link.close();
  });

  it("keeps a live query across connection replacement, and drops it when unsubscribed or closed", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
    });
    const seen: unknown[] = [];
    const off = link.subscribe("runnerJobs:wake", {}, (value) => seen.push(value));
    connections.made[0]!.queries.get("runnerJobs:wake")!({ ready: 1 });
    link.reconnectNow();
    expect(connections.made[0]!.queries.size).toBe(0);
    connections.made[1]!.queries.get("runnerJobs:wake")!({ ready: 2 });
    expect(seen).toEqual([{ ready: 1 }, { ready: 2 }]);
    off();
    expect(connections.made[1]!.queries.size).toBe(0);
    link.subscribe("other", {}, () => {});
    await link.close();
    expect(connections.made[1]!.queries.size).toBe(0);
    // A subscription asked for after close attaches to nothing.
    link.subscribe("late", {}, () => {})();
    expect(connections.made[1]!.queries.size).toBe(0);
  });

  it("reads first-attach context on the current connection without consuming the mutation gate", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const gate = createMutationGate();
    const run = vi.spyOn(gate, "run");
    const link = createBackendLink({ connect: connections.connect, token, gate, ...clock });
    const input = { sessionId: "s", projectId: "p", ticketId: "t" };
    const reading = link.query!("runnerContext:forSession", input);
    expect(connections.made[0]!.reads[0]).toMatchObject({
      name: "runnerContext:forSession",
      args: input,
    });
    connections.made[0]!.reads[0]!.settle({ body: "cloud brief" });
    await expect(reading).resolves.toEqual({ body: "cloud brief" });
    expect(run).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    const refused = link.query!("runnerContext:forSession", input);
    connections.made[0]!.reads[1]!.fail(new Error("not a member"));
    await expect(refused).rejects.toThrow("not a member");
    expect(clock.pending()).toBe(0);
    await link.close();
  });

  it("bounds a context read to ten seconds and refuses offline, closed or query-less adapters", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
    });
    const reading = link.query!("runnerContext:forSession", {});
    const timedOut = expect(reading).rejects.toThrow("Volli Cloud is unreachable");
    clock.advance(9_999);
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    await timedOut;
    expect(clock.pending()).toBe(0);
    // A late answer cannot revive a timed-out first attach.
    connections.made[0]!.reads[0]!.settle({ body: "too late" });
    connections.made[0]!.setUp(false);
    await expect(link.query!("runnerContext:forSession", {})).rejects.toThrow(
      "Volli Cloud is unreachable",
    );
    expect(connections.made[0]!.reads).toHaveLength(1);
    await link.close();
    await expect(link.query!("runnerContext:forSession", {})).rejects.toThrow(
      "Volli Cloud is unreachable",
    );

    const legacy = fakeConnections();
    const oldLink = createBackendLink({
      connect: (auth) => {
        const connection: BackendConnection = legacy.connect(auth);
        delete connection.query;
        return connection;
      },
      token,
      gate: createMutationGate(),
      ...clock,
    });
    await expect(oldLink.query!("runnerContext:forSession", {})).rejects.toThrow(
      "Runner queries are unavailable",
    );
    expect(clock.pending()).toBe(0);
    await oldLink.close();
  });

  it("strands pending context reads on replacement or close, and clears their deadlines", async () => {
    const connections = fakeConnections();
    const clock = manualClock();
    const link = createBackendLink({
      connect: connections.connect,
      token,
      gate: createMutationGate(),
      ...clock,
    });
    const replaced = link.query!("runnerContext:forSession", {});
    const replacementError = expect(replaced).rejects.toBeInstanceOf(LinkResetError);
    link.reconnectNow();
    await replacementError;
    expect(clock.pending()).toBe(0);
    const closed = link.query!("runnerContext:forSession", {});
    const closeError = expect(closed).rejects.toBeInstanceOf(LinkResetError);
    await link.close();
    await closeError;
    expect(clock.pending()).toBe(0);
    connections.made[0]!.reads[0]!.settle({ body: "stale connection" });
    connections.made[1]!.reads[0]!.settle({ body: "closed connection" });
    expect(clock.pending()).toBe(0);
  });

  it("uses real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const connections = fakeConnections();
      createBackendLink({ connect: connections.connect, token, gate: createMutationGate() });
      connections.startDown();
      connections.made[0]!.setUp(false);
      await vi.advanceTimersByTimeAsync(LINK_RECONNECT.maxMs * 4);
      expect(connections.made.length).toBeGreaterThan(1);
      connections.made.at(-1)!.setUp(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
