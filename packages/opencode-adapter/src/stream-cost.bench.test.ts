import { describe, expect, it } from "vite-plus/test";
import type { HarnessObservation, ObservationSink } from "@volli/session-engine";
import {
  createOpenCodeNativeAdapter,
  type OpenCodeAdapterOptions,
  type OpenCodeChild,
  type OpenCodeNativeAdapter,
  type OpenCodeNetworkPort,
  type OpenCodeProcessPort,
  type OpenCodeSseEvent,
} from "./index";

/**
 * Wire probe for `docs/plans/delta-frames.md` ("Proof, checked in before the
 * change", item 1), now measuring the change it was built to price.
 *
 * The baseline it recorded: a full-`UIMessage` rebuild every 32ms, emitted as a
 * `transcript.message` observation, so one streamed answer cost the whole
 * message's bytes once per coalescing tick (19.63x its own final size). The
 * adapter now emits a transient delta batch per tick and settles durably at
 * turn end, so the same run costs the answer's own bytes plus one settled copy
 * of it. Both arms are summed here — a probe that counted only the durable one
 * would report a win it did not measure.
 *
 * Not a `vitest bench` — a plain assertion-bearing test whose console output
 * is the artifact. Determinism matters more than wall-clock speed: fixed
 * fixture text, fixed chunk sizes, real timers driven by explicit waits (this
 * file has no fake-timer story to inherit, so it copies the real-timer
 * pattern `index.test.ts` already uses for its coalescing assertions).
 */

// ---------------------------------------------------------------------------
// Deterministic long-answer fixture
// ---------------------------------------------------------------------------

/** Reproducible prose — no Date.now, no randomness, same bytes every run. */
function fixtureProse(count: number, seed: string): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `Paragraph ${seed}-${i} explains step ${i} of the migration in plain language, ` +
      `covering rationale, tradeoffs, and the follow-up work it unlocks for the delta-frame overlay.`,
  ).join("\n\n");
}

/** A fenced code block whose body grows with `lines`, still fully deterministic. */
function fixtureCodeBlock(lang: string, lines: number, seed: string): string {
  const body = Array.from(
    { length: lines },
    (_, i) =>
      `const line${i} = "${seed}-${i}"; // deterministic fixture line for the stream-cost probe`,
  ).join("\n");
  return "```" + lang + "\n" + body + "\n```\n";
}

/**
 * The full streamed answer: three fenced code blocks (ts/tsx/json) separated
 * by prose, ~16-20KB — big enough that per-tick full-message coalescing costs
 * something worth measuring, small enough the probe runs in about a second.
 */
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

/** Fixed 24/32/48/64-char chunks, cycled in order — no randomness in the split. */
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
// Minimal scripted-SSE harness, copied from index.test.ts's FakeNetwork /
// FakeProcess seam (not imported — that file exports neither, and this probe
// only needs a sliver of what it does).
// ---------------------------------------------------------------------------

class FakeProcess implements OpenCodeProcessPort {
  spawns: Array<{
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }> = [];
  async resolveCommand(command: string): Promise<string> {
    return command === "opencode" ? "/trusted/opencode" : command;
  }
  async version(): Promise<string> {
    return "1.17.18";
  }
  async sha256(): Promise<string> {
    return "sha256:trusted";
  }
  async spawn(input: {
    path: string;
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
  }): Promise<OpenCodeChild> {
    this.spawns.push(input);
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
 * A network whose SSE subscription yields a scripted event list in batches,
 * sleeping (real timer) between batches. The sleep is what lets
 * `STREAM_DELTA_DELAY_MS` (32ms) fire and coalesce each batch into a tick of
 * its own — a subscribe() that yields everything in one microtask tick would
 * produce exactly one frame and prove nothing about per-tick amplification.
 */
class FakeNetwork implements OpenCodeNetworkPort {
  requests: Array<{ path: string; method: string; body: unknown }> = [];
  events: readonly OpenCodeSseEvent[] = [];
  batchSize = 1;
  batchWaitMs = 0;
  async request(input: Parameters<OpenCodeNetworkPort["request"]>[0]) {
    this.requests.push({ path: input.path, method: input.method, body: input.body });
    if (input.path.startsWith("/global/health")) {
      return { status: 200, body: { healthy: true, version: "1.17.18" } };
    }
    if (
      input.path.startsWith("/session") &&
      input.method === "POST" &&
      input.path.includes("prompt_async")
    ) {
      return { status: 204, body: null };
    }
    if (input.path.startsWith("/session") && input.method === "POST") {
      return { status: 200, body: { id: "native-session-1" } };
    }
    if (input.path.includes("/message")) return { status: 200, body: [] };
    if (input.path.startsWith("/session/status")) {
      return { status: 200, body: { "native-session-1": { type: "idle" } } };
    }
    if (input.path.startsWith("/permission")) return { status: 200, body: [] };
    if (input.path.startsWith("/question")) return { status: 200, body: [] };
    if (input.path.includes("/todo")) return { status: 200, body: [] };
    return { status: 200, body: [] };
  }
  async subscribe(
    _input: Parameters<OpenCodeNetworkPort["subscribe"]>[0],
  ): Promise<AsyncIterable<OpenCodeSseEvent>> {
    const events = this.events;
    const batchSize = this.batchSize;
    const batchWaitMs = this.batchWaitMs;
    return (async function* () {
      for (let start = 0; start < events.length; start += batchSize) {
        for (const event of events.slice(start, start + batchSize)) yield event;
        if (batchWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, batchWaitMs));
      }
    })();
  }
}

function createAdapter(options: OpenCodeAdapterOptions = {}): OpenCodeNativeAdapter {
  const fake = options.process;
  return createOpenCodeNativeAdapter({
    ...(fake instanceof FakeProcess
      ? { resolveCommand: (command: string) => fake.resolveCommand(command) }
      : {}),
    // Fixed clock: occurredAt must not vary the measured byte counts run to run.
    now: () => 1234,
    ...options,
  });
}

/** What one observation costs on the wire, which is the whole measurement. */
function bytes(observation: HarnessObservation): number {
  return Buffer.byteLength(JSON.stringify(observation), "utf8");
}

function spec() {
  return {
    sessionId: "volli-session-1",
    attachmentId: "attachment-1",
    profileId: "native",
    directory: "/workspace/one",
    continuity: "fresh",
    native: null,
  } as const;
}

// ---------------------------------------------------------------------------
// Scenario: one assistant turn, streamed as ~400 message.part.delta events
// plus two completed tool calls, ending on session.idle.
// ---------------------------------------------------------------------------

const SESSION_ID = "native-session-1";
const MESSAGE_ID = "provider-assistant";
const TEXT_PART_ID = "answer";

function buildScenarioEvents(chunks: readonly string[]): OpenCodeSseEvent[] {
  const events: OpenCodeSseEvent[] = [
    {
      id: "assistant-open",
      type: "message.updated",
      properties: { info: { id: MESSAGE_ID, sessionID: SESSION_ID, role: "assistant" } },
    },
  ];
  chunks.forEach((delta, index) => {
    events.push({
      id: `delta-${index}`,
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        partID: TEXT_PART_ID,
        field: "text",
        delta,
      },
    });
  });
  events.push(
    {
      id: "tool-read-1",
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "tool-part-1",
          messageID: MESSAGE_ID,
          type: "tool",
          tool: "read",
          callID: "call-read-1",
          state: {
            status: "completed",
            input: { path: "packages/session-engine/src/session-runtime.ts" },
            output: { content: 'case "transcript.message"' },
            title: "Read session-runtime.ts",
            time: { start: 1, end: 2 },
          },
        },
      },
    },
    {
      id: "tool-read-2",
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          id: "tool-part-2",
          messageID: MESSAGE_ID,
          type: "tool",
          tool: "read",
          callID: "call-read-2",
          state: {
            status: "completed",
            input: { path: "packages/opencode-adapter/src/index.ts" },
            output: { content: "STREAM_SNAPSHOT_DELAY_MS" },
            title: "Read index.ts",
            time: { start: 3, end: 4 },
          },
        },
      },
    },
    { id: "idle-final", type: "session.idle", properties: { sessionID: SESSION_ID } },
  );
  return events;
}

describe("opencode-adapter stream-cost probe", () => {
  it("measures wire amplification for a long streamed answer", async () => {
    const fixtureText = buildFixtureText();
    const chunks = chunkFixture(fixtureText);
    // Sanity on the fixture itself: stay in the 16-20KB band the plan asks for.
    expect(fixtureText.length).toBeGreaterThanOrEqual(16_000);
    expect(fixtureText.length).toBeLessThanOrEqual(20_000);
    expect(chunks.length).toBeGreaterThan(300);

    const network = new FakeNetwork();
    network.events = buildScenarioEvents(chunks);
    // >32ms (STREAM_DELTA_DELAY_MS) so each batch's coalescing timer fires and
    // flushes before the next batch arrives, instead of the whole run
    // collapsing into a single tick that prices nothing.
    network.batchSize = 10;
    network.batchWaitMs = 40;

    const adapter = createAdapter({ process: new FakeProcess(), network });
    const observations: HarnessObservation[] = [];
    const sink: ObservationSink = {
      emit: async (observation) => {
        observations.push(observation);
      },
    };
    await adapter.attach(spec(), sink);
    // Generous over the batching schedule (~40ms * ~40 batches) plus buffer
    // for the final flush's own async work after the last yielded event.
    const totalBatches = Math.ceil(network.events.length / network.batchSize);
    await new Promise((resolve) => setTimeout(resolve, totalBatches * network.batchWaitMs + 250));

    const transcriptMessages = observations.filter(
      (observation): observation is Extract<HarnessObservation, { kind: "transcript.message" }> =>
        observation.kind === "transcript.message",
    );
    const transcriptDeltas = observations.filter(
      (observation): observation is Extract<HarnessObservation, { kind: "transcript.delta" }> =>
        observation.kind === "transcript.delta",
    );

    // Sanity facts that hold both before and after the delta-frame change:
    // something painted, and the settled content matches the fixture exactly
    // (a flushed final message is always durable, delta or not).
    expect(transcriptMessages.length).toBeGreaterThanOrEqual(1);
    const finalObservation = transcriptMessages.at(-1)!;
    const finalTextPart = finalObservation.message.parts.find((part) => part.type === "text");
    expect(finalTextPart).toMatchObject({ type: "text", text: fixtureText });
    expect(
      finalObservation.message.parts.filter((part) => part.type === "dynamic-tool"),
    ).toHaveLength(2);
    expect(observations).toContainEqual(
      expect.objectContaining({ id: "idle-final", kind: "turn.completed" }),
    );

    // Both arms, because both are bytes on the wire: the transient overlay is
    // what the reader watches being written, the durable settle is what the
    // Session keeps.
    const deltaOpCounts: Record<string, number> = {};
    for (const observation of transcriptDeltas) {
      deltaOpCounts[observation.delta.op] = (deltaOpCounts[observation.delta.op] ?? 0) + 1;
    }
    const durableBytes = transcriptMessages.reduce((sum, next) => sum + bytes(next), 0);
    const transientBytes = transcriptDeltas.reduce((sum, next) => sum + bytes(next), 0);
    const wireBytesTotal = durableBytes + transientBytes;
    const finalMessageBytes = bytes(finalObservation);
    const amplification = wireBytesTotal / finalMessageBytes;

    // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
    console.log(
      [
        "",
        "[stream-cost probe 1] opencode-adapter wire bytes",
        `  fixture length:            ${fixtureText.length} chars`,
        `  message.part.delta events: ${chunks.length}`,
        `  transcript.message settles emitted:  ${transcriptMessages.length}`,
        `  transcript.delta frames emitted:     ${transcriptDeltas.length}`,
        // The mix is the diagnostic: a run that re-upserts the growing part
        // instead of appending to it is the regression this probe exists to
        // catch, and it costs the whole answer per tick again.
        `  delta ops by kind: ${JSON.stringify(deltaOpCounts)}`,
        `  durable wire bytes:   ${durableBytes}`,
        `  transient wire bytes: ${transientBytes}`,
        `  total wire bytes (sum of JSON.stringify(observation)): ${wireBytesTotal}`,
        `  final settle bytes (JSON.stringify(observation)):      ${finalMessageBytes}`,
        `  amplification (total / final): ${amplification.toFixed(2)}x`,
        "",
      ].join("\n"),
    );

    // Phase 3 ceilings (docs/plans/delta-frames.md, "after" column). A
    // regression back to snapshot-per-tick coalescing would blow every one of
    // these: settles would climb off 1, durable bytes would stop being a
    // single settle's worth, and amplification would jump back toward 19.63x.
    expect(transcriptMessages).toHaveLength(1);
    expect(durableBytes).toBe(finalMessageBytes);
    // The floor is ~2.0x (one transient copy of the answer plus one durable
    // copy of it, named in the doc); the ceiling here is generous headroom
    // above the measured 2.55x, not a target to creep toward.
    expect(amplification).toBeLessThan(3.0);
  });
});
