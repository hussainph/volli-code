/**
 * A Session recorded before transcript digests existed, opened through the real
 * host runtime (VC-315's legacy baseline).
 *
 * The renderer tests that hold the re-check review's plan and `/copy` probes
 * take the host half from here rather than from a hand-written projection, so
 * what they pin is the whole path: pre-digest history in the ledger, a bounded
 * open on a fresh host with no projection checkpoint, and what the surface
 * shows from that snapshot.
 */
import {
  ACTIVITY_METADATA_KEY,
  type SessionEvent,
  type SessionLedgerIds,
  type SessionTodoList,
} from "@volli/shared";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionRuntime,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionEnginePorts,
  type SessionRuntimeSnapshot,
  type TranscriptArtifactStore,
} from "@volli/session-engine";
import type { UIMessage } from "ai";

/** One recorded assistant message: its prose (blank is silent) and, optionally, a plan call. */
export interface LegacyMessage {
  say: string;
  plan?: SessionTodoList;
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
      native: { id: "native-legacy", detail: null },
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

function planPart(todos: SessionTodoList): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "volli.activity",
    toolCallId: "legacy-plan-call",
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

async function location() {
  return { directory: "/projects/legacy", venue: { id: "machine-1", kind: "local" as const } };
}

const locations = { resolve: location, prepare: location, reaffirm: async () => undefined };

/** A transcript fact as a build before digests wrote it. */
function strip(event: SessionEvent): SessionEvent {
  if (event.payload.kind !== "transcript.referenced") return event;
  const { digest: _digest, ...payload } = event.payload;
  return { ...event, payload };
}

/**
 * Records `messages` in one turn, then opens the Session as a host upgraded
 * past them does: every transcript fact read back without its digest, and no
 * projection checkpoint. Answers that open's snapshot.
 *
 * `engineOf` is the engine factory, handed in by the calling test: this file
 * is not a `.test` file, and desktop sources other than tests never build a
 * Session engine of their own (VC-632's guard).
 */
export async function openLegacySession(
  engineOf: (ports: SessionEnginePorts) => SessionEngine,
  messages: readonly LegacyMessage[],
): Promise<SessionRuntimeSnapshot> {
  let now = 100;
  const clock = { now: () => now++ };
  let id = 0;
  const ids: SessionLedgerIds = { next: (kind) => `${kind}-${++id}` };
  const engine = engineOf({ ledger: createInMemorySessionLedger(), clock, ids });
  const memory = createInMemoryTranscriptArtifactStore();
  let nextPlan: SessionTodoList | null = null;
  const artifacts: TranscriptArtifactStore = {
    read: (reference) => memory.read(reference),
    byteLength: (reference) => memory.byteLength!(reference),
    write: (artifact) => {
      if (nextPlan !== null) artifact.message.parts.push(planPart(nextPlan));
      return memory.write(artifact);
    },
  };
  const adapter = new TemplateAdapter();
  const live = createSessionRuntime({
    engine,
    executor: adapter,
    artifacts,
    locations,
    clock,
    ids: { next: (kind) => `live-${kind}-${++id}` },
  });
  const { sessionId } = await live.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Legacy",
    },
  });
  await live.command({
    commandId: "command-attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  const sink = adapter.sink!;
  await sink.emit({ kind: "turn", state: "started", turnId: "turn-1" });
  for (const [index, message] of messages.entries()) {
    nextPlan = message.plan ?? null;
    await sink.emit({
      kind: "message-settled",
      turnId: "turn-1",
      message: { entryId: `entry-${index}`, role: "assistant", text: message.say },
    });
    nextPlan = null;
  }
  await live.close();

  const legacy: SessionEngine = {
    ...engine,
    listEvents: async (input) => (await engine.listEvents(input)).map(strip),
    getProjectionCheckpoint: async () => null,
    saveProjectionCheckpoint: async () => undefined,
  };
  const host = createSessionRuntime({
    engine: legacy,
    executor: new TemplateAdapter(),
    artifacts: memory,
    locations,
    clock,
    ids: { next: (kind) => `host-${kind}-${++id}` },
  });
  try {
    return await host.snapshot({ sessionId });
  } finally {
    await host.close();
  }
}
