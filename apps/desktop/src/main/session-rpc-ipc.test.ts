import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeCatalog, SessionRuntime, SessionStreamFrame } from "@volli/session-engine";

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
          runtimeCatalog: {
            inspect: async () => {
              throw new Error("runtimeCatalog is not exercised by the streaming fixture");
            },
            save: async () => {
              throw new Error("runtimeCatalog is not exercised by the streaming fixture");
            },
            resolve: async () => {
              throw new Error("runtimeCatalog is not exercised by the streaming fixture");
            },
          },
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

import { registerSessionRpcIpcHandlers } from "./session-rpc-ipc";

interface FakeSender {
  readonly id: number;
  readonly send: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: {
    snapshot: string[];
    projection: string[];
    subscribe: number[];
    cancelled: { sessionId: string; interactionId: string; reason: string }[];
  };
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
          projection: { capabilities: [] },
          throughSequence: 0,
          frames: [],
          transcript: [],
        } as never;
      },
      projection: async ({ sessionId }) => {
        calls.projection.push(sessionId);
        return { projection: { capabilities: [] }, throughSequence: 4 } as never;
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
      refreshCapabilities: async () => ({}) as never,
      reconcile: async () => undefined,
      close: async () => undefined,
    },
    calls,
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

function runtimeCatalogFixture(): {
  resolveRuntimeCatalog: (projectId?: string) => RuntimeCatalog;
  calls: {
    resolvedFor: (string | undefined)[];
    inspected: unknown[];
    saved: unknown[];
    resolved: unknown[];
  };
} {
  const calls = {
    resolvedFor: [] as (string | undefined)[],
    inspected: [] as unknown[],
    saved: [] as unknown[],
    resolved: [] as unknown[],
  };
  const catalog: RuntimeCatalog = {
    inspect: async (input) => {
      calls.inspected.push(input);
      return { providers: [], models: [], modelTotal: 0 } as never;
    },
    save: async (input) => {
      calls.saved.push(input);
      return input.preferences;
    },
    resolve: async (input) => {
      calls.resolved.push(input);
      return {
        adapterId: input.adapterId,
        observedAt: 10,
        catalog: { providers: [], models: [], agents: [] },
        selection: { providerId: "", modelId: "", variant: "", agent: "" },
      };
    },
  };
  return {
    resolveRuntimeCatalog: (projectId) => {
      calls.resolvedFor.push(projectId);
      return catalog;
    },
    calls,
  };
}

function sender(id = 1): FakeSender {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
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
      data: { projection: { capabilities: [] }, throughSequence: 4 },
    });
    await expect(
      invoke(sender(), {
        procedure: "session.cancelInteraction",
        input: { sessionId: "session-1", interactionId: "question-1" },
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

    const cancel = listeners.get(SESSION_RPC_CANCEL_CHANNEL);
    if (!cancel) throw new Error("Session RPC cancellation handler is not registered");
    (cancel as (...args: unknown[]) => unknown)({ sender: sender(2) }, response.subscriptionId);
    expect(owner.removeListener).not.toHaveBeenCalled();
    (cancel as (...args: unknown[]) => unknown)({ sender: owner }, response.subscriptionId);
    await vi.waitFor(() =>
      expect(owner.removeListener).toHaveBeenCalledWith("destroyed", expect.any(Function)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(owner.send).toHaveBeenCalledTimes(1);
    await registration.close();
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

  it("routes runtimeCatalog.inspect over IPC, carrying the resolver through the context", async () => {
    const fixture = runtimeFixture();
    const catalog = runtimeCatalogFixture();
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: catalog.resolveRuntimeCatalog,
    });

    await expect(
      invoke(sender(), {
        procedure: "runtimeCatalog.inspect",
        input: { projectId: "project-1", adapterId: "opencode" },
      }),
    ).resolves.toEqual({ ok: true, data: { providers: [], models: [], modelTotal: 0 } });

    expect(catalog.calls.resolvedFor).toEqual(["project-1"]);
    expect(catalog.calls.inspected).toEqual([{ adapterId: "opencode" }]);
    await registration.close();
  });

  it("routes runtimeCatalog.save over IPC, carrying the resolver through the context", async () => {
    const fixture = runtimeFixture();
    const catalog = runtimeCatalogFixture();
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: catalog.resolveRuntimeCatalog,
    });
    const preferences = {
      version: 1 as const,
      enabledModels: [],
      defaults: { providerId: "", modelId: "", variant: "", agent: "" },
    };

    await expect(
      invoke(sender(), {
        procedure: "runtimeCatalog.save",
        input: { adapterId: "opencode", preferences },
      }),
    ).resolves.toEqual({ ok: true, data: preferences });

    // No `projectId` on this request — the router resolves against `undefined`.
    expect(catalog.calls.resolvedFor).toEqual([undefined]);
    expect(catalog.calls.saved).toEqual([{ adapterId: "opencode", preferences }]);
    await registration.close();
  });

  it("routes runtimeCatalog.resolve over IPC, carrying the resolver through the context", async () => {
    const fixture = runtimeFixture();
    const catalog = runtimeCatalogFixture();
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: catalog.resolveRuntimeCatalog,
    });

    await expect(
      invoke(sender(), { procedure: "runtimeCatalog.resolve", input: { adapterId: "opencode" } }),
    ).resolves.toEqual({
      ok: true,
      data: {
        adapterId: "opencode",
        observedAt: 10,
        catalog: { providers: [], models: [], agents: [] },
        selection: { providerId: "", modelId: "", variant: "", agent: "" },
      },
    });

    expect(catalog.calls.resolvedFor).toEqual([undefined]);
    expect(catalog.calls.resolved).toEqual([{ adapterId: "opencode" }]);
    await registration.close();
  });

  it("fails clearly when no resolver is registered for this transport", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({ runtime: fixture.runtime });

    await expect(
      invoke(sender(), { procedure: "runtimeCatalog.resolve", input: { adapterId: "opencode" } }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "Runtime Catalog is unavailable on this transport" },
    });
    await registration.close();
  });

  // The bridge flattens every failure into `{ code, message }`, and a caller
  // that cannot tell "this project does not exist" from "the catalog broke"
  // has to guess which one it is showing. The router raises the resolver's
  // rejection as a TRPCError, so the code has to survive the flattening — not
  // collapse into the INTERNAL_SERVER_ERROR fallback the sanitizer applies to
  // anything it cannot read a code off.
  it("carries a NOT_FOUND for an unknown project id across the bridge, code intact", async () => {
    const fixture = runtimeFixture();
    const registration = registerSessionRpcIpcHandlers({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: (projectId) => {
        throw new Error(`Unknown project ${projectId ?? "none"}`);
      },
    });

    await expect(
      invoke(sender(), {
        procedure: "runtimeCatalog.inspect",
        input: { projectId: "ghost-project", adapterId: "opencode" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Unknown project ghost-project" },
    });
    await registration.close();
  });
});

function emptyStream(): AsyncIterable<readonly [string, unknown]> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<readonly [string, unknown]> {
      return { next: async () => ({ done: true, value: undefined }) };
    },
  };
}

function failingStream(error: Error): AsyncIterable<readonly [string, unknown]> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<readonly [string, unknown]> {
      return { next: async () => Promise.reject(error) };
    },
  };
}
