import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { ObservabilityEvent } from "@volli/shared";

import {
  analyzeTurn,
  runConcurrencyBenchmark,
  runScriptedTurn,
  summarize,
  type RecordedFixtureEvent,
} from "./measurement";

function recorded(
  event: ObservabilityEvent,
  recordedAt: number,
  order: number,
): RecordedFixtureEvent {
  return { event, recordedAt, order };
}

describe("VC-441 fixture turn analysis", () => {
  it("keeps missing provider, tool, and authority spans unknown and flags out-of-order events", () => {
    const events = [
      recorded({ kind: "turn", outcome: "completed", durationMs: 100, runId: "synthetic" }, 200, 0),
      recorded(
        {
          kind: "provider-attempt",
          providerId: "fixture-local",
          modelId: "fixture-model-v1",
          api: "anthropic-messages",
          stopReason: "stop",
          durationMs: 30,
          ttftMs: 10,
          runId: "synthetic",
        },
        160,
        1,
      ),
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

    expect(sample.eventOrderValid).toBe(false);
    expect(sample.eventOrderViolations).toBe(1);
    expect(sample.firstMessageToCompletionMs).toBe(110);
    expect(sample.providerDurationMs).toBeNull();
    expect(sample.ttftMs).toBeNull();
    expect(sample.toolsByName.read).toEqual({ count: 0, durationMs: null });
    expect(sample.authorityWaitMs).toBeNull();
    expect(sample.retryCount).toBeNull();
    expect(sample.unaccountedGapMs).toBe(70);
    expect(sample.gapIncludesMissingSpans).toBe(true);
  });

  it("runs the local stream fixture through VC-119 instrumentation without exporting content", async () => {
    const sample = await runScriptedTurn({
      concurrency: 1,
      wave: 0,
      sessionIndex: 0,
      sampleId: "privacy-canary",
    });
    const serialized = JSON.stringify(sample);

    expect(sample.modelAttemptCount).toBe(3);
    expect(sample.providerDurationMs).not.toBeNull();
    expect(sample.ttftSampleCount).toBe(3);
    expect(sample.toolRoundCount).toBe(1);
    expect(sample.toolCallCount).toBe(3);
    expect(sample.toolsByName.read?.count).toBe(1);
    expect(sample.toolsByName.bash?.count).toBe(1);
    expect(sample.toolsByName["fetch-url"]?.count).toBe(1);
    expect(sample.toolsByName["fetch-url"]?.durationMs).toBeGreaterThanOrEqual(25);
    expect(sample.authorityWaitCount).toBe(1);
    expect(sample.authorityWaitMs).toBeGreaterThan(0);
    expect(sample.compactionCount).toBe(1);
    expect(sample.retryCount).toBe(1);
    expect(sample.eventOrderValid).toBe(true);
    expect(serialized).not.toContain("fixture-private-prompt-and-tool-output-canary");
    expect(serialized).not.toContain("fixture_mcp_batch");
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
        expect(content).not.toContain("fixture-private-prompt-and-tool-output-canary");
        expect(content).not.toContain("fixture_mcp_batch");
        expect(content).not.toContain("fixture-call-");
      }
      const report = JSON.parse(await readFile(join(directory, "benchmark.json"), "utf8")) as {
        arms: Array<{ turnSampleCount: number; orderViolationCount: number }>;
      };
      expect(report.arms).toHaveLength(1);
      expect(report.arms[0]).toMatchObject({ turnSampleCount: 40, orderViolationCount: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses nearest-rank p50/p95 and preserves the sample size", () => {
    expect(summarize(Array.from({ length: 20 }, (_value, index) => index + 1))).toEqual({
      n: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
      mean: 10.5,
    });
  });
});
