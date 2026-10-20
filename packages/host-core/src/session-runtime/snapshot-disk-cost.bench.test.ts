/**
 * What opening a Session costs the host on disk, by age (VC-315).
 *
 * `session-engine`'s `snapshot-replay-cost.bench.test.ts` prices a snapshot
 * against in-memory stores, a floor. This is the same read against the
 * production artifact store, `FileTranscriptArtifactStore` in a temporary
 * directory: real files, real gzip, a cold store (no size cached) for every
 * open. It prices the host's main-process half of a reopen: choosing the
 * window from persisted sizes (an open and four bytes per candidate), then
 * reading, inflating and verifying exactly the window's bodies.
 *
 * The ledger stays in memory, so the event reads are a floor; the artifact
 * half is the disk's. Counts and bytes are asserted; times are printed.
 *
 * Opt-in (`VOLLI_SNAPSHOT_DISK_BENCH=1`): seeding writes every artifact the
 * way the store does, fsync and all, which takes minutes at 10,000 events —
 * a measurement to run, not a check for every suite.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInMemorySessionLedger,
  createSessionEngine,
  createSessionRuntime,
  SESSION_HISTORY_WINDOW,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { SessionEvent, SessionProjectionCheckpoint } from "@volli/shared";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

/** The ticket's 100, 1,000 and 10,000 events. */
const SIZES = [100, 1_000, 10_000] as const;
const RESULT_CHARS = [400, 1_200, 3_000, 800, 600, 2_000, 900, 24_000] as const;
const REPLY_CHARS = 1_500;

const venue = { id: "machine-1", kind: "local" as const };
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

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
  const line = `${seed}: deterministic history fixture line for the disk probe.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function counter(prefix: string) {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

/** One Session of exactly `events` events, its transcript bodies on disk. */
async function seedSession(events: number) {
  const directory = await mkdtemp(join(tmpdir(), "volli-snapshot-disk-"));
  directories.push(directory);
  let now = 100;
  const clock = { now: () => now++ };
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock,
    ids: counter(""),
  });
  const files = createFileTranscriptArtifactStore(directory);
  const adapter = new TemplateAdapter();
  const location = async () => ({ directory, venue });
  const locations = { resolve: location, prepare: location, reaffirm: async () => undefined };
  const recorder = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: files,
    locations,
    clock,
    ids: counter("recorder-"),
  });
  const { sessionId } = await recorder.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Disk probe",
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
  const template = await files.read(referenced.payload.reference);
  await recorder.close();

  const log: SessionEvent[] = recorded.slice(0, opening);
  const append = (from: SessionEvent, payload: SessionEvent["payload"]) => {
    const sequence = log.length + 1;
    log.push({ ...from, id: `synthetic-${sequence}`, sequence, payload } as SessionEvent);
  };
  const transcript = async (turnId: string, chars: number) => {
    const artifact: SessionTranscriptArtifact = {
      ...template,
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
      reference: await files.write(artifact),
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
  /** A runtime over a cold store, its body reads counted. */
  const open = () => {
    const cold = createFileTranscriptArtifactStore(directory);
    const counts = { bodies: 0, sizes: 0 };
    const artifacts: TranscriptArtifactStore = {
      write: (record) => cold.write(record),
      read: (reference) => {
        counts.bodies += 1;
        return cold.read(reference);
      },
      byteLength: (reference) => {
        counts.sizes += 1;
        return cold.byteLength(reference);
      },
    };
    const runtime = createSessionRuntime({
      engine: reader,
      executor: new TemplateAdapter(),
      artifacts,
      locations,
      clock,
      ids: counter("runtime-"),
    });
    return { runtime, counts };
  };
  // The fold a host keeps between opens, so the timed open is a reopen.
  const warm = open();
  await warm.runtime.projection({ sessionId });
  await warm.runtime.close();
  return { sessionId, log, open };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;

describe.runIf(process.env["VOLLI_SNAPSHOT_DISK_BENCH"] === "1")(
  "snapshot disk cost (VC-315)",
  () => {
    it("opens a Session from disk at the same cost however old it is", async () => {
      const rows: string[] = [];
      for (const events of SIZES) {
        const { sessionId, log, open } = await seedSession(events);
        const transcripts = log.filter(({ payload }) => payload.kind === "transcript.referenced");
        const { runtime, counts } = open();
        const started = performance.now();
        const snapshot = await runtime.snapshot({ sessionId });
        const ms = performance.now() - started;
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            projection: snapshot.projection,
            throughSequence: snapshot.throughSequence,
            frames: snapshot.frames,
            before: snapshot.before,
            latestReply: snapshot.latestReply,
          }),
        ).length;
        const inWindow = snapshot.frames.filter(({ transcript }) => transcript !== null).length;
        expect(snapshot.frames.length).toBeLessThanOrEqual(SESSION_HISTORY_WINDOW.events);
        // Exactly the window's bodies, from disk; sizes for at most its last chunk more.
        expect(counts.bodies).toBe(inWindow);
        expect(counts.sizes).toBeLessThan(inWindow + 32);
        // Every cloned message carries the template's digest, so the newest is the reply.
        expect(snapshot.latestReply).not.toBeNull();
        await runtime.close();
        rows.push(
          [
            String(events).padStart(8),
            String(transcripts.length).padStart(9),
            String(snapshot.frames.length).padStart(7),
            String(counts.bodies).padStart(7),
            String(counts.sizes).padStart(6),
            kb(bytes).padStart(9),
            ms.toFixed(1).padStart(8),
          ].join(" | "),
        );
      }
      // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
      console.log(
        [
          "",
          "[snapshot-disk-cost] cold FileTranscriptArtifactStore; in-memory ledger",
          "  events | on disk | frames | bodies | sizes |     bytes | open ms",
          ...rows,
          "",
        ].join("\n"),
      );
    }, 300_000);
  },
);
