import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionRuntime, SessionStreamFrame } from "@volli/session-engine";

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, (...args: never[]) => unknown>(),
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

import {
  registerSessionRpcIpcHandlers,
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type SessionRpcIpcResponse,
} from "./session-rpc-ipc";

interface FakeSender {
  readonly id: number;
  readonly send: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: { snapshot: string[]; subscribe: number[] };
  emit(nextFrame: SessionStreamFrame): void;
} {
  const calls = { snapshot: [] as string[], subscribe: [] as number[] };
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
      subscribe: async ({ afterSequence }, next) => {
        calls.subscribe.push(afterSequence);
        listener = (nextFrame) => void next(nextFrame);
        return () => {
          listener = null;
        };
      },
      cancelInteraction: async () => undefined,
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
        expect.objectContaining({ subscriptionId: response.subscriptionId, eventId: "3" }),
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
});
