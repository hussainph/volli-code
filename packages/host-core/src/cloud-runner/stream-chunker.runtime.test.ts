/**
 * The chunker over the real Session runtime: overlay emission in, chunks out,
 * folded by a reader with the same transcript-overlay fold, and the settle
 * named by the durable fact's real sequence.
 */
import {
  applyTranscriptDelta,
  createSessionEngine,
  createSessionExecutorSlot,
  createSessionRuntime,
  projectKeyedTranscriptMessage,
  type NativeHarnessAdapter,
  type ObservationSink,
  type TranscriptDelta,
  type TranscriptOverlay,
} from "@volli/session-engine";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
} from "@volli/session-engine/testing";
import {
  STREAM_CHUNK_OPS,
  parseStreamChunkOps,
  type StreamChunkAppend,
  type StreamChunkOpKind,
  type StreamChunkSettle,
} from "@volli/shared/cloud";
import type { RuntimeObservation } from "@volli/shared";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import { createStreamChunker, runtimeStreamSource } from "./stream-chunker";

async function location() {
  return { directory: "/fixture", venue: { id: "machine", kind: "local" as const } };
}

function harness() {
  let sink: ObservationSink | null = null;
  const adapter: NativeHarnessAdapter = {
    id: "fake",
    durableIdNamespace: "fake",
    adapterVersion: "1.0.0",
    runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
    async attach(_spec, observations) {
      sink = observations;
      return {
        native: { id: "native-1", detail: null },
        dispatch: async (command) => ({
          commandId: command.commandId,
          status: "accepted",
          acceptedAt: 200,
          native: { id: command.commandId, detail: null },
        }),
        reconcile: async () => ({ cursor: { value: 0 }, observations: [], receipts: [] }),
        release: async () => {},
      };
    },
  };
  let now = 100;
  let seq = 0;
  const clock = { now: () => now++ };
  const ids = { next: (kind: string) => `${kind}-${++seq}` };
  const runtime = createSessionRuntime({
    engine: createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids }),
    executors: createSessionExecutorSlot(adapter),
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: { resolve: location, prepare: location, reaffirm: async () => {} },
    clock,
    ids,
  });
  return {
    runtime,
    emit: (observation: RuntimeObservation) => sink!.emit(observation),
  };
}

function readerFold(rows: readonly StreamChunkAppend[]): TranscriptOverlay {
  let overlay: TranscriptOverlay = new Map();
  for (const row of rows) {
    const parsed = parseStreamChunkOps(row.ops, row.baseline);
    if (!parsed.ok) throw new Error(parsed.reason);
    for (const delta of parsed.ops as unknown as TranscriptDelta[]) {
      overlay = applyTranscriptDelta(overlay, row.messageId, delta);
    }
  }
  return overlay;
}

describe("the chunker over the real Session runtime", () => {
  test("the op vocabulary the backend checks is the overlay's own", () => {
    expectTypeOf<StreamChunkOpKind>().toEqualTypeOf<TranscriptDelta["op"]>();
    expect(STREAM_CHUNK_OPS).toHaveLength(6);
  });

  test("streams a message mid-word to a watcher, then settles it by its fact's sequence", async () => {
    const { runtime, emit } = harness();
    const created = await runtime.command({
      commandId: "create",
      command: {
        kind: "session.create",
        projectId: "project-1",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
      },
    });
    const sessionId = created.sessionId;
    await runtime.command({
      commandId: "attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });

    let tick: (() => void) | null = null;
    let at = 0;
    const appends: StreamChunkAppend[] = [];
    const settles: StreamChunkSettle[] = [];
    const chunker = createStreamChunker({
      source: runtimeStreamSource(runtime),
      backend: {
        append: async (chunk) => {
          appends.push(chunk);
        },
        settle: async (settle) => {
          settles.push(settle);
        },
      },
      timers: {
        setInterval: (run) => {
          tick = run;
          return 1;
        },
        clearInterval: () => {
          tick = null;
        },
      },
      now: () => at,
    });
    const advance = async () => {
      at += 500;
      tick?.();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };

    // Before anyone watches, nothing streams.
    await emit({ kind: "delta", turnId: "turn-1", channel: "text", text: "Hel" });
    chunker.setWatched([sessionId]);
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
    await advance();
    // The watcher joined mid-message: the runtime's baseline is the first chunk.
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ sessionId, seq: 0, baseline: true });

    await emit({ kind: "delta", turnId: "turn-1", channel: "text", text: "lo, " });
    await emit({ kind: "delta", turnId: "turn-1", channel: "text", text: "world" });
    await advance();
    expect(appends).toHaveLength(2);
    expect(appends[1].baseline).toBe(false);
    const [messageId] = [...readerFold(appends).keys()];
    expect(projectKeyedTranscriptMessage(readerFold(appends).get(messageId)!).parts).toMatchObject([
      { type: "text", text: "Hello, world" },
    ]);

    await emit({
      kind: "message-settled",
      turnId: "turn-1",
      occurredAt: 500,
      message: { entryId: "entry-1", role: "assistant", text: "Hello, world" },
    });
    await advance();
    const { throughSequence } = await runtime.projection({ sessionId });
    // The streamed message settles under its executor's own id, and the
    // stream it replaced is told the sequence of that fact.
    expect(settles).toEqual([{ sessionId, messageId, sequence: throughSequence }]);
    // Every chunk was emitted before the fact that settled it.
    expect(appends.every((chunk) => chunk.throughSequence < throughSequence)).toBe(true);

    await chunker.close();
    await runtime.close();
  });
});
