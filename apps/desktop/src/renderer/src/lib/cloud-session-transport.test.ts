/**
 * The cloud Session edge (VC-931): its reads against scripted backend
 * answers in the backend's own shapes, its stream's two live queries and its
 * viewer driven step by step, and the whole of it under the real chat core
 * (`ChatSessionClient` and the real transcript fold), so frames, bodies and
 * streamed text are checked where the chat actually draws them.
 */
import { isResnapshotRequired } from "@volli/host-protocol";
import {
  ChatSessionClient,
  createSurfaceStore,
  layerTranscriptOverlay,
  type ChatStreamEvent,
  type FlushScheduler,
} from "@volli/session-presentation";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CloudApi, CloudClient, CloudSession } from "./cloud-client";
import {
  CLOUD_NOT_CONNECTED,
  cloudChatTransport,
  cloudSessionPort,
  cloudTranscriptSource,
  createCloudSessionTransport,
  type CloudSessionPort,
  type CloudSessionTransportDeps,
  type CloudWatchResult,
} from "./cloud-session-transport";
import { CLOUD_SESSION_UNAVAILABLE } from "./cloud-session-view";
import type { CloudTranscriptReader, CloudTranscriptRequest } from "./cloud-transcript-reader";
import {
  SESSION_ID,
  appendOp,
  chunksAnswer,
  digestOf,
  historyAnswer,
  messageOf,
  referencedEvent,
  resetOp,
  snapshotAnswer,
  turnEvent,
  viewJson,
  type HistoryRow,
} from "./cloud-session.test-support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Lets every queued promise reaction run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface Watch<Args> {
  args: Args;
  push(result: CloudWatchResult): void;
  stopped: boolean;
}

class FakePort implements CloudSessionPort {
  snapshots = 0;
  snapshotAnswer: unknown = snapshotAnswer(0);
  historyAnswer: (args: { beforeSequence: number; limit: number }) => unknown = () =>
    historyAnswer([]);
  readonly historyCalls: { sessionId: string; beforeSequence: number; limit: number }[] = [];
  readonly historyWatches: Watch<{ sessionId: string; afterSequence: number; limit: number }>[] =
    [];
  readonly chunkWatches: Watch<{
    sessionId: string;
    cursors: { messageId: string; seq: number }[];
  }>[] = [];
  readonly viewer: string[] = [];
  open: (viewerId: string) => Promise<unknown> = async (viewerId) => ({
    viewerId,
    expiresAt: 0,
    heartbeatMs: 5_000,
  });
  beat: () => Promise<unknown> = async () => ({ open: true, heartbeatMs: 5_000 });
  shut: () => Promise<unknown> = async () => null;

  async snapshot(sessionId: string) {
    expect(sessionId).toBe(SESSION_ID);
    this.snapshots += 1;
    return this.snapshotAnswer;
  }

  async history(args: { sessionId: string; beforeSequence: number; limit: number }) {
    this.historyCalls.push(args);
    return this.historyAnswer(args);
  }

  readonly snapshotWatches: Watch<string>[] = [];

  watchSnapshot(sessionId: string, listener: (result: CloudWatchResult) => void) {
    const watch = { args: sessionId, push: listener, stopped: false };
    this.snapshotWatches.push(watch);
    return () => {
      watch.stopped = true;
    };
  }

  watchHistory(
    args: { sessionId: string; afterSequence: number; limit: number },
    listener: (result: CloudWatchResult) => void,
  ) {
    const watch = { args, push: listener, stopped: false };
    this.historyWatches.push(watch);
    return () => {
      watch.stopped = true;
    };
  }

  watchChunks(
    args: { sessionId: string; cursors: { messageId: string; seq: number }[] },
    listener: (result: CloudWatchResult) => void,
  ) {
    const watch = { args, push: listener, stopped: false };
    this.chunkWatches.push(watch);
    return () => {
      watch.stopped = true;
    };
  }

  openViewer(args: { viewerId: string; sessionId: string; clientSessionId: string }) {
    this.viewer.push(`open ${args.viewerId} ${args.clientSessionId}`);
    return this.open(args.viewerId);
  }

  heartbeatViewer(viewerId: string) {
    this.viewer.push(`beat ${viewerId}`);
    return this.beat();
  }

  closeViewer(viewerId: string) {
    this.viewer.push(`close ${viewerId}`);
    return this.shut();
  }

  /** The live history query now. */
  get historyWatch(): Watch<{ sessionId: string; afterSequence: number; limit: number }> {
    return this.historyWatches.at(-1)!;
  }

  get chunkWatch(): Watch<{ sessionId: string; cursors: { messageId: string; seq: number }[] }> {
    return this.chunkWatches.at(-1)!;
  }
}

class FakeClock {
  readonly timers = new Map<number, { run: () => void; ms: number }>();
  #next = 0;

  setTimeout(run: () => void, ms: number): unknown {
    this.#next += 1;
    this.timers.set(this.#next, { run, ms });
    return this.#next;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** The one pending timer's delay. */
  pending(): number[] {
    return [...this.timers.values()].map(({ ms }) => ms);
  }

  fire(): void {
    const [handle, timer] = [...this.timers.entries()][0]!;
    this.timers.delete(handle);
    timer.run();
  }
}

class ManualScheduler implements FlushScheduler {
  #flushes: (() => void)[] = [];

  schedule(flush: () => void): () => void {
    this.#flushes.push(flush);
    return () => {
      this.#flushes = this.#flushes.filter((pending) => pending !== flush);
    };
  }

  flush(): void {
    const flushes = this.#flushes;
    this.#flushes = [];
    for (const flush of flushes) flush();
  }
}

/** Bodies for whatever is asked, as `body <sequence>`. */
const everyBody: CloudTranscriptReader = async (_sessionId, requests) =>
  new Map(
    requests.map((request) => [
      request.sequence,
      messageOf(`m${request.sequence}`, `body ${request.sequence}`),
    ]),
  );

function harness() {
  const port = new FakePort();
  const clock = new FakeClock();
  const scheduler = new ManualScheduler();
  const warnings: string[] = [];
  const reads: CloudTranscriptRequest[][] = [];
  let reader: CloudTranscriptReader = everyBody;
  let viewers = 0;
  const deps: CloudSessionTransportDeps = {
    port,
    readTranscripts: (sessionId, requests) => {
      expect(sessionId).toBe(SESSION_ID);
      reads.push([...requests]);
      return reader(sessionId, requests);
    },
    scheduler,
    newCommandId: () => "command-1",
    newViewerId: () => `viewer-${(viewers += 1)}`,
    clientSessionId: "window-1",
    clock,
    warn: (message) => warnings.push(message),
  };
  return {
    port,
    clock,
    scheduler,
    warnings,
    reads,
    useReader(next: CloudTranscriptReader) {
      reader = next;
    },
    transport: createCloudSessionTransport(deps),
  };
}

function recorder() {
  const log = { started: 0, data: [] as ChatStreamEvent[], errors: [] as unknown[] };
  return {
    log,
    handlers: {
      onStarted: () => {
        log.started += 1;
      },
      onData: (event: ChatStreamEvent) => log.data.push(event),
      onError: (error: unknown) => log.errors.push(error),
      onComplete: () => {
        throw new Error("a cloud stream never completes");
      },
    },
  };
}

const rows = (...sequences: number[]): HistoryRow[] =>
  sequences.map((sequence) => ({ sequence, event: referencedEvent(sequence) }));

function value(answer: unknown): CloudWatchResult {
  return { kind: "value", value: answer };
}

/* ------------------------------------------------------------------ reads */

describe("the cloud Session reads", () => {
  it("answers a snapshot with the fold and the newest window, bodies inlined", async () => {
    const { port, reads, transport } = harness();
    port.snapshotAnswer = snapshotAnswer(
      3,
      viewJson({
        latestReply: {
          sequence: 3,
          reference: { id: "artifact-3", mediaType: null, digest: digestOf(3) },
        },
      }),
    );
    port.historyAnswer = () =>
      historyAnswer([{ sequence: 1, event: turnEvent(1, "turn.started") }, ...rows(2, 3)], true);
    const snapshot = await transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    expect(port.historyCalls).toEqual([{ sessionId: SESSION_ID, beforeSequence: 4, limit: 50 }]);
    expect(reads).toEqual([
      [
        { sequence: 2, reference: { id: "artifact-2", mediaType: null, digest: digestOf(2) } },
        { sequence: 3, reference: { id: "artifact-3", mediaType: null, digest: digestOf(3) } },
      ],
    ]);
    expect(snapshot).toMatchObject({
      projection: { session: { id: SESSION_ID }, scheduledResume: null },
      throughSequence: 3,
      before: 1,
      latestReply: { sequence: 3, text: "body 3" },
    });
    expect(snapshot.frames).toEqual([
      { sessionId: SESSION_ID, sequence: 1, event: turnEvent(1, "turn.started"), transcript: null },
      {
        sessionId: SESSION_ID,
        sequence: 2,
        event: referencedEvent(2),
        transcript: { message: messageOf("m2", "body 2") },
      },
      {
        sessionId: SESSION_ID,
        sequence: 3,
        event: referencedEvent(3),
        transcript: { message: messageOf("m3", "body 3") },
      },
    ]);
  });

  it("reads the reply's body beside the window when the reply is older than it", async () => {
    const { port, reads, transport } = harness();
    port.snapshotAnswer = snapshotAnswer(
      9,
      viewJson({
        latestReply: {
          sequence: 2,
          reference: { id: "artifact-2", mediaType: null, digest: null },
        },
      }),
    );
    port.historyAnswer = () => historyAnswer(rows(8, 9));
    const snapshot = await transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    expect(reads[0]!.map(({ sequence }) => sequence)).toEqual([8, 9, 2]);
    expect(snapshot.frames.map((frame) => (frame as { sequence: number }).sequence)).toEqual([
      8, 9,
    ]);
    expect(snapshot.before).toBeNull();
    expect(snapshot.latestReply).toEqual({ sequence: 2, text: "body 2" });
  });

  it("reads no window for a Session whose fold is at its start", async () => {
    const { port, transport } = harness();
    const snapshot = await transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    expect(port.historyCalls).toEqual([]);
    expect(snapshot).toMatchObject({
      frames: [],
      throughSequence: 0,
      before: null,
      latestReply: null,
    });
  });

  it("waits for a Session's first fold rather than refusing it at once", async () => {
    const { port, clock, transport } = harness();
    port.snapshotAnswer = snapshotAnswer(0, null);
    const reading = transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    await settle();
    const watch = port.snapshotWatches[0]!;
    expect(watch.args).toBe(SESSION_ID);
    expect(clock.pending()).toEqual([15_000]);
    watch.push({ kind: "loading" });
    watch.push(value(snapshotAnswer(0, null)));
    port.historyAnswer = () => historyAnswer(rows(1));
    watch.push(value(snapshotAnswer(1)));
    // Settled once: a later answer changes nothing.
    watch.push(value(snapshotAnswer(1, viewJson({ turnActive: true }))));
    const snapshot = await reading;
    expect(snapshot.throughSequence).toBe(1);
    expect(snapshot.projection.turnActive).toBe(false);
    expect(snapshot.frames).toHaveLength(1);
    expect(watch.stopped).toBe(true);
    expect(clock.pending()).toEqual([]);
  });

  it("gives up waiting for a first fold after a while, or on the watch's failure", async () => {
    const waiting = harness();
    waiting.port.snapshotAnswer = snapshotAnswer(0, null);
    const projection = waiting.transport.rpc.session.projection.query({ sessionId: SESSION_ID });
    await settle();
    waiting.clock.fire();
    await expect(projection).rejects.toThrow("This Session's history is still arriving");
    expect(waiting.port.snapshotWatches[0]!.stopped).toBe(true);
    waiting.port.snapshotWatches[0]!.push(value(snapshotAnswer(1)));

    const failing = harness();
    failing.port.snapshotAnswer = snapshotAnswer(0, null);
    const snapshot = failing.transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    await settle();
    const error = new Error("not_found");
    failing.port.snapshotWatches[0]!.push({ kind: "error", error });
    await expect(snapshot).rejects.toBe(error);
    expect(failing.clock.pending()).toEqual([]);

    const corrupt = harness();
    corrupt.port.snapshotAnswer = snapshotAnswer(0, null);
    const broken = corrupt.transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
    await settle();
    corrupt.port.snapshotWatches[0]!.push(value({ foldedThrough: "x", state: "{}" }));
    await expect(broken).rejects.toThrow(/malformed/u);
  });

  it("pages older history by its cursor", async () => {
    const { port, transport } = harness();
    port.historyAnswer = ({ beforeSequence }) =>
      beforeSequence === 5 ? historyAnswer(rows(3, 4), true) : historyAnswer([], true);
    const page = await transport.rpc.session.history.query({ sessionId: SESSION_ID, before: 5 });
    expect(port.historyCalls).toEqual([{ sessionId: SESSION_ID, beforeSequence: 5, limit: 50 }]);
    expect(page.before).toBe(3);
    expect(page.frames).toHaveLength(2);
    // An empty page has nothing above it, whatever it says.
    expect(await transport.rpc.session.history.query({ sessionId: SESSION_ID, before: 3 })).toEqual(
      { frames: [], before: null },
    );
  });

  it("re-reads the projection alone", async () => {
    const { port, transport } = harness();
    port.snapshotAnswer = snapshotAnswer(2, viewJson({ turnActive: true }));
    const { projection } = await transport.rpc.session.projection.query({ sessionId: SESSION_ID });
    expect(projection.turnActive).toBe(true);
    expect(port.historyCalls).toEqual([]);
  });

  it("refuses every write, create and attach", async () => {
    const { transport } = harness();
    const session = transport.rpc.session;
    const refused = [
      session.command.mutate({
        commandId: "c",
        sessionId: SESSION_ID,
        command: { kind: "executor.interrupt" },
      }),
      session.cancelQueued.mutate({ commandId: "c", sessionId: SESSION_ID, messageId: "m" }),
      session.editQueued.mutate({
        commandId: "c",
        sessionId: SESSION_ID,
        messageId: "m",
        message: messageOf("m", "x", "user"),
      }),
      session.cancelInteraction.mutate({ sessionId: SESSION_ID, interactionId: "i" }),
      session.reconcile.mutate({ sessionId: SESSION_ID, attachmentId: "a" }),
      transport.createSession({
        operationId: "o",
        projectId: "p",
        ticketId: null,
        title: null,
      }),
      transport.attachSession({ operationId: "o", sessionId: SESSION_ID }),
    ];
    for (const call of refused) await expect(call).rejects.toThrow(CLOUD_SESSION_UNAVAILABLE);
    expect(transport.streamRecovery).toBe("host-link");
    expect(transport.newCommandId()).toBe("command-1");
    expect(session.subscribeQueue).toBeUndefined();
  });
});

/* ----------------------------------------------------------------- stream */

describe("the cloud Session stream", () => {
  it("delivers new facts in order, hydrated, and moves its query to the new cursor", async () => {
    const { port, reads, transport } = harness();
    const { log, handlers } = recorder();
    transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 3 },
      handlers,
    );
    const first = port.historyWatch;
    expect(first.args).toEqual({ sessionId: SESSION_ID, afterSequence: 3, limit: 100 });
    first.push({ kind: "loading" });
    expect(log.started).toBe(0);
    first.push(
      value(historyAnswer([...rows(3, 4), { sequence: 5, status: "unknown_kind", event: null }])),
    );
    await settle();
    expect(log.started).toBe(1);
    expect(reads.at(-1)!.map(({ sequence }) => sequence)).toEqual([4]);
    expect(log.data).toEqual([
      {
        id: "4",
        data: {
          sessionId: SESSION_ID,
          sequence: 4,
          event: referencedEvent(4),
          transcript: { message: messageOf("m4", "body 4") },
        },
      },
    ]);
    // Past the unreadable fact too.
    expect(first.stopped).toBe(true);
    expect(port.historyWatch.args.afterSequence).toBe(5);
    // The old query's late answers are not this stream's any more.
    first.push(value(historyAnswer(rows(6))));
    port.historyWatch.push(value(historyAnswer([])));
    await settle();
    expect(log.data).toHaveLength(1);
    expect(log.started).toBe(1);
    expect(port.historyWatches).toHaveLength(2);
  });

  it("applies answers one at a time, in order, while bodies are read", async () => {
    const { port, transport, useReader } = harness();
    const { log, handlers } = recorder();
    const reading = deferred<ReadonlyMap<number, UIMessage>>();
    useReader(async (sessionId, requests) =>
      requests[0]!.sequence === 1 ? reading.promise : everyBody(sessionId, requests),
    );
    transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      handlers,
    );
    const watch = port.historyWatch;
    watch.push(value(historyAnswer(rows(1))));
    await settle();
    watch.push(value(historyAnswer(rows(1, 2))));
    watch.push(value(historyAnswer(rows(1, 2, 3))));
    reading.resolve(new Map<number, UIMessage>());
    await settle();
    expect(log.data.map((event) => event.id)).toEqual(["1", "2", "3"]);
    expect(port.historyWatch.args.afterSequence).toBe(3);
  });

  it("asks for a fresh snapshot when a page's bodies cannot be read", async () => {
    const { port, transport, useReader } = harness();
    const { log, handlers } = recorder();
    useReader(async () => {
      throw new Error("store down");
    });
    transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      handlers,
    );
    port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    expect(log.errors).toHaveLength(1);
    expect(isResnapshotRequired(log.errors[0])).toBe(true);
    expect((log.errors[0] as Error).message).toBe("Session history could not be read: store down");
    // The stream is over: its queries and its viewer with it.
    expect(port.historyWatch.stopped).toBe(true);
    expect(port.chunkWatch.stopped).toBe(true);
    await settle();
    expect(port.viewer).toEqual(["open viewer-1 window-1", "close viewer-1"]);

    const other = harness();
    const second = recorder();
    other.useReader(() => Promise.reject("gone"));
    other.transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      second.handlers,
    );
    other.port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    expect((second.log.errors[0] as Error).message).toBe("Session history could not be read: gone");
  });

  it("ends on the backend's error or a malformed page, without a resnapshot", async () => {
    const failing = harness();
    const failed = recorder();
    failing.transport.rpc.session.subscribe.subscribe({ sessionId: SESSION_ID }, failed.handlers);
    expect(failing.port.historyWatch.args.afterSequence).toBe(0);
    const error = new Error("not_found");
    failing.port.historyWatch.push({ kind: "error", error });
    expect(failed.log.errors).toEqual([error]);
    expect(failing.port.historyWatch.stopped).toBe(true);

    const corrupt = harness();
    const broken = recorder();
    corrupt.transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      broken.handlers,
    );
    corrupt.port.historyWatch.push(value({ events: null }));
    await settle();
    expect(broken.log.errors).toHaveLength(1);
    expect(isResnapshotRequired(broken.log.errors[0])).toBe(false);
  });

  it("delivers nothing, and reports nothing, once let go mid-read", async () => {
    const { port, transport, useReader } = harness();
    const { log, handlers } = recorder();
    const reading = deferred<ReadonlyMap<number, UIMessage>>();
    useReader(() => reading.promise);
    const subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      handlers,
    );
    port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    subscription.unsubscribe();
    subscription.unsubscribe();
    reading.resolve(new Map<number, UIMessage>());
    await settle();
    expect(log.data).toEqual([]);

    const again = harness();
    const second = recorder();
    const failing = deferred<ReadonlyMap<number, UIMessage>>();
    again.useReader(() => failing.promise);
    const other = again.transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      second.handlers,
    );
    again.port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    other.unsubscribe();
    failing.reject(new Error("late"));
    await settle();
    expect(second.log.errors).toEqual([]);
  });

  it("stops at once when its subscriber lets go from inside a delivery", async () => {
    const { port, transport } = harness();
    const delivered: string[] = [];
    let subscription: { unsubscribe(): void } | null = null;
    subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      {
        onStarted: () => undefined,
        onData: (event) => {
          delivered.push(event.id);
          subscription?.unsubscribe();
        },
        onError: () => undefined,
        onComplete: () => undefined,
      },
    );
    port.historyWatch.push(value(historyAnswer(rows(1, 2))));
    await settle();
    expect(delivered).toEqual(["1"]);
    expect(port.historyWatches).toHaveLength(1);
  });

  it("streams text as overlays from the chunk cursors, ignoring stale and loading answers", async () => {
    const { port, transport } = harness();
    const { log, handlers } = recorder();
    transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 4 },
      handlers,
    );
    const first = port.chunkWatch;
    expect(first.args).toEqual({ sessionId: SESSION_ID, cursors: [] });
    first.push({ kind: "loading" });
    first.push(
      value(
        chunksAnswer([
          {
            messageId: "m9",
            chunks: [{ seq: 0, baseline: true, throughSequence: 4, ops: [resetOp("m9", "Hi")] }],
          },
        ]),
      ),
    );
    expect(log.data).toEqual([
      {
        id: "4",
        data: {
          kind: "overlay",
          sessionId: SESSION_ID,
          throughSequence: 4,
          messageId: "m9",
          delta: resetOp("m9", "Hi"),
        },
      },
    ]);
    expect(first.stopped).toBe(true);
    expect(port.chunkWatch.args.cursors).toEqual([{ messageId: "m9", seq: 0 }]);
    first.push(
      value(chunksAnswer([{ messageId: "m9", chunks: [{ seq: 1, ops: [appendOp("!")] }] }])),
    );
    expect(log.data).toHaveLength(1);
    // An answer that moves nothing keeps the query where it is.
    port.chunkWatch.push(value(chunksAnswer([])));
    expect(port.chunkWatches).toHaveLength(2);
  });

  it("stops at once when its subscriber lets go from inside an overlay", () => {
    const { port, transport } = harness();
    let subscription: { unsubscribe(): void } | null = null;
    const delivered: unknown[] = [];
    subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      {
        onStarted: () => undefined,
        onData: (event) => {
          delivered.push(event.data);
          subscription?.unsubscribe();
        },
        onError: () => undefined,
        onComplete: () => undefined,
      },
    );
    port.chunkWatch.push(
      value(
        chunksAnswer([
          {
            messageId: "m1",
            chunks: [
              { seq: 0, baseline: true, ops: [resetOp("m1", "a")] },
              { seq: 1, ops: [appendOp("b")] },
            ],
          },
        ]),
      ),
    );
    expect(delivered).toHaveLength(1);
    expect(port.chunkWatches).toHaveLength(1);
    expect(port.chunkWatch.stopped).toBe(true);
  });

  it("drops streamed text on a failed chunk read, and resumes it with the next fact", async () => {
    const { port, transport, warnings } = harness();
    const { log, handlers } = recorder();
    transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      handlers,
    );
    port.chunkWatch.push({ kind: "error", error: new Error("since failed") });
    expect(port.chunkWatch.stopped).toBe(true);
    expect(warnings).toEqual([
      "[cloud-session] streamed text stopped; it resumes with the next fact",
    ]);
    expect(log.errors).toEqual([]);
    port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    expect(port.chunkWatches).toHaveLength(2);
    expect(port.chunkWatch.stopped).toBe(false);
    port.chunkWatch.push(value({ streams: "nope" }));
    expect(warnings).toHaveLength(2);
    expect(port.chunkWatch.stopped).toBe(true);
    // A history answer that delivers nothing new does not restart it.
    port.historyWatch.push(value(historyAnswer(rows(1))));
    await settle();
    expect(port.chunkWatches).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------- viewer */

describe("the stream's viewer", () => {
  it("opens with the stream, renews on the lease's heartbeat, and closes with it", async () => {
    const { port, clock, warnings, transport } = harness();
    const subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      recorder().handlers,
    );
    await settle();
    expect(port.viewer).toEqual(["open viewer-1 window-1"]);
    expect(clock.pending()).toEqual([5_000]);
    // A lease asking for less than a second is not believed.
    port.beat = async () => ({ open: true, heartbeatMs: 10 });
    clock.fire();
    await settle();
    expect(clock.pending()).toEqual([20_000]);
    // Lapsed: open it again.
    port.beat = async () => ({ open: false });
    port.open = async () => null;
    clock.fire();
    await settle();
    expect(port.viewer.slice(-2)).toEqual(["beat viewer-1", "open viewer-1 window-1"]);
    expect(clock.pending()).toEqual([20_000]);
    // A failed renewal is logged and tried again later.
    port.beat = async () => {
      throw new Error("offline");
    };
    clock.fire();
    await settle();
    expect(warnings).toEqual(["[cloud-session] couldn't keep a viewer open"]);
    expect(clock.pending()).toEqual([20_000]);
    subscription.unsubscribe();
    expect(clock.pending()).toEqual([]);
    await settle();
    expect(port.viewer.at(-1)).toBe("close viewer-1");
  });

  it("closes a viewer whose open was still in flight, after the open lands", async () => {
    const { port, clock, warnings, transport } = harness();
    const opening = deferred<unknown>();
    port.open = () => opening.promise;
    const subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      recorder().handlers,
    );
    await settle();
    subscription.unsubscribe();
    await settle();
    expect(port.viewer).toEqual(["open viewer-1 window-1"]);
    opening.resolve({ heartbeatMs: 5_000 });
    await settle();
    expect(port.viewer).toEqual(["open viewer-1 window-1", "close viewer-1"]);
    // Nothing renews a viewer that was let go.
    expect(clock.pending()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("says nothing of an open that fails after the stream ended, and still closes", async () => {
    const { port, warnings, transport } = harness();
    const opening = deferred<unknown>();
    port.open = () => opening.promise;
    port.shut = async () => {
      throw new Error("close failed");
    };
    const subscription = transport.rpc.session.subscribe.subscribe(
      { sessionId: SESSION_ID, afterSequence: 0 },
      recorder().handlers,
    );
    await settle();
    subscription.unsubscribe();
    opening.reject(new Error("too_many_viewers"));
    await settle();
    expect(port.viewer).toEqual(["open viewer-1 window-1", "close viewer-1"]);
    expect(warnings).toEqual(["[cloud-session] couldn't close a viewer"]);
  });

  it("sends nothing for a stream let go before its viewer opened", async () => {
    const { port, transport } = harness();
    transport.rpc.session.subscribe
      .subscribe({ sessionId: SESSION_ID, afterSequence: 0 }, recorder().handlers)
      .unsubscribe();
    await settle();
    expect(port.viewer).toEqual([]);
  });
});

/* ------------------------------------------------------- the chat core */

describe("under the chat core", () => {
  it("shows the window, then live facts and streamed text, and reloads on an unreadable page", async () => {
    const { port, scheduler, transport, useReader } = harness();
    port.snapshotAnswer = snapshotAnswer(2);
    port.historyAnswer = () => historyAnswer(rows(1, 2));
    const store = createSurfaceStore();
    store.getState().seed(SESSION_ID, "ready");
    const notes: string[] = [];
    const client = new ChatSessionClient(SESSION_ID, {
      ...transport,
      store,
      notify: (message) => notes.push(message),
      renameSession: () => undefined,
    });
    await client.connect();
    const slice = () => store.getState().sessions[SESSION_ID]!;
    expect(slice().transcript.durableMessages.map((message) => message.id)).toEqual(["m1", "m2"]);

    port.historyWatch.push(value(historyAnswer(rows(3))));
    await settle();
    port.chunkWatch.push(
      value(
        chunksAnswer([
          {
            messageId: "m9",
            chunks: [
              { seq: 0, baseline: true, throughSequence: 3, ops: [resetOp("m9", "Typing")] },
            ],
          },
        ]),
      ),
    );
    scheduler.flush();
    const drawn = layerTranscriptOverlay(
      slice().transcript.durableMessages,
      slice().transcript.overlay,
    );
    expect(drawn.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m9"]);
    expect(drawn.at(-1)!.parts).toEqual([{ type: "text", text: "Typing" }]);

    let failures = 1;
    useReader(async (sessionId, requests) => {
      if (failures-- > 0) throw new Error("store down");
      return everyBody(sessionId, requests);
    });
    port.historyWatch.push(value(historyAnswer(rows(4))));
    await settle();
    // A quiet reload, not a band.
    expect(port.snapshots).toBe(2);
    expect(notes).toEqual([]);
    expect(slice().sessionError).toBeNull();
    client.dispose();
    await settle();
    expect(port.historyWatches.every((watch) => watch.stopped)).toBe(true);
    expect(port.viewer.filter((entry) => entry.startsWith("close"))).toHaveLength(2);
  });
});

/* ------------------------------------------------------- over Convex */

interface ClientCall {
  kind: "query" | "mutation" | "action" | "watch";
  ref: string;
  args: unknown;
}

/** Function references as their names: `sessions.snapshot`, … */
function names(module: string, ...functions: string[]): Record<string, string> {
  return Object.fromEntries(functions.map((name) => [name, `${module}.${name}`]));
}

/** A Convex client double: function references are their names. */
function fakeClient() {
  const calls: ClientCall[] = [];
  const watches: {
    ref: string;
    result: () => unknown;
    update: (() => void) | null;
    stopped: boolean;
  }[] = [];
  const answers = new Map<string, unknown>();
  const client = {
    query: async (ref: string, args: unknown) => {
      calls.push({ kind: "query", ref, args });
      return answers.get(ref);
    },
    mutation: async (ref: string, args: unknown) => {
      calls.push({ kind: "mutation", ref, args });
      return answers.get(ref) ?? null;
    },
    action: async (ref: string, args: unknown) => {
      calls.push({ kind: "action", ref, args });
      return answers.get(ref);
    },
    watchQuery: (ref: string, args: unknown) => {
      calls.push({ kind: "watch", ref, args });
      const watch = {
        ref,
        result: (): unknown => undefined,
        update: null as (() => void) | null,
        stopped: false,
      };
      watches.push(watch);
      return {
        onUpdate(callback: () => void) {
          watch.update = callback;
          return () => {
            watch.stopped = true;
          };
        },
        localQueryResult: () => watch.result(),
      };
    },
  };
  const api = {
    sessions: names("sessions", "snapshot", "history"),
    streamChunks: names("streamChunks", "since"),
    sessionViewers: names("sessionViewers", "open", "heartbeat", "close"),
    sessionTranscript: names("sessionTranscript", "artifacts", "segments", "presignGet"),
  };
  const session: CloudSession = {
    client: client as unknown as CloudClient,
    api: api as unknown as CloudApi,
  };
  return { session, calls, watches, answers };
}

describe("over the Convex client", () => {
  it("calls the backend's functions with the port's arguments", async () => {
    const { session, calls } = fakeClient();
    const port = cloudSessionPort(session);
    await port.snapshot(SESSION_ID);
    port.watchSnapshot(SESSION_ID, () => undefined)();
    await port.history({ sessionId: SESSION_ID, beforeSequence: 4, limit: 50 });
    await port.openViewer({ viewerId: "v", sessionId: SESSION_ID, clientSessionId: "w" });
    await port.heartbeatViewer("v");
    await port.closeViewer("v");
    port.watchHistory({ sessionId: SESSION_ID, afterSequence: 1, limit: 100 }, () => undefined)();
    port.watchChunks({ sessionId: SESSION_ID, cursors: [] }, () => undefined)();
    expect(calls).toEqual([
      { kind: "query", ref: "sessions.snapshot", args: { sessionId: SESSION_ID } },
      { kind: "watch", ref: "sessions.snapshot", args: { sessionId: SESSION_ID } },
      {
        kind: "query",
        ref: "sessions.history",
        args: { sessionId: SESSION_ID, beforeSequence: 4, limit: 50 },
      },
      {
        kind: "mutation",
        ref: "sessionViewers.open",
        args: { viewerId: "v", sessionId: SESSION_ID, clientSessionId: "w" },
      },
      { kind: "mutation", ref: "sessionViewers.heartbeat", args: { viewerId: "v" } },
      { kind: "mutation", ref: "sessionViewers.close", args: { viewerId: "v" } },
      {
        kind: "watch",
        ref: "sessions.history",
        args: { sessionId: SESSION_ID, afterSequence: 1, limit: 100 },
      },
      { kind: "watch", ref: "streamChunks.since", args: { sessionId: SESSION_ID, cursors: [] } },
    ]);
  });

  it("follows a live query: a held result at once, then each update, its error, and its end", async () => {
    const { session, watches } = fakeClient();
    const results: CloudWatchResult[] = [];
    const stop = cloudSessionPort(session).watchHistory(
      { sessionId: SESSION_ID, afterSequence: 0, limit: 100 },
      (result) => results.push(result),
    );
    const watch = watches[0]!;
    watch.result = () => ({ events: [], hasMore: false });
    await settle();
    expect(results).toEqual([{ kind: "value", value: { events: [], hasMore: false } }]);
    watch.result = () => undefined;
    watch.update!();
    const error = new Error("query failed");
    watch.result = () => {
      throw error;
    };
    watch.update!();
    expect(results.slice(1)).toEqual([{ kind: "loading" }, { kind: "error", error }]);
    stop();
    stop();
    expect(watch.stopped).toBe(true);
    watch.update!();
    expect(results).toHaveLength(3);
  });

  it("reads transcript objects through the client and the object store", async () => {
    const { session, calls } = fakeClient();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toEqual({ method: "GET", headers: { "x-amz": "1" } });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const source = cloudTranscriptSource(session, fetcher as unknown as typeof fetch);
    await source.artifacts(SESSION_ID, [digestOf(1)]);
    await source.segments(SESSION_ID, 5, 16);
    await source.presignGet(SESSION_ID, { kind: "pack", segmentId: "s" });
    expect(calls).toEqual([
      {
        kind: "query",
        ref: "sessionTranscript.artifacts",
        args: { sessionId: SESSION_ID, digests: [digestOf(1)] },
      },
      {
        kind: "query",
        ref: "sessionTranscript.segments",
        args: { sessionId: SESSION_ID, beforeSequence: 5, limit: 16 },
      },
      {
        kind: "action",
        ref: "sessionTranscript.presignGet",
        args: { sessionId: SESSION_ID, object: { kind: "pack", segmentId: "s" } },
      },
    ]);
    expect(await source.download({ url: "https://store/p", headers: { "x-amz": "1" } })).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    fetcher.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(
      source.download({ url: "https://store/p", headers: { "x-amz": "1" } }),
    ).rejects.toThrow("The transcript store answered 403");
    // zstd for real: "hello", compressed by zstd itself.
    const hello = Uint8Array.from(Buffer.from("28b52ffd200529000068656c6c6f", "hex"));
    const plain = source.decompress(hello);
    expect(new TextDecoder().decode(plain)).toBe("hello");
    expect(await source.sha256Hex(plain)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    source.warn("unreadable");
    expect(warn).toHaveBeenCalledWith("unreadable");
  });

  it("downloads with the window's fetch by default", async () => {
    const { session } = fakeClient();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([7])));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await cloudTranscriptSource(session).download({ url: "https://store/x", headers: {} }),
    ).toEqual(new Uint8Array([7]));
    expect(fetcher).toHaveBeenCalledWith("https://store/x", { method: "GET", headers: {} });
  });
});

/* -------------------------------------------------- the app's transport */

describe("cloudChatTransport", () => {
  it("refuses everything, without IPC, while no client runs", async () => {
    vi.stubGlobal("window", {});
    const transport = cloudChatTransport(null);
    const session = transport.rpc.session;
    for (const call of [
      session.snapshot.query({ sessionId: SESSION_ID }),
      session.history.query({ sessionId: SESSION_ID, before: 2 }),
      session.projection.query({ sessionId: SESSION_ID }),
      session.reconcile.mutate({ sessionId: SESSION_ID, attachmentId: "a" }),
      transport.createSession({ operationId: "o", projectId: "p", ticketId: null, title: null }),
      transport.attachSession({ operationId: "o", sessionId: SESSION_ID }),
    ]) {
      await expect(call).rejects.toThrow(CLOUD_NOT_CONNECTED);
    }
    const { log, handlers } = recorder();
    session.subscribe.subscribe({ sessionId: SESSION_ID }, handlers);
    const quiet = recorder();
    session.subscribe.subscribe({ sessionId: SESSION_ID }, quiet.handlers).unsubscribe();
    await settle();
    expect((log.errors[0] as Error).message).toBe(CLOUD_NOT_CONNECTED);
    expect(quiet.log.errors).toEqual([]);
    expect(transport.streamRecovery).toBe("host-link");
    expect(transport.newCommandId()).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("runs over the client, one body cache per client, one window id", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { session, calls, answers } = fakeClient();
    answers.set("sessions.snapshot", snapshotAnswer(1));
    answers.set("sessions.history", historyAnswer(rows(1)));
    answers.set("sessionTranscript.artifacts", [
      {
        digest: digestOf(1),
        status: "inline",
        mediaType: "x",
        bytes: 1,
        body: JSON.stringify(messageOf("m1", "hi")),
      },
    ]);
    answers.set("sessionViewers.open", { heartbeatMs: 1_000 });
    const first = cloudChatTransport(session);
    const second = cloudChatTransport(session);
    expect(first.newCommandId()).toMatch(/^[0-9a-f-]{36}$/u);
    for (const transport of [first, second]) {
      const snapshot = await transport.rpc.session.snapshot.query({ sessionId: SESSION_ID });
      expect(snapshot.frames).toHaveLength(1);
    }
    expect(calls.filter((call) => call.ref === "sessionTranscript.artifacts")).toHaveLength(1);

    const subscriptions = [first, second].map((transport) =>
      transport.rpc.session.subscribe.subscribe(
        { sessionId: SESSION_ID, afterSequence: 1 },
        recorder().handlers,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    const opens = calls.filter((call) => call.ref === "sessionViewers.open");
    const [one, two] = opens.map(
      (call) => call.args as { viewerId: string; clientSessionId: string },
    );
    expect(one!.viewerId).not.toBe(two!.viewerId);
    expect(one!.clientSessionId).toBe(two!.clientSessionId);
    answers.set("sessionViewers.heartbeat", { open: true, heartbeatMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((call) => call.ref === "sessionViewers.heartbeat")).toHaveLength(2);
    session.client.mutation = (async () => {
      throw new Error("offline");
    }) as unknown as CloudClient["mutation"];
    for (const subscription of subscriptions) subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith("[cloud-session] couldn't close a viewer", expect.any(Error));
  });
});
