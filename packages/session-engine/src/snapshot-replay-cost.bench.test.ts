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
 * What opening, resuming and scrolling back through a Session costs, by age
 * (VC-315; the post-M1 architecture review's benchmark 3).
 *
 * Before VC-315 a snapshot was the whole log: one frame per event, one
 * artifact read per transcript event, one reply. Measured on this fixture
 * before the change, with the same in-memory stores:
 *
 * | events | frames | artifact reads | snapshot JSON |
 * |-------:|-------:|---------------:|--------------:|
 * |     50 |     50 |             31 |       162 KB  |
 * |    500 |    500 |            353 |      1.81 MB  |
 * |  1,668 |  1,668 |          1,187 |      6.08 MB  |
 * |  5,000 |  5,000 |          3,567 |     18.31 MB  |
 *
 * After it a snapshot is the projection checkpoint plus a window bounded by
 * {@link SESSION_HISTORY_WINDOW}, so the first three columns stop depending on
 * the Session's age. This probe pins that, and pins the other half of the
 * contract: paging back with `history` and resuming with `subscribe` both
 * reach every event exactly once, so the bound never hides a gap.
 *
 * Counts and bytes are asserted; times are printed (the in-memory stores make
 * them a floor, not a disk figure). The one time asserted is the review's own
 * target, 200 ms at 500 events, which this clears by more than an order of
 * magnitude.
 *
 * The history is shaped like the busiest day in a real profile (2,796 events
 * in one Session, 9.3 MB of frames: a median frame of 1.1 KB, a 99th
 * percentile of 30 KB): per turn, a start, four tool results whose sizes cycle
 * through that spread, one reply and a completion. It is written straight
 * into the log rather than through a live executor, because the in-memory
 * ledger is quadratic to append to and a 5,000-event Session would take
 * minutes to grow; the runtime under test reads it exactly as it would read
 * one it had recorded.
 */

const SIZES = [50, 500, 1_668, 5_000] as const;
/** A lid closed long enough to miss this many events, resumed by cursor. */
const MISSED_BACKLOG = 1_000;
const RESULT_CHARS = [400, 1_200, 3_000, 800, 600, 2_000, 900, 24_000] as const;
const REPLY_CHARS = 1_500;
/** The review's target for opening a 500-event Session (benchmark 3). */
const OPEN_BYTES_TARGET = 1024 * 1024;
const OPEN_MS_TARGET = 200;

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
  reads: () => number;
  resetReads: () => void;
}

/**
 * One Session with exactly `events` events: a real create, attach and turn
 * recorded through the runtime, then turns cloned from that one until the log
 * is long enough, each transcript event pointing at its own artifact.
 */
async function seedHistory(events: number): Promise<Seeded> {
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
  let result = 0;
  for (let turn = 0; log.length < events; turn += 1) {
    const turnId = `turn-${turn}`;
    const steps = [
      async () => append(started, { ...started.payload, turnId } as SessionEvent["payload"]),
      ...Array.from(
        { length: 4 },
        () => () => transcript(turnId, RESULT_CHARS[result++ % RESULT_CHARS.length]!),
      ),
      () => transcript(turnId, REPLY_CHARS),
      async () => append(completed, { ...completed.payload, turnId } as SessionEvent["payload"]),
    ];
    for (const step of steps) if (log.length < events) await step();
  }

  let checkpoint: SessionProjectionCheckpoint | null = null;
  const reader: SessionEngine = {
    ...engine,
    listEvents: async ({ afterSequence = 0, limit }) =>
      log.slice(afterSequence, limit === undefined ? undefined : afterSequence + limit),
    latestEventSequence: async () => log.length,
    getProjectionCheckpoint: async () => checkpoint,
    saveProjectionCheckpoint: async (next) => {
      checkpoint = next;
    },
  };
  let reads = 0;
  const counted: TranscriptArtifactStore = {
    write: (record) => memory.write(record),
    read: (reference) => {
      reads += 1;
      return memory.read(reference);
    },
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
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
  };
}

interface Row {
  events: number;
  openFrames: number;
  openReads: number;
  openBytes: number;
  openMs: number;
  pages: number;
  pageBytesMax: number;
  pagedReads: number;
  fullLogBytes: number;
  resumeFrames: number;
  resumeBytes: number;
  resumeMs: number;
}

async function measure(events: number): Promise<Row> {
  const { runtime, sessionId, log, reads, resetReads } = await seedHistory(events);
  const transcriptEvents = log.filter(({ payload }) => payload.kind === "transcript.referenced");

  // Open: the snapshot a surface reads first, as the router would serialize it.
  resetReads();
  let started = performance.now();
  const snapshot = await runtime.snapshot({ sessionId });
  const openMs = performance.now() - started;
  const openReads = reads();
  const openBytes = bytesOf({
    projection: snapshot.projection,
    throughSequence: snapshot.throughSequence,
    frames: snapshot.frames,
    before: snapshot.before,
  });
  expect(snapshot.throughSequence).toBe(events);
  expect(snapshot.frames.at(-1)!.sequence).toBe(events);
  expect(snapshot.frames.length).toBeLessThanOrEqual(SESSION_HISTORY_WINDOW.events);
  expect(bytesOf(snapshot.frames)).toBeLessThanOrEqual(SESSION_HISTORY_WINDOW.bytes);
  expect(openBytes).toBeLessThanOrEqual(OPEN_BYTES_TARGET);
  // Lazy hydration: one artifact per transcript frame returned, plus at most
  // the rest of the chunk the window stopped in.
  const openTranscripts = snapshot.frames.filter(({ transcript }) => transcript !== null).length;
  expect(openReads).toBeGreaterThanOrEqual(openTranscripts);
  expect(openReads).toBeLessThan(openTranscripts + 32);

  // Scroll back to the first event: every frame exactly once, in order.
  resetReads();
  const pages: SessionStreamFrame[][] = [];
  for (let before = snapshot.before; before !== null;) {
    const page = await runtime.history({ sessionId, before });
    pages.unshift([...page.frames]);
    before = page.before;
  }
  const pagedReads = reads();
  const everything = [...pages.flat(), ...snapshot.frames];
  expect(everything.map(({ sequence }) => sequence)).toEqual(log.map(({ sequence }) => sequence));
  const pageBytes = pages.map((page) => bytesOf(page));
  for (const bytes of pageBytes) expect(bytes).toBeLessThanOrEqual(SESSION_HISTORY_WINDOW.bytes);
  expect(everything.filter(({ transcript }) => transcript !== null)).toHaveLength(
    transcriptEvents.length,
  );

  // Resume after a lid-close: every missed event once, strictly after the cursor.
  const afterSequence = Math.max(0, events - MISSED_BACKLOG);
  const replayed: SessionStreamFrame[] = [];
  let drained!: () => void;
  const done = new Promise<void>((resolve) => {
    drained = resolve;
  });
  started = performance.now();
  const stop = await runtime.subscribe({ sessionId, afterSequence }, (emission) => {
    if (!isSessionStreamFrame(emission)) return;
    replayed.push(emission);
    if (emission.sequence === events) drained();
  });
  await done;
  const resumeMs = performance.now() - started;
  stop();
  expect(replayed.map(({ sequence }) => sequence)).toEqual(
    log.slice(afterSequence).map(({ sequence }) => sequence),
  );

  return {
    events,
    openFrames: snapshot.frames.length,
    openReads,
    openBytes,
    openMs,
    pages: pages.length,
    pageBytesMax: Math.max(0, ...pageBytes),
    pagedReads,
    fullLogBytes: bytesOf(everything),
    resumeFrames: replayed.length,
    resumeBytes: bytesOf(replayed),
    resumeMs,
  };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;

describe("session snapshot and replay cost (VC-315)", () => {
  it("opens a Session at the same cost however old it is, and still reaches every event", async () => {
    const rows: Row[] = [];
    for (const events of SIZES) rows.push(await measure(events));

    // Flat: the open of a 5,000-event Session costs what a 500-event one does.
    const [, at500, , at5000] = rows;
    // Not equal: where the window's edge falls in the turn cycle moves by a
    // frame or two between ages, which is the whole of the difference.
    expect(at5000!.openFrames).toBeLessThanOrEqual(at500!.openFrames * 1.1);
    expect(at5000!.openBytes).toBeLessThanOrEqual(at500!.openBytes * 1.1);
    expect(at5000!.openReads).toBeLessThanOrEqual(at500!.openReads * 1.1);
    expect(at500!.openMs).toBeLessThanOrEqual(OPEN_MS_TARGET);

    // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
    console.log(
      [
        "",
        "[snapshot-replay-cost] open = snapshot; scroll = history pages to the first event; " +
          `resume = subscribe after missing ${MISSED_BACKLOG} events`,
        "  events | open frames | open reads | open bytes | open ms | pages | max page | full log  | resume frames | resume bytes | resume ms",
        ...rows.map((row) =>
          [
            String(row.events).padStart(8),
            String(row.openFrames).padStart(11),
            String(row.openReads).padStart(10),
            kb(row.openBytes).padStart(10),
            row.openMs.toFixed(1).padStart(7),
            String(row.pages).padStart(5),
            kb(row.pageBytesMax).padStart(8),
            kb(row.fullLogBytes).padStart(9),
            String(row.resumeFrames).padStart(13),
            kb(row.resumeBytes).padStart(12),
            row.resumeMs.toFixed(1).padStart(9),
          ].join(" | "),
        ),
        "",
      ].join("\n"),
    );
  }, 120_000);
});
