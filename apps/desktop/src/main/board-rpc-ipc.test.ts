/**
 * The desktop window's board bridge (VC-565): the real board router behind a
 * fake `ipcMain`, over a handler slice the cases drive. What it owes the
 * renderer's link (`board-rpc-link.ts`): an answer or the router's own error
 * envelope per call, an ack then tracked frames per subscription, a terminal
 * frame when the stream ends, and no frame after the subscriber let go.
 */
import {
  FeedResnapshotRequiredError,
  OperationUnavailableError,
  type BoardChange,
  type HandlerCall,
  type Project,
} from "@volli/shared";
import type { BoardRouterHandlers } from "@volli/session-rpc";
import { RpcDiagnosticLog } from "@volli/session-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BoardRpcIpcEvent, BoardRpcIpcResponse } from "../ipc/contract";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));
/** A stream a case hands `board.changes` in place of the router's own generator. */
const custom = vi.hoisted(() => ({
  stream: null as AsyncIterable<readonly [string, unknown]> | null,
}));

// The real router, unless a case states a stream the router itself never
// produces: one that ends cleanly, or an iterator with no `return`.
vi.mock("@volli/session-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/session-rpc")>();
  return {
    ...actual,
    createBoardRouter: () => {
      const router = actual.createBoardRouter();
      const stated = custom.stream;
      if (stated === null) return router;
      return {
        // oxlint-disable-next-line no-underscore-dangle -- the bridge reads procedure types here.
        _def: router._def,
        createCaller: () => ({ board: { changes: async () => stated } }),
      } as unknown as typeof router;
    },
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      electron.handlers.set(channel, handler);
    },
    on(channel: string, listener: (...args: unknown[]) => unknown) {
      electron.listeners.set(channel, listener);
    },
  },
}));

const { registerBoardRpcIpcHandlers } = await import("./board-rpc-ipc");

const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EVENT_CHANNEL = "volli:board-rpc-event";

interface FakeSender {
  readonly id: number;
  readonly sent: BoardRpcIpcEvent[];
  readonly send: (channel: string, event: BoardRpcIpcEvent) => void;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
  /** Electron's teardown: the flag, then every `destroyed` listener. */
  destroy(): void;
  /** Only the flag: a window that is gone before its `destroyed` event ran. */
  markDestroyed(): void;
  listenerCount(): number;
}

let nextSenderId = 1;

function sender(options: { onSend?: (event: BoardRpcIpcEvent) => void } = {}): FakeSender {
  const destroyedListeners = new Set<() => void>();
  let destroyed = false;
  const sent: BoardRpcIpcEvent[] = [];
  return {
    id: nextSenderId++,
    sent,
    send: (channel, event) => {
      expect(channel).toBe(EVENT_CHANNEL);
      sent.push(structuredClone(event));
      options.onSend?.(event);
    },
    isDestroyed: () => destroyed,
    once: (event, listener) => {
      if (event === "destroyed") destroyedListeners.add(listener);
    },
    removeListener: (event, listener) => {
      if (event === "destroyed") destroyedListeners.delete(listener);
    },
    destroy: () => {
      destroyed = true;
      const listeners = Array.from(destroyedListeners);
      destroyedListeners.clear();
      for (const listener of listeners) listener();
    },
    markDestroyed: () => {
      destroyed = true;
    },
    listenerCount: () => destroyedListeners.size,
  };
}

function invoke(owner: FakeSender, request: unknown): Promise<BoardRpcIpcResponse> {
  const handler = electron.handlers.get("volli:board-rpc");
  if (handler === undefined) throw new Error("The board bridge is not registered");
  return handler({ sender: owner }, request) as Promise<BoardRpcIpcResponse>;
}

function cancel(owner: FakeSender, subscriptionId: unknown): void {
  const listener = electron.listeners.get("volli:board-rpc-cancel");
  if (listener === undefined) throw new Error("The board bridge's cancel is not registered");
  listener({ sender: owner }, subscriptionId);
}

async function subscribed(owner: FakeSender, lastEventId?: string): Promise<string> {
  const reply = await invoke(owner, {
    path: "board.changes",
    input: lastEventId === undefined ? { projectId: PROJECT } : { projectId: PROJECT, lastEventId },
  });
  if (!(reply.ok && "subscriptionId" in reply)) {
    throw new Error(`Expected an ack, got ${JSON.stringify(reply)}`);
  }
  return reply.subscriptionId;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function project(): Project {
  return {
    id: PROJECT,
    name: "Board",
    path: "/work/board",
    ticketPrefix: "VC",
    baseBranch: "main",
    setupCommand: null,
    themeAppearance: null,
    skillModes: {},
    sessionModel: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  } as Project;
}

type Sink = Parameters<BoardRouterHandlers["board.changes"]>[2];
type BoardFeedEmission = Parameters<Sink["emit"]>[0];

/** The handler slice the router projects, recording what reached it. */
function fakeHost() {
  const sinks: Sink[] = [];
  const afters: (string | null)[] = [];
  const calls: { key: string; input: unknown; call: HandlerCall }[] = [];
  let unsubscribed = 0;
  let changesFailure: unknown = null;
  const host = {
    calls,
    afters,
    sinks,
    unsubscribed: () => unsubscribed,
    failChangesWith(error: unknown) {
      changesFailure = error;
    },
    /** Every live sink, one batch. */
    emit(batch: BoardFeedEmission) {
      for (const sink of sinks) void sink.emit(batch);
    },
    handlers: {
      "board.snapshot": (input: { projectId: string }, call: HandlerCall) => {
        calls.push({ key: "board.snapshot", input, call });
        return { project: project(), tickets: [], labels: [], cursor: "feed:0" };
      },
      "board.createTicket": (input: { commandId: string; title: string }, call: HandlerCall) => {
        calls.push({ key: "board.createTicket", input, call });
        return {
          receipt: { commandId: input.commandId, status: "completed", replayed: false },
          throughCursor: "feed:1",
          ticket: { id: "ticket-1", title: input.title },
        };
      },
      "board.ticketBody": () => {
        throw new OperationUnavailableError("The board is unavailable: the database did not open");
      },
      "board.roster": () => {
        throw new Error("disk I/O error at /Users/someone/volli.db");
      },
      "board.changes": async (
        input: { projectId: string; after: string | null },
        call: HandlerCall,
        sink: Sink,
      ) => {
        calls.push({ key: "board.changes", input, call });
        afters.push(input.after);
        if (changesFailure !== null) throw changesFailure;
        sinks.push(sink);
        return () => {
          unsubscribed += 1;
          sinks.splice(sinks.indexOf(sink), 1);
        };
      },
    } as unknown as BoardRouterHandlers,
  };
  return host;
}

/** A stream of fixed tracked frames, then a clean end. */
function stream(frames: (readonly [string, unknown])[]): AsyncIterable<readonly [string, unknown]> {
  return (async function* () {
    for (const frame of frames) yield frame;
  })();
}

/** A stream that rejects its first pull with `reason`. */
function failing(reason: unknown): AsyncIterable<readonly [string, unknown]> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(reason) }),
  };
}

/** An iterator with no `return`, whose one pull waits until `end`. */
function pending(): { stream: AsyncIterable<readonly [string, unknown]>; end(): void } {
  const { promise: waiting, resolve } =
    Promise.withResolvers<IteratorResult<readonly [string, unknown]>>();
  return {
    stream: { [Symbol.asyncIterator]: () => ({ next: () => waiting }) },
    end: () => resolve({ done: true, value: undefined }),
  };
}

function ticketChange(id: string, commandId?: string): BoardChange {
  return {
    kind: "ticket",
    op: "upsert",
    id,
    projectId: PROJECT,
    ...(commandId === undefined ? {} : { commandId }),
  } as BoardChange;
}

let registrations: { close(): Promise<void> }[];

beforeEach(() => {
  electron.handlers.clear();
  electron.listeners.clear();
  custom.stream = null;
  registrations = [];
});

afterEach(async () => {
  for (const registration of registrations.splice(0)) await registration.close();
});

function register(host: ReturnType<typeof fakeHost>, diagnostics?: RpcDiagnosticLog) {
  const registration = registerBoardRpcIpcHandlers({
    handlers: host.handlers,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  registrations.push(registration);
  return registration;
}

describe("the board bridge's calls", () => {
  it("answers a query with the handler's data, called as the desktop's own window", async () => {
    const host = fakeHost();
    register(host);
    const reply = await invoke(sender(), {
      path: "board.snapshot",
      input: { projectId: PROJECT },
    });
    expect(reply).toEqual({
      ok: true,
      data: { project: project(), tickets: [], labels: [], cursor: "feed:0" },
    });
    expect(host.calls).toEqual([
      {
        key: "board.snapshot",
        input: { projectId: PROJECT },
        call: expect.objectContaining({ origin: "desktop-window", actor: { kind: "user" } }),
      },
    ]);
  });

  it("answers a mutation with its receipt", async () => {
    const host = fakeHost();
    register(host);
    const reply = await invoke(sender(), {
      path: "board.createTicket",
      input: { commandId: COMMAND, projectId: PROJECT, status: "todo", title: "From IPC" },
    });
    expect(reply).toEqual({
      ok: true,
      data: {
        receipt: { commandId: COMMAND, status: "completed", replayed: false },
        throughCursor: "feed:1",
        ticket: { id: "ticket-1", title: "From IPC" },
      },
    });
  });

  it.each([
    ["no request", undefined],
    ["null", null],
    ["a string", "board.snapshot"],
    ["an array", ["board.snapshot", {}]],
    ["a path that is not a string", { path: 7, input: {} }],
    ["no input", { path: "board.snapshot" }],
    ["an unknown path", { path: "board.nothing", input: {} }],
    ["a namespace, not a procedure", { path: "board", input: {} }],
    ["an inherited property", { path: "toString", input: {} }],
    ["another router's procedure", { path: "session.projection", input: {} }],
  ])("refuses %s as BAD_REQUEST, reaching no handler", async (_label, request) => {
    const host = fakeHost();
    register(host);
    expect(await invoke(sender(), request)).toEqual({
      ok: false,
      error: { code: "BAD_REQUEST", message: "Invalid board request" },
    });
    expect(host.calls).toEqual([]);
  });

  it("answers the router's BAD_REQUEST for an input the procedure refuses", async () => {
    const host = fakeHost();
    register(host);
    const reply = await invoke(sender(), {
      path: "board.createTicket",
      input: { commandId: "not-a-uuid", projectId: PROJECT, status: "todo", title: "x" },
    });
    expect(reply).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    if (reply.ok) throw new Error("unreachable");
    expect(reply.error).not.toHaveProperty("reason");
    expect(host.calls).toEqual([]);
  });

  it("carries the router's reason: an unavailable operation is operation-unavailable", async () => {
    const host = fakeHost();
    register(host);
    expect(
      await invoke(sender(), { path: "board.ticketBody", input: { ticketId: "ticket-1" } }),
    ).toEqual({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "The board is unavailable: the database did not open",
        reason: "operation-unavailable",
      },
    });
  });

  it("answers a handler's own failure with its code and sanitized message, nothing else", async () => {
    const host = fakeHost();
    register(host);
    const reply = await invoke(sender(), { path: "board.roster", input: { projectId: PROJECT } });
    expect(reply).toMatchObject({ ok: false, error: { code: "INTERNAL_SERVER_ERROR" } });
    if (reply.ok) throw new Error("unreachable");
    expect(Object.keys(reply.error).toSorted()).toEqual(["code", "message"]);
    expect(reply.error.message).not.toContain("/Users/someone");
  });
});

describe("the board bridge's subscriptions", () => {
  it("acks with an id, then sends each batch tracked by its cursor to its owner only", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const bystander = sender();
    const subscriptionId = await subscribed(owner, "feed:3");
    expect(host.afters).toEqual(["feed:3"]);
    expect(host.calls[0]?.call).toMatchObject({ origin: "desktop-window" });

    const first = { cursor: "feed:4", changes: [ticketChange("ticket-1", COMMAND)] };
    const second = { cursor: "feed:5", changes: [ticketChange("ticket-2")] };
    host.emit(first);
    host.emit(second);
    await vi.waitFor(() => expect(owner.sent).toHaveLength(2));
    expect(owner.sent).toEqual([
      { kind: "data", subscriptionId, eventId: "feed:4", data: first },
      { kind: "data", subscriptionId, eventId: "feed:5", data: second },
    ]);
    expect(bystander.sent).toEqual([]);
  });

  it("follows live with no lastEventId", async () => {
    const host = fakeHost();
    register(host);
    await subscribed(sender());
    expect(host.afters).toEqual([null]);
  });

  it("gives each subscription its own id and frames", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const first = await subscribed(owner);
    const second = await subscribed(owner);
    expect(first).not.toBe(second);
    host.emit({ cursor: "feed:1", changes: [] });
    await vi.waitFor(() => expect(owner.sent).toHaveLength(2));
    expect(owner.sent.map((event) => event.subscriptionId).toSorted()).toEqual(
      [first, second].toSorted(),
    );
  });

  it("refuses a subscription's bad input as BAD_REQUEST, opening nothing", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const reply = await invoke(owner, { path: "board.changes", input: { projectId: "" } });
    expect(reply).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect(host.calls).toEqual([]);
    expect(owner.listenerCount()).toBe(0);
  });

  it("ends a cursor the feed cannot resume with an error frame naming the resnapshot", async () => {
    const host = fakeHost();
    const diagnostics = new RpcDiagnosticLog();
    const record = vi.spyOn(diagnostics, "record");
    register(host, diagnostics);
    host.failChangesWith(new FeedResnapshotRequiredError());
    const owner = sender();
    const subscriptionId = await subscribed(owner, "elsewhere:9");
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
    expect(owner.sent[0]).toMatchObject({
      kind: "error",
      subscriptionId,
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        procedure: "board.changes",
        phase: "error",
        transport: "electron-ipc",
        code: "PRECONDITION_FAILED",
      }),
    );
    // The stream is gone: its window's teardown hook went with it.
    await vi.waitFor(() => expect(owner.listenerCount()).toBe(0));
  });

  it("ends an unavailable feed with an operation-unavailable frame", async () => {
    const host = fakeHost();
    register(host);
    host.failChangesWith(new OperationUnavailableError("The board is unavailable"));
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
    expect(owner.sent[0]).toEqual({
      kind: "error",
      subscriptionId,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "The board is unavailable",
        reason: "operation-unavailable",
      },
    });
  });

  it("ends a feed whose source failed with the router's error frame, after the frames before it", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    const batch = { cursor: "feed:1", changes: [ticketChange("ticket-1")] };
    host.emit(batch);
    host.sinks[0]!.fail(new Error("the feed broke"));
    await vi.waitFor(() => expect(owner.sent).toHaveLength(2));
    expect(owner.sent).toEqual([
      { kind: "data", subscriptionId, eventId: "feed:1", data: batch },
      {
        kind: "error",
        subscriptionId,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Board feed source failed; resubscribe to resume",
          reason: "subscription-source-failed",
        },
      },
    ]);
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
  });

  it("swallows an error frame its window cannot take", async () => {
    const host = fakeHost();
    register(host);
    let attempts = 0;
    const owner = sender({
      onSend: () => {
        attempts += 1;
        throw new Error("Object has been destroyed");
      },
    });
    await subscribed(owner);
    host.sinks[0]!.fail(new Error("the feed broke"));
    await vi.waitFor(() => expect(attempts).toBe(1));
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
  });

  it("sends a done frame when the stream ends cleanly", async () => {
    custom.stream = stream([["feed:1", { cursor: "feed:1", changes: [] }]]);
    register(fakeHost());
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    await vi.waitFor(() => expect(owner.sent).toHaveLength(2));
    expect(owner.sent).toEqual([
      { kind: "data", subscriptionId, eventId: "feed:1", data: { cursor: "feed:1", changes: [] } },
      { kind: "done", subscriptionId },
    ]);
    await vi.waitFor(() => expect(owner.listenerCount()).toBe(0));
  });

  it("sends no done frame to a window that went as the stream ended", async () => {
    const held = pending();
    custom.stream = held.stream;
    register(fakeHost());
    const owner = sender();
    await subscribed(owner);
    // Gone while the stream was waiting, before Electron ran its `destroyed` listeners.
    owner.markDestroyed();
    held.end();
    await vi.waitFor(() => expect(owner.listenerCount()).toBe(0));
    expect(owner.sent).toEqual([]);
  });

  it("names a rejection that is not an Error by the bridge's own words", async () => {
    custom.stream = failing("not an error");
    register(fakeHost());
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
    expect(owner.sent[0]).toEqual({
      kind: "error",
      subscriptionId,
      error: { code: "INTERNAL_SERVER_ERROR", message: "Board subscription failed" },
    });
  });

  it("stops a stream whose iterator has no return", async () => {
    const held = pending();
    custom.stream = held.stream;
    const registration = register(fakeHost());
    const owner = sender();
    await subscribed(owner);
    await registration.close();
    expect(owner.listenerCount()).toBe(0);
    held.end();
    await flush();
    expect(owner.sent).toEqual([]);
  });

  it("returns a stream with no return when its window closed before the ack", async () => {
    custom.stream = pending().stream;
    register(fakeHost());
    const owner = sender();
    owner.markDestroyed();
    expect(await invoke(owner, { path: "board.changes", input: { projectId: PROJECT } })).toEqual({
      ok: false,
      error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" },
    });
  });
});

describe("the board bridge's teardown", () => {
  it("stops a subscription its owner cancels, sending nothing after", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    cancel(owner, subscriptionId);
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    expect(owner.listenerCount()).toBe(0);
    host.emit({ cursor: "feed:1", changes: [] });
    await flush();
    expect(owner.sent).toEqual([]);
    // Cancelling it again finds nothing.
    cancel(owner, subscriptionId);
    await flush();
    expect(host.unsubscribed()).toBe(1);
  });

  it("ignores a cancel from another window, an unknown id and a non-string", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const subscriptionId = await subscribed(owner);
    cancel(sender(), subscriptionId);
    cancel(owner, "not-a-subscription");
    cancel(owner, 42);
    cancel(owner, { subscriptionId });
    await flush();
    expect(host.unsubscribed()).toBe(0);
    host.emit({ cursor: "feed:1", changes: [] });
    await vi.waitFor(() => expect(owner.sent).toHaveLength(1));
  });

  it("stops the stream when its window is destroyed", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    const other = sender();
    await subscribed(owner);
    await subscribed(other);
    owner.destroy();
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    host.emit({ cursor: "feed:1", changes: [] });
    await vi.waitFor(() => expect(other.sent).toHaveLength(1));
    expect(owner.sent).toEqual([]);
  });

  it("drops a batch that arrives after its window went, and says no last word to it", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    await subscribed(owner);
    // Gone before Electron ran its `destroyed` listeners.
    owner.markDestroyed();
    host.emit({ cursor: "feed:1", changes: [] });
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    expect(owner.sent).toEqual([]);
  });

  it("sends no error frame to a window that went while the stream was failing", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    await subscribed(owner);
    owner.markDestroyed();
    host.sinks[0]!.fail(new Error("the feed broke"));
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    expect(owner.sent).toEqual([]);
  });

  it("stops after a frame whose sending closed the window", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender({ onSend: () => owner.markDestroyed() });
    await subscribed(owner);
    host.emit({ cursor: "feed:1", changes: [] });
    host.emit({ cursor: "feed:2", changes: [] });
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    expect(owner.sent.map((event) => event.kind)).toEqual(["data"]);
  });

  it("stops after a frame whose sending cancelled the stream", async () => {
    const host = fakeHost();
    register(host);
    let subscriptionId = "";
    const owner = sender({ onSend: () => cancel(owner, subscriptionId) });
    subscriptionId = await subscribed(owner);
    host.emit({ cursor: "feed:1", changes: [] });
    host.emit({ cursor: "feed:2", changes: [] });
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(1));
    await flush();
    expect(owner.sent.map((event) => event.kind)).toEqual(["data"]);
  });

  it("answers CLIENT_CLOSED_REQUEST to a window that closed before its ack, and opens nothing", async () => {
    const host = fakeHost();
    register(host);
    const owner = sender();
    owner.markDestroyed();
    expect(await invoke(owner, { path: "board.changes", input: { projectId: PROJECT } })).toEqual({
      ok: false,
      error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" },
    });
    expect(owner.listenerCount()).toBe(0);
    // The stream was returned before it ever reached the feed.
    expect(host.sinks).toEqual([]);
  });

  it("close() stops every live subscription, and is idempotent", async () => {
    const host = fakeHost();
    const registration = register(host);
    const owner = sender();
    const other = sender();
    await subscribed(owner);
    await subscribed(other);
    await subscribed(other);
    await registration.close();
    await vi.waitFor(() => expect(host.unsubscribed()).toBe(3));
    expect(owner.listenerCount()).toBe(0);
    expect(other.listenerCount()).toBe(0);
    host.emit({ cursor: "feed:1", changes: [] });
    await flush();
    expect([...owner.sent, ...other.sent]).toEqual([]);
    await registration.close();
    expect(host.unsubscribed()).toBe(3);
  });
});
