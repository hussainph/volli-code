import { describe, expect, it } from "vite-plus/test";
import type { SessionEvent, SessionLedgerIds, SessionProjectionCheckpoint } from "@volli/shared";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamFrame,
  SESSION_HISTORY_WINDOW,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionLocationResolver,
  type SessionRuntime,
  type SessionStreamFrame,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "./index";

/**
 * A history window's two contracts, held against randomized Sessions (VC-315;
 * the verification review's paging probe and B5, kept as regression tests).
 *
 * Paging: a snapshot's window, then `history` until its cursor runs out, then
 * `subscribe` after the snapshot's cursor, reach every event exactly once and
 * in order — with appends landing between pages, inside the ledger reads a
 * page makes, and before the subscribe. Every window holds at most
 * {@link SESSION_HISTORY_WINDOW} frames and bytes, unless it is one frame
 * larger than the byte bound on its own.
 *
 * Hydration: a window is chosen from persisted artifact sizes and only its
 * own frames' bodies are read. A body outside it is never read, so a corrupt
 * one cannot fail the open.
 */

const venue = { id: "machine-1", kind: "local" as const };

function fixedLocation(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue });
  return { resolve: at, prepare: at, reaffirm: async () => undefined };
}

function counter(prefix = ""): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${prefix}${kind}-${++sequence}` };
}

function runtimeCounter(prefix: string) {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

class TemplateAdapter implements NativeHarnessAdapter {
  readonly id = "fake";
  readonly durableIdNamespace = "fake";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" };
  sink: ObservationSink | null = null;

  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.sink = sink;
    return {
      native: { id: "native-session-1", detail: { provider: "fake" } },
      dispatch: async (command) => ({
        commandId: command.commandId,
        status: "accepted" as const,
        acceptedAt: 200,
        native: { id: command.commandId, detail: null },
      }),
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      release: async () => undefined,
    };
  }
}

function filler(chars: number, seed: string): string {
  const line = `${seed}: deterministic history fixture line for the snapshot probe.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

interface Seeded {
  runtime: SessionRuntime;
  sessionId: string;
  log: readonly SessionEvent[];
  /** Artifact bodies read since the last reset, by reference id. */
  reads: () => readonly string[];
  resetReads: () => void;
  append: () => Promise<void>;
  /** Makes the body (and, with `size`, the size) of this event's artifact unreadable. */
  failAt: (sequence: number, what?: "body" | "size") => void;
  /** Makes the next ledger range read append a transcript event first. */
  appendDuringRead: () => void;
  /** Makes the store report this size for this event's artifact. */
  lieAbout: (sequence: number, size: number) => void;
}

interface SeedOptions {
  /** A store with no size port is measured by reading each candidate, as before VC-315. */
  sizes?: boolean;
}

/**
 * One Session with exactly `events` events: a real create, attach and turn
 * recorded through the runtime, then turns cloned from that one until the log
 * is long enough, each transcript event pointing at its own artifact.
 */
async function seedHistory(events: number, seed = 1, options: SeedOptions = {}): Promise<Seeded> {
  let randomState = seed;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  // Mostly small, now and then a large output, and once in a while one larger
  // than a whole window on its own.
  const randomSize = () => {
    const n = random();
    return n % 17 === 0 ? 600_000 : n % 11 === 0 ? 180_000 : n % 31_000;
  };
  let now = 100;
  const clock = { now: () => now++ };
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock,
    ids: counter(),
  });
  const memory = createInMemoryTranscriptArtifactStore();
  const adapter = new TemplateAdapter();
  const recorder = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: memory,
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeCounter("recorder-"),
  });
  const { sessionId } = await recorder.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "History probe",
    },
  });
  await recorder.command({
    commandId: "command-attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  await adapter.sink!.emit({ kind: "turn", state: "started", turnId: "template" });
  await adapter.sink!.emit({
    kind: "message-settled",
    turnId: "template",
    message: { entryId: "template-reply", role: "assistant", text: "template" },
  });
  await adapter.sink!.emit({ kind: "turn", state: "completed", turnId: "template" });
  const recorded = await engine.listEvents({ sessionId });
  const opening = recorded.findIndex(({ payload }) => payload.kind === "turn.started");
  const started = recorded[opening]!;
  const referenced = recorded.find(({ payload }) => payload.kind === "transcript.referenced")!;
  const completed = recorded.find(({ payload }) => payload.kind === "turn.completed")!;
  if (referenced.payload.kind !== "transcript.referenced") throw new Error("no template");
  const templateArtifact = await memory.read(referenced.payload.reference);

  const log: SessionEvent[] = recorded.slice(0, opening);
  const append = (template: SessionEvent, payload: SessionEvent["payload"]) => {
    const sequence = log.length + 1;
    log.push({ ...template, id: `synthetic-${sequence}`, sequence, payload } as SessionEvent);
  };
  const transcript = async (turnId: string, chars: number) => {
    const artifact: SessionTranscriptArtifact = {
      ...templateArtifact,
      turnId,
      message: {
        id: `message-${log.length + 1}`,
        role: "assistant",
        parts: [{ type: "text", text: filler(chars, `${turnId}-${log.length}`) }],
      },
    };
    append(referenced, {
      ...referenced.payload,
      turnId,
      reference: await memory.write(artifact),
    } as SessionEvent["payload"]);
  };
  for (let turn = 0; log.length < events; turn += 1) {
    const turnId = `turn-${turn}`;
    const steps = [
      async () => append(started, { ...started.payload, turnId } as SessionEvent["payload"]),
      ...Array.from({ length: 4 }, () => () => transcript(turnId, randomSize())),
      () => transcript(turnId, randomSize()),
      async () => append(completed, { ...completed.payload, turnId } as SessionEvent["payload"]),
    ];
    for (const step of steps) if (log.length < events) await step();
  }
  const referenceAt = (sequence: number) => {
    const event = log.find((candidate) => candidate.sequence === sequence)!;
    if (event.payload.kind !== "transcript.referenced") throw new Error("not a transcript");
    return event.payload.reference.id;
  };

  let checkpoint: SessionProjectionCheckpoint | null = null;
  let interleave = false;
  const reader: SessionEngine = {
    ...engine,
    listEvents: async ({ afterSequence = 0, limit }) => {
      if (interleave) {
        interleave = false;
        await transcript(`concurrent-${log.length}`, randomSize());
      }
      return log.slice(afterSequence, limit === undefined ? undefined : afterSequence + limit);
    },
    latestEventSequence: async () => log.length,
    getProjectionCheckpoint: async () => checkpoint,
    saveProjectionCheckpoint: async (next) => {
      checkpoint = next;
    },
  };
  let reads: string[] = [];
  const corrupt = new Set<string>();
  const unsized = new Set<string>();
  const lies = new Map<string, number>();
  const counted: TranscriptArtifactStore = {
    write: (record) => memory.write(record),
    read: (reference) => {
      reads.push(reference.id);
      if (corrupt.has(reference.id)) throw new Error("artifact is corrupt");
      return memory.read(reference);
    },
    ...(options.sizes === false
      ? {}
      : {
          byteLength: async (reference) =>
            unsized.has(reference.id)
              ? null
              : (lies.get(reference.id) ?? memory.byteLength!(reference)),
        }),
  };
  const runtime = createSessionRuntime({
    engine: reader,
    executor: new TemplateAdapter(),
    artifacts: counted,
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeCounter("runtime-"),
  });
  // The fold a host keeps between opens, so the first timed open is a warm
  // one, as reopening a Session is.
  await runtime.projection({ sessionId });
  return {
    runtime,
    sessionId,
    log,
    failAt: (sequence, what = "body") => {
      corrupt.add(referenceAt(sequence));
      if (what === "size") unsized.add(referenceAt(sequence));
    },
    lieAbout: (sequence, size) => lies.set(referenceAt(sequence), size),
    appendDuringRead: () => {
      interleave = true;
    },
    append: () => transcript(`append-${log.length}`, randomSize()),
    reads: () => reads,
    resetReads: () => {
      reads = [];
    },
  };
}

/** The ids of the artifacts these frames inline: what a window may read. */
function inlined(frames: readonly SessionStreamFrame[]): string[] {
  return frames.flatMap(({ event }) =>
    event.payload.kind === "transcript.referenced" ? [event.payload.reference.id] : [],
  );
}

function inspect(frames: readonly SessionStreamFrame[]): "oversized" | "bounded" {
  const sequences = frames.map(({ sequence }) => sequence);
  expect(frames.length).toBeLessThanOrEqual(SESSION_HISTORY_WINDOW.events);
  expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
  if (bytesOf(frames) <= SESSION_HISTORY_WINDOW.bytes) return "bounded";
  expect(frames).toHaveLength(1);
  return "oversized";
}

describe("history windows (VC-315)", () => {
  it("pages every event exactly once under interleaved appends, and subscribe joins strictly after", async () => {
    let pages = 0;
    let oversized = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const { runtime, sessionId, log, append, reads, resetReads, appendDuringRead } =
        await seedHistory(320 + seed * 13, seed);
      appendDuringRead();
      resetReads();
      const snapshot = await runtime.snapshot({ sessionId });
      const checkpoint = snapshot.throughSequence;
      // Selected-only: the snapshot reads its own frames' bodies, nothing else.
      expect(reads().toSorted()).toEqual(inlined(snapshot.frames).toSorted());
      if (inspect(snapshot.frames) === "oversized") oversized += 1;
      // Pages newest first, flattened oldest first once the cursor runs out.
      const paged: (readonly SessionStreamFrame[])[] = [snapshot.frames];
      let cursor = snapshot.before;
      while (cursor !== null) {
        // Appends between pages must not move the old page's exclusive upper edge.
        await append();
        if (pages % 3 === 0) await append();
        resetReads();
        const requested = cursor;
        appendDuringRead();
        const page = await runtime.history({ sessionId, before: requested });
        if (inspect(page.frames) === "oversized") oversized += 1;
        expect(page.frames.every(({ sequence }) => sequence < requested)).toBe(true);
        expect(page.before === null || page.before < requested).toBe(true);
        expect(reads().toSorted()).toEqual(inlined(page.frames).toSorted());
        paged.push(page.frames);
        cursor = page.before;
        pages += 1;
      }
      const all = paged.toReversed().flat();
      expect(all.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: checkpoint }, (_, index) => index + 1),
      );
      expect(new Set(all.map(({ event }) => event.id)).size).toBe(checkpoint);
      const resumed: SessionStreamFrame[] = [];
      await append(); // the snapshot -> subscribe race, too
      const stop = await runtime.subscribe({ sessionId, afterSequence: checkpoint }, (emission) => {
        if (isSessionStreamFrame(emission)) resumed.push(emission);
      });
      expect([...all, ...resumed].map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: log.length }, (_, index) => index + 1),
      );
      stop();
      await runtime.close();
    }
    expect(pages).toBeGreaterThan(100);
    expect(oversized).toBeGreaterThan(0);
  }, 120_000);

  it("opens a healthy tail whatever the state of the bodies above it", async () => {
    const { runtime, sessionId, log, failAt } = await seedHistory(400, 1);
    try {
      const healthy = await runtime.snapshot({ sessionId });
      const first = healthy.frames[0]!.sequence;
      const excluded = log.findLast(
        ({ sequence, payload }) => sequence < first && payload.kind === "transcript.referenced",
      )!;
      // The body just above the window is corrupt; then its size is unreadable too.
      failAt(excluded.sequence);
      const corrupt = await runtime.snapshot({ sessionId });
      expect(corrupt.frames).toEqual(healthy.frames);
      expect(corrupt.before).toBe(healthy.before);
      failAt(excluded.sequence, "size");
      const unsized = await runtime.snapshot({ sessionId });
      expect(unsized.frames).toEqual(healthy.frames);
      // Paging back to it is where it fails, alone: the page that needs it.
      await expect(runtime.history({ sessionId, before: excluded.sequence + 1 })).rejects.toThrow(
        "artifact is corrupt",
      );
    } finally {
      await runtime.close();
    }
  });

  it("takes a frame whose size the store cannot say only on a page of its own", async () => {
    const { runtime, sessionId, log, failAt, reads, resetReads } = await seedHistory(400, 2);
    try {
      const healthy = await runtime.snapshot({ sessionId });
      // The oldest transcript frame in the window, so newer frames precede it.
      const inside = healthy.frames.find((frame) => inlined([frame]).length > 0)!;
      expect(inside.sequence).toBeLessThan(healthy.throughSequence);
      failAt(inside.sequence, "size");
      resetReads();
      const window = await runtime.snapshot({ sessionId });
      // The window stops just below it, having read nothing it did not return.
      expect(window.frames[0]!.sequence).toBe(inside.sequence + 1);
      expect(window.before).toBe(inside.sequence + 1);
      expect(reads().toSorted()).toEqual(inlined(window.frames).toSorted());
      // Paged to, it is a page by itself, and that page is where it is read.
      await expect(runtime.history({ sessionId, before: window.before! })).rejects.toThrow(
        "artifact is corrupt",
      );
      expect(log.length).toBe(400);
    } finally {
      await runtime.close();
    }
  });

  it("still holds the byte bound when a persisted size lies", async () => {
    const { runtime, sessionId, lieAbout } = await seedHistory(400, 3);
    try {
      const honest = await runtime.snapshot({ sessionId });
      for (const frame of honest.frames) {
        if (inlined([frame]).length > 0) lieAbout(frame.sequence, 1);
      }
      const lied = await runtime.snapshot({ sessionId });
      expect(inspect(lied.frames)).toBe("bounded");
      expect(lied.frames.at(-1)!.sequence).toBe(honest.frames.at(-1)!.sequence);
      expect(lied.before).toBe(lied.frames[0]!.sequence);
    } finally {
      await runtime.close();
    }
  });

  it("measures by reading when the store keeps no sizes, and pages the same", async () => {
    const sized = await seedHistory(400, 4);
    const unsized = await seedHistory(400, 4, { sizes: false });
    try {
      const expected = await sized.runtime.snapshot({ sessionId: sized.sessionId });
      const actual = await unsized.runtime.snapshot({ sessionId: unsized.sessionId });
      expect(actual.frames.map(({ sequence }) => sequence)).toEqual(
        expected.frames.map(({ sequence }) => sequence),
      );
      expect(actual.before).toBe(expected.before);
    } finally {
      await sized.runtime.close();
      await unsized.runtime.close();
    }
  });
});

/**
 * A live runtime recording a turn whose reply is followed by more silent
 * messages than a window holds: the review's B2 shape, end to end.
 */
async function recordedTurn(silent: number) {
  let now = 100;
  const clock = { now: () => now++ };
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock,
    ids: counter(),
  });
  const adapter = new TemplateAdapter();
  const runtime = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeCounter("live-"),
  });
  const { sessionId } = await runtime.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Reply probe",
    },
  });
  await runtime.command({
    commandId: "command-attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  const sink = adapter.sink!;
  await sink.emit({ kind: "turn", state: "started", turnId: "turn-1" });
  await sink.emit({
    kind: "message-settled",
    turnId: "turn-1",
    message: { entryId: "reply", role: "assistant", text: "Current-turn reply" },
  });
  for (let index = 0; index < silent; index += 1) {
    await sink.emit({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: `silent-${index}`, role: "assistant", text: "   " },
    });
  }
  return { runtime, engine, sessionId };
}

describe("the current turn's latest reply on open (VC-315, review B2)", () => {
  it("records a digest beside each settled message", async () => {
    const { runtime, engine, sessionId } = await recordedTurn(1);
    try {
      const digests = (await engine.listEvents({ sessionId })).flatMap(({ payload }) =>
        payload.kind === "transcript.referenced" ? [payload.digest] : [],
      );
      expect(digests).toEqual([{ role: "assistant", reply: true }, { role: "assistant" }]);
    } finally {
      await runtime.close();
    }
  });

  it("answers the reply whether it sits above the window or inside it", async () => {
    const { runtime, sessionId } = await recordedTurn(SESSION_HISTORY_WINDOW.events + 4);
    try {
      const snapshot = await runtime.snapshot({ sessionId });
      expect(snapshot.before).not.toBeNull();
      expect(snapshot.frames.some(({ transcript }) => transcript?.message.id === "reply")).toBe(
        false,
      );
      expect(snapshot.latestReply).toEqual({
        sequence: snapshot.projection.latestReply!.sequence,
        text: "Current-turn reply",
      });
    } finally {
      await runtime.close();
    }
    const short = await recordedTurn(3);
    try {
      const snapshot = await short.runtime.snapshot({ sessionId: short.sessionId });
      expect(snapshot.before).toBeNull();
      expect(snapshot.latestReply?.text).toBe("Current-turn reply");
    } finally {
      await short.runtime.close();
    }
  });
});
