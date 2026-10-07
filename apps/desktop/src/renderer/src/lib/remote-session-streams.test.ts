import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createRemoteSessionStreams,
  REMOTE_SESSION_STREAM_SLOTS,
  REMOTE_STREAM_RETRY_MS,
  type RemoteSessionStreams,
  type SessionStreamSource,
  type StreamHandlers,
} from "./remote-session-streams";

interface Opened {
  input: { sessionId: string; afterSequence?: number; lastEventId?: string };
  handlers: StreamHandlers;
  closed: boolean;
}

let opened: Opened[];
let streams: RemoteSessionStreams;
const source: SessionStreamSource = {
  subscribe(input, handlers) {
    const stream: Opened = { input, handlers, closed: false };
    opened.push(stream);
    return {
      unsubscribe: () => {
        stream.closed = true;
      },
    };
  },
};
const LIMIT = {
  data: {
    hostError: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many subscriptions",
      reason: "subscription-limit",
    },
  },
};

function core() {
  return {
    onStarted: vi.fn(),
    onData: vi.fn(),
    onError: vi.fn(),
    onComplete: vi.fn(),
  };
}

const live = () => opened.filter((stream) => !stream.closed);

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  streams = createRemoteSessionStreams({
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
});

afterEach(() => {
  streams.dispose();
  vi.useRealTimers();
});

describe("a remote Workspace's Session streams (VC-713, AM1)", () => {
  it("holds no stream for a Session off screen, and tells the core the stream stands", () => {
    const handlers = core();
    streams.wrap(source).subscribe({ sessionId: "s1", afterSequence: 4 }, handlers);
    expect(handlers.onStarted).toHaveBeenCalledOnce();
    expect(opened).toEqual([]);
  });

  it("opens the stream while the Session is on screen, and closes it when it leaves", () => {
    const handlers = core();
    streams.wrap(source).subscribe({ sessionId: "s1", afterSequence: 4 }, handlers);
    const hide = streams.show("s1");
    expect(live().map((stream) => stream.input)).toEqual([{ sessionId: "s1", afterSequence: 4 }]);
    // A reopen's own `started` is not news to the core.
    live()[0]!.handlers.onStarted();
    expect(handlers.onStarted).toHaveBeenCalledOnce();
    live()[0]!.handlers.onData({ id: "7", data: "frame" });
    expect(handlers.onData).toHaveBeenCalledWith({ id: "7", data: "frame" });
    hide();
    hide();
    expect(live()).toEqual([]);
    // Back on screen: resumed after what was delivered.
    streams.show("s1");
    expect(live()[0]!.input).toEqual({ sessionId: "s1", afterSequence: 4, lastEventId: "7" });
  });

  it("keeps a Session two panes show live until both let go", () => {
    streams.wrap(source).subscribe({ sessionId: "s1" }, core());
    const left = streams.show("s1");
    const right = streams.show("s1");
    left();
    expect(live()).toHaveLength(1);
    right();
    expect(live()).toEqual([]);
  });

  it("opens at most its slots, and gives a freed slot to the next Session on screen", () => {
    const door = streams.wrap(source);
    for (const id of ["s1", "s2", "s3"]) {
      door.subscribe({ sessionId: id }, core());
      streams.show(id);
    }
    expect(live().map((stream) => stream.input.sessionId)).toEqual(
      ["s1", "s2", "s3"].slice(0, REMOTE_SESSION_STREAM_SLOTS),
    );
    const first = opened.find((stream) => stream.input.sessionId === "s1")!;
    first.handlers.onComplete();
    expect(live().map((stream) => stream.input.sessionId)).toEqual(["s2", "s3"]);
  });

  it("parks a stream refused a slot, and asks again after a growing wait", async () => {
    const handlers = core();
    streams.wrap(source).subscribe({ sessionId: "s1" }, handlers);
    streams.show("s1");
    opened[0]!.handlers.onError(LIMIT);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(live()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS[0]!);
    expect(opened).toHaveLength(2);
    opened[1]!.handlers.onError(LIMIT);
    await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS[0]!);
    expect(opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS[1]! - REMOTE_STREAM_RETRY_MS[0]!);
    expect(opened).toHaveLength(3);
    // Data resets the wait.
    opened[2]!.handlers.onData({ id: "1", data: null });
    opened[2]!.handlers.onError(LIMIT);
    await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS[0]!);
    expect(opened).toHaveLength(4);
  });

  it("waits no longer than its longest step, however often it is refused", async () => {
    streams.wrap(source).subscribe({ sessionId: "s1" }, core());
    streams.show("s1");
    for (let attempt = 0; attempt < REMOTE_STREAM_RETRY_MS.length + 2; attempt += 1) {
      live()[0]!.handlers.onError(LIMIT);
      await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS.at(-1)!);
    }
    expect(live()).toHaveLength(1);
  });

  it("passes any other failure to the core, and frees the slot", () => {
    const door = streams.wrap(source);
    const first = core();
    door.subscribe({ sessionId: "s1" }, first);
    door.subscribe({ sessionId: "s2" }, core());
    door.subscribe({ sessionId: "s3" }, core());
    for (const id of ["s1", "s2", "s3"]) streams.show(id);
    const failure = { data: { hostError: { code: "FORBIDDEN", message: "No" } } };
    opened[0]!.handlers.onError(failure);
    expect(first.onError).toHaveBeenCalledWith(failure);
    expect(live().map((stream) => stream.input.sessionId)).toEqual(["s2", "s3"]);
  });

  it("ignores a late callback from a stream it has already closed", () => {
    const handlers = core();
    streams.wrap(source).subscribe({ sessionId: "s1" }, handlers);
    const hide = streams.show("s1");
    const old = opened[0]!;
    hide();
    old.handlers.onData({ id: "9", data: null });
    old.handlers.onError(new Error("late"));
    old.handlers.onComplete();
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onComplete).not.toHaveBeenCalled();
  });

  it("treats a stream that fails while it is opened as never live", () => {
    const sync: SessionStreamSource = {
      subscribe(_input, handlers) {
        handlers.onError(new Error("refused at once"));
        return { unsubscribe: vi.fn() };
      },
    };
    const handlers = core();
    streams.wrap(sync).subscribe({ sessionId: "s1" }, handlers);
    streams.show("s1");
    expect(handlers.onError).toHaveBeenCalledOnce();
    // The slot it never held is still free for another.
    streams.wrap(source).subscribe({ sessionId: "s2" }, core());
    streams.show("s2");
    expect(live()).toHaveLength(1);
  });

  it("ends its stream and its retry when the core lets go, once", async () => {
    const handlers = core();
    const subscription = streams.wrap(source).subscribe({ sessionId: "s1" }, handlers);
    streams.show("s1");
    opened[0]!.handlers.onError(LIMIT);
    subscription.unsubscribe();
    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(REMOTE_STREAM_RETRY_MS.at(-1)!);
    expect(opened).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const again = streams.wrap(source).subscribe({ sessionId: "s1" }, core());
    expect(live()).toHaveLength(1);
    again.unsubscribe();
    expect(live()).toEqual([]);
  });

  it("ends every stream and timer when the Workspace goes, and opens nothing after", async () => {
    const door = streams.wrap(source);
    door.subscribe({ sessionId: "s1" }, core());
    door.subscribe({ sessionId: "s2" }, core());
    streams.show("s1");
    streams.show("s2");
    opened[1]!.handlers.onError(LIMIT);
    streams.dispose();
    streams.dispose();
    expect(live()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    streams.show("s3");
    door.subscribe({ sessionId: "s3" }, core());
    expect(live()).toEqual([]);
  });
});
