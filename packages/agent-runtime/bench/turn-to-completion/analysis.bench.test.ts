import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { ObservabilityEvent } from "@volli/shared";

import {
  analyzeTurn,
  checkEventOrder,
  parseConcurrencyArgs,
  runConcurrencyBenchmark,
  runScriptedTurn,
  summarize,
  type RecordedFixtureEvent,
} from "./measurement";

const CANARY = "fixture-private-prompt-and-tool-output-canary";
const NATIVE_MCP_NAME = "fixture_mcp_batch";

function recorded(
  event: ObservabilityEvent,
  recordedAt: number,
  order: number,
): RecordedFixtureEvent {
  return { event, recordedAt, order };
}

const RUN = "synthetic";
const attempt = (
  stopReason: "toolUse" | "error" | "stop",
  durationMs: number | undefined = 30,
): ObservabilityEvent =>
  ({
    kind: "provider-attempt",
    providerId: "fixture-local",
    modelId: "fixture-model-v1",
    api: "anthropic-messages",
    stopReason,
    durationMs,
    ttftMs: 10,
    runId: RUN,
  }) as ObservabilityEvent;
const tool = (toolId: "read" | "bash", durationMs?: number): ObservabilityEvent => ({
  kind: "tool",
  outcome: "completed",
  activityKind: toolId === "read" ? "read-file" : "run-command",
  toolId,
  ...(durationMs === undefined ? {} : { durationMs }),
  runId: RUN,
});
const queue = (queuedMs: number): ObservabilityEvent => ({
  kind: "turn-queue",
  queuedMs,
  runId: RUN,
});
const compaction = (durationMs?: number): ObservabilityEvent => ({
  kind: "compaction",
  outcome: "compacted",
  reason: "overflow",
  tokensBefore: 2_000,
  tokensAfter: 1_200,
  ...(durationMs === undefined ? {} : { durationMs }),
  runId: RUN,
});
const turnEnd = (durationMs = 100): ObservabilityEvent => ({
  kind: "turn",
  outcome: "completed",
  durationMs,
  runId: RUN,
});

/** Builds a sequence with strictly increasing timestamps in emission order. */
function sequence(events: readonly ObservabilityEvent[], start = 110): RecordedFixtureEvent[] {
  return events.map((event, index) => recorded(event, start + index * 10, index));
}

function analyze(events: readonly RecordedFixtureEvent[]) {
  return analyzeTurn({
    sampleId: "synthetic",
    concurrency: 1,
    wave: 0,
    submittedAt: 90,
    turnStartedAt: 100,
    events,
    localTimerLatenessMs: [],
    expected: {
      modelAttempts: 2,
      toolsByName: { read: 1, bash: 1 },
      compactions: 0,
      retries: 0,
      turnQueues: 1,
    },
  });
}

/** One tool round with a measured compaction, and the turn-queue in front of it. */
function analyzeWithCompaction(events: readonly RecordedFixtureEvent[]) {
  return analyzeTurn({
    sampleId: "synthetic-vc455",
    concurrency: 1,
    wave: 0,
    submittedAt: 90,
    turnStartedAt: 100,
    events,
    localTimerLatenessMs: [],
    expected: {
      modelAttempts: 2,
      toolsByName: { read: 1, bash: 1 },
      compactions: 1,
      retries: 0,
      turnQueues: 1,
    },
  });
}

/** Explicit timestamps: queue [90,100], attempt [100,130], wait, tools, compaction [150,170], attempt [175,195]. */
function vc455Turn(options: { queue?: boolean; compactionMs?: number } = {}) {
  return [
    ...(options.queue === false ? [] : [recorded(queue(10), 100, 0)]),
    recorded(attempt("toolUse", 30), 130, 1),
    recorded(tool("read", 4), 139, 3),
    recorded(tool("bash", 6), 145, 4),
    recorded(compaction(options.compactionMs), 170, 5),
    recorded(attempt("stop", 20), 195, 6),
    recorded(turnEnd(100), 200, 7),
  ];
}

describe("VC-441 fixture turn analysis", () => {
  it("keeps missing provider and tool spans unknown and flags out-of-order events", () => {
    const events = [
      recorded({ kind: "turn", outcome: "completed", durationMs: 100, runId: RUN }, 200, 0),
      recorded(attempt("stop"), 160, 1),
    ];

    const sample = analyzeTurn({
      sampleId: "missing-spans",
      concurrency: 1,
      wave: 0,
      submittedAt: 90,
      turnStartedAt: 100,
      events,
      localTimerLatenessMs: [],
    });

    // Backwards timestamp, and an attempt after the terminal envelope.
    expect(sample.eventOrderValid).toBe(false);
    expect(sample.eventOrderViolations).toBe(2);
    expect(sample.firstMessageToCompletionMs).toBe(110);
    expect(sample.providerDurationMs).toBeNull();
    expect(sample.ttftMs).toBeNull();
    expect(sample.toolsByName.read).toEqual({ count: 0, durationMs: null });
    expect(sample.retryCount).toBeNull();
    expect(sample.unaccountedGapMs).toBe(70);
    expect(sample.gapIncludesMissingSpans).toBe(true);
  });

  it("accounts a complete, well-ordered turn and derives its tool round", () => {
    const sample = analyze(
      sequence([
        queue(5),
        attempt("toolUse"),
        tool("read", 4),
        tool("bash", 6),
        attempt("stop"),
        turnEnd(),
      ]),
    );
    expect(sample.eventOrderViolations).toBe(0);
    expect(sample.toolRoundCount).toBe(1);
    expect(sample.toolsByName.read).toEqual({ count: 1, durationMs: 4 });
    expect(sample.submissionToTurnStartMs).toBe(5);
    expect(sample.gapIncludesMissingSpans).toBe(false);
  });

  it("takes measured compaction and queue time out of the unaccounted gaps (VC-455)", () => {
    const sample = analyzeWithCompaction(vc455Turn({ compactionMs: 20 }));
    expect(sample.eventOrderViolations).toBe(0);
    expect(sample.compactionDurationMs).toBe(20);
    expect(sample.submissionToTurnStartMs).toBe(10);
    // Runtime turn 100 ms; known: 30 + 4 + 6 + 20 (compaction) + 20 = 80.
    expect(sample.unaccountedGapMs).toBe(20);
    // First message → completion 110 ms; the same 80 plus the 10 ms queue.
    expect(sample.firstMessageUnaccountedGapMs).toBe(20);
    expect(sample.gapIncludesMissingSpans).toBe(false);
    expect(sample.rawEvents[0]).toMatchObject({ kind: "turn-queue", durationMs: 10 });
    expect(sample.rawEvents.find(({ kind }) => kind === "compaction")).toMatchObject({
      durationMs: 20,
    });
  });

  it("leaves an untimed compaction in the gap and marks it incomplete, never zero", () => {
    const sample = analyzeWithCompaction(vc455Turn());
    expect(sample.compactionCount).toBe(1);
    expect(sample.compactionDurationMs).toBeNull();
    expect(sample.unaccountedGapMs).toBe(40);
    expect(sample.gapIncludesMissingSpans).toBe(true);
    expect(sample.rawEvents.find(({ kind }) => kind === "compaction")).toMatchObject({
      durationMs: null,
    });
  });

  it("keeps an unmeasured queue unknown instead of reading the fixture's own clock", () => {
    const sample = analyzeWithCompaction(vc455Turn({ queue: false, compactionMs: 20 }));
    expect(sample.submissionToTurnStartMs).toBeNull();
    // The in-turn gap does not depend on the queue; the first-message gap keeps it.
    expect(sample.unaccountedGapMs).toBe(20);
    expect(sample.firstMessageUnaccountedGapMs).toBe(30);
    expect(sample.gapIncludesMissingSpans).toBe(true);
  });

  it("keeps a tool span with no duration unknown instead of zero", () => {
    const sample = analyze(
      sequence([attempt("toolUse"), tool("read"), tool("bash", 6), attempt("stop"), turnEnd()]),
    );
    expect(sample.toolsByName.read).toEqual({ count: 1, durationMs: null });
    expect(sample.toolsByName.bash).toEqual({ count: 1, durationMs: 6 });
    expect(sample.gapIncludesMissingSpans).toBe(true);
  });

  it("reports a turn with no terminal envelope as having no completion or gap", () => {
    const sample = analyze(
      sequence([attempt("toolUse"), tool("read", 4), tool("bash", 6), attempt("stop")]),
    );
    expect(sample.firstMessageToCompletionMs).toBeNull();
    expect(sample.runtimeTurnMs).toBeNull();
    expect(sample.unaccountedGapMs).toBeNull();
    expect(sample.gapIncludesMissingSpans).toBe(true);
  });

  it("flags causal reorders even when every timestamp increases", () => {
    // Turn completes before its final provider attempt.
    expect(
      checkEventOrder(sequence([attempt("toolUse"), tool("read", 4), turnEnd(), attempt("stop")]))
        .violations,
    ).toBe(2);
    // A tool runs before any provider attempt asked for it.
    expect(
      checkEventOrder(sequence([tool("read", 4), attempt("stop"), turnEnd()])).violations,
    ).toBe(1);
    // A tool after a final (non-toolUse) attempt is outside any tool round.
    expect(
      checkEventOrder(sequence([attempt("stop"), tool("bash", 6), turnEnd()])).violations,
    ).toBe(1);
    // A queue measured after the turn's own work began is out of order.
    expect(checkEventOrder(sequence([attempt("stop"), queue(3), turnEnd()])).violations).toBe(1);
    // Emission order, not array order, is what is checked.
    const shuffled = sequence([attempt("toolUse"), tool("read", 4), attempt("stop"), turnEnd()]);
    expect(checkEventOrder([shuffled[3]!, shuffled[1]!, shuffled[0]!, shuffled[2]!])).toEqual({
      violations: 0,
      toolRoundCount: 1,
    });
  });

  it("runs the local stream fixture through VC-119 instrumentation without exporting content", async () => {
    const sinkEvents: RecordedFixtureEvent[] = [];
    const sample = await runScriptedTurn({
      concurrency: 1,
      wave: 0,
      sessionIndex: 0,
      sampleId: "privacy-canary",
      captureEvents: sinkEvents,
    });

    expect(sample.modelAttemptCount).toBe(3);
    expect(sample.providerDurationMs).not.toBeNull();
    expect(sample.ttftSampleCount).toBe(3);
    expect(sample.toolRoundCount).toBe(1);
    expect(sample.toolCallCount).toBe(3);
    expect(sample.toolsByName.read?.count).toBe(1);
    expect(sample.toolsByName.bash?.count).toBe(1);
    expect(sample.toolsByName["fetch-url"]?.count).toBe(1);
    expect(sample.toolsByName["fetch-url"]?.durationMs).toBeGreaterThanOrEqual(25);
    expect(sample.compactionCount).toBe(1);
    // VC-455: both are read from VC-119 envelopes. Compaction is timed by the
    // real reducer; the queue envelope still wraps the fixture's dispatch timer.
    expect(sample.compactionDurationMs).toBeGreaterThan(0);
    expect(sample.submissionToTurnStartMs).not.toBeNull();
    expect(sample.firstMessageUnaccountedGapMs).not.toBeNull();
    expect(sample.retryCount).toBe(1);
    expect(sample.eventOrderValid).toBe(true);

    // The raw envelopes VC-119's own reducer and stream instrument emitted —
    // not the bench's field allow-list — carry none of the request context,
    // stream deltas, error message, tool subject, input, output, or native name.
    expect(sinkEvents.length).toBeGreaterThanOrEqual(9);
    expect(sinkEvents.map(({ event }) => event)).toContainEqual({
      kind: "turn-queue",
      queuedMs: expect.any(Number),
      runId: expect.any(String),
    });
    expect(sinkEvents.find(({ event }) => event.kind === "compaction")?.event).toMatchObject({
      durationMs: expect.any(Number),
    });
    const rawSink = JSON.stringify(sinkEvents);
    expect(rawSink).not.toContain(CANARY);
    expect(rawSink).not.toContain(NATIVE_MCP_NAME);
    const errorAttempt = sinkEvents.find(
      ({ event }) => event.kind === "provider-attempt" && event.stopReason === "error",
    );
    expect(errorAttempt?.event).toMatchObject({ providerErrorClass: expect.any(String) });

    const serialized = JSON.stringify(sample);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(NATIVE_MCP_NAME);
    expect(
      sample.rawEvents.find((event) => event.kind === "tool" && event.activityKind === "fetch-url"),
    ).toMatchObject({ toolId: null, activityKind: "fetch-url" });
  });

  it("writes published artifacts that carry none of the fixture's private content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vc441-artifacts-"));
    try {
      await runConcurrencyBenchmark({ output: directory, repetitions: 20, concurrencies: [2] });
      const files = (await readdir(directory)).toSorted();
      expect(files).toEqual(["benchmark.json", "benchmark.md", "run-manifest.json"]);
      for (const file of files) {
        const content = await readFile(join(directory, file), "utf8");
        expect(content).not.toContain(CANARY);
        expect(content).not.toContain(NATIVE_MCP_NAME);
        expect(content).not.toContain("fixture-call-");
      }
      const report = JSON.parse(await readFile(join(directory, "benchmark.json"), "utf8")) as {
        arms: Array<{ turnSampleCount: number; orderViolationCount: number }>;
      };
      expect(report.arms).toHaveLength(1);
      expect(report.arms[0]).toMatchObject({ turnSampleCount: 40, orderViolationCount: 0 });
      const markdown = await readFile(join(directory, "benchmark.md"), "utf8");
      expect(markdown).toContain("--concurrencies 2");
      expect(markdown).toContain("The same script runs at concurrency 2.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses unsafe limits and output directories before measuring", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vc441-guard-"));
    try {
      await expect(
        runConcurrencyBenchmark({ output: directory, repetitions: 19, concurrencies: [1] }),
      ).rejects.toThrow(/repetitions/);
      await expect(
        runConcurrencyBenchmark({ output: directory, repetitions: 20, concurrencies: [21] }),
      ).rejects.toThrow(/concurrencies/);
      await expect(
        runConcurrencyBenchmark({ output: directory, repetitions: 20, concurrencies: [1, 1] }),
      ).rejects.toThrow(/concurrencies/);

      const foreign = join(directory, "foreign");
      await mkdir(foreign);
      await writeFile(join(foreign, "notes.txt"), "not ours");
      const startedAt = performance.now();
      await expect(
        runConcurrencyBenchmark({ output: foreign, repetitions: 20, concurrencies: [1] }),
      ).rejects.toThrow(/not owned by this benchmark/);
      // Refused up front, not after a multi-second measurement.
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      const otherVersion = join(directory, "other-version");
      await mkdir(otherVersion);
      await writeFile(join(otherVersion, "run-manifest.json"), '{"fixtureVersion":"other"}');
      await expect(
        runConcurrencyBenchmark({ output: otherVersion, repetitions: 20, concurrencies: [1] }),
      ).rejects.toThrow(/another fixture version/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses the CLI and requires an output directory", () => {
    expect(
      parseConcurrencyArgs([
        "--",
        "--output",
        "out",
        "--repetitions",
        "25",
        "--concurrencies",
        "1,5",
      ]),
    ).toEqual({ output: "out", repetitions: 25, concurrencies: [1, 5] });
    expect(() => parseConcurrencyArgs([])).toThrow(/--output/);
    expect(() => parseConcurrencyArgs(["--output", "out", "--bogus"])).toThrow(/Unknown/);
  });

  it("uses nearest-rank p50/p95 (rank ceil(q·n)) and preserves the sample size", () => {
    expect(summarize(Array.from({ length: 20 }, (_value, index) => index + 1))).toEqual({
      n: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
      mean: 10.5,
    });
    // n = 11 and n = 10 separate ceil from floor/round-down rank rules.
    expect(summarize(Array.from({ length: 11 }, (_value, index) => index + 1))).toMatchObject({
      p50: 6,
      p95: 11,
    });
    expect(summarize(Array.from({ length: 10 }, (_value, index) => index + 1))).toMatchObject({
      p50: 5,
      p95: 10,
    });
    // Missing values are dropped, never read as zero; signed mode keeps early fires.
    expect(summarize([null, undefined, 4, -1])).toMatchObject({ n: 1, min: 4 });
    expect(summarize([null, 4, -1], { allowNegative: true })).toMatchObject({ n: 2, min: -1 });
  });
});
