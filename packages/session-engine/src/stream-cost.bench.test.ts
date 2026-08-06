import { describe, expect, it } from "vite-plus/test";
import type { SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  canonicalJson,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamOverlay,
  type BindingHandle,
  type HarnessObservation,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionLocationResolver,
  type SessionRuntime,
  type SessionStreamFrame,
  type SessionStreamOverlay,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "./index";

/**
 * Persistence probe for `docs/plans/delta-frames.md` ("Proof, checked in
 * before the change", item 2). Every `transcript.message` observation the
 * runtime records writes the WHOLE message as a fresh content-addressed
 * artifact and appends one `transcript.referenced` ledger event; subscribers
 * get the full decoded artifact inlined on the frame
 * (`SessionStreamFrame.transcript`). That is unchanged by delta frames, on
 * purpose: `transcript.message` keeps its meaning and only the adapter's
 * emission cadence moved.
 *
 * The first test below feeds the observation mix the real adapter now
 * emits — verified against `packages/opencode-adapter/src/stream-cost.bench.test.ts`,
 * which measured it straight from the adapter: one `transcript.delta` reset,
 * 38 `part.append` deltas, one durable `transcript.message` settle (1 reset +
 * 38 appends = the same 39-frame shape). No adapter or timers here — this
 * probe only needs the engine's own side of that contract, built directly
 * against `@volli/session-engine`'s vocabulary (`session-engine` cannot import
 * `opencode-adapter` without a package cycle; the adapter-conformance half of
 * this contract already lives in
 * `apps/desktop/src/renderer/lab/chat/delta-frames.integration.test.ts`,
 * which drives the real adapter through the real runtime). This is what
 * settle-count persistence actually costs: one artifact write, one ledger
 * event, for the whole answer.
 *
 * The second test keeps the old per-chunk feed this file used to run
 * exclusively, relabeled honestly: no adapter emits `transcript.message` once
 * per chunk any more, but sessions recorded before this change have that
 * shape sitting on disk, and `snapshot()`'s latest-wins fold has to keep
 * reading it correctly. That is a compatibility guarantee, not a cost this
 * probe still prices — so it asserts the folded outcome, not the bytes.
 *
 * The fixture is the same deterministic long answer
 * `opencode-adapter/src/stream-cost.bench.test.ts` uses (fixed prose + three
 * fenced code blocks, ~16-20KB), so the two probes describe the same answer.
 */

// ---------------------------------------------------------------------------
// Deterministic long-answer fixture — identical generation to the
// opencode-adapter probe, so the two baselines describe the same answer.
// ---------------------------------------------------------------------------

function fixtureProse(count: number, seed: string): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `Paragraph ${seed}-${i} explains step ${i} of the migration in plain language, ` +
      `covering rationale, tradeoffs, and the follow-up work it unlocks for the delta-frame overlay.`,
  ).join("\n\n");
}

function fixtureCodeBlock(lang: string, lines: number, seed: string): string {
  const body = Array.from(
    { length: lines },
    (_, i) =>
      `const line${i} = "${seed}-${i}"; // deterministic fixture line for the stream-cost probe`,
  ).join("\n");
  return "```" + lang + "\n" + body + "\n```\n";
}

function buildFixtureText(): string {
  return [
    "# Long streamed answer\n\n",
    fixtureProse(9, "intro"),
    "\n\n",
    fixtureCodeBlock("ts", 50, "alpha"),
    "\n\n",
    fixtureProse(9, "middle"),
    "\n\n",
    fixtureCodeBlock("tsx", 50, "beta"),
    "\n\n",
    fixtureProse(9, "later"),
    "\n\n",
    fixtureCodeBlock("json", 36, "gamma"),
    "\n\n",
    fixtureProse(5, "outro"),
  ].join("");
}

/** UTF-8 byte length without Node's Buffer — this package stays transport/Node-free. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Splits `text` into `count` contiguous, deterministic pieces (remainder
 * folded into the last one) — the shape a real coalescing tick's text growth
 * takes, without needing this package to replay the adapter's own batching.
 */
function splitIntoPieces(text: string, count: number): string[] {
  const size = Math.floor(text.length / count);
  const pieces: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const isLast = index === count - 1;
    const end = isLast ? text.length : offset + size;
    pieces.push(text.slice(offset, end));
    offset = end;
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Minimal runtime harness, copied from session-runtime.test.ts's
// FakeAdapter/composition seam (not imported — this probe only needs the
// probe/attach/emit sliver, not dispatch/reconcile/release scripting).
// ---------------------------------------------------------------------------

const venue = { id: "machine-1", kind: "local" as const };

/** A host with nothing to materialize: preparing a location is resolving it. */
function fixedLocation(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue });
  return { resolve: at, prepare: at };
}

function ids(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

function runtimeIds(prefix = "") {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

class FakeAdapter implements NativeHarnessAdapter {
  readonly manifest = {
    id: "fake",
    displayName: "Fake",
    adapterVersion: "1.0.0",
    profiles: [{ id: "native", label: "Native", transport: "native" as const }],
  };
  sink: ObservationSink | null = null;

  async probe() {
    return {
      status: "available" as const,
      runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
      capabilities: { features: [], catalog: [] },
    };
  }

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

  emit(observation: HarnessObservation): Promise<void> {
    if (!this.sink) throw new Error("Fake adapter is not attached");
    return this.sink.emit(observation);
  }
}

/** Wraps an artifact store, counting writes and the exact bytes it hashes. */
function countingArtifactStore(inner: TranscriptArtifactStore): {
  store: TranscriptArtifactStore;
  writes: () => number;
  bytesTotal: () => number;
} {
  let writes = 0;
  let bytesTotal = 0;
  return {
    store: {
      write: async (record: SessionTranscriptArtifact) => {
        writes += 1;
        // The store hashes canonicalJson(record) (transcript-artifacts.ts:26)
        // — count exactly what gets encoded and persisted, not a looser proxy.
        bytesTotal += byteLength(canonicalJson(record));
        return inner.write(record);
      },
      read: (reference) => inner.read(reference),
    },
    writes: () => writes,
    bytesTotal: () => bytesTotal,
  };
}

/** Composition root, plus the counting decorator wrapped around the artifact store. */
function buildRuntime(): {
  runtime: SessionRuntime;
  engine: SessionEngine;
  adapter: FakeAdapter;
  counting: ReturnType<typeof countingArtifactStore>;
} {
  let now = 100;
  const clock = { now: () => now++ };
  const engine = createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids: ids() });
  const adapter = new FakeAdapter();
  const counting = countingArtifactStore(createInMemoryTranscriptArtifactStore());
  const runtime = createSessionRuntime({
    engine,
    adapters: createNativeAdapterRegistry([adapter]),
    artifacts: counting.store,
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeIds(),
  });
  return { runtime, engine, adapter, counting };
}

async function createAndAttach(runtime: SessionRuntime) {
  const created = await runtime.command({
    commandId: "command-create",
    command: { kind: "session.create", projectId: "project-1", ticketId: null, title: "Probe" },
  });
  await runtime.command({
    commandId: "command-attach",
    sessionId: created.sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: "fake",
      profileId: "native",
      continuity: "fresh",
    },
  });
  return created.sessionId;
}

function toolPart(callId: string, path: string, content: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "read",
    toolCallId: callId,
    state: "output-available",
    input: { path },
    output: { content },
  } as UIMessage["parts"][number];
}

// ---------------------------------------------------------------------------
// Scenario 1: the real adapter's observed mix — one reset, 38 appends, one
// durable settle carrying the full text plus two tool parts on the tail.
// ---------------------------------------------------------------------------

const MESSAGE_ID = "assistant-1";
const THREAD_ID = "thread:probe-session:root";
const BRANCH_ID = "branch:probe-session:main";
const ATTEMPT_ID = "attempt:assistant-1";
const TURN_ID = "turn-1";
const TEXT_KEY = "text-1";
/** Matches the wire probe's measured shape exactly: 1 reset + 38 part.append. */
const DELTA_PIECE_COUNT = 39;

function resetObservation(text: string): HarnessObservation {
  return {
    id: "delta-reset",
    kind: "transcript.delta",
    occurredAt: 1234,
    threadId: THREAD_ID,
    branchId: BRANCH_ID,
    attemptId: ATTEMPT_ID,
    turnId: TURN_ID,
    messageId: MESSAGE_ID,
    delta: {
      op: "reset",
      message: {
        id: MESSAGE_ID,
        role: "assistant",
        parts: [{ key: TEXT_KEY, part: { type: "text", text } }],
      },
    },
  };
}

function appendObservation(index: number, text: string): HarnessObservation {
  return {
    id: `delta-append-${index}`,
    kind: "transcript.delta",
    occurredAt: 1234,
    threadId: THREAD_ID,
    branchId: BRANCH_ID,
    attemptId: ATTEMPT_ID,
    turnId: TURN_ID,
    messageId: MESSAGE_ID,
    delta: { op: "part.append", key: TEXT_KEY, text },
  };
}

function settleObservation(fullText: string): HarnessObservation {
  return {
    id: "settle-final",
    kind: "transcript.message",
    occurredAt: 1234,
    turnId: TURN_ID,
    threadId: THREAD_ID,
    branchId: BRANCH_ID,
    attemptId: ATTEMPT_ID,
    message: {
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        { type: "text", text: fullText },
        toolPart(
          "call-read-1",
          "packages/session-engine/src/session-runtime.ts",
          'case "transcript.message"',
        ),
        toolPart(
          "call-read-2",
          "packages/opencode-adapter/src/index.ts",
          "STREAM_SNAPSHOT_DELAY_MS",
        ),
      ],
    },
  };
}

describe("session-engine stream-cost probe", () => {
  it("measures settle-count persistence and subscriber wire cost for the adapter's real delta+settle mix", async () => {
    const fixtureText = buildFixtureText();
    expect(fixtureText.length).toBeGreaterThanOrEqual(16_000);
    expect(fixtureText.length).toBeLessThanOrEqual(20_000);

    const pieces = splitIntoPieces(fixtureText, DELTA_PIECE_COUNT);
    expect(pieces).toHaveLength(DELTA_PIECE_COUNT);
    expect(pieces.join("")).toBe(fixtureText);
    const [baseline, ...appends] = pieces;

    const { runtime, adapter, counting } = buildRuntime();
    const sessionId = await createAndAttach(runtime);
    const start = await runtime.snapshot({ sessionId });

    const durableFrames: SessionStreamFrame[] = [];
    const overlays: SessionStreamOverlay[] = [];
    const unsubscribe = await runtime.subscribe(
      { sessionId, afterSequence: start.throughSequence },
      (emission) => {
        if (isSessionStreamOverlay(emission)) overlays.push(emission);
        else durableFrames.push(emission);
      },
    );

    await adapter.emit(resetObservation(baseline!));
    for (const [index, text] of appends.entries()) {
      await adapter.emit(appendObservation(index, text));
    }
    await adapter.emit(settleObservation(fixtureText));
    unsubscribe();

    // The mix fed matches the wire probe's measured shape exactly.
    expect(overlays).toHaveLength(DELTA_PIECE_COUNT);
    expect(overlays.filter((overlay) => overlay.delta.op === "reset")).toHaveLength(1);
    expect(overlays.filter((overlay) => overlay.delta.op === "part.append")).toHaveLength(
      DELTA_PIECE_COUNT - 1,
    );

    const referencedFrames = durableFrames.filter(
      (frame) => frame.event.payload.kind === "transcript.referenced",
    );

    const finalSnapshot = await runtime.snapshot({ sessionId });
    const finalArtifact = finalSnapshot.transcript.at(-1)!;
    const finalTextPart = finalArtifact.message.parts.find((part) => part.type === "text");
    expect(finalTextPart).toMatchObject({ type: "text", text: fixtureText });
    expect(finalArtifact.message.parts.filter((part) => part.type === "dynamic-tool")).toHaveLength(
      2,
    );

    // Phase 3 ceilings (docs/plans/delta-frames.md, "after"): settle-count
    // persistence — one artifact write and one ledger event for the whole
    // answer, not one per chunk. A regression to per-chunk durability would
    // blow both straight past 1.
    expect(counting.writes()).toBe(1);
    expect(referencedFrames).toHaveLength(1);

    const artifactBytes = counting.bytesTotal();
    const durableFrameBytes = durableFrames.reduce(
      (sum, frame) => sum + byteLength(JSON.stringify(frame)),
      0,
    );
    const overlayBytes = overlays.reduce(
      (sum, overlay) => sum + byteLength(JSON.stringify(overlay)),
      0,
    );
    const subscriberBytesTotal = durableFrameBytes + overlayBytes;
    const finalMessageBytes = byteLength(
      canonicalJson({
        version: 1,
        threadId: THREAD_ID,
        branchId: BRANCH_ID,
        attemptId: ATTEMPT_ID,
        turnId: TURN_ID,
        message: finalArtifact.message,
      } satisfies SessionTranscriptArtifact),
    );

    // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
    console.log(
      [
        "",
        "[stream-cost probe 2] session-engine persistence + subscriber wire (settle-count cadence)",
        `  fixture length:              ${fixtureText.length} chars`,
        `  transcript.delta fed:        ${DELTA_PIECE_COUNT} (1 reset + ${DELTA_PIECE_COUNT - 1} part.append)`,
        `  transcript.message fed:      1 (the settle)`,
        `  artifact writes:             ${counting.writes()}`,
        `  artifact bytes (single settle): ${artifactBytes}`,
        `  ledger events appended:      ${referencedFrames.length}`,
        `  subscriber durable frame bytes: ${durableFrameBytes}`,
        `  subscriber overlay bytes:       ${overlayBytes}`,
        `  subscriber bytes total (durable + overlay): ${subscriberBytesTotal}`,
        `  final message bytes:         ${finalMessageBytes}`,
        `  subscriber amplification (total / final): ${(subscriberBytesTotal / finalMessageBytes).toFixed(2)}x`,
        "",
      ].join("\n"),
    );
  });

  // -------------------------------------------------------------------------
  // Scenario 2: the old per-chunk feed this file used to run exclusively —
  // now the shape a session recorded before this change actually has on
  // disk, not a reading of what the adapter emits today. `snapshot()`'s
  // latest-wins fold has to keep resolving that history to the right content,
  // so this asserts the folded outcome, not what the redundant writes cost.
  // -------------------------------------------------------------------------

  it("historical worst case / old-session replay still folds correctly under per-chunk transcript.message", async () => {
    const OLD_REPLAY_MESSAGE_ID = "assistant-old-replay";
    const OLD_REPLAY_CHUNKS = [
      "Hel",
      "lo, ",
      "old ",
      "per-",
      "chunk ",
      "adapt",
      "er repl",
      "ay ",
      "before delta ",
      "frames landed.",
    ] as const;

    const { runtime, adapter } = buildRuntime();
    const sessionId = await createAndAttach(runtime);

    let text = "";
    for (const [index, chunk] of OLD_REPLAY_CHUNKS.entries()) {
      text += chunk;
      await adapter.emit({
        id: `old-snapshot-${index}`,
        kind: "transcript.message",
        occurredAt: 1234,
        turnId: TURN_ID,
        threadId: THREAD_ID,
        branchId: BRANCH_ID,
        attemptId: ATTEMPT_ID,
        message: { id: OLD_REPLAY_MESSAGE_ID, role: "assistant", parts: [{ type: "text", text }] },
      });
    }
    const finalText = text;
    await adapter.emit({
      id: "old-snapshot-final",
      kind: "transcript.message",
      occurredAt: 1234,
      turnId: TURN_ID,
      threadId: THREAD_ID,
      branchId: BRANCH_ID,
      attemptId: ATTEMPT_ID,
      message: {
        id: OLD_REPLAY_MESSAGE_ID,
        role: "assistant",
        parts: [
          { type: "text", text: finalText },
          toolPart("call-replay-1", "old/replayed-path.ts", "old tool output"),
        ],
      },
    });

    // Latest-wins on replay: many redundant durable snapshots for the same
    // message id, and `snapshot()` still resolves to exactly the last one —
    // the compatibility guarantee this case exists to prove, independent of
    // how many of them there were.
    const finalSnapshot = await runtime.snapshot({ sessionId });
    const finalArtifact = finalSnapshot.transcript.at(-1)!;
    expect(finalArtifact.message).toMatchObject({
      id: OLD_REPLAY_MESSAGE_ID,
      role: "assistant",
      parts: [
        { type: "text", text: finalText },
        expect.objectContaining({ type: "dynamic-tool", toolCallId: "call-replay-1" }),
      ],
    });
  });
});
