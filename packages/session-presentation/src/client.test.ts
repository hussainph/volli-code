/**
 * The resident Session core, driven through the seams it declares.
 *
 * Everything effectful is injected, so these run against the package's real
 * surface store and a real fold with a scripted RPC edge, recorded notify and
 * rename fakes, and a flush the test decides the moment of. That is the point
 * of the shape: the behaviours worth protecting here — one store write per
 * batch, a reconnect that resumes rather than replays, a queued message that
 * leaves exactly once — are all about *when* things happen, and none of them
 * is observable through a component.
 */
import type { CommandReceipt, ModelSelection, SessionPresentationProjection } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isDeliverable,
  isWorking,
  racingFlushScheduler,
  settledLifecycle,
  type ChatCommandRequest,
  type ChatSessionRpc,
  type ChatSessionSlice,
  type ChatSessionProjection,
  type ChatStreamCursor,
  type ChatStreamRecovery,
  type FlushHost,
  type FlushScheduler,
} from "./client";
import { disposeChatClient, getOrCreateChatClient } from "./registry";
import { createSurfaceStore, type SessionSurfaceStore } from "./surface-store";
import { EMPTY_TRANSCRIPT } from "./transcript";
import { rejectedReceipt } from "./wire";

/* ------------------------------------------------------------------ scripts */

const SESSION = {
  id: "durable",
  projectId: "p1",
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 0,
};
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
 * — a Board chat's from the app default, a Ticket Session's the same. A
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
    // Derived from the same attachment the edge reads it from (VC-285): an
    // attached Session that saved no Snapshot is running at the runtime's own
    // defaults, which is a fact rather than a gap.
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    modelSelection: MODEL_POLICY,
    modelTier: null,
    turnActive: false,
    lastActivityAt: SESSION.createdAt,
    bornTicketless: SESSION.ticketId === null,
    scheduledResume: null,
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

function compactionProgressOf(
  throughSequence: number,
  state: "started" | "finished" = "started",
): unknown {
  return {
    kind: "compaction",
    sessionId: SESSION.id,
    throughSequence,
    state,
    reason: "threshold",
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
  /**
   * What the host said a refusal on this result weighed (VC-141). Typed as
   * `unknown` rather than the severity union on purpose: the client reads it
   * structurally off JSON, so the fakes have to be able to send a host that
   * said nothing, said something else, or said it wrong.
   */
  refusal?: unknown;
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
  snapshotProjection: ChatSessionProjection = projectionFor(null);
  snapshotGate: Promise<unknown> = Promise.resolve();
  snapshotError: Error | null = null;

  liveProjection: ChatSessionProjection = projectionFor(null);
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
      cancelQueued: { mutate: async () => this.answerCancel() },
      editQueued: { mutate: async () => this.answerCancel() },
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
async function adopted(
  prepare: (rpc: FakeRpc) => void = () => undefined,
  streamRecovery?: ChatStreamRecovery,
) {
  const rpc = new FakeRpc();
  const scheduler = new ManualScheduler();
  prepare(rpc);
  let commandIds = 0;
  const notifications: string[] = [];
  const notificationTones: Array<"error" | "neutral"> = [];
  const renames: { sessionId: string; title: string; refineFrom?: string }[] = [];
  const store = createSurfaceStore();
  const sessionId = `session-${++sessionCounter}`;
  // The desktop's adopt glue, restated locally: seed the slice, register the
  // client, open its stream. Everything the desktop store wraps around this
  // — tabs, starting flags, create/adopt orchestration — is desktop policy,
  // deliberately absent here.
  store.getState().seed(sessionId, "ready");
  const client = getOrCreateChatClient(sessionId, {
    rpc,
    ...(streamRecovery === undefined ? {} : { streamRecovery }),
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
    store,
    // No default: the core states the tone on every line, and a double that
    // supplied one would hide a core that had stopped doing so.
    notify: (message, tone) => {
      notifications.push(message);
      notificationTones.push(tone);
    },
    renameSession: (target, title, refineFrom) => {
      renames.push({
        sessionId: target,
        title,
        ...(refineFrom === undefined ? {} : { refineFrom }),
      });
      // The desktop dependency makes this optimistic write synchronously,
      // before its IPC round trip starts. Keep the core fixture honest so a
      // rapid steer sees the opening title the same way the app does.
      const slice = store.getState().sessions[target];
      if (slice?.projection !== null && slice?.projection !== undefined) {
        store.getState().setProjection(target, {
          ...slice.projection,
          session: { ...slice.projection.session, title },
        });
      }
    },
  });
  void client.connect();
  // The desktop's close order restated: dispose the client first, then drop
  // the slice, so nothing folds into a Session the surface no longer holds.
  const close = () => {
    disposeChatClient(sessionId);
    store.getState().remove(sessionId);
  };
  open.push({ close });
  await settle();
  const slice = () => store.getState().sessions[sessionId];
  return {
    client,
    rpc,
    scheduler,
    store,
    sessionId,
    slice,
    close,
    notifications,
    notificationTones,
    renames,
    stream: () => rpc.streams.at(-1)!,
  };
}

/** Every distinct slice the store published, for counting writes per batch. */
function watchSlices(store: SessionSurfaceStore, sessionId: string): ChatSessionSlice[] {
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

/* -------------------------------------------------------------- derivations */

describe("session derivations", () => {
  it("is working only with both a bound executor and a live turn", () => {
    const live = projectionFor("attach-1");
    const turning = { ...EMPTY_TRANSCRIPT, turnActive: true };

    expect(isWorking(sliceOf({ projection: live, transcript: turning }))).toBe(true);
    expect(isWorking(sliceOf({ projection: live }))).toBe(false);
    expect(isWorking(sliceOf({ transcript: turning }))).toBe(false);
  });

  it("asks the same durable model policy of a Board chat and a Ticket Session", () => {
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

  // VC-367. `isDeliverable` answers "can this leave now", which is false for
  // both a Session coming up and a Session whose executor is gone. Only the
  // second never ends on its own, and only the second is worth a process.

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

  it("reports a failed snapshot even when no chat view is mounted", async () => {
    const { slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotError = new Error("socket hang up");
    });

    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up");
    expect(notifications).toEqual(["Lost the Session stream: socket hang up"]);
    expect(notificationTones).toEqual(["error"]);
  });

  it("lets only the open that still owns the stream report a failed snapshot", async () => {
    // Both attempts fail; two error rows for one fault would be the surface
    // reporting its own retry as a second thing that went wrong.
    const { client, rpc, store, sessionId, slice, notifications } = await adopted();
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
    expect(notifications).toEqual(["Lost the Session stream: socket hang up"]);
  });

  it("subscribes from the start for a Session this surface no longer holds", async () => {
    const { client, rpc, sessionId, close } = await adopted();
    close();

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

  it("folds a live compaction and clears it before reconnecting", async () => {
    const { rpc, scheduler, slice, stream } = await adopted();

    stream().send("0", compactionProgressOf(0));
    scheduler.paint();
    expect(slice()!.transcript.liveCompaction).toEqual({ throughSequence: 0, reason: "threshold" });

    stream().start();
    stream().fail(new Error("socket hang up"));
    await settle();

    expect(rpc.streams).toHaveLength(2);
    expect(slice()!.transcript.liveCompaction).toBeNull();
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

/** What a client host link hands a subscriber whose cursor the host can no longer resume. */
const RESNAPSHOT = Object.assign(new Error("That cursor is gone"), {
  data: {
    code: "PRECONDITION_FAILED",
    hostError: {
      code: "PRECONDITION_FAILED",
      reason: "subscription-resnapshot-required",
      message: "That cursor is gone",
    },
  },
});

describe("stream recovery behind a client host link", () => {
  it("retries nothing itself: a stream the link ended surfaces at once", async () => {
    const { rpc, stream, slice, notifications } = await adopted(undefined, "host-link");
    const started = stream();
    started.start();
    started.send("7", frameOf(7, "turn.started"));

    started.fail(new Error("subscription-source-failed"));
    await settle();

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: subscription-source-failed");
    expect(notifications).toEqual(["Lost the Session stream: subscription-source-failed"]);
  });

  it("surfaces a clean completion rather than resuming it", async () => {
    const { rpc, stream, slice } = await adopted(undefined, "host-link");
    stream().start();
    stream().complete();
    await settle();

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: the Session stream ended");
  });

  it("reloads the snapshot on a resnapshot and subscribes from its cursor", async () => {
    const { rpc, sessionId, stream, slice, notifications } = await adopted((fake) => {
      fake.snapshotThrough = 4;
    }, "host-link");
    const first = stream();
    first.start();
    first.send("5", frameOf(5, "turn.started"));
    rpc.snapshotThrough = 900;

    first.fail(RESNAPSHOT);
    await settle();

    expect(first.unsubscribed).toBe(true);
    expect(rpc.streams).toHaveLength(2);
    expect(rpc.streams[1]!.input).toEqual({ sessionId, afterSequence: 900 });
    expect(slice()!.sessionError).toBeNull();
    expect(notifications).toEqual([]);
  });

  it("stops reloading a host that refuses its own snapshot's cursor", async () => {
    const { rpc, stream, slice } = await adopted(undefined, "host-link");
    for (let reload = 0; reload < 3; reload++) {
      stream().start();
      stream().fail(RESNAPSHOT);
      await settle();
    }
    expect(rpc.streams).toHaveLength(4);
    stream().start();
    stream().fail(RESNAPSHOT);
    await settle();

    expect(rpc.streams).toHaveLength(4);
    expect(slice()!.sessionError).toBe("Lost the Session stream: That cursor is gone");
  });

  it("counts reloads only while nothing arrives between them", async () => {
    const { rpc, stream } = await adopted(undefined, "host-link");
    for (let reload = 0; reload < 5; reload++) {
      stream().start();
      stream().send(`${reload + 1}`, frameOf(reload + 1, "turn.started"));
      stream().fail(RESNAPSHOT);
      await settle();
    }
    expect(rpc.streams).toHaveLength(6);
  });
});

describe("reconnect", () => {
  it("resumes from the last cursor after a stream that had started drops", async () => {
    const { rpc, stream, notifications } = await adopted();
    const dropped = stream();
    dropped.start();
    dropped.send("7", frameOf(7, "turn.started"));

    dropped.fail(new Error("socket hang up"));
    await settle();

    expect(dropped.unsubscribed).toBe(true);
    expect(rpc.streams).toHaveLength(2);
    expect(rpc.streams[1]!.input.lastEventId).toBe("7");
    expect(notifications).toEqual([]);
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
    const { rpc, stream, slice, notifications, notificationTones } = await adopted();

    stream().fail(new Error("Session subscription fell behind"));
    await settle();

    expect(rpc.streams).toHaveLength(1);
    expect(slice()!.sessionError).toBe("Lost the Session stream: Session subscription fell behind");
    expect(notifications).toEqual(["Lost the Session stream: Session subscription fell behind"]);
    expect(notificationTones).toEqual(["error"]);
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

describe("background connection recovery", () => {
  it("re-arms notification when explicit recovery cannot reopen a live executor's stream", async () => {
    const { client, rpc, stream, notifications, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });
    stream().fail(new Error("snapshot unavailable"));
    expect(notifications).toEqual(["Lost the Session stream: snapshot unavailable"]);
    rpc.snapshotError = new Error("snapshot unavailable");

    await expect(client.recover()).resolves.toBe(false);

    expect(notifications).toEqual([
      "Lost the Session stream: snapshot unavailable",
      "Lost the Session stream: snapshot unavailable",
    ]);
    expect(slice()!.sessionError).toBe("Lost the Session stream: snapshot unavailable");
    expect(rpc.reconciles).toEqual([]);
  });

  it("announces a repeated stream fault once until an explicit reconnect", async () => {
    const { client, stream, notifications } = await adopted();

    stream().fail(new Error("bridge unavailable"));
    stream().fail(new Error("bridge unavailable"));
    expect(notifications).toEqual(["Lost the Session stream: bridge unavailable"]);

    await client.connect();
    stream().fail(new Error("bridge unavailable"));
    expect(notifications).toEqual([
      "Lost the Session stream: bridge unavailable",
      "Lost the Session stream: bridge unavailable",
    ]);
  });

  it("announces a failed reconnect only after the automatic attempt fails", async () => {
    const { stream, rpc, slice, notifications, notificationTones } = await adopted();
    stream().start();
    rpc.snapshotError = new Error("bridge unavailable");

    stream().fail(new Error("temporary drop"));
    await settle();

    expect(slice()!.sessionError).toBe("Lost the Session stream: bridge unavailable");
    expect(notifications).toEqual(["Lost the Session stream: bridge unavailable"]);
    expect(notificationTones).toEqual(["error"]);
  });

  it("does not announce a projection failure after the surface let go", async () => {
    const gate = deferred();
    const { stream, rpc, close, slice, notifications } = await adopted();
    rpc.projectionGate = gate.promise;
    rpc.projectionError = new Error("bridge unavailable");

    stream().send("1", frameOf(1, "turn.started"));
    close();
    gate.release();
    await settle();

    expect(slice()).toBeUndefined();
    expect(notifications).toEqual([]);
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
    expect(slice()!.sessionError).toBe("Could not start Session: Runtime recovery is required.");
  });
});

describe("startAttach", () => {
  it("opens the stream and attaches in one gesture, with no projection to wait for", async () => {
    // The first attach of a Session this surface just brought into residence:
    // a create, or a Chat Draft promoted by its first message (VC-358). Unlike
    // `retryAttach` there is no projection yet to gate on — this is what
    // produces one.
    const { client, rpc, sessionId, slice } = await adopted();

    await expect(client.startAttach()).resolves.toBe(true);

    expect(rpc.attaches).toEqual([{ operationId: expect.any(String), sessionId }]);
    expect(rpc.streams).toHaveLength(2);
    expect(slice()!.sessionError).toBeNull();
  });

  it("keeps a refusal off the slice when it is already reported elsewhere", async () => {
    // A Ticket Session's attach: a worktree that cannot be materialized is
    // recorded as Ticket Attention, which is the surface a person acts on.
    // Saying it here too would be one problem with two dismissals.
    const { client, slice, notifications } = await adopted((fake) => {
      fake.answerAttach = () => ({
        sessionId: SESSION.id,
        state: "needs-recovery",
        receipt: null,
        throughSequence: 1,
      });
    });

    await expect(client.startAttach({ refusalIsReportedElsewhere: true })).resolves.toBe(false);
    expect(slice()!.sessionError).toBeNull();
    expect(notifications).toEqual([]);
  });

  it("waits for nothing when the surface dropped the Session mid-attach", async () => {
    // A close landing while the attach is in flight. There is no slice left to
    // hold the wait against, and nothing left to read it — the Session is
    // durable and reopening it adopts fresh, so the flight settles into
    // nothing rather than parking a wait on a client that is already gone.
    let releaseAttach!: () => void;
    const attaching = new Promise<void>((resolve) => (releaseAttach = resolve));
    const { client, close, slice } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await attaching;
        return { sessionId: SESSION.id, state: "ready", receipt: null, throughSequence: 1 };
      };
    });

    const attach = client.startAttach();
    close();
    releaseAttach();

    await expect(attach).resolves.toBe(true);
    expect(slice()).toBeUndefined();
  });

  it.each([false, true])(
    "reports a thrown attach outside the chat even with durable refusal reporting=%s",
    async (refusalIsReportedElsewhere) => {
      const { client, slice, notifications, notificationTones } = await adopted((fake) => {
        fake.answerAttach = () => {
          throw new Error("socket hang up");
        };
      });

      await expect(client.startAttach({ refusalIsReportedElsewhere })).resolves.toBe(false);
      expect(slice()!.sessionError).toBe("Could not start Session: socket hang up");
      expect(notifications).toEqual(["Could not start Session: socket hang up"]);
      expect(notificationTones).toEqual(["error"]);
    },
  );

  it("announces repeated automatic attach failures once, but re-arms for an explicit Retry", async () => {
    const { client, rpc, notifications } = await adopted((fake) => {
      fake.answerAttach = () => {
        throw new Error("socket hang up");
      };
    });

    await client.startAttach();
    await client.startAttach();
    expect(notifications).toEqual(["Could not start Session: socket hang up"]);

    await client.retryAttach();
    expect(notifications).toEqual([
      "Could not start Session: socket hang up",
      "Could not start Session: socket hang up",
    ]);

    rpc.answerAttach = () => ACCEPTED;
    await expect(client.startAttach()).resolves.toBe(true);
    rpc.answerAttach = () => {
      throw new Error("socket hang up");
    };
    await client.startAttach();
    expect(notifications).toHaveLength(3);
  });

  it("does not announce an attach failure after its client retired, even with a retained slice", async () => {
    const gate = deferred();
    const { client, slice, notifications } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await gate.promise;
        throw new Error("socket hang up");
      };
    });

    const attaching = client.startAttach();
    client.dispose();
    gate.release();

    await expect(attaching).resolves.toBe(false);
    expect(slice()!.sessionError).toBeNull();
    expect(notifications).toEqual([]);
  });

  it("does not reconstruct a slice removed while attach was in flight", async () => {
    const gate = deferred();
    const { client, store, sessionId, slice } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await gate.promise;
        return ACCEPTED;
      };
    });

    const attaching = client.startAttach();
    store.getState().remove(sessionId);
    gate.release();

    await expect(attaching).resolves.toBe(true);
    expect(slice()).toBeUndefined();
  });

  it("does not let an old attach failure overwrite a reopened Session", async () => {
    const gate = deferred();
    const { client, close, store, sessionId, slice, notifications } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await gate.promise;
        throw new Error("old attach failed");
      };
    });

    const attaching = client.startAttach();
    close();
    store.getState().seed(sessionId, "ready");
    const replacement = slice();
    gate.release();

    await expect(attaching).resolves.toBe(false);
    expect(slice()).toBe(replacement);
    expect(slice()!.sessionError).toBeNull();
    expect(notifications).toEqual([]);
  });

  it.each([ACCEPTED, REFUSED])(
    "does not let an old attach result settle a reopened Session (%j)",
    async (answer) => {
      const gate = deferred();
      const { client, close, store, sessionId, slice } = await adopted((fake) => {
        fake.answerAttach = async () => {
          await gate.promise;
          return answer;
        };
      });

      const attaching = client.startAttach();
      close();
      store.getState().seed(sessionId, "starting");
      const replacement = slice();
      gate.release();

      await expect(attaching).resolves.toBe(answer === ACCEPTED);
      expect(slice()).toBe(replacement);
      expect(slice()!.lifecycle).toBe("starting");
    },
  );

  it("keeps a failed-stream recovery band after an independent attach succeeds", async () => {
    const gate = deferred();
    const { client, rpc, slice, notifications } = await adopted();
    rpc.snapshotError = new Error("snapshot unavailable");
    rpc.answerAttach = async () => {
      await gate.promise;
      return ACCEPTED;
    };

    const attaching = client.startAttach();
    await settle();
    expect(slice()!.sessionError).toBe("Lost the Session stream: snapshot unavailable");
    gate.release();

    await expect(attaching).resolves.toBe(true);
    expect(slice()!.lifecycle).toBe("error");
    expect(slice()!.sessionError).toBe("Lost the Session stream: snapshot unavailable");
    expect(notifications).toEqual(["Lost the Session stream: snapshot unavailable"]);
  });

  it("does not announce an attach failure after its surface let go", async () => {
    const gate = deferred();
    const { client, close, slice, notifications } = await adopted((fake) => {
      fake.answerAttach = async () => {
        await gate.promise;
        throw new Error("socket hang up");
      };
    });

    const attaching = client.startAttach();
    close();
    gate.release();

    await expect(attaching).resolves.toBe(false);
    expect(slice()).toBeUndefined();
    expect(notifications).toEqual([]);
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
    const { client, close } = await adopted();
    close();

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
    const { client, rpc, close } = await adopted();
    close();

    await expect(client.recover()).resolves.toBe(false);
    expect(rpc.commands).toHaveLength(0);
  });

  it("reopens a stream it terminally lost — the failure the band names (VC-97)", async () => {
    // The defect this regression pins: `Lost the Session stream` used to be
    // answered with a reconcile alone, which repairs the durable binding and
    // NOT the renderer's subscription — so Retry could report success, clear
    // the band, and leave the transcript frozen behind it.
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    rpc.streams[0]!.fail(new Error("socket hang up"));
    await settle();
    rpc.streams[1]!.fail(new Error("socket hang up again"));
    await settle();
    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up again");
    const streamsAtLoss = rpc.streams.length;

    await expect(client.recover()).resolves.toBe(true);
    await settle();

    expect(rpc.reconciles).toEqual([{ sessionId: expect.any(String), attachmentId: "attach-1" }]);
    expect(rpc.streams.length).toBeGreaterThan(streamsAtLoss);
    expect(rpc.streams.at(-1)!.unsubscribed).toBe(false);
  });

  it("stops when the reopen fails, so nothing clears the band behind it (VC-97)", async () => {
    // The reopen and the reconcile settle the same latch, and the reconcile is
    // the louder writer. Raced, a fast-failing reopen would latch the honest
    // `Lost the Session stream` band and a reconcile landing after it would
    // clear that band with no stream behind it — a Retry reporting success
    // onto a silently frozen transcript, which is the whole defect. Ordered,
    // the failed reopen ends the recovery and its band stands.
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    rpc.streams[0]!.fail(new Error("socket hang up"));
    await settle();
    rpc.streams[1]!.fail(new Error("socket hang up again"));
    await settle();
    const streamsAtLoss = rpc.streams.length;
    rpc.snapshotError = new Error("snapshot unavailable");

    await expect(client.recover()).resolves.toBe(false);
    await settle();

    // Never issued: a reconcile the recovery cannot stand behind is one whose
    // success would only hide the failure the band names.
    expect(rpc.reconciles).toHaveLength(0);
    expect(rpc.streams.length).toBe(streamsAtLoss);
    expect(slice()!.sessionError).toBe("Lost the Session stream: snapshot unavailable");
    expect(slice()!.lifecycle).toBe("error");
  });

  it("does not churn a healthy stream on recover", async () => {
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    await settle();
    const streamsBefore = rpc.streams.length;

    await expect(client.recover()).resolves.toBe(true);
    await settle();

    expect(rpc.streams.length).toBe(streamsBefore);
    expect(slice()!.sessionError).toBeNull();
  });

  it("latches a reconciliation the harness refused — recovery is plumbing", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
      fake.answerReconcile = () => REFUSED;
    });

    await expect(client.recover()).resolves.toBe(false);

    expect(slice()!.sessionError).toBe("Reconcile: Pi is unavailable");
  });

  it("latches a reconciliation the transport dropped", async () => {
    const { client, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
      fake.answerReconcile = () => {
        throw new Error("socket hang up");
      };
    });

    await expect(client.recover()).resolves.toBe(false);

    expect(slice()!.sessionError).toBe("Reconcile: socket hang up");
  });
});

describe("dismissError", () => {
  it("clears the latch without demanding anything of the transport", async () => {
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    rpc.streams[0]!.fail(new Error("socket hang up"));
    await settle();
    rpc.streams[1]!.fail(new Error("socket hang up again"));
    await settle();
    expect(slice()!.sessionError).not.toBeNull();
    const streamsAtLoss = rpc.streams.length;

    client.dismissError();
    await settle();

    expect(slice()!.sessionError).toBeNull();
    expect(slice()!.lifecycle).toBe("ready");
    // A dead stream is quietly reopened: a dismissal that left the transcript
    // frozen would trade an honest band for an invisible one.
    expect(rpc.streams.length).toBeGreaterThan(streamsAtLoss);
    expect(rpc.reconciles).toHaveLength(0);
  });

  it("is a plain clear while the stream is healthy", async () => {
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    await settle();
    const streamsBefore = rpc.streams.length;

    client.dismissError();
    await settle();

    expect(slice()!.sessionError).toBeNull();
    expect(rpc.streams.length).toBe(streamsBefore);
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

describe("scheduled resume", () => {
  it("schedules a resume at the stated reset, and cancels it by its schedule id", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });

    await expect(
      client.scheduleResume({
        attentionId: "attention-1",
        attachmentId: "attach-1",
        resumeAt: 1_800_000_000_000,
      }),
    ).resolves.toBe(true);
    await expect(client.cancelScheduledResume("schedule-1")).resolves.toBe(true);

    expect(rpc.commands).toEqual([
      {
        commandId: expect.any(String),
        sessionId,
        command: {
          kind: "resume.schedule",
          attentionId: "attention-1",
          attachmentId: "attach-1",
          resumeAt: 1_800_000_000_000,
        },
      },
      {
        commandId: expect.any(String),
        sessionId,
        command: { kind: "resume.cancel", scheduleId: "schedule-1" },
      },
    ]);
  });
});

describe("compactContext", () => {
  it("sends an explicit compaction, carrying instructions only when there are any", async () => {
    const { client, rpc, sessionId } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
    });

    await expect(client.compactContext("keep the API work")).resolves.toBe(true);
    await expect(client.compactContext(null)).resolves.toBe(true);

    expect(rpc.commands).toEqual([
      {
        commandId: expect.any(String),
        sessionId,
        command: {
          kind: "context.compact",
          attachmentId: "attach-1",
          instructions: "keep the API work",
        },
      },
      {
        commandId: expect.any(String),
        sessionId,
        command: { kind: "context.compact", attachmentId: "attach-1" },
      },
    ]);
    // Absent, not present-and-undefined: the ledger asserts strict JSON, and
    // structured clone would have carried the key across.
    expect("instructions" in rpc.commands.at(-1)!.command).toBe(false);
  });

  it("reads an accepted compaction as done, and says nothing about it", async () => {
    const { client, notifications } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => ACCEPTED;
    });

    // The compaction itself is announced by the runtime as a Session Event.
    // A toast here would be this client narrating a fact already on screen.
    await expect(client.compactContext(null)).resolves.toBe(true);
    expect(notifications).toEqual([]);
  });

  it("reads a compaction as done when the answer carries no receipt at all", async () => {
    const { client } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => ({ sessionId: SESSION.id });
    });

    // Not a shape this host sends — `rendererCommandResult` always sets the
    // key — but the reader is structural on purpose, so the shape has to have
    // a defined meaning rather than a thrown one. A result that refused
    // nothing did not refuse this.
    await expect(client.compactContext(null)).resolves.toBe(true);
  });

  it("toasts a thrown mutate as a failure, never the sessionError band", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => {
        throw new Error("socket hang up");
      };
    });

    // A throw is the ambiguous case — a transport that never reached main and
    // a failure past the durable write both arrive this way — and it is a
    // moment, not a state: notified like every other refused command, never
    // latched onto the Session the way `#run` would have.
    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: socket hang up");
    expect(notificationTones.at(-1)).toBe("error");
    expect(slice()!.sessionError).toBeNull();
  });

  it("falls back to the rejection code when an unrecognised refusal carries no detail", async () => {
    const { client, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => ({
        sessionId: SESSION.id,
        receipt: {
          id: "receipt-compact-mute",
          commandId: "command-compact-mute",
          status: "rejected",
          code: "location_unavailable",
          detail: null,
          recordedAt: 0,
          sequence: 1,
        },
      });
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: location_unavailable");
    expect(notificationTones.at(-1)).toBe("error");
  });

  it("toasts a refusal nobody vouched for as a failure, never the sessionError band", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => REFUSED;
    });

    // No `refusal` on the result: a host that said nothing about the weight of
    // its own refusal has not vouched for it, and an unvouched refusal is a
    // failure. A one-shot toast even so — not the `sessionError` band that
    // draws a Retry button, because there is nothing here to retry.
    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: Pi is unavailable");
    expect(notificationTones.at(-1)).toBe("error");
    expect(slice()!.sessionError).toBeNull();
  });

  // VC-141: the four compaction refusals as the host actually sends them —
  // its own sentence, and its own judgement of what that sentence weighs.
  // Nothing below names a rejection code, and that is the point: the client
  // reads the weight the host set, so a second runtime with a vocabulary of
  // its own needs no change on this side.
  const compactionRefusal = (
    code: string,
    detail: string,
    refusal: "benign" | "failure",
  ): CommandAnswer => ({
    sessionId: SESSION.id,
    refusal,
    receipt: {
      id: `receipt-${code}`,
      commandId: `command-${code}`,
      status: "rejected",
      code,
      detail,
      recordedAt: 0,
      sequence: 1,
    },
  });

  it("toasts the host's own words, neutrally, when there is nothing left to summarize", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () =>
        compactionRefusal("PI_NOTHING_TO_COMPACT", "There is nothing left to summarize.", "benign");
    });

    // Nothing to compact is an outcome the person's own `/compact` chose, not
    // a failure of the Session's plumbing (CLAUDE.md's line between the two):
    // the neutral tone that is a plain toast, never the longer-held error one.
    // Unprefixed, because naming the command again would make an outcome read
    // as a fault.
    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("There is nothing left to summarize.");
    expect(notificationTones.at(-1)).toBe("neutral");
    expect(slice()!.sessionError).toBeNull();
  });

  // The two causes behind one busy code. The runtime writes a different
  // sentence for each on purpose — a person told "already being compacted"
  // about a Session that is plainly mid-turn would go looking for a summary
  // that is not running — and carrying its words rather than a code keeps both.
  it("toasts the live-turn sentence, neutrally, when a turn holds the context", async () => {
    const { client, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () =>
        compactionRefusal(
          "PI_BUSY",
          "The context cannot be compacted while Pi is running.",
          "benign",
        );
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("The context cannot be compacted while Pi is running.");
    expect(notificationTones.at(-1)).toBe("neutral");
  });

  it("toasts the other busy sentence under the very same code", async () => {
    const { client, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () =>
        compactionRefusal("PI_BUSY", "This context is already being compacted.", "benign");
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("This context is already being compacted.");
    expect(notificationTones.at(-1)).toBe("neutral");
  });

  it("toasts an error, with the provider's own words, when the summary itself failed", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () =>
        compactionRefusal("PI_COMPACTION_FAILED", "The provider refused the summary.", "failure");
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: The provider refused the summary.");
    expect(notificationTones.at(-1)).toBe("error");
    expect(slice()!.sessionError).toBeNull();
  });

  it("toasts an error when the attachment the compaction needed has closed", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () =>
        compactionRefusal("PI_ATTACHMENT_CLOSED", "This attachment is closed.", "failure");
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: This attachment is closed.");
    expect(notificationTones.at(-1)).toBe("error");
    expect(slice()!.sessionError).toBeNull();
  });

  it("never reads a benign mark on anything the host did not refuse", async () => {
    const { client, notifications } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      // A stray mark beside an accepted receipt must not invent a refusal:
      // the receipt's own status is what decides that there was one.
      fake.answer = () => ({ ...ACCEPTED, refusal: "benign" });
    });

    await expect(client.compactContext(null)).resolves.toBe(true);
    expect(notifications).toEqual([]);
  });

  // BOUNDARIES.md rule 4: "Leave reconciliation semantics undecided rather
  // than assumed absent." An unreconciled receipt is the runtime saying it
  // does not know, and reporting that as a finished compaction is the one
  // answer it cannot support.
  it("refuses to call an unreconciled compaction done, and says so in the host's words", async () => {
    const { client, slice, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => ({
        sessionId: SESSION.id,
        receipt: {
          id: "receipt-compact-unknown",
          commandId: "command-compact-unknown",
          status: "unreconciled",
          detail: "Pi stopped answering mid-summary.",
          recordedAt: 0,
          sequence: 1,
        },
      });
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: Pi stopped answering mid-summary.");
    expect(notificationTones.at(-1)).toBe("error");
    expect(slice()!.sessionError).toBeNull();
  });

  it("says the uncertainty itself when an unreconciled receipt left no words", async () => {
    const { client, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.answer = () => ({
        sessionId: SESSION.id,
        receipt: {
          id: "receipt-compact-mute",
          commandId: "command-compact-mute",
          status: "unreconciled",
          detail: null,
          recordedAt: 0,
          sequence: 1,
        },
      });
    });

    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(notifications.at(-1)).toBe("Compact: the runtime could not confirm whether this ran");
    expect(notificationTones.at(-1)).toBe("error");
  });

  it("refuses a compaction when the Session has no live executor, and still says why", async () => {
    const { client, rpc, notifications, notificationTones } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor(null);
    });

    // VC-141's own complaint, in the one arm this client can see for itself: a
    // `/compact` that goes nowhere must not go nowhere silently.
    await expect(client.compactContext(null)).resolves.toBe(false);
    expect(rpc.commands).toEqual([]);
    expect(notifications.at(-1)).toBe("Compaction can't run until the Session is live");
    expect(notificationTones.at(-1)).toBe("error");
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

  it("sends an attachment as a volli-blob file part, never as bytes (VC-50)", async () => {
    const { client, rpc } = await ready();
    const hash = "a".repeat(64);

    await expect(
      client.submit(
        {
          id: "queued-1",
          text: "what is this?",
          attachments: [
            {
              linkId: "l1",
              blobHash: hash,
              label: "shot.png",
              originalName: "shot.png",
              mime: "image/png",
              sizeBytes: 12,
            },
          ],
        },
        "queue",
      ),
    ).resolves.toBe("delivered");

    const submitted = rpc.submissions()[0]!.command;
    expect(submitted).toMatchObject({
      kind: "message.submit",
      message: {
        parts: [
          { type: "text", text: "what is this?" },
          {
            type: "file",
            url: `volli-blob:${hash}`,
            mediaType: "image/png",
            filename: "shot.png",
          },
        ],
      },
    });
    // The durable record holds a reference and nothing else. Base64 in the
    // transcript is the failure this whole design is written against: it
    // replays on every later turn until the session stops accepting even text.
    expect(JSON.stringify(submitted)).not.toMatch(/base64|data:/i);
  });

  it("delivers a message that is nothing but an attachment (VC-50)", async () => {
    const { client } = await ready();

    await expect(
      client.submit(
        {
          id: "queued-2",
          text: "   ",
          attachments: [
            {
              linkId: "l1",
              blobHash: "b".repeat(64),
              label: "shot.png",
              originalName: "shot.png",
              mime: "image/png",
              sizeBytes: 12,
            },
          ],
        },
        "queue",
      ),
    ).resolves.toBe("delivered");
  });

  it("sends a skill resource as its own part beside the intact text (VC-49)", async () => {
    const { client, rpc } = await ready();
    const resource = { name: "hussain-sol", text: "# The skill body" };

    await expect(
      client.submit(
        {
          id: "queued-1",
          text: "can you tell me what /hussain-sol does?",
          resources: [resource],
        },
        "queue",
      ),
    ).resolves.toBe("delivered");

    // The text part is the user's words exactly as typed — the reference is
    // never rewritten into the body — and the body rides as a typed data part.
    expect(rpc.submissions()[0]!.command).toMatchObject({
      kind: "message.submit",
      message: {
        id: "queued-1",
        role: "user",
        parts: [
          { type: "text", text: "can you tell me what /hussain-sol does?" },
          { type: "data-skill-resource", data: resource },
        ],
      },
    });
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

    await client.submit({ id: "m1", text: "go" });

    expect(slice()!.lifecycle).toBe("working");
  });

  it("refuses blank text", async () => {
    const { client, rpc } = await ready();

    await expect(client.submit({ id: "m1", text: "   " }, "queue")).resolves.toBe("refused");
    expect(rpc.submissions()).toHaveLength(0);
  });

  it("refuses while there is nowhere to deliver", async () => {
    const { client, rpc } = await adopted();

    await expect(client.submit({ id: "m1", text: "go" })).resolves.toBe("refused");
    expect(rpc.submissions()).toHaveLength(0);
  });

  it("refuses for a Session this surface no longer holds", async () => {
    const { client, rpc, close } = await ready();
    close();

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

    await expect(client.submit({ id: "m1", text: "go" })).resolves.toBe("recorded");
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
    const { client, sessionId, renames } = await readyWithTitle(null);

    await expect(
      client.submit({ id: "m1", text: "Fix the parser\nmore detail" }, "steer"),
    ).resolves.toBe("delivered");

    // One call, not two: the heuristic title and the message a model may
    // sharpen it from travel together, so no window exists between them in
    // which the title could change out from under the refinement's baseline.
    expect(renames).toEqual([
      {
        sessionId,
        title: "Fix the parser",
        refineFrom: "Fix the parser\nmore detail",
      },
    ]);
  });

  it("uses the opening message before its turn settles, not a later steer", async () => {
    const firstTurn = deferred();
    const { client, rpc, sessionId, renames } = await readyWithTitle(null);
    rpc.answer = (request) =>
      request.command.kind === "message.submit" && request.command.message.id === "opening"
        ? firstTurn.promise.then(() => ACCEPTED)
        : ACCEPTED;

    const opening = client.submit(
      { id: "opening", text: "Investigate the authentication timeout" },
      "queue",
    );

    // Pi resolves an opening prompt only after its whole turn, but the title
    // must begin from the first prompt while that turn remains in flight.
    expect(renames).toEqual([
      {
        sessionId,
        title: "Investigate the authentication timeout",
        refineFrom: "Investigate the authentication timeout",
      },
    ]);

    await expect(
      client.submit({ id: "steer", text: "Prioritize the deployment logs" }, "steer"),
    ).resolves.toBe("delivered");
    expect(renames).toHaveLength(1);

    firstTurn.release();
    await expect(opening).resolves.toBe("delivered");
  });

  it("refines an attachment-only message from the file label", async () => {
    const { client, sessionId, renames } = await readyWithTitle(null);

    await expect(
      client.submit(
        {
          id: "m1",
          text: "",
          attachments: [
            {
              linkId: "l1",
              blobHash: "a".repeat(64),
              label: "shot.png",
              originalName: "shot.png",
              mime: "image/png",
              sizeBytes: 12,
            },
          ],
        },
        "steer",
      ),
    ).resolves.toBe("delivered");

    expect(renames).toEqual([
      {
        sessionId,
        title: "shot.png",
        refineFrom: "shot.png",
      },
    ]);
  });

  it("titles a message durably accepted before an executor exists", async () => {
    const { client, sessionId, renames } = await adopted();
    await client.submit({ id: "q1", text: "Fix the parser" }, "queue");
    expect(renames).toEqual([{ sessionId, title: "Fix the parser", refineFrom: "Fix the parser" }]);
  });

  it("refines a composed start's seeded fallback from its opening message", async () => {
    const { client, sessionId, renames } = await readyWithTitle("Work on VC-42");

    await expect(
      client.submit(
        {
          id: "m1",
          text: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
          autoTitleBaseline: "Work on VC-42",
        },
        "queue",
      ),
    ).resolves.toBe("delivered");

    expect(renames).toEqual([
      {
        sessionId,
        title: "Work on VC-42",
        refineFrom: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
      },
    ]);
  });

  it("protects a human rename made after a composed start was seeded", async () => {
    const { client, renames } = await readyWithTitle("My release review");

    await expect(
      client.submit(
        {
          id: "m1",
          text: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
          autoTitleBaseline: "Work on VC-42",
        },
        "queue",
      ),
    ).resolves.toBe("delivered");

    expect(renames).toEqual([]);
  });

  it("leaves every user title alone, including one that resembles the old default", async () => {
    const { client, renames } = await readyWithTitle("Chat 1");

    await expect(client.submit({ id: "m1", text: "Fix the parser" }, "steer")).resolves.toBe(
      "delivered",
    );

    expect(renames).toEqual([]);
  });

  it("never delivers, and never renames, a blank message", async () => {
    const { client, renames } = await readyWithTitle(null);

    await expect(client.submit({ id: "m1", text: "   " }, "steer")).resolves.toBe("refused");

    expect(renames).toEqual([]);
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

  it("keeps a standing transport failure until recovery, not the next command", async () => {
    // The old bargain — any successful command clears the latch — is what let
    // a reconcile round trip hide a frozen stream: an unrelated command's
    // success proves nothing about the failure the band names. A transport
    // failure now stands until recovered or dismissed (VC-97).
    const { client, rpc, slice } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    rpc.streams[0]!.start();
    rpc.streams[0]!.fail(new Error("socket hang up"));
    await settle();
    rpc.streams[1]!.fail(new Error("socket hang up again"));
    await settle();
    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up again");

    await client.cancelInteraction("ask-1");

    expect(slice()!.sessionError).toBe("Lost the Session stream: socket hang up again");

    await client.recover();

    expect(slice()!.sessionError).toBeNull();
  });

  it("notifies a command the harness refused, without latching the Session", async () => {
    const { client, slice, notifications } = await adopted((fake) => {
      fake.answerCancel = () => REFUSED;
    });

    await expect(client.cancelInteraction("ask-1")).resolves.toBe(false);

    // A refused withdrawal is a moment, not a state: the card it addressed is
    // still on screen saying so, so the failure is one notify line (a toast,
    // on the desktop) and the Session's plumbing is not implicated.
    expect(notifications.at(-1)).toBe("Decision not cancelled: Pi is unavailable");
    expect(slice()!.sessionError).toBeNull();
    expect(slice()!.lifecycle).toBe("ready");
  });

  it("notifies a command the transport dropped, without latching the Session", async () => {
    const { client, slice, notifications } = await adopted((fake) => {
      fake.answerCancel = () => {
        throw new Error("socket hang up");
      };
    });

    await expect(client.cancelInteraction("ask-1")).resolves.toBe(false);

    expect(notifications.at(-1)).toBe("Decision not cancelled: socket hang up");
    expect(slice()!.sessionError).toBeNull();
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

const queued = (id: string) => ({
  id,
  commandId: id,
  state: "queued" as const,
  message: { id, role: "user" as const, parts: [{ type: "text" as const, text: id }] },
});

describe("the host-owned follow-up queue", () => {
  it("accepts while busy without demoting or starting a turn", async () => {
    const { client, slice, stream, scheduler, rpc } = await adopted((fake) => {
      fake.snapshotProjection = projectionFor("attach-1");
      fake.liveProjection = projectionFor("attach-1");
    });
    stream().send("1", frameOf(1, "turn.started"));
    scheduler.paint();
    await client.submit({ id: "q1", text: "later" }, "queue");
    expect(slice()!.lifecycle).toBe("working");
    expect(rpc.submissions()[0]?.command).toMatchObject({ delivery: "queue" });
  });

  it("accepts without an executor and never performs a client attach or release", async () => {
    const { client, rpc, store, sessionId, slice, stream } = await adopted();
    await expect(client.submit({ id: "q1", text: "later" }, "queue")).resolves.toBe("delivered");
    stream().send("0", {
      kind: "queue",
      sessionId,
      throughSequence: 0,
      revision: 1,
      queue: [queued("q1"), queued("q2")],
    });
    expect(slice()!.queue.map((row) => row.id)).toEqual(["q1", "q2"]);
    store.getState().setProjection(sessionId, projectionFor("attach-1"));
    store.getState().settle(sessionId, null);
    await settle();
    expect(rpc.attaches).toEqual([]);
    expect(rpc.submissions()).toHaveLength(1);
    expect(slice()!.lifecycle).toBe("ready");
  });

  it("orders queue updates by revision even at the same transcript cursor", async () => {
    const { slice, stream, sessionId } = await adopted();
    const emit = (revision: number, queue: ReturnType<typeof queued>[]) =>
      stream().send("0", { kind: "queue", sessionId, throughSequence: 0, revision, queue });
    emit(2, [queued("q2")]);
    emit(1, [queued("q1")]);
    emit(2, []);
    expect(slice()!.queue.map((row) => row.id)).toEqual(["q2"]);
    emit(3, []);
    expect(slice()!.queue).toEqual([]);
  });

  it("keeps the projected row when cancellation loses release and surfaces the refusal", async () => {
    const { client, rpc, slice, store, sessionId, notifications } = await adopted();
    store.getState().setQueue(sessionId, [queued("q1")], 1);
    rpc.answerCancel = () => REFUSED;
    await expect(client.cancelQueued("q1")).resolves.toBe(false);
    expect(slice()!.queue.map((row) => row.id)).toEqual(["q1"]);
    expect(notifications).toEqual(["Message not removed: Pi is unavailable"]);
  });

  it("preserves locally recoverable words when durable queue admission is refused", async () => {
    const { client, rpc, slice, notifications } = await adopted();
    rpc.answer = () => REFUSED;
    await expect(client.submit({ id: "q1", text: "later" }, "queue")).resolves.toBe("refused");
    expect(slice()!.sessionError).toContain("Pi is unavailable");
    expect(notifications).toEqual(["Message not queued: Pi is unavailable"]);
    expect(rpc.projectionQueries).toBe(0);
    rpc.answerCancel = () => REFUSED;
    await expect(client.editQueued({ id: "q1", text: "changed" })).resolves.toBe(false);
    expect(rpc.projectionQueries).toBe(0);
  });

  it("ignores a queue addressed to another Session", async () => {
    const { stream, slice } = await adopted();
    stream().send("0", {
      kind: "queue",
      sessionId: "other",
      throughSequence: 0,
      revision: 1,
      queue: [queued("q1")],
    });
    expect(slice()!.queue).toEqual([]);
  });

  it("steers through message.submit without cancelling or optimistically removing the row", async () => {
    const { client, rpc, store, sessionId, slice, notifications } = await adopted((fake) => {
      fake.snapshotProjection = { ...projectionFor("attach-1"), turnActive: true };
      fake.liveProjection = { ...projectionFor("attach-1"), turnActive: true };
    });
    store.getState().setQueue(sessionId, [queued("q1")], 1);
    await expect(client.steerQueued("q1")).resolves.toBe("delivered");
    expect(rpc.submissions()[0]).toMatchObject({
      commandId: "cmd-1",
      command: {
        kind: "message.submit",
        delivery: "steer",
        message: queued("q1").message,
      },
    });
    expect(slice()!.queue.map(({ id }) => id)).toEqual(["q1"]);
    expect(rpc.projectionQueries).toBe(1);
    expect(notifications).toEqual([]);
  });

  it("retains the row and reports a queued steering refusal or lost transport", async () => {
    const { client, rpc, store, sessionId, slice, notifications } = await adopted((fake) => {
      fake.snapshotProjection = { ...projectionFor("attach-1"), turnActive: true };
    });
    store.getState().setQueue(sessionId, [queued("q1")], 1);
    rpc.answer = () => REFUSED;
    await expect(client.steerQueued("q1")).resolves.toBe("refused");
    expect(notifications.at(-1)).toBe("Message not steered: Pi is unavailable");
    rpc.answer = () => {
      throw new Error("transport lost");
    };
    await expect(client.steerQueued("q1")).resolves.toBe("refused");
    expect(notifications.at(-1)).toBe("Message not steered: transport lost");
    expect(slice()!.queue.map(({ id }) => id)).toEqual(["q1"]);
    expect(rpc.projectionQueries).toBe(0);
  });

  it("does not steer a claimed row or an ended turn", async () => {
    const { client, rpc, store, sessionId } = await adopted();
    store.getState().setQueue(sessionId, [{ ...queued("q1"), state: "releasing" }], 1);
    await expect(client.steerQueued("q1")).resolves.toBe("refused");
    store.getState().setQueue(sessionId, [queued("q1")], 2);
    await expect(client.steerQueued("q1")).resolves.toBe("refused");
    expect(rpc.submissions()).toEqual([]);
  });

  it("refreshes after host edit/cancel and refuses steering a missing row", async () => {
    const { client, rpc, notifications } = await adopted();
    await expect(client.editQueued({ id: "q1", text: "changed" })).resolves.toBe(true);
    await settle();
    await expect(client.cancelQueued("q1")).resolves.toBe(true);
    await settle();
    expect(rpc.projectionQueries).toBe(2);
    await expect(client.steerQueued("q1")).resolves.toBe("refused");
    expect(rpc.submissions()).toEqual([]);
    expect(notifications[0]).toContain("no longer available");
  });
});

/* --------------------------------------------------------------- the ending */

describe("dispose", () => {
  it("cancels a pending flush and unsubscribes", async () => {
    const { client, scheduler, stream, slice, close } = await adopted();
    stream().send("1", transcriptFrameOf(1, "m1"));

    client.dispose();

    expect(scheduler.pending).toBeNull();
    expect(scheduler.cancelled).toBe(1);
    expect(stream().unsubscribed).toBe(true);
    // The slice is the store's; disposing a client says nothing about it.
    expect(slice()).toBeDefined();
    close();
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
