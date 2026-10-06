import { describe, expect, it, vi } from "vite-plus/test";
import {
  ACTIVITY_METADATA_KEY,
  type SessionEvent,
  type SessionLedgerIds,
  type SessionProjectionCheckpoint,
  type SessionTodoList,
  type TranscriptReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  currentTodoList,
  SESSION_HISTORY_WINDOW,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionLocationResolver,
  type SessionRuntimeSnapshot,
  type SessionStreamFrame,
  type TranscriptArtifactStore,
} from "./index";
import { BASELINE_SCAN_CHUNK, recoverTranscriptBaseline } from "./transcript-baseline";
import type { SessionTranscriptArtifact } from "./transcript-artifacts";

/**
 * The plan and reply of a Session whose history predates transcript digests,
 * recovered by the host on a bounded open (VC-315's legacy baseline).
 *
 * The first describe block holds the re-check review's host probe, kept as a
 * passing test: a Session recorded before digests existed, reopened through a
 * fresh runtime with its projection checkpoint gone, still answers its plan
 * and its current turn's reply although both sit above the window. The rest
 * pin how: once, cached, best effort, and through digests where there are
 * some.
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

/** The plan tool part a `todo_write` call settles into. */
function planPart(todos: SessionTodoList, callId: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "volli.activity",
    toolCallId: callId,
    state: "output-available",
    input: { todos },
    output: { ok: true },
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: "plan",
        nativeToolName: "todo_write",
        subject: { label: null, path: null, lineRange: null },
        outcome: null,
        startedAt: null,
        endedAt: null,
      },
    },
  } as UIMessage["parts"][number];
}

/** One step of a recorded Session. */
type Step =
  /** An assistant message: `text` (blank is silent), and a plan call when `plan` is given. */
  | { say: string; plan?: SessionTodoList }
  /** `count` silent assistant messages. */
  | { silent: number }
  /** A user message submitted between turns: the current turn's reply resets. */
  | { submit: string }
  /** This build is installed: everything recorded so far reads back without digests. */
  | "upgrade";

const PLAN = [{ content: "Finish legacy migration", status: "in_progress" as const }];

interface Recorded {
  sessionId: string;
  /** Every event as a reader sees it: digests stripped up to the upgrade. */
  events: () => Promise<readonly SessionEvent[]>;
  /** Opens the Session through a fresh runtime, as a restarted host does. */
  reopen: () => Promise<{
    snapshot: SessionRuntimeSnapshot;
    /** Artifact ids read by this open. */
    reads: readonly string[];
    failures: readonly unknown[];
  }>;
  /** The persisted projection checkpoint, shared by every reopen. */
  checkpoint: () => SessionProjectionCheckpoint | null;
  forgetCheckpoint: () => void;
  /** Ledger reads that fail: the recovery's scan, or the fold that keeps its result. */
  faults: { scan: boolean; adopt: boolean };
  /** Makes this artifact's body unreadable, throwing `thrown`. */
  corrupt: (referenceId: string, thrown?: unknown) => void;
  /** A body as stored, read past every counter and fault. */
  stored: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  /** The artifact id of the message whose prose is `text`. */
  referenceOf: (text: string) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Records `steps` through a live runtime, then serves the log back as a host
 * reading pre-digest data does: every transcript fact recorded before
 * `"upgrade"` loses its digest. The projection checkpoint starts absent.
 */
async function record(steps: readonly Step[]): Promise<Recorded> {
  let now = 100;
  const clock = { now: () => now++ };
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock,
    ids: counter(),
  });
  const memory = createInMemoryTranscriptArtifactStore();
  let nextPlan: SessionTodoList | null = null;
  let calls = 0;
  const recording: TranscriptArtifactStore = {
    read: (reference) => memory.read(reference),
    byteLength: (reference) => memory.byteLength!(reference),
    write: (artifact) => {
      // Into the very message being recorded, so the digest the runtime
      // writes after this sees the plan call as it would a real one.
      if (nextPlan !== null)
        artifact.message.parts.push(planPart(nextPlan, `plan-call-${++calls}`));
      return memory.write(artifact);
    },
  };
  const adapter = new TemplateAdapter();
  const live = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts: recording,
    locations: fixedLocation("/projects/fake"),
    clock,
    ids: runtimeCounter("live-"),
  });
  const { sessionId } = await live.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Legacy baseline",
    },
  });
  await live.command({
    commandId: "command-attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  const sink = adapter.sink!;
  let turn = 0;
  let entry = 0;
  let open = false;
  const ensureTurn = async () => {
    if (open) return;
    turn += 1;
    open = true;
    await sink.emit({ kind: "turn", state: "started", turnId: `turn-${turn}` });
  };
  const settle = async (text: string) => {
    await ensureTurn();
    entry += 1;
    await sink.emit({
      kind: "message-settled",
      turnId: `turn-${turn}`,
      message: { entryId: `entry-${entry}`, role: "assistant", text },
    });
  };
  let legacyThrough = 0;
  for (const step of steps) {
    if (step === "upgrade") {
      legacyThrough = await engine.latestEventSequence({ sessionId });
    } else if ("say" in step) {
      nextPlan = step.plan ?? null;
      await settle(step.say);
      nextPlan = null;
    } else if ("silent" in step) {
      for (let index = 0; index < step.silent; index += 1) await settle("   ");
    } else {
      if (open) await sink.emit({ kind: "turn", state: "completed", turnId: `turn-${turn}` });
      open = false;
      entry += 1;
      await live.command({
        commandId: `command-submit-${entry}`,
        sessionId,
        command: {
          kind: "message.submit",
          message: {
            id: `user-${entry}`,
            role: "user",
            parts: [{ type: "text", text: step.submit }],
          },
        },
      });
    }
  }
  if (!steps.includes("upgrade")) legacyThrough = await engine.latestEventSequence({ sessionId });

  const strip = (event: SessionEvent): SessionEvent => {
    if (event.payload.kind !== "transcript.referenced" || event.sequence > legacyThrough) {
      return event;
    }
    const { digest: _digest, ...payload } = event.payload;
    return { ...event, payload };
  };
  let persisted: SessionProjectionCheckpoint | null = null;
  const faults = { scan: false, adopt: false };
  const reader: SessionEngine = {
    ...engine,
    listEvents: async (input) => {
      // The recovery's backward ranges are full scan chunks; the fold's tail
      // read after a recovery pages from a cursor past the first event.
      if (faults.scan && input.limit === BASELINE_SCAN_CHUNK) throw new Error("ledger is down");
      if (faults.adopt && (input.afterSequence ?? 0) > 0 && input.limit === 500) {
        throw new Error("ledger is down");
      }
      return (await engine.listEvents(input)).map(strip);
    },
    getProjectionCheckpoint: async () => (persisted === null ? null : structuredClone(persisted)),
    saveProjectionCheckpoint: async (checkpoint) => {
      if (persisted !== null && persisted.throughSequence > checkpoint.throughSequence) return;
      persisted = structuredClone(checkpoint);
    },
  };
  const corrupt = new Map<string, unknown>();
  const runtimes: { close: () => Promise<void> }[] = [live];
  return {
    sessionId,
    events: () => reader.listEvents({ sessionId }),
    reopen: async () => {
      const reads: string[] = [];
      const failures: unknown[] = [];
      const runtime = createSessionRuntime({
        engine: reader,
        executor: new TemplateAdapter(),
        artifacts: {
          write: (artifact) => memory.write(artifact),
          byteLength: (reference) => memory.byteLength!(reference),
          read: async (reference) => {
            reads.push(reference.id);
            if (corrupt.has(reference.id)) throw corrupt.get(reference.id);
            return memory.read(reference);
          },
        },
        locations: fixedLocation("/projects/fake"),
        clock,
        ids: runtimeCounter(`reopen-${runtimes.length}-`),
        onProjectionCheckpointFailure: (error) => {
          failures.push(error);
        },
      });
      runtimes.push(runtime);
      const snapshot = await runtime.snapshot({ sessionId });
      return { snapshot, reads, failures };
    },
    checkpoint: () => persisted,
    forgetCheckpoint: () => {
      persisted = null;
    },
    corrupt: (id, thrown = new Error("artifact is corrupt")) => corrupt.set(id, thrown),
    faults,
    stored: (reference) => memory.read(reference),
    referenceOf: async (text) => {
      for (const event of await engine.listEvents({ sessionId })) {
        if (event.payload.kind !== "transcript.referenced") continue;
        const body = await memory.read(event.payload.reference);
        if (body.message.parts.some((part) => part.type === "text" && part.text === text)) {
          return event.payload.reference.id;
        }
      }
      throw new Error(`no message says ${text}`);
    },
    close: async () => {
      for (const runtime of runtimes) await runtime.close();
    },
  };
}

/** The artifact ids a window inlines: what an open may read for its frames. */
function inlined(frames: readonly SessionStreamFrame[]): string[] {
  return frames.flatMap(({ event }) =>
    event.payload.kind === "transcript.referenced" ? [event.payload.reference.id] : [],
  );
}

/** What an open read beyond its own window's frames. */
function outside(open: { snapshot: SessionRuntimeSnapshot; reads: readonly string[] }): string[] {
  const window = new Set(inlined(open.snapshot.frames));
  return open.reads.filter((id) => !window.has(id));
}

/** Silent messages enough to push everything before them above the window. */
const BEYOND = SESSION_HISTORY_WINDOW.events + 4;

describe("VC-315 recheck: legacy host snapshot", () => {
  it("recovers the legacy plan and reply above the bounded tail", async () => {
    const legacy = await record([{ say: "Current-turn reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      const { snapshot } = await legacy.reopen();
      expect(snapshot.before).not.toBeNull();
      expect(
        snapshot.frames.some(({ transcript }) =>
          (JSON.stringify(transcript?.message.parts) ?? "").includes("Current-turn reply"),
        ),
      ).toBe(false);
      // The record really holds the plan and the prose above this window, and
      // nothing on it says so but the body: no digest.
      const events = await legacy.events();
      const reply = events.find(({ payload }) => payload.kind === "transcript.referenced")!;
      if (reply.payload.kind !== "transcript.referenced") throw new Error("no reply");
      expect(reply.payload.digest).toBeUndefined();
      expect(reply.sequence).toBeLessThan(snapshot.frames[0]!.sequence);
      const stored = await legacy.stored(reply.payload.reference);
      expect(currentTodoList([stored.message])).toEqual(PLAN);
      expect(JSON.stringify(stored.message.parts)).toContain("Current-turn reply");

      expect(snapshot.projection.todoList).toEqual(PLAN);
      expect(snapshot.latestReply).toEqual({
        sequence: reply.sequence,
        text: "Current-turn reply",
      });
    } finally {
      await legacy.close();
    }
  });
});

describe("recovering a legacy Session's baseline (VC-315)", () => {
  it("runs once: the next open reads nothing outside its window but what a digest-bearing Session reads", async () => {
    const legacy = await record([
      { say: "   ", plan: PLAN },
      { silent: BEYOND },
      { say: "Latest reply" },
    ]);
    try {
      const first = await legacy.reopen();
      expect(first.snapshot.projection.todoList).toEqual(PLAN);
      expect(first.snapshot.latestReply?.text).toBe("Latest reply");
      // The scan read the legacy bodies between the window and the plan.
      expect(outside(first).length).toBeGreaterThan(0);
      expect(legacy.checkpoint()?.baselineComplete).toBe(true);
      expect(legacy.checkpoint()?.projection.todoList).toEqual(PLAN);

      const second = await legacy.reopen();
      expect(second.snapshot.projection.todoList).toEqual(PLAN);
      expect(second.snapshot.latestReply?.text).toBe("Latest reply");
      expect(second.reads.toSorted()).toEqual(inlined(second.snapshot.frames).toSorted());
      expect(outside(second)).toEqual([]);
    } finally {
      await legacy.close();
    }
  });

  it("reads the reply above the window on later opens exactly as a digest-bearing Session does", async () => {
    const legacy = await record([{ say: "Current-turn reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      await legacy.reopen();
      const again = await legacy.reopen();
      expect(again.snapshot.projection.todoList).toEqual(PLAN);
      expect(again.snapshot.latestReply?.text).toBe("Current-turn reply");
      // The B2 baseline's one body above the window, and no scan.
      expect(outside(again)).toEqual([await legacy.referenceOf("Current-turn reply")]);
    } finally {
      await legacy.close();
    }
  });

  it("recovers again, the same, when the checkpoint is thrown away", async () => {
    const legacy = await record([{ say: "Current-turn reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      const first = await legacy.reopen();
      legacy.forgetCheckpoint();
      const again = await legacy.reopen();
      expect(again.snapshot.projection.todoList).toEqual(first.snapshot.projection.todoList);
      expect(again.snapshot.latestReply).toEqual(first.snapshot.latestReply);
      expect(outside(again).toSorted()).toEqual(outside(first).toSorted());
    } finally {
      await legacy.close();
    }
  });

  it("opens with no plan when the plan's body outside the window is corrupt, and says so", async () => {
    const legacy = await record([
      { say: "Earlier reply" },
      { say: "   ", plan: PLAN },
      { silent: BEYOND },
    ]);
    try {
      const events = await legacy.events();
      const transcripts = events.filter(({ payload }) => payload.kind === "transcript.referenced");
      const planEvent = transcripts[1]!;
      if (planEvent.payload.kind !== "transcript.referenced") throw new Error("unreachable");
      legacy.corrupt(planEvent.payload.reference.id);
      // And one silent body between it and the window, failing with no Error at all.
      const silent = transcripts[2]!;
      if (silent.payload.kind !== "transcript.referenced") throw new Error("unreachable");
      legacy.corrupt(silent.payload.reference.id, "disk said no");

      const open = await legacy.reopen();
      expect(open.snapshot.frames.length).toBeGreaterThan(0);
      expect(open.snapshot.before).not.toBeNull();
      expect(open.snapshot.projection.todoList).toBeUndefined();
      // Skipped, not fatal: the scan went on past it and found the reply.
      expect(open.snapshot.latestReply?.text).toBe("Earlier reply");
      expect((open.failures as Error[]).map(({ message }) => message.split(": ").slice(1))).toEqual(
        [
          [
            `plan and reply recovery skipped the transcript at sequence ${silent.sequence}`,
            "disk said no",
          ],
          [
            `plan and reply recovery skipped the transcript at sequence ${planEvent.sequence}`,
            "artifact is corrupt",
          ],
        ],
      );
      // Best effort is still once: the next open does not try the body again.
      const next = await legacy.reopen();
      expect(next.snapshot.projection.todoList).toBeUndefined();
      expect(next.reads).not.toContain(planEvent.payload.reference.id);
    } finally {
      await legacy.close();
    }
  });

  it("opens as before when the scan itself fails, and recovers on the next open", async () => {
    const legacy = await record([{ say: "Current-turn reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      legacy.faults.scan = true;
      const failed = await legacy.reopen();
      expect(failed.snapshot.before).not.toBeNull();
      expect(failed.snapshot.frames.length).toBeGreaterThan(0);
      expect(failed.snapshot.projection.todoList).toBeUndefined();
      expect(failed.snapshot.latestReply).toBeNull();
      expect(failed.failures).toEqual([new Error("ledger is down")]);
      expect(legacy.checkpoint()?.baselineComplete).toBeUndefined();

      legacy.faults.scan = false;
      const recovered = await legacy.reopen();
      expect(recovered.snapshot.projection.todoList).toEqual(PLAN);
      expect(recovered.snapshot.latestReply?.text).toBe("Current-turn reply");
    } finally {
      await legacy.close();
    }
  });

  it("answers what it recovered even when keeping it fails, and recovers again next time", async () => {
    const legacy = await record([{ say: "Current-turn reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      legacy.faults.adopt = true;
      const unkept = await legacy.reopen();
      expect(unkept.snapshot.projection.todoList).toEqual(PLAN);
      expect(unkept.snapshot.latestReply?.text).toBe("Current-turn reply");
      expect(unkept.failures).toEqual([new Error("ledger is down")]);
      expect(legacy.checkpoint()?.baselineComplete).toBeUndefined();

      legacy.faults.adopt = false;
      const again = await legacy.reopen();
      expect(again.snapshot.projection.todoList).toEqual(PLAN);
      expect(outside(again).length).toBeGreaterThan(0);
      expect(legacy.checkpoint()?.baselineComplete).toBe(true);
    } finally {
      await legacy.close();
    }
  });

  it("recovers through a mixed Session's digest-bearing tail, reading only the legacy bodies", async () => {
    const legacy = await record([
      { say: "Legacy reply", plan: PLAN },
      "upgrade",
      { silent: BEYOND },
    ]);
    try {
      const events = await legacy.events();
      const digested = events.filter(
        ({ payload }) => payload.kind === "transcript.referenced" && payload.digest !== undefined,
      );
      expect(digested.length).toBe(BEYOND);
      const open = await legacy.reopen();
      expect(open.snapshot.projection.todoList).toEqual(PLAN);
      expect(open.snapshot.latestReply?.text).toBe("Legacy reply");
      // Digests answered every newer fact; the one legacy body was read once.
      expect(outside(open)).toEqual([await legacy.referenceOf("Legacy reply")]);
    } finally {
      await legacy.close();
    }
  });

  it("lets a newer turn's user message and plan outrank the legacy baseline", async () => {
    const newer = [{ content: "Ship it", status: "pending" as const }];
    const legacy = await record([
      { say: "Legacy reply", plan: PLAN },
      { silent: 3 },
      "upgrade",
      { submit: "Next, please" },
      { say: "   ", plan: newer },
      { silent: BEYOND },
    ]);
    try {
      const open = await legacy.reopen();
      // The newer digest-bearing plan already stands in the projection.
      expect(open.snapshot.projection.todoList).toEqual(newer);
      // The submit opened a turn that has not spoken: no reply, and the scan
      // stopped at it without reading a single legacy body.
      expect(open.snapshot.latestReply).toBeNull();
      expect(open.snapshot.projection.latestReply).toBeUndefined();
      expect(outside(open)).toEqual([]);
      expect(legacy.checkpoint()?.baselineComplete).toBe(true);
    } finally {
      await legacy.close();
    }
  });

  it("never scans a Session born with digests", async () => {
    const born = await record(["upgrade", { say: "Reply", plan: PLAN }, { silent: BEYOND }]);
    try {
      const open = await born.reopen();
      expect(open.snapshot.projection.todoList).toEqual(PLAN);
      expect(outside(open)).toEqual([await born.referenceOf("Reply")]);
      expect(born.checkpoint()?.baselineComplete).toBe(true);
    } finally {
      await born.close();
    }
  });

  it("holds a short legacy Session's baseline from its window alone", async () => {
    const legacy = await record([{ say: "Short reply", plan: PLAN }, { silent: 3 }]);
    try {
      const open = await legacy.reopen();
      expect(open.snapshot.before).toBeNull();
      expect(open.snapshot.projection.todoList).toEqual(PLAN);
      expect(open.snapshot.latestReply?.text).toBe("Short reply");
      expect(outside(open)).toEqual([]);
    } finally {
      await legacy.close();
    }
  });
});

/** A transcript fact, with a digest or as one written before them. */
function fact(
  sequence: number,
  digest?: { role: "user" | "assistant"; reply?: true; todoList?: SessionTodoList },
): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "s",
    sequence,
    payload: {
      kind: "transcript.referenced",
      attachmentId: null,
      turnId: null,
      reference: { id: `ref-${sequence}`, mediaType: null, digest: null },
      ...(digest === undefined ? {} : { digest }),
    },
  } as unknown as SessionEvent;
}

/** A transcript body holding `message`. */
function bodyOf(message: Partial<UIMessage>): SessionTranscriptArtifact {
  return {
    message: { id: "m", role: "assistant", parts: [], ...message },
  } as SessionTranscriptArtifact;
}

describe("recoverTranscriptBaseline", () => {
  it("reads in backward ranges, a pool at a time, and stops at the first answer", async () => {
    const log = Array.from({ length: BASELINE_SCAN_CHUNK * 2 + 10 }, (_, index) => fact(index + 1));
    const ranges: [number, number][] = [];
    const read = vi.fn(async (reference: { id: string }) =>
      reference.id === "ref-5"
        ? bodyOf({ parts: [{ type: "text", text: "found" }, planPart(PLAN, "c")] })
        : bodyOf({}),
    );
    const recovered = await recoverTranscriptBaseline({}, log.length, {
      range: async (after, before) => {
        ranges.push([after, before]);
        return log.slice(after, before - 1);
      },
      read,
      held: new Map(),
      concurrency: 4,
      onSkipped: () => undefined,
    });
    expect(recovered.todoList).toEqual(PLAN);
    expect(recovered.latestReply).toMatchObject({ sequence: 5 });
    expect(ranges).toEqual([
      [log.length - BASELINE_SCAN_CHUNK, log.length + 1],
      [log.length - BASELINE_SCAN_CHUNK * 2, log.length - BASELINE_SCAN_CHUNK + 1],
      [0, log.length - BASELINE_SCAN_CHUNK * 2 + 1],
    ]);
    // Every body from the head down to the answer, and at most a pool past it.
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(log.length - 4);
    expect(read.mock.calls.length).toBeLessThanOrEqual(log.length);
  });

  it("keeps what the projection already says and looks only for the rest", async () => {
    const range = vi.fn(async () => [fact(1, { role: "assistant", reply: true })]);
    const location = { sequence: 9, reference: { id: "r", mediaType: null, digest: null } };
    const both = await recoverTranscriptBaseline({ todoList: [], latestReply: location }, 9, {
      range,
      read: async () => bodyOf({}),
      held: new Map(),
      concurrency: 4,
      onSkipped: () => undefined,
    });
    expect(both).toEqual({ todoList: [], latestReply: location, read: new Map() });
    expect(range).not.toHaveBeenCalled();
  });

  it("skips a body that is not a message, and a reporter that throws", async () => {
    const skipped: number[] = [];
    const recovered = await recoverTranscriptBaseline({}, 2, {
      range: async () => [fact(1), fact(2)],
      read: async (reference) =>
        reference.id === "ref-2"
          ? ({
              message: { role: "assistant", parts: null },
            } as unknown as SessionTranscriptArtifact)
          : bodyOf({ parts: [{ type: "text", text: "older" }] }),
      held: new Map(),
      concurrency: 1,
      onSkipped: (sequence) => {
        skipped.push(sequence);
        throw new Error("reporter down");
      },
    });
    expect(recovered.latestReply).toMatchObject({ sequence: 1 });
    expect(recovered.todoList).toBeUndefined();
    expect(skipped).toEqual([2]);
  });

  it("survives a reporter whose report rejects", async () => {
    const recovered = await recoverTranscriptBaseline({}, 1, {
      range: async () => [fact(1)],
      read: async () => ({ message: { parts: 7 } }) as unknown as SessionTranscriptArtifact,
      held: new Map(),
      concurrency: 1,
      onSkipped: async () => {
        throw new Error("reporter down");
      },
    });
    expect(recovered).toEqual({ read: new Map([[1, { message: { parts: 7 } }]]) });
  });

  it("stops the reply at a user message, from a digest or a body", async () => {
    const fromDigest = await recoverTranscriptBaseline({}, 2, {
      range: async () => [fact(1, { role: "assistant", reply: true }), fact(2, { role: "user" })],
      read: async () => bodyOf({}),
      held: new Map(),
      concurrency: 4,
      onSkipped: () => undefined,
    });
    expect(fromDigest.latestReply).toBeUndefined();
    const fromBody = await recoverTranscriptBaseline({}, 2, {
      range: async () => [fact(1, { role: "assistant", reply: true }), fact(2)],
      read: async () => bodyOf({ role: "user", parts: [{ type: "text", text: "hi" }] }),
      held: new Map(),
      concurrency: 4,
      onSkipped: () => undefined,
    });
    expect(fromBody.latestReply).toBeUndefined();
  });

  it("reads nothing the window already holds", async () => {
    const read = vi.fn(async () => bodyOf({}));
    const recovered = await recoverTranscriptBaseline({}, 1, {
      range: async () => [fact(1)],
      read,
      held: new Map([[1, bodyOf({ parts: [{ type: "text", text: "held" }] })]]),
      concurrency: 4,
      onSkipped: () => undefined,
    });
    expect(recovered.latestReply).toMatchObject({ sequence: 1 });
    expect(read).not.toHaveBeenCalled();
  });
});
