import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionRuntime, SessionStreamFrame } from "@volli/session-engine";

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
}));
const { terminalStream } = vi.hoisted(() => ({
  terminalStream: { current: null as AsyncIterable<readonly [string, unknown]> | null },
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
      if (stream === null) return actual.createSessionRouter();
      return {
        createCaller: () => ({
          session: { subscribe: async () => stream },
        }),
      } as unknown as ReturnType<typeof actual.createSessionRouter>;
    },
  };
});

import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type SessionRpcIpcResponse,
} from "@volli/shared";

import {
  registerDegradedSessionRpcIpcHandlers,
  registerSessionRpcIpcHandlers,
} from "./session-rpc-ipc";

interface FakeSender {
  readonly id: number;
  readonly send: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
  /** Fires whatever `once("destroyed", …)` registered — the WebContents teardown path. */
  destroy(): void;
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: {
    snapshot: string[];
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
    projection: [] as string[],
    subscribe: [] as number[],
    cancelled: [] as { sessionId: string; interactionId: string; reason: string }[],
  };
  let listener: ((frame: SessionStreamFrame) => void) | null = null;
  return {
    runtime: {
      command: async () => ({}) as never,
      snapshot: async ({ sessionId }) => {
        calls.snapshot.push(sessionId);
        return {
          projection: {},
          throughSequence: 0,
          frames: [],
          transcript: [],
        } as never;
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
  let destroyed = false;
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.push(listener);
    }),
    removeListener: vi.fn(),
    destroy: () => {
      destroyed = true;
      for (const listener of destroyedListeners.splice(0)) listener();
    },
  };
}

function invoke(owner: FakeSender, request: unknown): Promise<SessionRpcIpcResponse> {
  const handler = handlers.get(SESSION_RPC_IPC_CHANNEL);
  if (!handler) throw new Error("Session RPC handler is not registered");
  return (handler as (...args: unknown[]) => unknown)(
    { sender: owner },
    request,
  ) as Promise<SessionRpcIpcResponse>;
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
});

describe("registerSessionRpcIpcHandlers", () => {
  it("routes a query through the Session tRPC router and marks diagnostics as Electron IPC", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), { procedure: "session.snapshot", input: { sessionId: "session-1" } }),
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

  // Electron IPC is the only transport production has, so a router procedure the
  // allow-list omits is dead there — and reads to the renderer as a caller bug
  // (`BAD_REQUEST`) rather than as a missing route.
  it("reaches every Session procedure the router publishes", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), { procedure: "session.projection", input: { sessionId: "session-1" } }),
    ).resolves.toEqual({
      ok: true,
      data: { projection: {}, throughSequence: 4 },
    });
    await expect(
      invoke(sender(), {
        procedure: "session.cancelInteraction",
        input: { sessionId: "session-1", interactionId: "question-1" },
      }),
    ).resolves.toEqual({ ok: true, data: undefined });

    await expect(
      invoke(sender(), {
        procedure: "session.command",
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
    ).resolves.toEqual({ ok: true, data: {} });
    await expect(
      invoke(sender(), {
        procedure: "session.reconcile",
        input: { sessionId: "session-1", attachmentId: "attachment-1" },
      }),
    ).resolves.toEqual({ ok: true, data: undefined });

    expect(fixture.calls.projection).toEqual(["session-1"]);
    // The reason is the router's to state, not the renderer's: this transport
    // is the user seam, and abandonment is all it can honestly report.
    expect(fixture.calls.cancelled).toEqual([
      { sessionId: "session-1", interactionId: "question-1", reason: "abandoned" },
    ]);
    await registration.close();
  });

  it("rejects unknown procedures and lets tRPC validate known procedure input", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), { procedure: "labDiagnostics.list", input: {} }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid Session RPC request" },
    });
    await expect(
      invoke(sender(), { procedure: "session.snapshot", input: { sessionId: "" } }),
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
      error: { code: "BAD_REQUEST", message: "Invalid Session RPC request" },
    };

    await expect(invoke(sender(), "session.snapshot")).resolves.toEqual(invalid);
    await expect(invoke(sender(), ["session.snapshot", {}])).resolves.toEqual(invalid);
    await expect(invoke(sender(), { procedure: "session.snapshot" })).resolves.toEqual(invalid);
    await expect(invoke(sender(), { procedure: 7, input: {} })).resolves.toEqual(invalid);

    await registration.close();
  });

  it("streams tracked subscription frames only to the owner and stops on cancellation", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      procedure: "session.subscribe",
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

  it("ignores a cancellation that does not name a subscription", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      procedure: "session.subscribe",
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
      procedure: "session.subscribe",
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

  // The teardown announcement is an event, so it can still be queued when a
  // frame lands — and `webContents.send` on a destroyed WebContents throws
  // rather than being ignored. The check at the top of the pump loop is already
  // stale by the time the frame it is waiting for arrives.
  it("stops streaming to a renderer that went away before it said so", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();
    const response = await invoke(owner, {
      procedure: "session.subscribe",
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
      procedure: "session.subscribe",
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
        procedure: "session.subscribe",
        input: { sessionId: "session-1", afterSequence: 0 },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" },
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
      procedure: "session.subscribe",
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
      procedure: "session.subscribe",
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
  it("reports a subscription failure that threw something other than an Error", async () => {
    terminalStream.current = failingStream("native stream vanished");
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });
    const owner = sender();

    const response = await invoke(owner, {
      procedure: "session.subscribe",
      input: { sessionId: "session-1", afterSequence: 0 },
    });
    if (!(response.ok && "subscriptionId" in response)) throw new Error("Expected subscription id");

    await vi.waitFor(() =>
      expect(owner.send).toHaveBeenCalledWith(SESSION_RPC_EVENT_CHANNEL, {
        kind: "error",
        subscriptionId: response.subscriptionId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Session subscription failed",
        },
      }),
    );
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
        procedure: "modelAccess.inspect",
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
      readModelAccessDefaults: () => ({ global, ticket: null, utility: null }),
      writeModelAccessDefault: (purpose, selection) => {
        writes.push({ purpose, selection });
        return { global, ticket: selection, utility: null };
      },
    });

    await expect(
      invoke(sender(), { procedure: "modelAccess.defaults", input: undefined }),
    ).resolves.toEqual({
      ok: true,
      data: { global, ticket: null, utility: null },
    });
    await expect(
      invoke(sender(), {
        procedure: "modelAccess.setDefault",
        input: { purpose: "ticket", selection: ticket },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { global, ticket, utility: null },
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
      invoke(sender(), { procedure: "modelAccess.hiddenModels", input: undefined }),
    ).resolves.toEqual({ ok: true, data: hidden });
    await expect(
      invoke(sender(), { procedure: "modelAccess.setHiddenModels", input: [] }),
    ).resolves.toEqual({ ok: true, data: [] });
    expect(writes).toEqual([[]]);
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
        procedure: "sessions.create",
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
        procedure: "sessions.create",
        input: {
          operationId: "project-create",
          projectId: "project-1",
          ticketId: null,
          title: "Scratch",
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
        { operationId: "project-create", projectId: "project-1", ticketId: null, title: "Scratch" },
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
        procedure: "sessions.attach",
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
      invoke(sender(), { procedure: "session.snapshot", input: { sessionId: "session-1" } }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: reason },
    });
    await expect(
      invoke(sender(), { procedure: "modelAccess.inspect", input: {} }),
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
