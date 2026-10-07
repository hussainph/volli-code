import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import type { SessionRuntime, SessionStreamFrame } from "@volli/session-engine";

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
}));
const { terminalStream, routerCallers } = vi.hoisted(() => ({
  terminalStream: { current: null as AsyncIterable<readonly [string, unknown]> | null },
  /** Every caller the bridge handed the real router, in order. */
  routerCallers: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
    on(channel: string, listener: (...args: never[]) => unknown) {
      listeners.set(channel, listener);
    },
  },
}));

vi.mock("@volli/session-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/session-rpc")>();
  return {
    ...actual,
    createSessionRouter: () => {
      const stream = terminalStream.current;
      if (stream === null) {
        const router = actual.createSessionRouter();
        return {
          ...router,
          createCaller: (context: Parameters<typeof router.createCaller>[0], options) => {
            routerCallers.push((context as { caller: unknown }).caller);
            return router.createCaller(context, options);
          },
        } as typeof router;
      }
      const router = actual.createSessionRouter();
      return {
        ...router,
        createCaller: () => ({
          session: { subscribe: async () => stream },
        }),
      } as unknown as typeof router;
    },
  };
});

import {
  EMPTY_MODEL_ACCESS_DEFAULTS,
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
} from "@volli/shared";
import type { IpcResponse } from "@volli/host-protocol/ipc";

import { LOCAL_DESKTOP_CALLER } from "@volli/session-rpc";
import { captureHostLog } from "@volli/host-core/testing";

import { sessionHandlersFrom, type LegacySessionPorts } from "@volli/session-rpc/testing";

import {
  registerDegradedSessionRpcIpcHandlers,
  registerSessionRpcIpcHandlers as registerBridge,
  type RegisterSessionRpcIpcOptions,
} from "./session-rpc-ipc";

/**
 * The bridge over a map built from the per-behaviour ports a case states
 * (VC-668). Anything else a case passes, a rogue caller included, reaches the
 * bridge untouched, so a test of what the bridge ignores still tests it.
 */
function registerSessionRpcIpcHandlers(
  options: Omit<LegacySessionPorts, "caller" | "diagnostics"> &
    Omit<RegisterSessionRpcIpcOptions, "handlers">,
) {
  return registerBridge({
    ...(options as object),
    handlers: sessionHandlersFrom(options),
  } as unknown as RegisterSessionRpcIpcOptions);
}

interface FakeSender {
  readonly id: number;
  readonly send: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
  /** Fires whatever `once("destroyed", …)` registered — the WebContents teardown path. */
  destroy(): void;
  /** Emits `did-start-navigation` with these details; the WebContents lives on. */
  navigate(details: { isMainFrame: boolean; isSameDocument: boolean }): void;
  /** Emits `render-process-gone`; the WebContents lives on. */
  crash(): void;
  /** How many navigation and crash listeners are still attached. */
  liveListeners(): number;
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: {
    snapshot: string[];
    history: number[];
    projection: string[];
    subscribe: number[];
    cancelled: { sessionId: string; interactionId: string; reason: string }[];
  };
  /** Whether the runtime subscription is still open — false once the bridge unsubscribed it. */
  isListening(): boolean;
  emit(nextFrame: SessionStreamFrame): void;
} {
  const calls = {
    snapshot: [] as string[],
    history: [] as number[],
    projection: [] as string[],
    subscribe: [] as number[],
    cancelled: [] as { sessionId: string; interactionId: string; reason: string }[],
  };
  let listener: ((frame: SessionStreamFrame) => void) | null = null;
  return {
    runtime: {
      command: async () =>
        ({ sessionId: "session-1", receipt: null, throughSequence: 4, refusal: null }) as never,
      snapshot: async ({ sessionId }) => {
        calls.snapshot.push(sessionId);
        return {
          projection: {},
          throughSequence: 0,
          frames: [],
          transcript: [],
          latestReply: null,
        } as never;
      },
      history: async ({ before }) => {
        calls.history.push(before);
        return { frames: [], before: null };
      },
      projection: async ({ sessionId }) => {
        calls.projection.push(sessionId);
        return { projection: {}, throughSequence: 4 } as never;
      },
      subscribe: async ({ afterSequence }, next) => {
        calls.subscribe.push(afterSequence);
        listener = (nextFrame) => void next(nextFrame);
        return () => {
          listener = null;
        };
      },
      cancelInteraction: async (request) => {
        calls.cancelled.push(request);
        return undefined;
      },
      reconcile: async () => undefined,
      close: async () => undefined,
    },
    calls,
    isListening: () => listener !== null,
    emit: (nextFrame) => {
      if (listener === null) throw new Error("Subscription is not listening");
      listener(nextFrame);
    },
  };
}

function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: "session-1",
    sequence,
    event: {
      id: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: {
        kind: "session.created",
        session: {
          id: "session-1",
          projectId: "project-1",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
          createdAt: 10,
        },
      },
    },
    transcript: null,
  };
}

function sender(id = 1): FakeSender {
  const destroyedListeners: (() => void)[] = [];
  const attached = new Map<string, Set<(...args: never[]) => void>>();
  const on = (event: string) => attached.get(event) ?? new Set();
  let destroyed = false;
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.push(listener);
    }),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      attached.set(event, on(event).add(listener));
    }),
    removeListener: vi.fn((event: string, listener: (...args: never[]) => void) => {
      on(event).delete(listener);
    }),
    destroy: () => {
      destroyed = true;
      for (const listener of destroyedListeners.splice(0)) listener();
    },
    navigate: (details) => {
      for (const listener of on("did-start-navigation")) {
        (listener as (value: typeof details) => void)(details);
      }
    },
    crash: () => {
      for (const listener of on("render-process-gone")) (listener as () => void)();
    },
    liveListeners: () => on("did-start-navigation").size + on("render-process-gone").size,
  };
}

function invoke(owner: FakeSender, request: unknown): Promise<IpcResponse> {
  const handler = handlers.get(SESSION_RPC_IPC_CHANNEL);
  if (!handler) throw new Error("Session RPC handler is not registered");
  return (handler as (...args: unknown[]) => unknown)(
    { sender: owner },
    request,
  ) as Promise<IpcResponse>;
}

function cancel(event: { sender: FakeSender }, subscriptionId: unknown): void {
  const listener = listeners.get(SESSION_RPC_CANCEL_CHANNEL);
  if (!listener) throw new Error("Session RPC cancellation handler is not registered");
  (listener as (...args: unknown[]) => unknown)(event, subscriptionId);
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  terminalStream.current = null;
  routerCallers.length = 0;
});

describe("registerSessionRpcIpcHandlers", () => {
  // VC-564 review B2: the window is the desktop's own (D7), and production
  // options cannot make it anyone else.
  it("takes no caller and no Session-to-Workspace port in its options", () => {
    expectTypeOf<RegisterSessionRpcIpcOptions>().not.toHaveProperty("caller");
    expectTypeOf<RegisterSessionRpcIpcOptions>().not.toHaveProperty("resourceWorkspace");
    const fixture = runtimeFixture();
    // @ts-expect-error -- a caller is not a production option.
    registerSessionRpcIpcHandlers({ runtime: fixture.runtime, caller: LOCAL_DESKTOP_CALLER });
  });

  it("always judges the desktop's own window, whatever else rides in the options", async () => {
    const fixture = runtimeFixture();
    const network = {
      actor: {
        kind: "device",
        deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
        workspaceId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      },
      current: () => true,
    };
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      ...({ caller: network, resourceWorkspace: () => null } as object),
    });
    const owner = sender();
    // A network device with that port would be refused this Session; the
    // desktop skips Workspace resolution and reads it.
    await expect(
      invoke(owner, { path: "session.snapshot", type: "query", input: { sessionId: "session-1" } }),
    ).resolves.toMatchObject({ ok: true });
    await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1" },
    });
    expect(fixture.calls.snapshot).toEqual(["session-1"]);
    expect(routerCallers).toEqual([LOCAL_DESKTOP_CALLER, LOCAL_DESKTOP_CALLER]);
    expect(routerCallers.every((caller) => caller === LOCAL_DESKTOP_CALLER)).toBe(true);
    await registration.close();
  });

  it("routes a query through the Session tRPC router and marks diagnostics as Electron IPC", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), {
        path: "session.snapshot",
        type: "query",
        input: { sessionId: "session-1" },
      }),
    ).resolves.toMatchObject({ ok: true, data: { throughSequence: 0 } });

    expect(fixture.calls.snapshot).toEqual(["session-1"]);
    expect(registration.diagnostics.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          procedure: "session.snapshot",
          transport: "electron-ipc",
          phase: "success",
        }),
      ]),
    );
    await registration.close();
  });

  it("handles each request inside the renderer's trace, and mints one for a malformed trace (VC-699)", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const log = captureHostLog();
    try {
      const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
      await invoke(sender(), {
        path: "session.snapshot",
        type: "query",
        input: { sessionId: "session-1" },
        trace,
      });
      await invoke(sender(), {
        path: "session.snapshot",
        type: "query",
        input: { sessionId: "session-1" },
        trace: { traceId: "nope", spanId: "nope" },
      });
      const rpc = log.of("rpc");
      expect(rpc.length).toBeGreaterThanOrEqual(2);
      expect(rpc[0]).toMatchObject({
        traceId: trace.traceId,
        spanId: trace.spanId,
        door: "ipc",
        operation: "session.snapshot",
      });
      const minted = rpc.at(-1)!;
      expect(minted["traceId"]).toMatch(/^[0-9a-f]{32}$/u);
      expect(minted["traceId"]).not.toBe(trace.traceId);
    } finally {
      log.restore();
      await registration.close();
    }
  });

  it("forwards payload-free router timing to the benchmark observer", async () => {
    const fixture = runtimeFixture();
    const samples: unknown[] = [];
    let now = 0;
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      performanceObserver: {
        now: () => ++now,
        record: (sample) => samples.push(sample),
      },
    });

    await invoke(sender(), {
      path: "session.projection",
      type: "query",
      input: { sessionId: "session-private" },
    });

    expect(samples).toEqual([
      { procedure: "session.projection", durationMs: 1, outcome: "success" },
    ]);
    expect(JSON.stringify(samples)).not.toContain("session-private");
    await registration.close();
  });

  // Electron IPC is the only transport production has, so a router procedure the
  // allow-list omits is dead there — and reads to the renderer as a caller bug
  // (`BAD_REQUEST`) rather than as a missing route.
  it("reaches every Session procedure the router publishes", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), {
        path: "session.projection",
        type: "query",
        input: { sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { projection: {}, throughSequence: 4 },
    });
    await expect(
      invoke(sender(), {
        path: "session.history",
        type: "query",
        input: { sessionId: "session-1", before: 7 },
      }),
    ).resolves.toEqual({ ok: true, data: { frames: [], before: null } });
    expect(fixture.calls.history).toEqual([7]);
    await expect(
      invoke(sender(), {
        path: "session.cancelInteraction",
        type: "mutation",
        input: { sessionId: "session-1", interactionId: "question-1" },
      }),
    ).resolves.toEqual({ ok: true, data: undefined });

    await expect(
      invoke(sender(), {
        path: "session.command",
        type: "mutation",
        input: {
          commandId: "command-1",
          sessionId: "session-1",
          command: {
            kind: "model.select",
            selection: {
              providerId: "openai-codex",
              modelId: "gpt-5.6-sol",
              reasoningLevel: "high",
            },
          },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { sessionId: "session-1", receipt: null, throughSequence: 4, refusal: null },
    });
    await expect(
      invoke(sender(), {
        path: "session.reconcile",
        type: "mutation",
        input: { sessionId: "session-1", attachmentId: "attachment-1" },
      }),
    ).resolves.toEqual({ ok: true, data: undefined });

    expect(fixture.calls.projection).toEqual(["session-1"]);
    // The reason is the router's to state, not the renderer's: this transport
    // is the user seam, and abandonment is all it can honestly report.
    expect(fixture.calls.cancelled).toEqual([
      {
        sessionId: "session-1",
        interactionId: "question-1",
        reason: "abandoned",
        origin: { kind: "user" },
      },
    ]);
    await registration.close();
  });

  it("routes queue mutations through the same validated catalog on flag-off IPC", async () => {
    const fixture = runtimeFixture();
    const command = vi.fn(async () => ({
      sessionId: "session-1",
      command: {} as never,
      receipt: null,
      throughSequence: 1,
      refusal: null,
    }));
    const registration = registerSessionRpcIpcHandlers({
      runtime: { ...fixture.runtime, command },
    });
    const message = { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] };
    for (const [path, input] of [
      ["session.cancelQueued", { commandId: "cancel", sessionId: "session-1", messageId: "m" }],
      [
        "session.editQueued",
        { commandId: "edit", sessionId: "session-1", messageId: "m", message },
      ],
    ] as const) {
      await expect(invoke(sender(), { path, type: "mutation", input })).resolves.toMatchObject({
        ok: true,
        data: { sessionId: "session-1", throughSequence: 1 },
      });
    }
    expect(command).toHaveBeenCalledWith({
      commandId: "cancel",
      sessionId: "session-1",
      command: { kind: "message.cancel", messageId: "m" },
    });
    expect(command).toHaveBeenCalledWith({
      commandId: "edit",
      sessionId: "session-1",
      command: { kind: "message.edit", messageId: "m", message },
    });
    await registration.close();
  });

  it("skips output validation on in-process IPC but still validates input", async () => {
    const fixture = runtimeFixture();
    const malformed = {
      sessionId: "session-1",
      receipt: null,
      throughSequence: "not-a-number",
      refusal: null,
    };
    fixture.runtime.command = vi.fn(async () => malformed as never);
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const input = {
      commandId: "command-1",
      sessionId: "session-1",
      command: { kind: "executor.retry" },
    };
    await expect(
      invoke(sender(), { path: "session.command", type: "mutation", input }),
    ).resolves.toEqual({
      ok: true,
      data: malformed,
    });
    await expect(
      invoke(sender(), {
        path: "session.command",
        type: "mutation",
        input: { ...input, commandId: "" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(fixture.runtime.command).toHaveBeenCalledTimes(1);
    await registration.close();
  });

  // A path the routers publish but the desktop withholds (`DESKTOP_IPC_EXPOSURE`)
  // answers exactly as one no router publishes: tRPC's own `NOT_FOUND`, as the
  // WebSocket adapter answers a path it has no procedure for.
  it("refuses withheld and unknown procedures and lets tRPC validate known procedure input", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    for (const [path, type] of [
      ["labDiagnostics.list", "query"],
      ["labDiagnostics.subscribe", "subscription"],
      ["protocol.welcome", "query"],
      ["session.list", "query"],
      ["session.nonsense", "query"],
      // A served path called as another type is not that procedure either.
      ["session.snapshot", "mutation"],
    ] as const) {
      await expect(invoke(sender(), { path, type, input: {} })).resolves.toEqual({
        ok: false,
        error: { code: "NOT_FOUND", message: `No "${type}"-procedure on path "${path}"` },
      });
    }
    await expect(
      invoke(sender(), { path: "session.snapshot", type: "query", input: { sessionId: "" } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });

    await registration.close();
  });

  // The renderer's link only ever sends the envelope, but this handler is on a
  // channel any renderer code could reach; anything that is not one is refused
  // before it can be read for a procedure name.
  it("rejects a request that is not an envelope at all", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const invalid = {
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid IPC request" },
    };

    await expect(invoke(sender(), "session.snapshot")).resolves.toEqual(invalid);
    await expect(invoke(sender(), ["session.snapshot", {}])).resolves.toEqual(invalid);
    await expect(invoke(sender(), { path: "session.snapshot" })).resolves.toEqual(invalid);
    await expect(invoke(sender(), { path: 7, type: "query", input: {} })).resolves.toEqual(invalid);
    await expect(
      invoke(sender(), { path: "session.snapshot", type: "fetch", input: {} }),
    ).resolves.toEqual(invalid);
    await expect(invoke(sender(), null)).resolves.toEqual(invalid);

    await registration.close();
  });

  it("streams tracked subscription frames only to the owner and stops on cancellation", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 2 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([2]));
    fixture.emit(frame(3));
    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(
        SESSION_RPC_EVENT_CHANNEL,
        expect.objectContaining({
          kind: "data",
          subscriptionId: response.subscriptionId,
          eventId: "3",
        }),
      ),
    );

    cancel({ sender: sender(2) }, response.subscriptionId);
    expect(owner.removeListener).not.toHaveBeenCalled();
    cancel({ sender: owner }, response.subscriptionId);
    await vi.waitFor(() =>
      expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(owner.send).toHaveBeenCalledTimes(1);
    await registration.close();
  });

  it("reads and follows this Mac's log over the same bridge (VC-699)", async () => {
    const batch = {
      entries: [
        {
          cursor: "ring:2",
          record: {
            ts: "2026-10-07T00:00:00.000Z",
            level: "info" as const,
            component: "c",
            msg: "m",
          },
        },
      ],
      gap: false,
      cursor: "ring:2",
    };
    let push!: (next: typeof batch) => void;
    const registration = registerSessionRpcIpcHandlers({
      runtime: runtimeFixture().runtime,
      readLogs: () => batch,
      followLogs: (_query, listener) => {
        push = listener as (next: typeof batch) => void;
        return () => undefined;
      },
    });
    const owner = sender();
    expect(await invoke(owner, { path: "logs.tail", type: "query", input: { limit: 5 } })).toEqual({
      ok: true,
      data: batch,
    });
    const response = await invoke(owner, {
      path: "logs.follow",
      type: "subscription",
      input: { after: "ring:1" },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");
    await vi.waitFor(() => expect(push).toBeDefined());
    push(batch);
    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(SESSION_RPC_EVENT_CHANNEL, {
        kind: "data",
        subscriptionId: response.subscriptionId,
        eventId: "ring:2",
        data: batch,
      }),
    );
    await registration.close();
  });

  it("ignores a cancellation that does not name a subscription", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    cancel({ sender: owner }, 42);
    fixture.emit(frame(3));
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledTimes(1));

    await registration.close();
  });

  it("drops a subscription whose renderer announces it was destroyed", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");
    await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([0]));

    owner.destroy();
    await vi.waitFor(() => expect(fixture.isListening()).toBe(false));

    expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(owner.send).not.toHaveBeenCalled();
    await registration.close();
  });

  // The WebContents outlives a reload, a main-frame navigation and a dead
  // render process: the document that opened the stream is gone all the same,
  // so its subscription is too, and nothing of it stays attached.
  it("drops a subscription whose document reloaded, navigated away or crashed", async () => {
    for (const leave of [
      (owner: FakeSender) => owner.navigate({ isMainFrame: true, isSameDocument: false }),
      (owner: FakeSender) => owner.crash(),
    ]) {
      const fixture = runtimeFixture();
      const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
      const owner = sender();
      await invoke(owner, {
        path: "session.subscribe",
        type: "subscription",
        input: { sessionId: "session-1", afterSequence: 0 },
      });
      await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([0]));
      expect(owner.liveListeners()).toBe(2);

      leave(owner);
      await vi.waitFor(() => expect(fixture.isListening()).toBe(false));

      expect(owner.liveListeners()).toBe(0);
      expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
      expect(owner.send).not.toHaveBeenCalled();
      await registration.close();
    }
  });

  // A fragment change or a subframe navigation leaves the document that
  // subscribed in place, and its stream with it.
  it("keeps a subscription across a same-document or subframe navigation", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([0]));

    owner.navigate({ isMainFrame: true, isSameDocument: true });
    owner.navigate({ isMainFrame: false, isSameDocument: false });
    fixture.emit(frame(1));

    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledTimes(1));
    expect(fixture.isListening()).toBe(true);
    await registration.close();
    expect(owner.liveListeners()).toBe(0);
  });

  // The teardown announcement is an event, so it can still be queued when a
  // frame lands — and `webContents.send` on a destroyed WebContents throws
  // rather than being ignored. The check at the top of the pump loop is already
  // stale by the time the frame it is waiting for arrives.
  it("stops streaming to a renderer that went away before it said so", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");
    await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([0]));

    owner.isDestroyed = () => true;
    fixture.emit(frame(3));
    await vi.waitFor(() =>
      expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function)),
    );

    expect(owner.send).not.toHaveBeenCalled();
    await registration.close();
  });

  it("tears down every live subscription when the bridge closes", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");
    await vi.waitFor(() => expect(fixture.calls.subscribe).toEqual([0]));

    await registration.close();

    expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(fixture.isListening()).toBe(false);
    expect(owner.send).not.toHaveBeenCalled();
  });

  it("does not retain a subscription whose renderer is already destroyed", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    owner.isDestroyed = () => true;

    await expect(
      invoke(owner, {
        path: "session.subscribe",
        type: "subscription",
        input: { sessionId: "session-1", afterSequence: 0 },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CLIENT_CLOSED_REQUEST", message: "The peer closed" },
    });
    expect(owner.once).not.toHaveBeenCalled();
    await registration.close();
  });

  it("tells its owner when a subscription completes", async () => {
    terminalStream.current = emptyStream();
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();

    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(SESSION_RPC_EVENT_CHANNEL, {
        kind: "done",
        subscriptionId: response.subscriptionId,
      }),
    );
    await registration.close();
  });

  it("tells its owner when a subscription fails", async () => {
    terminalStream.current = failingStream(new Error("native stream closed unexpectedly"));
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();

    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(SESSION_RPC_EVENT_CHANNEL, {
        kind: "error",
        subscriptionId: response.subscriptionId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "native stream closed unexpectedly",
        },
      }),
    );
    await registration.close();
  });

  // A rejection that is not an Error has no message to sanitize and no code to
  // read, so the frame says only what is true rather than stringifying whatever
  // was thrown into the renderer.
  // tRPC's own reading of a thrown value (`getTRPCErrorFromUnknown`), through
  // the router's formatter: the envelope the WebSocket sends for it too.
  it("reports a subscription failure that threw something other than an Error", async () => {
    terminalStream.current = failingStream("native stream vanished");
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();

    const response = await invoke(owner, {
      path: "session.subscribe",
      type: "subscription",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(SESSION_RPC_EVENT_CHANNEL, {
        kind: "error",
        subscriptionId: response.subscriptionId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "native stream vanished",
        },
      }),
    );
    await registration.close();
  });

  it("routes experimental flag reads and writes over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readExperiments: () => ({ cloud: { enabled: false, source: "default" } }),
      writeExperiment: async (id, enabled) => {
        writes.push([id, enabled]);
        return { cloud: { enabled, source: "storage" } };
      },
    });

    await expect(
      invoke(sender(), { path: "settings.experiments", type: "query", input: undefined }),
    ).resolves.toEqual({
      ok: true,
      data: { cloud: { enabled: false, source: "default" } },
    });
    await expect(
      invoke(sender(), {
        path: "settings.setExperiment",
        type: "mutation",
        input: { id: "cloud", enabled: true },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { cloud: { enabled: true, source: "storage" } },
    });
    expect(writes).toEqual([["cloud", true]]);
    await registration.close();
  });

  it("rejects invalid experimental flag requests before invoking the writer", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      writeExperiment: (id, enabled) => {
        writes.push([id, enabled]);
        return { cloud: { enabled, source: "storage" } };
      },
    });

    await expect(
      invoke(sender(), {
        path: "settings.setExperiment",
        type: "mutation",
        input: { id: "unknown", enabled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    await expect(
      invoke(sender(), {
        path: "settings.setExperiment",
        type: "mutation",
        input: { id: "cloud", enabled: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(writes).toEqual([]);
    await registration.close();
  });

  it("reports when experimental flag callbacks are unavailable over IPC", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), { path: "settings.experiments", type: "query", input: undefined }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Experimental settings are unavailable on this transport",
      },
    });
    await expect(
      invoke(sender(), {
        path: "settings.setExperiment",
        type: "mutation",
        input: { id: "cloud", enabled: true },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Experimental settings are unavailable on this transport",
      },
    });
    await registration.close();
  });

  it("routes product-owned Model Access inspection over IPC", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      inspectModelAccess: async (input) => {
        calls.push(input);
        return { observedAt: 42, providers: [], models: [] };
      },
    });

    await expect(
      invoke(sender(), {
        path: "modelAccess.inspect",
        type: "query",
        input: { refresh: true },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { observedAt: 42, providers: [], models: [] },
    });
    expect(calls).toEqual([{ refresh: true }]);
    await registration.close();
  });

  it("routes the user-configured Model Access defaults over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const global = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const ticket = {
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoningLevel: "medium" as const,
    };
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readModelAccessDefaults: () => ({ ...EMPTY_MODEL_ACCESS_DEFAULTS, global }),
      writeModelAccessDefault: (purpose, selection) => {
        writes.push({ purpose, selection });
        return { ...EMPTY_MODEL_ACCESS_DEFAULTS, global, ticket: selection };
      },
    });

    await expect(
      invoke(sender(), { path: "modelAccess.defaults", type: "query", input: undefined }),
    ).resolves.toEqual({
      ok: true,
      data: { ...EMPTY_MODEL_ACCESS_DEFAULTS, global },
    });
    await expect(
      invoke(sender(), {
        path: "modelAccess.setDefault",
        type: "mutation",
        input: { purpose: "ticket", selection: ticket },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { ...EMPTY_MODEL_ACCESS_DEFAULTS, global, ticket },
    });
    expect(writes).toEqual([{ purpose: "ticket", selection: ticket }]);
    await registration.close();
  });

  it("routes the curated hidden-model list over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const hidden = [{ providerId: "anthropic", modelId: "claude-haiku" }];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readHiddenModels: () => hidden,
      writeHiddenModels: (next) => {
        writes.push(next);
      },
    });

    await expect(
      invoke(sender(), { path: "modelAccess.hiddenModels", type: "query", input: undefined }),
    ).resolves.toEqual({ ok: true, data: hidden });
    await expect(
      invoke(sender(), { path: "modelAccess.setHiddenModels", type: "mutation", input: [] }),
    ).resolves.toEqual({ ok: true, data: [] });
    expect(writes).toEqual([[]]);
    await registration.close();
  });

  it("routes the compaction policy over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const stored = { autoCompaction: true };
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readCompactionPolicy: () => stored,
      writeCompactionPolicy: (policy) => {
        writes.push(policy);
        return policy;
      },
    });

    await expect(
      invoke(sender(), { path: "modelAccess.compactionPolicy", type: "query", input: undefined }),
    ).resolves.toEqual({ ok: true, data: stored });
    const saved = { autoCompaction: false };
    await expect(
      invoke(sender(), { path: "modelAccess.setCompactionPolicy", type: "mutation", input: saved }),
    ).resolves.toEqual({ ok: true, data: saved });
    expect(writes).toEqual([saved]);
    await registration.close();
  });

  it("routes the Code Mode policy over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const stored = { enabled: true, models: { "anthropic/claude-opus-4-5": "only" as const } };
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readCodeModePolicy: () => stored,
      writeCodeModePolicy: (policy) => {
        writes.push(policy);
        return policy;
      },
    });

    await expect(
      invoke(sender(), { path: "modelAccess.codeModePolicy", type: "query", input: undefined }),
    ).resolves.toEqual({ ok: true, data: stored });
    const saved = { enabled: false, models: { "openai-codex/gpt-5.5": "both" } };
    await expect(
      invoke(sender(), { path: "modelAccess.setCodeModePolicy", type: "mutation", input: saved }),
    ).resolves.toEqual({ ok: true, data: saved });
    expect(writes).toEqual([saved]);
    await registration.close();
  });

  it("routes the picker view over IPC", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      readModelPickerView: () => "all",
      writeModelPickerView: (view) => {
        writes.push(view);
        return view;
      },
    });

    await expect(
      invoke(sender(), { path: "modelAccess.pickerView", type: "query", input: undefined }),
    ).resolves.toEqual({ ok: true, data: "all" });
    await expect(
      invoke(sender(), { path: "modelAccess.setPickerView", type: "mutation", input: "defaults" }),
    ).resolves.toEqual({ ok: true, data: "defaults" });
    expect(writes).toEqual(["defaults"]);
    await registration.close();
  });

  it("routes the create-only Session start over IPC, answering identity alone", async () => {
    // VC-16's optimistic open: this is the fast half of a chat start, and what
    // makes it fast is that it answers a Session id and nothing about an
    // executor — the attach that materializes the worktree is its own route.
    // One procedure for both Roles: the nullable ticketId IS the Role.
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      createSession: async (input) => {
        calls.push(["create", input]);
        return { sessionId: input.ticketId === null ? "session-2" : "session-1" };
      },
    });

    await expect(
      invoke(sender(), {
        path: "sessions.create",
        type: "mutation",
        input: {
          operationId: "ticket-create",
          projectId: "project-1",
          ticketId: "ticket-1",
          title: "VC-1",
        },
      }),
    ).resolves.toEqual({ ok: true, data: { sessionId: "session-1" } });
    await expect(
      invoke(sender(), {
        path: "sessions.create",
        type: "mutation",
        input: {
          operationId: "project-create",
          projectId: "project-1",
          ticketId: null,
          title: "Board chat",
        },
      }),
    ).resolves.toEqual({ ok: true, data: { sessionId: "session-2" } });

    expect(calls).toEqual([
      [
        "create",
        {
          operationId: "ticket-create",
          projectId: "project-1",
          ticketId: "ticket-1",
          title: "VC-1",
        },
      ],
      [
        "create",
        {
          operationId: "project-create",
          projectId: "project-1",
          ticketId: null,
          title: "Board chat",
        },
      ],
    ]);
    await registration.close();
  });

  it("routes the one Session reattach over IPC — no Role in the request", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      attachSession: async (input) => {
        calls.push(["attach", input]);
        return { sessionId: "session-1", state: "ready", receipt: null, throughSequence: 6 };
      },
    });

    await expect(
      invoke(sender(), {
        path: "sessions.attach",
        type: "mutation",
        input: { operationId: "retry-1", sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { sessionId: "session-1", state: "ready", receipt: null, throughSequence: 6 },
    });
    expect(calls).toEqual([["attach", { operationId: "retry-1", sessionId: "session-1" }]]);
    await registration.close();
  });
});

// The degraded bridge (VC-76): a boot whose database never opened claims the
// channel and answers with the recorded reason, instead of letting the
// renderer's invoke reject with Electron's nameless "No handler registered".
describe("registerDegradedSessionRpcIpcHandlers", () => {
  it("answers every request with the reason the runtime is down", async () => {
    const reason =
      "The local database failed to open: better-sqlite3 was built for a different Node ABI.";
    registerDegradedSessionRpcIpcHandlers(reason);

    await expect(
      invoke(sender(), {
        path: "session.snapshot",
        type: "query",
        input: { sessionId: "session-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: reason },
    });
    await expect(
      invoke(sender(), { path: "modelAccess.inspect", type: "query", input: {} }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: reason },
    });
  });

  it("claims the cancel channel as an inert listener — nothing to stop, nothing to throw", () => {
    registerDegradedSessionRpcIpcHandlers("db is down");
    expect(() => cancel({ sender: sender() }, "subscription-1")).not.toThrow();
  });
});

function emptyStream(): AsyncIterable<readonly [string, unknown]> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<readonly [string, unknown]> {
      return { next: async () => ({ done: true, value: undefined }) };
    },
  };
}

function failingStream(error: unknown): AsyncIterable<readonly [string, unknown]> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<readonly [string, unknown]> {
      return { next: async () => Promise.reject(error) };
    },
  };
}
