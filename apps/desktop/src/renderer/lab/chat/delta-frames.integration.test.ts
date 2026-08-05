/**
 * The delta contract, end to end, through the three layers that have to agree.
 *
 * Every layer is unit-tested against `docs/plans/delta-frames.md` on its own,
 * and each of those tests states the contract in its own layer's vocabulary.
 * That is exactly the shape of test that cannot catch the bug this change is
 * most likely to have — the adapter guaranteeing one thing and the engine
 * assuming a neighbouring one. So this drives the real OpenCode adapter from
 * scripted SSE, through the real `DefaultSessionRuntime`, out of a real
 * subscription, over a JSON round trip (the emission crosses the RPC edge as
 * JSON, and a fold that only ever sees live objects proves nothing about that),
 * and into the renderer's real `appendFrames` — then reads the lines the chat
 * would draw.
 *
 * It lives beside the renderer fold because that is the half with no other
 * home: `session-controller.ts` resolves `@renderer/*`, so only the renderer
 * test project can load it. The Node-hosted adapter is imported here for that
 * reason alone; a test file never enters the renderer bundle, which is the
 * module graph the "no Node imports" rule is about.
 */
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamOverlay,
  type SessionRuntime,
  type SessionStreamEmission,
  type SessionStreamOverlay,
  type TranscriptOverlay,
} from "@volli/session-engine";
import {
  createOpenCodeNativeAdapter,
  type OpenCodeChild,
  type OpenCodeNetworkPort,
  type OpenCodeProcessPort,
  type OpenCodeSseEvent,
} from "@volli/opencode-adapter";
import type { SessionInteraction } from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { appendFrames, type LabSessionFrame } from "./session-controller";

const NATIVE_SESSION_ID = "native-session-1";
const MESSAGE_ID = "provider-assistant";
const TEXT_PART = "answer";
/** Over `STREAM_DELTA_DELAY_MS` (32), so each scripted batch lands in a tick of its own. */
const TICK_MS = 50;

// ---------------------------------------------------------------------------
// Scripted OpenCode. Copied rather than imported for the reason
// `stream-cost.bench.test.ts` states: the adapter's own test file exports
// neither fake, and this needs a sliver of what they do.
// ---------------------------------------------------------------------------

class FakeProcess implements OpenCodeProcessPort {
  async resolveCommand(command: string): Promise<string> {
    return command;
  }
  async version(): Promise<string> {
    return "1.17.18";
  }
  async sha256(): Promise<string> {
    return "sha256:trusted";
  }
  async spawn(): Promise<OpenCodeChild> {
    return { exited: new Promise(() => undefined), stop: async () => undefined };
  }
  async allocatePort(): Promise<number> {
    return 43123;
  }
  randomSecret(): string {
    return "never-persist-this";
  }
}

/**
 * A network whose SSE subscription plays scripted batches with a real wait
 * between them, and hands the test a hook to run between two of them — which is
 * how the mid-message subscribe is staged at the one moment it is interesting.
 */
class ScriptedNetwork implements OpenCodeNetworkPort {
  batches: ReadonlyArray<readonly OpenCodeSseEvent[]> = [];
  /** Runs once the batch at this index has been played and its tick has fired. */
  readonly interludes = new Map<number, () => Promise<void>>();
  /** How many times the adapter has opened the event stream. */
  subscriptions = 0;
  /** When set, the first stream ends after its batches instead of holding open. */
  endFirstStream = false;

  async request(input: Parameters<OpenCodeNetworkPort["request"]>[0]) {
    if (input.path.startsWith("/global/health")) {
      return { status: 200, body: { healthy: true, version: "1.17.18" } };
    }
    if (input.path.startsWith("/session") && input.method === "POST") {
      return input.path.includes("prompt_async")
        ? { status: 204, body: null }
        : { status: 200, body: { id: NATIVE_SESSION_ID } };
    }
    if (input.path.includes("/message")) return { status: 200, body: [] };
    if (input.path.startsWith("/session/status")) {
      return { status: 200, body: { [NATIVE_SESSION_ID]: { type: "idle" } } };
    }
    if (input.path.startsWith("/permission")) return { status: 200, body: [] };
    if (input.path.startsWith("/question")) return { status: 200, body: [] };
    if (input.path.includes("/todo")) return { status: 200, body: [] };
    return { status: 200, body: [{ id: "reported", name: "Reported" }] };
  }

  async subscribe(
    input: Parameters<OpenCodeNetworkPort["subscribe"]>[0],
  ): Promise<AsyncIterable<OpenCodeSseEvent>> {
    const first = this.subscriptions++ === 0;
    const { batches, interludes, endFirstStream } = this;
    return (async function* () {
      // Only the first generation carries the script. A reconnect replays
      // nothing here on purpose: what the reader is owed after one is the
      // durable settle the disconnect made, not the deltas it lost.
      if (first) {
        for (const [index, batch] of batches.entries()) {
          yield* batch;
          await wait(TICK_MS);
          await interludes.get(index)?.();
        }
        if (endFirstStream) return;
      }
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve()));
    })();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The scripted turn: an assistant message that writes, runs a tool, and writes.
// ---------------------------------------------------------------------------

const CHUNKS = ["Reading ", "the runtime ", "overlay, ", "then answering."] as const;
const ANSWER = CHUNKS.join("");

function openAssistant(): OpenCodeSseEvent {
  return {
    id: "assistant-open",
    type: "message.updated",
    properties: { info: { id: MESSAGE_ID, sessionID: NATIVE_SESSION_ID, role: "assistant" } },
  };
}

function textDelta(index: number): OpenCodeSseEvent {
  return {
    id: `delta-${index}`,
    type: "message.part.delta",
    properties: {
      sessionID: NATIVE_SESSION_ID,
      messageID: MESSAGE_ID,
      partID: TEXT_PART,
      field: "text",
      delta: CHUNKS[index],
    },
  };
}

function toolCall(status: "running" | "completed"): OpenCodeSseEvent {
  return {
    id: `tool-${status}`,
    type: "message.part.updated",
    properties: {
      sessionID: NATIVE_SESSION_ID,
      part: {
        id: "tool-part",
        messageID: MESSAGE_ID,
        type: "tool",
        tool: "read",
        callID: "call-read",
        state:
          status === "running"
            ? { status: "running", input: { path: "session-runtime.ts" }, title: "Read" }
            : {
                status: "completed",
                input: { path: "session-runtime.ts" },
                output: { content: "overlay" },
                title: "Read",
                time: { start: 1, end: 2 },
              },
      },
    },
  };
}

const IDLE: OpenCodeSseEvent = {
  id: "idle-final",
  type: "session.idle",
  properties: { sessionID: NATIVE_SESSION_ID },
};

// ---------------------------------------------------------------------------
// Composition: the real runtime hosting the real adapter.
// ---------------------------------------------------------------------------

function composition(network: ScriptedNetwork): SessionRuntime {
  let now = 1000;
  const clock = { now: () => now++ };
  let sequence = 0;
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const adapter = createOpenCodeNativeAdapter({
    process: new FakeProcess(),
    network,
    now: clock.now,
    // A reconnect has to happen inside one test's patience, not OpenCode's.
    healthRetryDelayMs: 5,
  });
  return createSessionRuntime({
    engine: createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids }),
    adapters: createNativeAdapterRegistry([adapter]),
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: {
      resolve: async () => ({ directory: "/workspace/one", venue: { id: "lab", kind: "local" } }),
    },
    clock,
    ids,
  });
}

async function startSession(runtime: SessionRuntime): Promise<string> {
  const created = await runtime.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      title: "Delta frames",
    },
  });
  await runtime.command({
    commandId: "command-attach",
    sessionId: created.sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: "opencode",
      profileId: "native",
      continuity: "fresh",
    },
  });
  return created.sessionId;
}

// ---------------------------------------------------------------------------
// The reader: the lab chat's own intake, minus React.
// ---------------------------------------------------------------------------

const EMPTY = {
  frames: [] as readonly LabSessionFrame[],
  throughSequence: 0,
  turnActive: false,
  durableMessages: [] as readonly UIMessage[],
  overlay: new Map() as TranscriptOverlay,
  durableSequences: new Map() as ReadonlyMap<string, number>,
  messages: [] as readonly UIMessage[],
  openedInteractions: new Map<string, SessionInteraction>() as ReadonlyMap<
    string,
    SessionInteraction
  >,
};

/**
 * One reader of one Session, batching exactly as the controller batches:
 * overlays into an ordered array, durable frames into the sequence-keyed map,
 * one `appendFrames` per animation frame. Every emission makes the JSON round
 * trip it makes on the wire before the fold sees it.
 */
class Reader {
  state = EMPTY as ReturnType<typeof appendFrames>;
  /** Every emission this reader was handed, in delivery order, for the tests about order. */
  readonly received: SessionStreamEmission[] = [];
  readonly #frames = new Map<number, LabSessionFrame>();
  readonly #overlays: SessionStreamOverlay[] = [];
  #unsubscribe: (() => void) | null = null;

  async open(runtime: SessionRuntime, sessionId: string, afterSequence: number): Promise<void> {
    this.#unsubscribe = await runtime.subscribe({ sessionId, afterSequence }, (emission) => {
      const wire = JSON.parse(JSON.stringify(emission)) as SessionStreamEmission;
      this.received.push(wire);
      if (isSessionStreamOverlay(wire)) this.#overlays.push(wire);
      else this.#frames.set(wire.sequence, wire as unknown as LabSessionFrame);
    });
  }

  /** The transient ops this reader was handed, in order. */
  overlayOps(): string[] {
    return this.received.flatMap((emission) =>
      isSessionStreamOverlay(emission) ? [emission.delta.op] : [],
    );
  }

  /** The durable transcript snapshots this reader was handed. */
  settles(): UIMessage[] {
    return this.received.flatMap((emission) =>
      isSessionStreamOverlay(emission) || !emission.transcript ? [] : [emission.transcript.message],
    );
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** One animation frame's worth of intake. */
  flush(): this {
    const batch = [...this.#frames.values()];
    this.#frames.clear();
    this.state = appendFrames(this.state, batch, this.#overlays.splice(0));
    return this;
  }

  /** What the chat would draw. */
  lines(): string[] {
    return this.state.messages.map((message) => `${message.role}: ${render(message)}`);
  }
}

function render(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "reasoning") return `<thinking:${part.state}>`;
      if (part.type === "dynamic-tool") return `<${part.toolName}:${part.state}>`;
      return `<${part.type}>`;
    })
    .join("|");
}

describe("delta frames, adapter to renderer", () => {
  it("grows one message through the overlay and settles it in place", async () => {
    const network = new ScriptedNetwork();
    network.batches = [
      [openAssistant(), textDelta(0)],
      [textDelta(1), toolCall("running")],
      [toolCall("completed"), textDelta(2)],
      [textDelta(3)],
      [IDLE],
    ];
    const runtime = composition(network);
    const sessionId = await startSession(runtime);
    const reader = new Reader();
    await reader.open(runtime, sessionId, 0);

    const seen: string[][] = [];
    for (const index of [0, 1, 2, 3]) {
      network.interludes.set(index, async () => {
        seen.push(reader.flush().lines());
      });
    }
    await wait(TICK_MS * 8);
    reader.flush();

    // The reader watched one message grow, and never more than one.
    expect(seen.map((lines) => lines.length)).toEqual([1, 1, 1, 1]);
    expect(seen.map((lines) => lines[0])).toEqual([
      "assistant: Reading ",
      "assistant: Reading the runtime |<read:input-available>",
      "assistant: Reading the runtime overlay, |<read:output-available>",
      "assistant: Reading the runtime overlay, then answering.|<read:output-available>",
    ]);

    // Settled: one durable message saying exactly what the overlay said, and
    // the transient entry gone rather than laid over it.
    expect(reader.state.overlay.size).toBe(0);
    expect(reader.state.durableMessages).toHaveLength(1);
    expect(reader.lines()).toEqual([`assistant: ${ANSWER}|<read:output-available>`]);

    // The point of the whole change, read off the wire: the message was made
    // durable once, at its settle point, not once per coalescing tick.
    expect(reader.settles().map(render)).toEqual([`${ANSWER}|<read:output-available>`]);
    // And the transient arm led with a baseline and then only ever grew.
    expect(reader.overlayOps()[0]).toBe("reset");
    expect(reader.overlayOps().filter((op) => op === "reset")).toHaveLength(1);
    reader.close();
  });

  it("serves a reader that joins mid-message the baseline it missed", async () => {
    const network = new ScriptedNetwork();
    network.batches = [
      [openAssistant(), textDelta(0)],
      [textDelta(1)],
      [textDelta(2), textDelta(3)],
      [IDLE],
    ];
    const runtime = composition(network);
    const sessionId = await startSession(runtime);
    const late = new Reader();

    // Joins after two ticks, having seen neither of their deltas.
    network.interludes.set(1, async () => {
      await late.open(runtime, sessionId, 0);
    });
    let baseline: string[] = [];
    network.interludes.set(2, async () => {
      baseline = late.flush().lines();
    });
    await wait(TICK_MS * 8);
    late.flush();

    // The first thing a mid-message subscriber is handed is a baseline, and it
    // carries what was already written — a fold handed the appends alone holds
    // no entry for them and would have drawn nothing at all.
    const first = late.received.find((emission) => isSessionStreamOverlay(emission));
    expect(first && isSessionStreamOverlay(first) && first.delta.op).toBe("reset");
    expect(baseline).toEqual([`assistant: ${ANSWER}`]);
    expect(late.state.overlay.size).toBe(0);
    expect(late.lines()).toEqual([`assistant: ${ANSWER}`]);
    late.close();
  });

  it("settles the in-flight message durably when the adapter is released", async () => {
    const network = new ScriptedNetwork();
    network.batches = [[openAssistant(), textDelta(0)], [textDelta(1)]];
    const runtime = composition(network);
    const sessionId = await startSession(runtime);
    const reader = new Reader();
    await reader.open(runtime, sessionId, 0);
    await wait(TICK_MS * 4);

    // Mid-message, with nothing durable behind it yet: the overlay holds the
    // only copy of what has been written.
    expect(reader.flush().state.overlay.size).toBe(1);
    expect(reader.state.durableMessages).toHaveLength(0);

    const { projection } = await runtime.projection({ sessionId });
    const attachmentId = projection.liveExecutor?.id ?? "";
    expect(attachmentId).not.toBe("");
    await runtime.command({
      commandId: "command-release",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    reader.flush();

    // Release is a normal user action, not a crash, so it settles first. The
    // transcript survives the executor going away, and the transient entry it
    // came from is gone rather than laid over the durable record of it.
    expect(reader.state.durableMessages.map(render)).toEqual(["Reading the runtime "]);
    expect(reader.state.overlay.size).toBe(0);
    expect(reader.lines()).toEqual(["assistant: Reading the runtime "]);
    reader.close();
  });

  it("settles the in-flight message durably when the stream drops", async () => {
    const network = new ScriptedNetwork();
    network.endFirstStream = true;
    network.batches = [[openAssistant(), textDelta(0)], [textDelta(1)]];
    const runtime = composition(network);
    const sessionId = await startSession(runtime);
    const reader = new Reader();
    await reader.open(runtime, sessionId, 0);

    await wait(TICK_MS * 6);
    reader.flush();

    // The disconnect is a settle point, so the tail the overlay held is durable
    // now and no reader has to have been watching to keep it.
    expect(network.subscriptions).toBeGreaterThan(1);
    expect(reader.state.overlay.size).toBe(0);
    expect(reader.state.durableMessages.map(render)).toEqual(["Reading the runtime "]);
    reader.close();

    // A reader that arrives after the drop replays durable history and is
    // served the same transcript — no gap, and no second bubble.
    const resumed = new Reader();
    await resumed.open(runtime, sessionId, 0);
    expect(resumed.flush().lines()).toEqual(["assistant: Reading the runtime "]);
    resumed.close();
  });
});
