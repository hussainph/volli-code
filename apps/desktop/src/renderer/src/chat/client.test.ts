/**
 * The resident Session core, driven through the seams it declares.
 *
 * Everything effectful is injected, so these run against a real store and a real
 * fold with a scripted RPC edge and a flush the test decides the moment of.
 * That is the point of the shape: the behaviours worth protecting here — one
 * store write per batch, a reconnect that resumes rather than replays, a queued
 * message that leaves exactly once — are all about *when* things happen, and
 * none of them is observable through a component.
 */
import type { CommandReceipt, ModelSelection, SessionPresentationProjection } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  browserChatTransport,
  isDeliverable,
  isWorking,
  racingFlushScheduler,
  settledLifecycle,
  type ChatCommandRequest,
  type ChatSessionRpc,
  type ChatSessionSlice,
  type ChatStreamCursor,
  type FlushHost,
  type FlushScheduler,
} from "@renderer/chat/client";
import { getChatClient } from "@renderer/chat/registry";
import { EMPTY_TRANSCRIPT } from "@renderer/chat/transcript";
import { rejectedReceipt } from "@renderer/chat/wire";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/* ------------------------------------------------------------------ scripts */

const SESSION = { id: "durable", projectId: "p1", ticketId: null, title: null, createdAt: 0 };
const ACCEPTED_RECEIPT: CommandReceipt = {
  id: "receipt-accepted",
  commandId: "command-accepted",
  status: "accepted",
  acceptedAt: 0,
  result: { kind: "session.signaled", sessionId: SESSION.id },
  recordedAt: 0,
  sequence: 1,
};
const REJECTED_RECEIPT: CommandReceipt = {
  id: "receipt-rejected",
  commandId: "command-rejected",
  status: "rejected",
  code: "adapter_unavailable",
  detail: "Pi is unavailable",
  recordedAt: 0,
  sequence: 1,
};
const ACCEPTED = { sessionId: SESSION.id, receipt: ACCEPTED_RECEIPT };
const REFUSED = {
  sessionId: SESSION.id,
  receipt: REJECTED_RECEIPT,
};

/**
 * The durable policy every structured Session records before anything attaches
 * — a project chat's from the app default, a Ticket Session's the same. A
 * projection without one is a Session whose model has not been written down,
 * which is what the deliverability tests below vary.
 */
const MODEL_POLICY: ModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoningLevel: "high",
};

/**
 * A projection as it actually crosses the edge: the presentation shape, with
 * executor identity reduced to `{ id }` and no command/receipt history. The
 * full `SessionProjection` never reaches this client, so a fixture built from
 * one would exercise fields the edge deliberately withholds.
 */
function projectionFor(attachmentId: string | null): SessionPresentationProjection {
  return {
    session: SESSION,
    status: "open",
    liveExecutor: attachmentId === null ? null : { id: attachmentId },
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    modelSelection: MODEL_POLICY,
    turnActive: false,
    lastActivityAt: SESSION.createdAt,
    bornTicketless: SESSION.ticketId === null,
  };
}

/** The renderer-safe payload each kind actually crosses the edge with. */
function payloadOf(kind: string): Record<string, unknown> {
  switch (kind) {
    case "turn.started":
    case "turn.completed":
    case "turn.interrupted":
      return { kind, attachmentId: "attach-1", turnId: "turn-1" };
    case "interaction.opened":
      return {
        kind,
        interaction: {
          id: "ask:call-1",
          attachmentId: "attach-1",
          kind: "permission",
          title: "Allow write?",
          detail: null,
          options: [],
          multiple: false,
          native: { id: null, detail: null },
        },
      };
    case "attention.raised":
      return {
        kind,
        attention: {
          kind: "input_required",
          id: "attention-1",
          attachmentId: null,
          detail: null,
          diagnostic: null,
        },
      };
    case "transcript.referenced":
      return {
        kind,
        attachmentId: null,
        turnId: null,
        reference: { id: "sha256:artifact", mediaType: null, digest: null },
      };
    default:
      return { kind };
  }
}

/** A durable frame as it crosses the edge: loose JSON the wire reader validates. */
function frameOf(sequence: number, kind: string): unknown {
  return {
    sessionId: SESSION.id,
    sequence,
    event: {
      id: `event-${sequence}`,
      sessionId: SESSION.id,
      sequence,
      occurredAt: sequence,
      recordedAt: sequence,
      provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
      payload: payloadOf(kind),
    },
    transcript: null,
  };
}

function transcriptFrameOf(sequence: number, messageId: string): unknown {
  return {
    ...(frameOf(sequence, "transcript.referenced") as Record<string, unknown>),
    transcript: {
      message: { id: messageId, role: "assistant", parts: [{ type: "text", text: "settled" }] },
    },
  };
}

function overlayOf(throughSequence: number, messageId: string, text: string): unknown {
  return {
    kind: "overlay",
    sessionId: SESSION.id,
    throughSequence,
    messageId,
    delta: {
      op: "reset",
      message: {
        id: messageId,
        role: "assistant",
        parts: [{ key: "t0", part: { type: "text", text } }],
      },
    },
  };
}

function sliceOf(overrides: Partial<ChatSessionSlice> = {}): ChatSessionSlice {
  return {
    projection: null,
    transcript: EMPTY_TRANSCRIPT,
    lifecycle: "ready",
    sessionError: null,
    queue: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------- fakes */

interface CommandAnswer {
  sessionId: string;
  receipt?: CommandReceipt | null;
  state?: "ready" | "needs-recovery";
  throughSequence?: number;
}

class FakeStream {
  unsubscribed = false;
  constructor(
    readonly input: ChatStreamCursor,
    readonly handlers: {
      onStarted(): void;
      onData(event: { id: string; data: unknown }): void;
      onError(error: unknown): void;
      onComplete(): void;
    },
  ) {}
  start(): void {
    this.handlers.onStarted();
  }
  send(id: string, data: unknown): void {
    this.handlers.onData({ id, data });
  }
  fail(error: unknown): void {
    this.handlers.onError(error);
  }
  complete(): void {
    this.handlers.onComplete();
  }
}

class FakeRpc implements ChatSessionRpc {
  readonly commands: ChatCommandRequest[] = [];
  readonly cancels: { sessionId: string; interactionId: string }[] = [];
  readonly reconciles: { sessionId: string; attachmentId: string }[] = [];
  readonly streams: FakeStream[] = [];
  readonly attaches: Array<{ operationId: string; sessionId: string }> = [];
  projectionQueries = 0;

  snapshotFrames: readonly unknown[] = [];
  snapshotThrough = 0;
  snapshotProjection = projectionFor(null);
  snapshotGate: Promise<unknown> = Promise.resolve();
  snapshotError: Error | null = null;

  liveProjection = projectionFor(null);
  projectionGate: Promise<unknown> = Promise.resolve();
  projectionError: Error | null = null;

  answer: (request: ChatCommandRequest) => CommandAnswer | Promise<CommandAnswer> = () => ACCEPTED;
  answerAttach: () => CommandAnswer | Promise<CommandAnswer> = () => ACCEPTED;
  answerCancel: () => unknown = () => ACCEPTED;
  answerReconcile: () => unknown = () => ACCEPTED;
  /** Runs inside `subscribe`, before the caller holds the handle. */
  onSubscribe: ((stream: FakeStream) => void) | null = null;

  readonly session: ChatSessionRpc["session"];

  constructor() {
    this.session = {
      snapshot: {
        query: async () => {
          await this.snapshotGate;
          if (this.snapshotError !== null) throw this.snapshotError;
          return {
            projection: this.snapshotProjection,
            frames: this.snapshotFrames,
            throughSequence: this.snapshotThrough,
          };
        },
      },
      projection: {
        query: async () => {
          this.projectionQueries += 1;
          await this.projectionGate;
          if (this.projectionError !== null) throw this.projectionError;
          return { projection: this.liveProjection };
        },
      },
      subscribe: {
        subscribe: (input, handlers) => {
          const stream = new FakeStream(input, handlers);
          this.streams.push(stream);
          this.onSubscribe?.(stream);
          return {
            unsubscribe: () => {
              stream.unsubscribed = true;
            },
          };
        },
      },
      command: {
        mutate: async (input) => {
          this.commands.push(input);
          return this.answer(input);
        },
      },
      cancelInteraction: {
        mutate: async (input) => {
          this.cancels.push(input);
          return this.answerCancel();
        },
      },
      reconcile: {
        mutate: async (input) => {
          this.reconciles.push(input);
          return this.answerReconcile();
        },
      },
    };
  }

  submissions(): ChatCommandRequest[] {
    return this.commands.filter((request) => request.command.kind === "message.submit");
  }
}

class ManualScheduler implements FlushScheduler {
  pending: (() => void) | null = null;
  cancelled = 0;
  schedule(flush: () => void): () => void {
    this.pending = flush;
    return () => {
      this.pending = null;
      this.cancelled += 1;
    };
  }
  /** Runs the batch the client is holding. Fails loudly when nothing is pending. */
  paint(): void {
    const flush = this.pending;
    if (flush === null) throw new Error("no flush was scheduled");
    this.pending = null;
    flush();
  }
}

/* ------------------------------------------------------------------ harness */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let sessionCounter = 0;
const open: { close(): void }[] = [];

afterEach(() => {
  for (const session of open) session.close();
  open.length = 0;
});

/** One adopted Session, connected, with its stream ready to be driven. */
async function adopted(prepare: (rpc: FakeRpc) => void = () => undefined) {
  const rpc = new FakeRpc();
  const scheduler = new ManualScheduler();
  prepare(rpc);
  let commandIds = 0;
  const store = createChatSessionsStore(() => ({
    rpc,
    scheduler,
    newCommandId: () => `cmd-${++commandIds}`,
    createSession: async () => {
      throw new Error("adopted fixtures do not start Sessions");
    },
    attachSession: async (input) => {
      rpc.attaches.push(input);
      const answer = await rpc.answerAttach();
      return {
        sessionId: answer.sessionId,
        state: answer.state ?? (rejectedReceipt(answer) === null ? "ready" : "needs-recovery"),
        receipt: answer.receipt ?? null,
        throughSequence: answer.throughSequence ?? 1,
      };
    },
  }));
  const sessionId = `session-${++sessionCounter}`;
  open.push({ close: () => store.getState().closeChatSession(sessionId) });
  store.getState().adoptChatSession(sessionId);
  const client = getChatClient(sessionId)!;
  await settle();
  const slice = () => store.getState().sessions[sessionId];
  return { client, rpc, scheduler, store, sessionId, slice, stream: () => rpc.streams.at(-1)! };
}

/** Every distinct slice the store published, for counting writes per batch. */
function watchSlices(
  store: ReturnType<typeof createChatSessionsStore>,
  sessionId: string,
): ChatSessionSlice[] {
  const writes: ChatSessionSlice[] = [];
  store.subscribe(() => {
    const slice = store.getState().sessions[sessionId];
    if (slice !== undefined && slice !== writes.at(-1)) writes.push(slice);
  });
  return writes;
}

/* ------------------------------------------------------------------- pacing */

/** A window that hands out callbacks and never runs them; the test decides. */
function fakeHost() {
  const host = {
    frames: [] as (() => void)[],
    timers: [] as (() => void)[],
    cancelledFrames: [] as number[],
    clearedTimers: [] as number[],
    requestAnimationFrame(callback: () => void) {
      host.frames.push(callback);
      return host.frames.length;
    },
    cancelAnimationFrame(handle: number) {
      host.cancelledFrames.push(handle);
    },
    setTimeout(callback: () => void) {
      host.timers.push(callback);
      return host.timers.length;
    },
    clearTimeout(handle: number) {
      host.clearedTimers.push(handle);
    },
  };
  return host satisfies FlushHost & Record<string, unknown>;
}

describe("racingFlushScheduler", () => {
  it("folds on the frame callback while the surface is painting", () => {
    const host = fakeHost();
    let folded = 0;
    racingFlushScheduler(host).schedule(() => {
      folded += 1;
    });

    host.frames[0]!();

    expect(folded).toBe(1);
    expect(host.clearedTimers).toEqual([1]);
  });

  it("folds on the timer when the window is occluded and no frame ever comes", () => {
    // The whole reason the timer is there: an occluded Electron window stops
    // firing frame callbacks, and a resident Session must keep folding anyway.
    const host = fakeHost();
    let folded = 0;
    racingFlushScheduler(host).schedule(() => {
      folded += 1;
    });

    host.timers[0]!();

    expect(folded).toBe(1);
    expect(host.cancelledFrames).toEqual([1]);
  });

  it("folds once when both the frame and the timer come round", () => {
    const host = fakeHost();
    let folded = 0;
    racingFlushScheduler(host).schedule(() => {
      folded += 1;
    });

    host.frames[0]!();
    host.timers[0]!();

    expect(folded).toBe(1);
  });

  it("retires a flush that was cancelled before either fired", () => {
    const host = fakeHost();
    let folded = 0;
    const cancel = racingFlushScheduler(host).schedule(() => {
      folded += 1;
    });

    cancel();
    host.frames[0]!();
    host.timers[0]!();

    expect(folded).toBe(0);
  });
});

describe("browserChatTransport", () => {
  it("routes product starts and retries without renderer runtime identity", async () => {
    const procedures: string[] = [];
    const inputs: unknown[] = [];
    vi.stubGlobal("window", {
      api: {
        sessionRpc: {
          request: async (request: { procedure: string; input: unknown }) => {
            procedures.push(request.procedure);
            inputs.push(request.input);
            return { ok: true, data: null };
          },
          onEvent: () => () => undefined,
          cancel: () => undefined,
        },
      },
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    const transport = browserChatTransport();

    expect(typeof transport.rpc.session.snapshot.query).toBe("function");
    expect(transport.newCommandId()).not.toBe(transport.newCommandId());
    expect(typeof transport.scheduler.schedule(() => undefined)).toBe("function");
    await transport.createSession({
      operationId: "project-create",
      projectId: "project-1",
      ticketId: null,
      title: "Scratch",
    });
    await transport.createSession({
      operationId: "ticket-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });
    // Named skills ride the same two CREATE procedures — slugs only, never
    // bodies: main resolves and records the bytes. Create rather than start
    // because VC-16 made minting the durable Session the optimistic half, and
    // that is the half the record has to be written in.
    await transport.createSession({
      operationId: "project-skill-create",
      projectId: "project-1",
      ticketId: null,
      title: "Scratch",
      skills: ["svg-logo-designer"],
    });
    await transport.createSession({
      operationId: "ticket-skill-create",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
      skills: ["svg-logo-designer"],
    });
    await transport.attachSession({
      operationId: "project-retry",
      sessionId: "session-1",
    });
    await transport.attachSession({
      operationId: "ticket-retry",
      sessionId: "session-2",
    });
    // One procedure per verb, whatever the Role: the nullable ticketId rides
    // the create input, and the attach carries no Role at all.
    expect(procedures).toEqual([
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.create",
      "sessions.attach",
      "sessions.attach",
    ]);
    expect(inputs[0]).toMatchObject({ ticketId: null });
    expect(inputs[1]).toMatchObject({ ticketId: "ticket-1" });
    expect(inputs[0]).not.toHaveProperty("skills");
    expect(inputs[1]).not.toHaveProperty("skills");
    expect(inputs[2]).toMatchObject({ skills: ["svg-logo-designer"] });
    expect(inputs[3]).toMatchObject({ skills: ["svg-logo-designer"] });
    vi.unstubAllGlobals();
  });
});

/* -------------------------------------------------------------- derivations */

describe("session derivations", () => {
  it("is working only with both a bound executor and a live turn", () => {
    const live = projectionFor("attach-1");
    const turning = { ...EMPTY_TRANSCRIPT, turnActive: true };

    expect(isWorking(sliceOf({ projection: live, transcript: turning }))).toBe(true);
    expect(isWorking(sliceOf({ projection: live }))).toBe(false);
    expect(isWorking(sliceOf({ transcript: turning }))).toBe(false);
  });

  it("asks the same durable model policy of a project chat and a Ticket Session", () => {
    // The carve-out that used to live here read birth as a licence to deliver
    // without one. Both Roles record the app default before anything attaches
    // now, so an absent selection means the same thing on either.
    const ticketless = projectionFor("attach-1");
    const ticketed = { ...ticketless, bornTicketless: false };

    expect(isDeliverable(sliceOf({ projection: ticketless }))).toBe(true);
    expect(isDeliverable(sliceOf({ projection: ticketed }))).toBe(true);
    expect(isDeliverable(sliceOf({ projection: { ...ticketless, modelSelection: null } }))).toBe(
      false,
    );
    expect(isDeliverable(sliceOf({ projection: { ...ticketed, modelSelection: null } }))).toBe(
      false,
    );
  });

  it("has nowhere to deliver without a live executor, whatever model is recorded", () => {
    expect(isDeliverable(sliceOf({ projection: projectionFor(null) }))).toBe(false);
    expect(isDeliverable(sliceOf())).toBe(false);
  });

  it("holds starting and error against anything the stream says", () => {
    const before = sliceOf({ lifecycle: "starting" });
    const after = sliceOf({
      lifecycle: "starting",
      projection: projectionFor("a"),
      transcript: { ...EMPTY_TRANSCRIPT, turnActive: true },
    });

    expect(settledLifecycle(before, after)).toBe("starting");
    expect(
      settledLifecycle({ ...before, lifecycle: "error" }, { ...after, lifecycle: "error" }),
    ).toBe("error");
  });

  it("moves only when a batch crossed a turn boundary", () => {
    // The gap a delivered message lives in: accepted, so optimistically
    // `working`, but no turn has started yet. A batch that says nothing about
    // turns must leave it alone, or the message queued behind it goes out early.
    const live = projectionFor("attach-1");
    const idle = sliceOf({ lifecycle: "working", projection: live });
    const turning = { ...idle, transcript: { ...EMPTY_TRANSCRIPT, turnActive: true } };

    expect(settledLifecycle(idle, { ...idle, projection: projectionFor("attach-1") })).toBe(
      "working",
    );
    expect(settledLifecycle(idle, turning)).toBe("working");
    expect(settledLifecycle(turning, { ...turning, transcript: EMPTY_TRANSCRIPT })).toBe("ready");
  });

  it("settles a turn that opened and closed inside one batch", () => {
    // Both ends read idle, exactly like a batch that said nothing about turns —
    // and holding `working` here is what strands the queue behind a turn that
    // has already finished.
    const idle = sliceOf({ lifecycle: "working", projection: projectionFor("attach-1") });
    const whole = {
      ...idle,
      transcript: { ...EMPTY_TRANSCRIPT, turnEpoch: EMPTY_TRANSCRIPT.turnEpoch + 2 },
    };

    expect(settledLifecycle(idle, whole)).toBe("ready");
  });
});

/* -------------------------------------------------------------- first light */

describe("connect", () => {
  it("seeds the transcript from the snapshot and subscribes past it", async () => {
    const { rpc, sessionId, slice } = await adopted((fake) => {
      fake.snapshotFrames = [frameOf(1, "turn.started"), frameOf(2, "turn.completed")];
      fake.snapshotThrough = 2;
      fake.snapshotProjection = projectionFor("attach-1");
    });

    expect(rpc.streams).toHaveLength(1);
    expect(rpc.streams[0]!.input).toEqual({ sessionId, afterSequence: 2 });
    expect(slice()!.transcript.frames).toHaveLength(2);
    expect(slice()!.projection?.liveExecutor?.id).toBe("attach-1");
  });

  it("drops a malformed snapshot frame rather than drawing it", async () => {
    const { slice } = await adopted((fake) => {
      fake.snapshotFrames = [frameOf(1, "turn.started"), { sessionId: SESSION.id }];
      fake.snapshotThrough = 1;
    });

    expect(slice()!.transcript.frames).toHaveLength(1);
  });

  it("abandons a snapshot whose stream was reopened while it was in flight", async () => {
    // Two opens overlapping is the ordinary case — a retry reopens the stream
    // beside the attach it is retrying — and the loser must not seed a second
    // subscription onto the winner.
    const gate = deferred();
    const { client, rpc } = await adopted((fake) => {
      fake.snapshotGate = gate.promise;
    });

    const first = client.connect();
    const second = client.connect();
    gate.release();
    await Promise.all([first, second]);

    expect(rpc.streams).toHaveLength(1);
  });

  it("says so when the snapshot never answered", async () => {
    const { slice } = await adopted((fake) => {
      fake.snapshotError = new Error("socket hang up");
    });

    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up");
  });

  it("lets only the open that still owns the stream report a failed snapshot", async () => {
    // Both attempts fail; two error rows for one fault would be the surface
    // reporting its own retry as a second thing that went wrong.
    const { client, rpc, store, sessionId, slice } = await adopted();
    const gate = deferred();
    rpc.snapshotGate = gate.promise;
    rpc.snapshotError = new Error("socket hang up");
    const writes = watchSlices(store, sessionId);

    const abandoned = client.connect();
    const current = client.connect();
    gate.release();
    await Promise.all([abandoned, current]);

    expect(writes).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up");
  });

  it("subscribes from the start for a Session this surface no longer holds", async () => {
    const { client, rpc, store, sessionId } = await adopted();
    store.getState().closeChatSession(sessionId);

    await client.connect();

    expect(rpc.streams.at(-1)!.input).toEqual({ sessionId, afterSequence: 0 });
  });
});

/* --------------------------------------------------------------- the stream */

describe("stream folding", () => {
  it("commits a run of frames as one store write", async () => {
    const { rpc, scheduler, store, sessionId, stream, slice } = await adopted();
    const writes = watchSlices(store, sessionId);

    stream().send("1", transcriptFrameOf(1, "m1"));
    stream().send("2", transcriptFrameOf(2, "m2"));
    stream().send("3", transcriptFrameOf(3, "m3"));
    expect(writes).toHaveLength(0);
    expect(rpc.projectionQueries).toBe(0);

    scheduler.paint();

    expect(writes).toHaveLength(1);
    expect(slice()!.transcript.frames).toHaveLength(3);
  });

  it("keeps every overlay in a batch rather than the last one", async () => {
    // Overlays in one paint share a `throughSequence`, so anything keyed by it
    // would drop the missing middle of a streaming sentence.
    const { scheduler, stream, slice } = await adopted();

    stream().send("0", overlayOf(0, "m1", "half"));
    stream().send("0", overlayOf(0, "m2", "other"));
    scheduler.paint();

    expect(slice()!.transcript.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("ignores an emission that is neither a frame nor an overlay", async () => {
    const { scheduler, stream } = await adopted();

    stream().send("junk", { kind: "overlay", sessionId: SESSION.id });

    expect(scheduler.pending).toBeNull();
  });

  it("refreshes the projection off a frame that could have moved it, before the paint", async () => {
    // A permission ask reaches the user through the projection. Waiting on a
    // frame callback an occluded window may be seconds from running is exactly
    // how a blocked Session sits there saying nothing.
    const { rpc, stream, slice } = await adopted((fake) => {
      fake.liveProjection = projectionFor("attach-1");
    });

    stream().send("1", frameOf(1, "interaction.opened"));
    await settle();

    expect(rpc.projectionQueries).toBe(1);
    expect(slice()!.projection?.liveExecutor?.id).toBe("attach-1");
  });

  it("asks for no projection on a transcript reference", async () => {
    const { rpc, stream } = await adopted();

    stream().send("1", transcriptFrameOf(1, "m1"));
    await settle();

    expect(rpc.projectionQueries).toBe(0);
  });

  it("coalesces a burst of projection refreshes into one query and one behind it", async () => {
    const gate = deferred();
    const { rpc, stream } = await adopted((fake) => {
      fake.projectionGate = gate.promise;
    });

    stream().send("1", frameOf(1, "turn.started"));
    stream().send("2", frameOf(2, "attention.raised"));
    stream().send("3", frameOf(3, "interaction.opened"));
    gate.release();
    await settle();

    expect(rpc.projectionQueries).toBe(2);
  });

  it("says so when a projection refresh failed", async () => {
    const { stream, slice } = await adopted((fake) => {
      fake.projectionError = new Error("runtime is gone");
    });

    stream().send("1", frameOf(1, "turn.started"));
    await settle();

    expect(slice()!.sessionError).toBe("Lost the Session stream: runtime is gone");
  });
});

/* ------------------------------------------------------------------ dropped */

describe("reconnect", () => {
  it("resumes from the last cursor after a stream that had started drops", async () => {
    const { rpc, stream } = await adopted();
    const dropped = stream();
    dropped.start();
    dropped.send("7", frameOf(7, "turn.started"));

    dropped.fail(new Error("socket hang up"));
    await settle();

    expect(dropped.unsubscribed).toBe(true);
    expect(rpc.streams).toHaveLength(2);
    expect(rpc.streams[1]!.input.lastEventId).toBe("7");
  });

  it("falls back to a fresh snapshot when the dropped stream delivered no cursor", async () => {
    const { rpc, sessionId, stream } = await adopted((fake) => {
      fake.snapshotThrough = 4;
    });
    stream().start();

    stream().fail(new Error("socket hang up"));
    await settle();

    expect(rpc.streams).toHaveLength(2);
    expect(rpc.streams[1]!.input).toEqual({ sessionId, afterSequence: 4 });
  });

  it("treats a clean completion like a drop and resumes from the cursor", async () => {
    // A Session stream has no legitimate clean end while the Session lives:
    // the producer only completes on teardown races, and shrugging here is
    // exactly the silent dead stream that held a Stop button forever.
    const { rpc, stream } = await adopted();
    const completed = stream();
    completed.start();
    completed.send("7", frameOf(7, "turn.started"));

    completed.complete();
    await settle();

    expect(completed.unsubscribed).toBe(true);
    expect(rpc.streams).toHaveLength(2);
    expect(rpc.streams[1]!.input.lastEventId).toBe("7");
  });

  it("surfaces a completion that arrived before the stream ever started", async () => {
    const { rpc, stream, slice } = await adopted();

    stream().complete();
    await settle();

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: the Session stream ended");
  });

  it("surfaces a stream that failed before it ever started rather than retrying", async () => {
    // One retry per healthy stream is what bounds this: a subscription that
    // never started is reporting a fault a retry would only repeat.
    const { rpc, stream, slice } = await adopted();

    stream().fail(new Error("Session subscription fell behind"));
    await settle();

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: Session subscription fell behind");
  });

  it("surfaces a subscription that failed inside the subscribe call", async () => {
    const { rpc, slice } = await adopted((fake) => {
      fake.onSubscribe = (stream) => {
        fake.onSubscribe = null;
        stream.fail(new Error("bridge is gone"));
      };
    });

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: bridge is gone");
  });
});

/* ------------------------------------------------------------- the executor */

describe("product-owned attach", () => {
  it("reports the refusal a harness answered with, and keeps the Session", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.answerAttach = () => REFUSED;
    });

    await expect(client.retryAttach()).resolves.toBe(false);
    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.sessionError).toBe("Could not start Session: Pi is unavailable");
  });

  it("reports a transport failure the same way", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.answerAttach = () => {
        throw new Error("socket hang up");
      };
    });

    await expect(client.retryAttach()).resolves.toBe(false);
    expect(slice()!.sessionError).toBe("Could not start Session: socket hang up");
  });

  it("keeps an attachment without a terminal receipt in recovery", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.answerAttach = () => ({
        sessionId: SESSION.id,
        state: "needs-recovery",
        receipt: null,
        throughSequence: 1,
      });
    });

    await expect(client.retryAttach()).resolves.toBe(false);
    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.sessionError).toBe("Could not start Session: attachment needs recovery");
  });
});

describe("retryAttach", () => {
  it("re-attaches the same durable Session and reopens its stream", async () => {
    const { client, rpc, sessionId, slice } = await adopted();

    await expect(client.retryAttach()).resolves.toBe(true);

    expect(rpc.attaches).toEqual([{ operationId: expect.any(String), sessionId }]);
    expect(rpc.commands).toEqual([]);
    expect(rpc.streams).toHaveLength(2);
    expect(slice()!.lifecycle).toBe("ready");
  });

  it("waits for the durable Session state before another attachment attempt", async () => {
    const { client, rpc } = await adopted((fake) => {
      fake.snapshotError = new Error("snapshot unavailable");
    });

    await expect(client.retryAttach()).resolves.toBe(false);

    expect(rpc.attaches).toEqual([]);
  });

  it("refuses while an attempt is already in flight", async () => {
    const gate = deferred();
    const { client } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await gate.promise;
        return ACCEPTED;
      };
    });

    const first = client.retryAttach();
    await expect(client.retryAttach()).resolves.toBe(false);
    gate.release();
    await first;
  });

  it("refuses for a Session this surface no longer holds", async () => {
    const { client, store, sessionId } = await adopted();
    store.getState().closeChatSession(sessionId);

    await expect(client.retryAttach()).resolves.toBe(false);
  });
});

describe("recover", () => {
  it("reconciles a live attachment", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });

    await expect(client.recover()).resolves.toBe(true);

    expect(rpc.reconciles).toEqual([{ sessionId, attachmentId: "attach-1" }]);
  });

  it("re-attaches a durable Session that has no executor", async () => {
    const { client, rpc } = await adopted();

    await expect(client.recover()).resolves.toBe(true);

    expect(rpc.attaches).toHaveLength(1);
    expect(rpc.commands).toEqual([]);
  });

  it("does nothing for a Session this surface no longer holds", async () => {
    const { client, store, sessionId, rpc } = await adopted();
    store.getState().closeChatSession(sessionId);

    await expect(client.recover()).resolves.toBe(false);
    expect(rpc.commands).toHaveLength(0);
  });
});

describe("retryRuntime", () => {
  it("sends an explicit retry to the live attachment without another message", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });

    await expect(client.retryRuntime()).resolves.toBe(true);

    expect(rpc.commands).toEqual([
      {
        commandId: expect.any(String),
        sessionId,
        command: { kind: "executor.retry", attachmentId: "attach-1" },
      },
    ]);
  });

  it("refuses runtime retry when the Session has no live attachment", async () => {
    const { client, rpc } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor(null);
    });

    await expect(client.retryRuntime()).resolves.toBe(false);
    expect(rpc.commands).toEqual([]);
  });
});

describe("selectModel", () => {
  it("records a per-Session override without runtime identity", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = { ...projectionFor("attach-1"), bornTicketless: false };
    });

    await expect(
      client.selectModel({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
      }),
    ).resolves.toBe(true);

    expect(rpc.commands).toEqual([
      {
        commandId: expect.any(String),
        sessionId,
        command: {
          kind: "model.select",
          selection: {
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            reasoningLevel: "xhigh",
          },
        },
      },
    ]);
  });

  it("does not issue a model command during an active turn", async () => {
    const { client, rpc } = await adopted((fake) => {
      fake.snapshotProjection = {
        ...projectionFor("attach-1"),
        bornTicketless: false,
        turnActive: true,
      };
    });

    await expect(
      client.selectModel({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).resolves.toBe(false);
    expect(rpc.commands).toEqual([]);
  });
});

/* -------------------------------------------------------------- the message */

describe("submit", () => {
  async function ready(prepare: (rpc: FakeRpc) => void = () => undefined) {
    return adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      prepare(fake);
    });
  }

  it("keeps model policy out of message commands", async () => {
    const { client, rpc, sessionId } = await ready();

    await expect(client.submit({ id: "queued-1", text: "  ship it  " }, "steer")).resolves.toBe(
      "delivered",
    );

    expect(rpc.submissions()).toEqual([
      {
        commandId: "queued-1",
        sessionId,
        command: {
          kind: "message.submit",
          message: {
            id: "queued-1",
            role: "user",
            parts: [{ type: "text", text: "ship it" }],
          },
          delivery: "steer",
        },
      },
    ]);
    expect(Object.keys(rpc.submissions()[0]!.command).toSorted()).toEqual([
      "delivery",
      "kind",
      "message",
    ]);
  });

  it("replays one ambiguous delivery with the same message and command identity", async () => {
    let attempts = 0;
    const { client, rpc } = await ready((fake) => {
      fake.answer = () => {
        attempts += 1;
        if (attempts === 1) throw new Error("reply lost after acceptance");
        return ACCEPTED;
      };
    });
    const message = { id: "held-steer-1", text: "redirect now" };

    await expect(client.submit(message, "steer")).resolves.toBe("refused");
    await expect(client.submit(message, "steer")).resolves.toBe("delivered");

    expect(rpc.submissions()).toEqual([
      expect.objectContaining({
        commandId: "held-steer-1",
        command: expect.objectContaining({
          delivery: "steer",
          message: expect.objectContaining({ id: "held-steer-1" }),
        }),
      }),
      expect.objectContaining({
        commandId: "held-steer-1",
        command: expect.objectContaining({
          delivery: "steer",
          message: expect.objectContaining({ id: "held-steer-1" }),
        }),
      }),
    ]);
  });

  it("uses the Ticket's durable selection without copying it onto the message", async () => {
    const { client, rpc } = await adopted((fake) => {
      fake.snapshotProjection = {
        ...projectionFor("attach-1"),
        bornTicketless: false,
        modelSelection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      };
    });

    await expect(client.submit({ id: "m1", text: "go" }, "queue")).resolves.toBe("delivered");

    expect(rpc.submissions()[0]!.command).not.toHaveProperty("model");
    expect(rpc.submissions()[0]!.command).not.toHaveProperty("variant");
    expect(rpc.submissions()[0]!.command).not.toHaveProperty("agent");
  });

  it("marks the Session working once the harness took it", async () => {
    const { client, slice } = await ready();

    await client.submit({ id: "m1", text: "go" }, "queue");

    expect(slice()!.lifecycle).toBe("working");
  });

  it("refuses blank text", async () => {
    const { client, rpc } = await ready();

    await expect(client.submit({ id: "m1", text: "   " }, "queue")).resolves.toBe("refused");
    expect(rpc.submissions()).toHaveLength(0);
  });

  it("refuses while there is nowhere to deliver", async () => {
    const { client, rpc } = await adopted();

    await expect(client.submit({ id: "m1", text: "go" }, "queue")).resolves.toBe("refused");
    expect(rpc.submissions()).toHaveLength(0);
  });

  it("refuses for a Session this surface no longer holds", async () => {
    const { client, store, sessionId, rpc } = await ready();
    store.getState().closeChatSession(sessionId);

    await expect(client.submit({ id: "m1", text: "go" }, "queue")).resolves.toBe("refused");
    expect(rpc.submissions()).toHaveLength(0);
  });

  // A refusal is a COMPLETED round trip: the runtime commits the durable
  // intent and the transcript artifact before it ever asks the executor, so
  // these words are in the ledger. Anything that hands them back to a composer
  // is offering to send them twice.
  it("reports a message the harness refused as recorded, not lost", async () => {
    const { client, slice } = await ready((fake) => {
      fake.answer = (request) => (request.command.kind === "message.submit" ? REFUSED : ACCEPTED);
    });

    await expect(client.submit({ id: "m1", text: "go" }, "queue")).resolves.toBe("recorded");
    expect(slice()!.sessionError).toBe("Message not delivered: Pi is unavailable");
  });

  it("reports a message the transport dropped", async () => {
    const { client, slice } = await ready((fake) => {
      fake.answer = () => {
        throw new Error("socket hang up");
      };
    });

    await expect(client.submit({ id: "m1", text: "go" }, "queue")).resolves.toBe("refused");
    expect(slice()!.sessionError).toBe("Message not delivered: socket hang up");
  });
});

/* ---------------------------------------------------------- auto-titling */

describe("auto-title on delivery", () => {
  function projectionWithTitle(title: string | null): SessionPresentationProjection {
    return { ...projectionFor("attach-1"), session: { ...SESSION, title } };
  }

  async function readyWithTitle(title: string | null) {
    return adopted((fake) => {
      fake.snapshotProjection = projectionWithTitle(title);
    });
  }

  it("names an untitled Session once its first message delivers", async () => {
    const { client, sessionId } = await readyWithTitle(null);
    const renameMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });

    await expect(
      client.submit({ id: "m1", text: "Fix the parser\nmore detail" }, "steer"),
    ).resolves.toBe("delivered");
    await settle();

    expect(renameMock).toHaveBeenCalledWith({ sessionId, title: "Fix the parser" });
    vi.unstubAllGlobals();
  });

  it("fires through a queue release too — the one choke point both paths share", async () => {
    const renameMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });
    // No live executor yet, so the message queues; setProjection below is what
    // the queue's release rule reacts to, exactly as it would off a stream
    // frame that just brought one up.
    const { store, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = {
        ...projectionFor(null),
        session: { ...SESSION, title: null },
      };
    });
    store.getState().enqueue(sessionId, { id: "q1", text: "Fix the parser" });
    expect(renameMock).not.toHaveBeenCalled();

    store.getState().setProjection(sessionId, projectionWithTitle(null));
    await settle();

    expect(renameMock).toHaveBeenCalledWith({ sessionId, title: "Fix the parser" });
    vi.unstubAllGlobals();
  });

  it("leaves every user title alone, including one that resembles the old default", async () => {
    const { client } = await readyWithTitle("Chat 1");
    const renameMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });

    await expect(client.submit({ id: "m1", text: "Fix the parser" }, "steer")).resolves.toBe(
      "delivered",
    );
    await settle();

    expect(renameMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("never delivers, and never renames, a blank message", async () => {
    const { client } = await readyWithTitle(null);
    const renameMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });

    await expect(client.submit({ id: "m1", text: "   " }, "steer")).resolves.toBe("refused");

    expect(renameMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not fail the submit when the rename itself fails", async () => {
    const { client } = await readyWithTitle(null);
    const renameMock = vi.fn().mockRejectedValue(new Error("ipc down"));
    vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });

    await expect(client.submit({ id: "m1", text: "Fix the parser" }, "steer")).resolves.toBe(
      "delivered",
    );
    await settle();

    expect(renameMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/* --------------------------------------------------------------- the harness */

describe("commands addressed to an attachment", () => {
  it("names the live attachment when interrupting", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });

    await expect(client.interrupt()).resolves.toBe(true);

    expect(rpc.commands[0]).toEqual({
      commandId: expect.any(String),
      sessionId,
      command: { kind: "executor.interrupt", attachmentId: "attach-1" },
    });
  });

  it("omits the attachment key entirely when there is none", async () => {
    // Not `attachmentId: undefined`: structured clone keeps a key JSON would
    // have dropped, and the ledger asserts strict JSON on the way to disk.
    const { client, rpc } = await adopted();

    await client.interrupt();

    expect(rpc.commands[0]!.command).toEqual({ kind: "executor.interrupt" });
  });

  it("refuses to reconcile with no attachment to reconcile", async () => {
    const { client, rpc } = await adopted();

    await expect(client.reconcile()).resolves.toBe(false);
    expect(rpc.reconciles).toHaveLength(0);
  });

  it("clears a standing failure once the next command lands", async () => {
    let attempts = 0;
    const { client, slice } = await adopted((fake) => {
      fake.answerCancel = () => {
        attempts += 1;
        return attempts === 1 ? REFUSED : ACCEPTED;
      };
    });
    await client.cancelInteraction("ask-1");
    expect(slice()!.lifecycle).toBe("error");

    await client.cancelInteraction("ask-1");

    expect(slice()!.sessionError).toBeNull();
    expect(slice()!.lifecycle).toBe("ready");
  });

  it("reports a command the harness refused", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.answerCancel = () => REFUSED;
    });

    await expect(client.cancelInteraction("ask-1")).resolves.toBe(false);
    expect(slice()!.sessionError).toBe("Decision not cancelled: Pi is unavailable");
  });

  it("reports a command the transport dropped", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.answerCancel = () => {
        throw new Error("socket hang up");
      };
    });

    await expect(client.cancelInteraction("ask-1")).resolves.toBe(false);
    expect(slice()!.sessionError).toBe("Decision not cancelled: socket hang up");
  });
});

describe("resolveInteraction", () => {
  it("carries a flat resolution with no answers key at all", async () => {
    const { client, rpc } = await adopted();

    await client.resolveInteraction("ask-1", { optionIds: ["allow"], response: null });

    expect(rpc.commands[0]!.command).toEqual({
      kind: "interaction.resolve",
      interactionId: "ask-1",
      resolution: { optionIds: ["allow"], response: null },
    });
  });

  it("carries every prompt's answer when the ask had several", async () => {
    const { client, rpc } = await adopted();

    await client.resolveInteraction("ask-1", {
      optionIds: [],
      response: null,
      answers: [{ promptId: "p1", optionIds: ["yes"], response: "sure" }],
    });

    expect(rpc.commands[0]!.command).toMatchObject({
      resolution: {
        answers: [{ promptId: "p1", optionIds: ["yes"], response: "sure" }],
      },
    });
  });
});

/* ----------------------------------------------------------------- the queue */

describe("the queued message", () => {
  async function pending(prepare: (rpc: FakeRpc) => void = () => undefined) {
    return adopted(prepare);
  }

  it("holds a message written before an executor was live, and releases it once", async () => {
    const { rpc, store, sessionId, slice } = await pending((fake) => {
      fake.liveProjection = projectionFor("attach-1");
    });
    store.getState().enqueue(sessionId, { id: "q1", text: "start on the parser" });
    expect(rpc.submissions()).toHaveLength(0);

    store.getState().setProjection(sessionId, projectionFor("attach-1"));
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
    expect(slice()!.queue).toEqual([]);
    expect(slice()!.lifecycle).toBe("working");
  });

  it("releases nothing twice however much the store churns underneath it", async () => {
    const gate = deferred();
    const { rpc, store, sessionId } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = async () => {
        await gate.promise;
        return ACCEPTED;
      };
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "once" });
    for (let churn = 0; churn < 5; churn += 1) {
      store.getState().setProjection(sessionId, projectionFor("attach-1"));
    }
    gate.release();
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
  });

  it("does not let an explicit steer claim the row resident drain is submitting", async () => {
    const gate = deferred();
    const { client, rpc, store, sessionId, slice } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = async () => {
        await gate.promise;
        return ACCEPTED;
      };
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "once" });
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q1"]);
    expect(client.claimQueued("q1")).toBe(false);

    gate.release();
    await settle();
    expect(slice()!.queue).toEqual([]);
  });

  it("stops when the Session closes mid-release", async () => {
    const gate = deferred();
    const { rpc, store, sessionId } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = async () => {
        await gate.promise;
        return ACCEPTED;
      };
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    store.getState().closeChatSession(sessionId);
    gate.release();
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
  });

  it("holds the queue behind a failure rather than feeding a harness that just refused", async () => {
    const { rpc, store, sessionId, slice } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => REFUSED;
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q2"]);
  });

  it("keeps the current queue row recoverable when transport fails before recording", async () => {
    let attempts = 0;
    const { rpc, store, sessionId, slice } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket hang up");
        return ACCEPTED;
      };
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
    expect(rpc.submissions()[0]).toMatchObject({
      commandId: "q1",
      command: { message: { id: "q1" }, delivery: "queue" },
    });
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q1", "q2"]);

    store.getState().settle(sessionId, null);
    await settle();

    expect(rpc.submissions()).toHaveLength(2);
    expect(rpc.submissions()[1]).toMatchObject({
      commandId: "q1",
      command: { message: { id: "q1" }, delivery: "queue" },
    });
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q2"]);
  });

  it("releases the next one when the turn it started completes", async () => {
    const { rpc, scheduler, store, sessionId, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    await settle();
    expect(rpc.submissions()).toHaveLength(1);

    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    stream().send("2", frameOf(2, "turn.completed"));
    scheduler.paint();
    await settle();

    expect(rpc.submissions()).toHaveLength(2);
  });

  it("does not auto-release a queued message while an explicit steer owns it", async () => {
    const { client, rpc, scheduler, store, sessionId, slice, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    await settle();
    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    expect(rpc.submissions()).toHaveLength(0);

    expect(client.claimQueued("q2")).toBe(true);
    stream().send("2", frameOf(2, "turn.completed"));
    scheduler.paint();
    await settle();

    expect(rpc.submissions()).toHaveLength(0);
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q1", "q2"]);
    client.releaseQueuedClaim("q2");
    await settle();
    expect(rpc.submissions()).toHaveLength(1);
    expect(slice()!.queue.map((entry) => entry.id)).toEqual(["q2"]);
  });

  it("resumes earlier neighbors when a claimed target vanished before consumption", async () => {
    const { client, rpc, scheduler, store, sessionId, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    await settle();
    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    expect(client.claimQueued("q2")).toBe(true);
    store.getState().dequeue(sessionId, "q2");
    stream().send("2", frameOf(2, "turn.completed"));
    scheduler.paint();
    await settle();

    expect(client.dequeueClaimed("q2")).toBe(false);
    client.releaseQueuedClaim("q2");
    await settle();

    expect(rpc.submissions()).toHaveLength(1);
    expect(rpc.submissions()[0]!.command).toMatchObject({
      message: { parts: [{ type: "text", text: "first" }] },
    });
  });

  it("consumes exactly one claimed row and rejects missing or duplicate claims", async () => {
    const { client, scheduler, store, sessionId, slice, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    await settle();
    store.getState().enqueue(sessionId, { id: "q1", text: "first" });

    expect(client.claimQueued("missing")).toBe(false);
    expect(client.claimQueued("q1")).toBe(true);
    expect(client.claimQueued("q1")).toBe(false);
    expect(client.dequeueClaimed("missing")).toBe(false);
    expect(client.dequeueClaimed("q1")).toBe(true);
    expect(slice()!.queue).toEqual([]);
    client.releaseQueuedClaim("q1");
  });

  it("refuses queue claims after the owning surface closes", async () => {
    const { client, scheduler, store, sessionId, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    await settle();
    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    expect(client.claimQueued("q1")).toBe(true);

    store.getState().closeChatSession(sessionId);

    expect(client.claimQueued("q1")).toBe(false);
    expect(client.dequeueClaimed("q1")).toBe(false);
    client.releaseQueuedClaim("q1");
  });

  it("releases the next one when the whole turn arrived in a single fold", async () => {
    // A turn can begin and end inside one batch — a fast refusal, an occluded
    // window folding 50ms at a time, a reconnect replaying what it missed. The
    // Session reads idle at both ends of that fold, and taking that for silence
    // left the rest of the queue stranded behind a turn already over.
    const { rpc, scheduler, store, sessionId, slice, stream } = await pending((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });

    store.getState().enqueue(sessionId, { id: "q1", text: "first" });
    store.getState().enqueue(sessionId, { id: "q2", text: "second" });
    await settle();
    expect(rpc.submissions()).toHaveLength(1);

    stream().send("1", frameOf(1, "turn.started"));
    stream().send("2", frameOf(2, "turn.completed"));
    scheduler.paint();
    await settle();

    expect(rpc.submissions()).toHaveLength(2);
    expect(slice()!.queue).toEqual([]);
  });
});

/* --------------------------------------------------------------- the ending */

describe("dispose", () => {
  it("cancels a pending flush and unsubscribes", async () => {
    const { client, scheduler, stream, slice, store, sessionId } = await adopted();
    stream().send("1", transcriptFrameOf(1, "m1"));

    client.dispose();

    expect(scheduler.pending).toBeNull();
    expect(scheduler.cancelled).toBe(1);
    expect(stream().unsubscribed).toBe(true);
    // The slice is the store's; disposing a client says nothing about it.
    expect(slice()).toBeDefined();
    store.getState().closeChatSession(sessionId);
  });

  it("is safe with nothing pending and no stream open", async () => {
    const gate = deferred();
    const { client } = await adopted((fake) => {
      fake.snapshotGate = gate.promise;
    });

    expect(() => {
      client.dispose();
    }).not.toThrow();
    gate.release();
    await settle();
  });
});
