import { initTRPC, TRPCError, tracked } from "@trpc/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { createIpcServer } from "./server";
import type { IpcEvent, IpcPeer } from "./wire";

interface Ctx {
  readonly who: string;
}

/** A router whose formatter attaches the host protocol's envelope, as every catalog family does. */
const catalogLike = initTRPC.context<Ctx>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      hostError: {
        code: error.code,
        message: `formatted: ${error.message}`,
        ...(error.message === "reasoned" ? { reason: "verb-refused" } : {}),
      },
    },
  }),
});

const streams = vi.hoisted(() => ({
  gate: null as null | { release(): void; wait: Promise<void> },
}));

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  streams.gate = { release, wait };
  return streams.gate;
}

const router = catalogLike.router({
  who: catalogLike.procedure.query(({ ctx }) => ctx.who),
  echo: catalogLike.procedure
    .input((value: unknown) => {
      if (typeof value !== "string") throw new Error("not a string");
      return value;
    })
    .mutation(({ input }) => input),
  refuse: catalogLike.procedure
    .input((value: unknown) => value as string)
    .query(({ input }) => {
      throw new TRPCError({ code: "FORBIDDEN", message: input });
    }),
  stream: catalogLike.procedure
    .input((value: unknown) => {
      if (value === null) throw new TRPCError({ code: "BAD_REQUEST", message: "no input" });
      return value as { fail?: string; untracked?: boolean; hold?: boolean };
    })
    .subscription(async function* ({ input, signal }) {
      if (input.untracked === true) {
        yield { plain: true };
        return;
      }
      yield tracked("1", { sequence: 1 });
      if (input.hold === true) {
        const held = streams.gate!;
        await Promise.race([
          held.wait,
          new Promise((resolve) => signal?.addEventListener("abort", resolve)),
        ]);
        if (signal?.aborted !== true) yield tracked("2", { sequence: 2 });
      }
      if (input.fail !== undefined)
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: input.fail });
    }),
  hidden: catalogLike.procedure.query(() => "withheld"),
});

/** A router with tRPC's default formatter: no host envelope to read. */
const plain = initTRPC.context<Ctx>().create();
const plainRouter = plain.router({
  plainRefuse: plain.procedure.mutation(() => {
    throw new TRPCError({ code: "CONFLICT", message: "plain conflict" });
  }),
});

const SERVED = ["who", "echo", "refuse", "stream", "plainRefuse", "nobodyPublishes"];

function server(onSubscriptionError?: (path: string, error: unknown) => void) {
  return createIpcServer({
    routers: [router, plainRouter],
    served: SERVED,
    createContext: () => ({ who: "desktop" }),
    ...(onSubscriptionError === undefined ? {} : { onSubscriptionError }),
  });
}

interface FakePeer extends IpcPeer {
  readonly events: IpcEvent[];
  destroy(): void;
  listeners(): number;
}

let nextId = 1;
function peer(options: { throwOnSend?: (event: IpcEvent) => boolean } = {}): FakePeer {
  const events: IpcEvent[] = [];
  const teardown = new Set<() => void>();
  let destroyed = false;
  return {
    id: nextId++,
    events,
    isDestroyed: () => destroyed,
    send: (event) => {
      if (options.throwOnSend?.(event) === true) throw new Error("peer cannot receive");
      events.push(event);
    },
    onDestroyed: (listener) => {
      teardown.add(listener);
      return () => teardown.delete(listener);
    },
    destroy: () => {
      destroyed = true;
      for (const listener of teardown) listener();
    },
    listeners: () => teardown.size,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createIpcServer", () => {
  it("refuses anything that is not a request", async () => {
    const bridge = server();
    for (const value of [null, "who", { path: "who" }, { path: 1, type: "query" }]) {
      await expect(bridge.request(peer(), value)).resolves.toEqual({
        ok: false,
        error: { code: "BAD_REQUEST", message: "Invalid IPC request" },
      });
    }
  });

  it("answers a withheld, unpublished or mistyped path as tRPC answers an unknown one", async () => {
    const bridge = server();
    for (const [path, type] of [
      ["hidden", "query"],
      ["nobodyPublishes", "query"],
      ["who", "mutation"],
    ] as const) {
      await expect(bridge.request(peer(), { path, type, input: undefined })).resolves.toEqual({
        ok: false,
        error: { code: "NOT_FOUND", message: `No "${type}"-procedure on path "${path}"` },
      });
    }
  });

  it("runs queries and mutations through the router, in the context it builds per call", async () => {
    const bridge = server();
    await expect(
      bridge.request(peer(), { path: "who", type: "query", input: undefined }),
    ).resolves.toEqual({ ok: true, data: "desktop" });
    await expect(
      bridge.request(peer(), { path: "echo", type: "mutation", input: "hi" }),
    ).resolves.toEqual({ ok: true, data: "hi" });
  });

  it("answers a failure with the router's own envelope, as the WebSocket would", async () => {
    const bridge = server();
    await expect(
      bridge.request(peer(), { path: "refuse", type: "query", input: "no" }),
    ).resolves.toEqual({ ok: false, error: { code: "FORBIDDEN", message: "formatted: no" } });
    await expect(
      bridge.request(peer(), { path: "refuse", type: "query", input: "reasoned" }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "formatted: reasoned", reason: "verb-refused" },
    });
    // tRPC's input parser fails before the resolver; the envelope is the same.
    await expect(
      bridge.request(peer(), { path: "echo", type: "mutation", input: 7 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    // A router with no host envelope is read for its code and message.
    await expect(
      bridge.request(peer(), { path: "plainRefuse", type: "mutation", input: undefined }),
    ).resolves.toEqual({ ok: false, error: { code: "CONFLICT", message: "plain conflict" } });
  });

  it("runs each well-formed request inside its scope, a subscription's frames included (VC-699)", async () => {
    const seen: { path: string; trace: unknown }[] = [];
    let inScope: string | null = null;
    const frames: (string | null)[] = [];
    const bridge = createIpcServer({
      routers: [router, plainRouter],
      served: SERVED,
      createContext: () => ({ who: "desktop" }),
      scope: async (request, run) => {
        seen.push({ path: request.path, trace: request.trace });
        const previous = inScope;
        inScope = request.path;
        try {
          return await run();
        } finally {
          inScope = previous;
        }
      },
    });
    const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
    await expect(
      bridge.request(peer(), { path: "who", type: "query", input: undefined, trace }),
    ).resolves.toEqual({ ok: true, data: "desktop" });
    const watcher = peer();
    const send = watcher.send;
    watcher.send = (event) => {
      frames.push(inScope);
      send(event);
    };
    await bridge.request(watcher, { path: "stream", type: "subscription", input: {} });
    await bridge.request(peer(), null);
    expect(seen).toEqual([
      { path: "who", trace },
      { path: "stream", trace: undefined },
    ]);
    await flush();
    expect(frames.length).toBeGreaterThan(0);
    await bridge.close();
  });

  it("refuses to serve one path from two routers", () => {
    expect(() =>
      createIpcServer({
        routers: [router, router],
        served: ["who"],
        createContext: () => ({ who: "x" }),
      }),
    ).toThrow("IPC serves who, which 2 routers publish");
  });

  it("acknowledges a subscription, then sends its tracked frames and a clean end", async () => {
    const bridge = server();
    const owner = peer();
    const reply = await bridge.request(owner, { path: "stream", type: "subscription", input: {} });
    if (!(reply.ok && "subscriptionId" in reply)) throw new Error("Expected an acknowledgement");
    await vi.waitFor(() => expect(owner.events.at(-1)?.kind).toBe("done"));
    expect(owner.events).toEqual([
      { kind: "data", subscriptionId: reply.subscriptionId, eventId: "1", data: { sequence: 1 } },
      { kind: "done", subscriptionId: reply.subscriptionId },
    ]);
    expect(owner.listeners()).toBe(0);
  });

  it("sends an untracked emission with no event id", async () => {
    const bridge = server();
    const owner = peer();
    const reply = await bridge.request(owner, {
      path: "stream",
      type: "subscription",
      input: { untracked: true },
    });
    await vi.waitFor(() => expect(owner.events.at(-1)?.kind).toBe("done"));
    expect(owner.events[0]).toEqual({
      kind: "data",
      subscriptionId: (reply as { subscriptionId: string }).subscriptionId,
      eventId: null,
      data: { plain: true },
    });
  });

  it("ends a failing stream with the envelope, never a clean end, and reports it", async () => {
    const failures: unknown[] = [];
    const bridge = server((path, error) => failures.push({ path, error }));
    const owner = peer();
    const reply = await bridge.request(owner, {
      path: "stream",
      type: "subscription",
      input: { fail: "fell behind" },
    });
    await vi.waitFor(() => expect(owner.events.at(-1)?.kind).toBe("error"));
    const error = { code: "TOO_MANY_REQUESTS", message: "formatted: fell behind" };
    expect(owner.events.at(-1)).toEqual({
      kind: "error",
      subscriptionId: (reply as { subscriptionId: string }).subscriptionId,
      error,
    });
    expect(failures).toEqual([{ path: "stream", error }]);
  });

  it("keeps a failure in the report when the peer cannot receive it, and without a reporter", async () => {
    const owner = peer({ throwOnSend: (event) => event.kind === "error" });
    const reported: unknown[] = [];
    await server((path) => reported.push(path)).request(owner, {
      path: "stream",
      type: "subscription",
      input: { fail: "gone" },
    });
    await vi.waitFor(() => expect(reported).toEqual(["stream"]));
    expect(owner.events.map(({ kind }) => kind)).toEqual(["data"]);

    const quiet = peer();
    await server().request(quiet, { path: "stream", type: "subscription", input: { fail: "x" } });
    await vi.waitFor(() => expect(quiet.events.at(-1)?.kind).toBe("error"));
  });

  it("answers a subscription that fails to open with the envelope", async () => {
    const bridge = server();
    await expect(
      bridge.request(peer(), { path: "stream", type: "subscription", input: null }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "BAD_REQUEST", message: "formatted: no input" },
    });
  });

  it("does not keep a subscription whose peer is already gone", async () => {
    const bridge = server();
    const owner = peer();
    owner.destroy();
    await expect(
      bridge.request(owner, { path: "stream", type: "subscription", input: {} }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CLIENT_CLOSED_REQUEST", message: "The peer closed" },
    });
    expect(owner.events).toEqual([]);
  });

  it("stops a stream when its peer goes away, sending nothing more", async () => {
    gate();
    const bridge = server();
    const owner = peer();
    await bridge.request(owner, { path: "stream", type: "subscription", input: { hold: true } });
    await vi.waitFor(() => expect(owner.events).toHaveLength(1));
    owner.destroy();
    streams.gate!.release();
    await flush();
    expect(owner.events).toHaveLength(1);
    expect(owner.listeners()).toBe(0);
  });

  it("drops a frame that arrives after its peer went away", async () => {
    const bridge = server();
    const owner = peer();
    // Destroyed between the peer's check and the frame's arrival, without a
    // teardown notice: the frame is not sent.
    let checks = 0;
    const racing: IpcPeer = {
      ...owner,
      isDestroyed: () => ++checks > 2,
      onDestroyed: () => () => {},
    };
    await bridge.request(racing, { path: "stream", type: "subscription", input: {} });
    await flush();
    expect(owner.events).toEqual([]);
  });

  it("stops a stream only for the peer that opened it, and only for a real id", async () => {
    gate();
    const bridge = server();
    const owner = peer();
    const stranger = peer();
    const reply = await bridge.request(owner, {
      path: "stream",
      type: "subscription",
      input: { hold: true },
    });
    const { subscriptionId } = reply as { subscriptionId: string };
    await vi.waitFor(() => expect(owner.events).toHaveLength(1));

    bridge.cancel(owner, 42);
    bridge.cancel(owner, "not-a-subscription");
    bridge.cancel(stranger, subscriptionId);
    expect(owner.listeners()).toBe(1);

    bridge.cancel(owner, subscriptionId);
    await flush();
    streams.gate!.release();
    await flush();
    // Cancellation is local teardown: no frame, and no terminal `done` either.
    expect(owner.events).toHaveLength(1);
    expect(owner.listeners()).toBe(0);
  });

  it("closes every live stream when the door closes", async () => {
    gate();
    const bridge = server();
    const owners = [peer(), peer()];
    for (const owner of owners) {
      await bridge.request(owner, { path: "stream", type: "subscription", input: { hold: true } });
    }
    await vi.waitFor(() => expect(owners.every((owner) => owner.events.length === 1)).toBe(true));
    await bridge.close();
    expect(owners.map((owner) => owner.listeners())).toEqual([0, 0]);
    await bridge.close();
  });
});
