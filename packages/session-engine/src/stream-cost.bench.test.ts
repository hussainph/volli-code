import { describe, expect, it } from "vite-plus/test";
import type { RuntimeObservation, SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  canonicalJson,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamOverlay,
  sessionMainBranchId,
  sessionRootThreadId,
  type BindingHandle,
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
 * The first test below feeds the observation mix an executor really reports:
 * one turn, 39 text deltas, two completed activities and one settled assistant
 * message. What each of those costs is the Engine's own translation to decide
 * — 41 overlays and no artifact at all, while each of the three durable
 * messages costs exactly one artifact and one ledger event. That is what
 * settle-count persistence buys: durability per message, never per chunk. The
 * removed `@volli/opencode-adapter`'s own probe measured the same 39-piece
 * answer and is where these numbers came from.
 *
 * The second test keeps the old per-chunk shape this file used to feed, stated
 * honestly: nothing can report it and no translation produces it any more, so
 * it is written straight to the ledger — which is what "history an older build
 * left on disk" actually is. `snapshot()`'s latest-wins fold has to keep
 * reading it correctly. That is a compatibility guarantee, not a cost this
 * probe still prices — so it asserts the folded outcome, not the bytes.
 *
 * The fixture is the same deterministic long answer the removed adapter's
 * probe used (fixed prose + three fenced code blocks, ~16-20KB), so today's
 * numbers stay comparable to the baseline they were set against.
 */

// ---------------------------------------------------------------------------
// Deterministic long-answer fixture — identical generation to the removed
// @volli/opencode-adapter probe, so the two baselines describe the same answer.
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
  return { resolve: at, prepare: at, reaffirm: async () => undefined };
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

  emit(observation: RuntimeObservation): Promise<void> {
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
    executor: adapter,
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
// Scenario 1: the mix an executor really reports — one turn, 39 text deltas,
// two completed activities, one settled assistant message. What each of those
// costs in artifacts and on the wire is the Session Engine's own translation
// to decide, which is exactly what this prices.
// ---------------------------------------------------------------------------

const TURN_ID = "turn-1";
/** Matches the wire probe's measured shape exactly: 39 text deltas. */
const DELTA_PIECE_COUNT = 39;

function textDelta(text: string): RuntimeObservation {
  return { kind: "delta", turnId: TURN_ID, channel: "text", text };
}

function completedActivity(callId: string, path: string, content: string): RuntimeObservation {
  return {
    kind: "activity",
    state: "completed",
    turnId: TURN_ID,
    activityId: callId,
    descriptor: {
      kind: "read-file",
      nativeToolName: "read",
      subject: { label: path, path, lineRange: null },
      outcome: null,
      startedAt: 10,
      endedAt: 20,
    },
    input: { path },
    output: { content },
    occurredAt: 1234,
  };
}

function settled(fullText: string): RuntimeObservation {
  return {
    kind: "message-settled",
    turnId: TURN_ID,
    message: { entryId: "entry-final", role: "assistant", text: fullText },
    occurredAt: 1234,
  };
}

describe("session-engine stream-cost probe", () => {
  it("measures settle-count persistence and subscriber wire cost for a real turn's observation mix", async () => {
    const fixtureText = buildFixtureText();
    expect(fixtureText.length).toBeGreaterThanOrEqual(16_000);
    expect(fixtureText.length).toBeLessThanOrEqual(20_000);

    const pieces = splitIntoPieces(fixtureText, DELTA_PIECE_COUNT);
    expect(pieces).toHaveLength(DELTA_PIECE_COUNT);
    expect(pieces.join("")).toBe(fixtureText);

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

    await adapter.emit({ kind: "turn", state: "started", turnId: TURN_ID });
    for (const piece of pieces) await adapter.emit(textDelta(piece!));
    await adapter.emit(
      completedActivity(
        "call-read-1",
        "packages/session-engine/src/session-runtime.ts",
        'case "transcript.message"',
      ),
    );
    await adapter.emit(
      completedActivity(
        "call-read-2",
        "packages/session-engine/src/projection.ts",
        "STREAM_DELTA_DELAY_MS",
      ),
    );
    await adapter.emit(settled(fixtureText));
    unsubscribe();

    // Every overlay the turn puts on the wire, and the total is asserted
    // exhaustively: the per-op counts below are what the probe explains, but
    // only a length pin can catch an emission that is none of them, and the
    // published bytes are summed over the whole array.
    //
    // The first delta opens the message before it grows it, which is the one
    // emission the raw piece count does not predict. The settle adds the last
    // one: a settled message is named by the runtime's own entry id while its
    // deltas were addressed to an id minted before that name existed, so the
    // transient claim is always withdrawn rather than superseded in place. The
    // two activities settle straight to durable messages and never claim an
    // overlay at all.
    expect(overlays.filter((overlay) => overlay.delta.op === "reset")).toHaveLength(1);
    expect(overlays.filter((overlay) => overlay.delta.op === "part.upsert")).toHaveLength(1);
    expect(overlays.filter((overlay) => overlay.delta.op === "part.append")).toHaveLength(
      DELTA_PIECE_COUNT - 1,
    );
    expect(overlays.filter((overlay) => overlay.delta.op === "message.remove")).toHaveLength(1);
    expect(overlays).toHaveLength(DELTA_PIECE_COUNT + 2);

    const referencedFrames = durableFrames.filter(
      (frame) => frame.event.payload.kind === "transcript.referenced",
    );

    const finalSnapshot = await runtime.snapshot({ sessionId });
    const finalArtifact = finalSnapshot.transcript.at(-1)!;
    const finalTextPart = finalArtifact.message.parts.find((part) => part.type === "text");
    expect(finalTextPart).toMatchObject({ type: "text", text: fixtureText });
    expect(
      finalSnapshot.transcript.flatMap((artifact) =>
        artifact.message.parts.filter((part) => part.type === "dynamic-tool"),
      ),
    ).toHaveLength(2);

    // Settle-count persistence, which is the ceiling this probe guards: one
    // artifact and one ledger event per durable MESSAGE — the answer plus its
    // two activities — never one per delta. A regression to per-chunk
    // durability would blow both straight past three.
    expect(counting.writes()).toBe(3);
    expect(referencedFrames).toHaveLength(3);

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
        threadId: finalArtifact.threadId,
        branchId: finalArtifact.branchId,
        attemptId: finalArtifact.attemptId,
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
        `  text deltas fed:             ${DELTA_PIECE_COUNT}`,
        `  durable messages fed:        3 (one settle, two activities)`,
        `  artifact writes:             ${counting.writes()}`,
        `  artifact bytes (all settles): ${artifactBytes}`,
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
  // Scenario 2: the old per-chunk cadence, which is now only a shape sitting on
  // disk. No executor can report it and no translation produces it, so it is
  // written straight to the ledger — which is the honest way to state "history
  // an older build left behind". `snapshot()`'s latest-wins fold has to keep
  // resolving it to the right content, so this asserts the folded outcome, not
  // what the redundant writes cost.
  // -------------------------------------------------------------------------

  it("historical worst case / old-session replay still folds correctly under per-chunk snapshots", async () => {
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

    const { runtime, engine, counting } = buildRuntime();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const provenance = {
      source: { kind: "adapter" as const, id: "fake", detail: null },
      venue,
    };
    const record = async (parts: UIMessage["parts"], id: string) => {
      const reference = await counting.store.write({
        version: 1,
        threadId: sessionRootThreadId(sessionId),
        branchId: sessionMainBranchId(sessionId),
        attemptId: `attempt:${OLD_REPLAY_MESSAGE_ID}`,
        turnId: TURN_ID,
        message: { id: OLD_REPLAY_MESSAGE_ID, role: "assistant", parts },
      });
      await engine.observe({
        id,
        sessionId,
        attachmentId,
        occurredAt: 1234,
        provenance,
        kind: "transcript.referenced",
        turnId: TURN_ID,
        reference,
      });
    };

    let text = "";
    for (const [index, chunk] of OLD_REPLAY_CHUNKS.entries()) {
      text += chunk;
      await record([{ type: "text", text }], `old-snapshot-${index}`);
    }
    const finalText = text;
    await record(
      [
        { type: "text", text: finalText },
        toolPart("call-replay-1", "old/replayed-path.ts", "old tool output"),
      ],
      "old-snapshot-final",
    );

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
