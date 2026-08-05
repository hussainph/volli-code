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
  type SessionRuntime,
  type SessionStreamFrame,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "./index";

/**
 * Baseline probe for `docs/plans/delta-frames.md` ("Proof, checked in before
 * the change", item 2). Today every `transcript.message` observation the
 * runtime records writes the WHOLE message as a fresh content-addressed
 * artifact and appends one `transcript.referenced` ledger event
 * (`session-runtime.ts:1214-1230`); subscribers get the full decoded artifact
 * inlined on the frame (`SessionStreamFrame.transcript`). If an adapter emits
 * a full snapshot once per 32ms coalescing tick — which is exactly what
 * `packages/opencode-adapter`'s stream-cost probe measures at the wire — this
 * is what that cadence costs in durable storage and in every subscriber's
 * feed.
 *
 * This drives `DefaultSessionRuntime` directly with the SAME deterministic
 * long-answer fixture `opencode-adapter/src/stream-cost.bench.test.ts` uses
 * (fixed prose + three fenced code blocks, ~16-20KB, fixed 24-64 char
 * chunks), feeding cumulative `transcript.message` observations straight to
 * the sink — no adapter, no timers, no coalescing to wait out.
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

const CHUNK_SIZES = [24, 32, 48, 64] as const;

function chunkFixture(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < text.length) {
    const size = CHUNK_SIZES[sizeIndex % CHUNK_SIZES.length]!;
    chunks.push(text.slice(offset, offset + size));
    offset += size;
    sizeIndex += 1;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Minimal runtime harness, copied from session-runtime.test.ts's
// FakeAdapter/composition seam (not imported — this probe only needs the
// probe/attach/emit sliver, not dispatch/reconcile/release scripting).
// ---------------------------------------------------------------------------

const venue = { id: "machine-1", kind: "local" as const };

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
    locations: { resolve: async () => ({ directory: "/projects/fake", venue }) },
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

// ---------------------------------------------------------------------------
// Scenario: the fixture's growth curve fed as ~400 cumulative
// transcript.message observations (no coalescing timer here — this probe
// asks "what would every 32ms tick cost if it settled durably", which is
// exactly today's adapter behavior), plus two tool parts on the tail end.
// ---------------------------------------------------------------------------

const MESSAGE_ID = "assistant-1";
const THREAD_ID = "thread:probe-session:root";
const BRANCH_ID = "branch:probe-session:main";
const ATTEMPT_ID = "attempt:assistant-1";

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

/** Cumulative message snapshots: text grows one chunk per snapshot, then two tool parts land. */
function buildSnapshotMessages(chunks: readonly string[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let text = "";
  for (const chunk of chunks) {
    text += chunk;
    messages.push({ id: MESSAGE_ID, role: "assistant", parts: [{ type: "text", text }] });
  }
  const toolOne = toolPart(
    "call-read-1",
    "packages/session-engine/src/session-runtime.ts",
    'case "transcript.message"',
  );
  const toolTwo = toolPart(
    "call-read-2",
    "packages/opencode-adapter/src/index.ts",
    "STREAM_SNAPSHOT_DELAY_MS",
  );
  messages.push({
    id: MESSAGE_ID,
    role: "assistant",
    parts: [{ type: "text", text }, toolOne],
  });
  messages.push({
    id: MESSAGE_ID,
    role: "assistant",
    parts: [{ type: "text", text }, toolOne, toolTwo],
  });
  return messages;
}

describe("session-engine stream-cost probe (baseline, pre delta-frames change)", () => {
  it("measures persistence and frame-wire amplification for a long streamed answer", async () => {
    const fixtureText = buildFixtureText();
    const chunks = chunkFixture(fixtureText);
    expect(fixtureText.length).toBeGreaterThanOrEqual(16_000);
    expect(fixtureText.length).toBeLessThanOrEqual(20_000);
    expect(chunks.length).toBeGreaterThan(300);

    const messages = buildSnapshotMessages(chunks);

    const { runtime, adapter, counting } = buildRuntime();
    const sessionId = await createAndAttach(runtime);
    const start = await runtime.snapshot({ sessionId });

    const frames: SessionStreamFrame[] = [];
    const unsubscribe = await runtime.subscribe(
      { sessionId, afterSequence: start.throughSequence },
      (emission) => {
        // Durable frames only — this probe prices what gets written down, and
        // the fixture below feeds `transcript.message` exclusively, so no
        // overlay can reach here in the first place.
        if (isSessionStreamOverlay(emission)) return;
        frames.push(emission);
      },
    );

    for (const [index, message] of messages.entries()) {
      await adapter.emit({
        id: `snapshot-${index}`,
        kind: "transcript.message",
        occurredAt: 1234,
        turnId: "turn-1",
        threadId: THREAD_ID,
        branchId: BRANCH_ID,
        attemptId: ATTEMPT_ID,
        message,
      });
    }
    unsubscribe();

    // Sanity facts that hold both before and after the delta-frame change:
    // one durable write per fed transcript.message (an engine invariant the
    // adapter's emission cadence does not touch), and the settled content
    // matches the fixture exactly.
    expect(counting.writes()).toBe(messages.length);
    const referencedFrames = frames.filter(
      (frame) => frame.event.payload.kind === "transcript.referenced",
    );
    expect(referencedFrames.length).toBe(messages.length);

    const finalSnapshot = await runtime.snapshot({ sessionId });
    const finalArtifact = finalSnapshot.transcript.at(-1)!;
    const finalTextPart = finalArtifact.message.parts.find((part) => part.type === "text");
    expect(finalTextPart).toMatchObject({ type: "text", text: fixtureText });
    expect(finalArtifact.message.parts.filter((part) => part.type === "dynamic-tool")).toHaveLength(
      2,
    );

    // The baseline numbers docs/plans/delta-frames.md records.
    const artifactWrites = counting.writes();
    const artifactBytesTotal = counting.bytesTotal();
    const ledgerEventsAppended = referencedFrames.length;
    const frameBytesTotal = frames.reduce(
      (sum, frame) => sum + byteLength(JSON.stringify(frame)),
      0,
    );
    const finalMessageBytes = byteLength(
      canonicalJson({
        version: 1,
        threadId: THREAD_ID,
        branchId: BRANCH_ID,
        attemptId: ATTEMPT_ID,
        turnId: "turn-1",
        message: finalArtifact.message,
      } satisfies SessionTranscriptArtifact),
    );
    const artifactAmplification = artifactBytesTotal / finalMessageBytes;
    const frameAmplification = frameBytesTotal / finalMessageBytes;

    // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
    console.log(
      [
        "",
        "[stream-cost probe 2] session-engine persistence + frame wire (pre delta-frames baseline)",
        `  fixture length:                 ${fixtureText.length} chars`,
        `  transcript.message observations fed: ${messages.length}`,
        `  artifact writes:                ${artifactWrites}`,
        `  artifact bytes total:           ${artifactBytesTotal}`,
        `  ledger events appended:         ${ledgerEventsAppended}`,
        `  subscriber frame bytes total:   ${frameBytesTotal}`,
        `  final message bytes:            ${finalMessageBytes}`,
        `  artifact amplification (bytes total / final): ${artifactAmplification.toFixed(2)}x`,
        `  frame amplification (bytes total / final):    ${frameAmplification.toFixed(2)}x`,
        "",
      ].join("\n"),
    );

    // Structural placeholder for phase 3: after the delta-frame change lands,
    // these flip to hard ceilings instead of a log (settle-count writes).
    expect(Number.isFinite(artifactAmplification)).toBe(true);
    expect(Number.isFinite(frameAmplification)).toBe(true);
  });
});
