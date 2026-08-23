/**
 * The developer smoke path against a local Jaeger, with synthetic data.
 *
 * Manual and host-dependent, so it is gated off by default and skipped in CI —
 * the same shape as `packages/agent-runtime/src/pi/scoped-execution-env.srt.integration.test.ts`.
 *
 *   docker run --rm -p 16686:16686 -p 4317:4317 -p 4318:4318 jaegertracing/jaeger:2.18.0
 *   VOLLI_JAEGER_INTEGRATION=1 pnpm -C apps/desktop exec vp test run \
 *     src/main/observability/jaeger.integration.test.ts
 *
 * See docs/observability-smoke.md.
 *
 * Every event here is fabricated. Nothing in this file reads a Session, a
 * Ticket, a transcript or a credential — the point is to prove the wire, and a
 * smoke test that needed real agent traffic would be a smoke test nobody could
 * run twice the same way.
 *
 * What it actually proves, which unit tests cannot: that Jaeger accepts what
 * Volli emits. A span the OTLP transformer serializes wrongly, an attribute
 * type a collector rejects, or a trace id the protocol considers invalid all
 * pass an InMemorySpanExporter and fail here.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import type { ObservabilityEvent } from "@volli/shared";

import { OtlpObservabilityExporter, traceIdForRun } from "./otlp";
import { QueuedObservabilitySink } from "./sink";

const enabled = process.env.VOLLI_JAEGER_INTEGRATION === "1";

/** Jaeger all-in-one's OTLP/HTTP receiver and its query API. */
const COLLECTOR = process.env.VOLLI_JAEGER_OTLP ?? "http://localhost:4318";
const QUERY = process.env.VOLLI_JAEGER_QUERY ?? "http://localhost:16686";

/** Jaeger's own ingestion lag; polled rather than slept through. */
const QUERY_ATTEMPTS = 30;
const QUERY_INTERVAL_MS = 500;

interface JaegerSpan {
  traceID: string;
  operationName: string;
  duration: number;
  tags: { key: string; value: unknown }[];
}

/**
 * One synthetic run, covering every arm of the vocabulary.
 *
 * A whole run rather than one span each, because the thing worth seeing in
 * Jaeger is the shape: one trace, an attempt with usage on it, the tools around
 * it, and a lost-telemetry marker that reads as a report rather than a fault.
 */
function syntheticRun(runId: string): ObservabilityEvent[] {
  return [
    { kind: "attachment", phase: "started", runId },
    {
      kind: "provider-attempt",
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      api: "anthropic-messages",
      reasoningLevel: "medium",
      stopReason: "toolUse",
      durationMs: 1420,
      ttftMs: 380,
      chunkCount: 96,
      inputTokens: 12_400,
      outputTokens: 310,
      cacheReadTokens: 11_800,
      cacheWriteTokens: 600,
      reasoningTokens: 128,
      totalTokens: 13_110,
      costUsd: 0.0271,
      responseModelId: "claude-sonnet-4-20250514",
      runId,
    },
    {
      kind: "tool",
      activityKind: "read-file",
      toolId: "read",
      outcome: "completed",
      durationMs: 12,
      runId,
    },
    {
      kind: "tool",
      activityKind: "run-command",
      toolId: "bash",
      outcome: "failed",
      durationMs: 2100,
      runId,
    },
    { kind: "authority", outcome: "denied", cause: "call.unreadable", runId },
    {
      kind: "compaction",
      outcome: "compacted",
      reason: "threshold",
      tokensBefore: 180_000,
      tokensAfter: 24_000,
      runId,
    },
    { kind: "attention", phase: "raised", reason: "context", runId },
    { kind: "turn", outcome: "completed", durationMs: 4300, runId },
    { kind: "dropped", reason: "queue-full", count: 7, runId },
    { kind: "attachment", phase: "closed", runId },
  ];
}

async function fetchTrace(traceId: string): Promise<JaegerSpan[]> {
  for (let attempt = 0; attempt < QUERY_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${QUERY}/api/traces/${traceId}`);
    if (response.ok) {
      const body = (await response.json()) as { data?: { spans?: JaegerSpan[] }[] };
      const spans = body.data?.[0]?.spans ?? [];
      if (spans.length > 0) return spans;
    }
    await new Promise((resolve) => setTimeout(resolve, QUERY_INTERVAL_MS));
  }
  return [];
}

const tag = (span: JaegerSpan | undefined, key: string): unknown =>
  span?.tags.find((entry) => entry.key === key)?.value;

describe.skipIf(!enabled)("Jaeger OTLP smoke (VOLLI_JAEGER_INTEGRATION=1)", () => {
  it("delivers a whole synthetic run as one trace Jaeger can serve back", async () => {
    const runId = `smoke-${randomUUID()}`;
    const exporter = new OtlpObservabilityExporter({
      endpoint: COLLECTOR,
      serviceVersion: "0.0.0-smoke",
      onDeliveryFailure: (error) => {
        throw new Error(`Collector at ${COLLECTOR} refused the batch: ${String(error)}`);
      },
    });
    // Driven through the real sink, so the smoke covers the queue and the
    // scheduled drain rather than only the transport under them.
    const sink = new QueuedObservabilitySink({ exporter });
    for (const event of syntheticRun(runId)) sink.record(event);
    await sink.flush(10_000);

    const spans = await fetchTrace(traceIdForRun(runId));
    expect(spans.length).toBeGreaterThan(0);

    // Every event of one run landed in one trace, which is the grouping the
    // derived trace id exists to produce.
    expect(new Set(spans.map((span) => span.traceID))).toEqual(new Set([traceIdForRun(runId)]));
    expect(spans.map((span) => span.operationName).toSorted()).toEqual(
      [
        "chat claude-sonnet-4",
        "execute_tool read",
        "execute_tool bash",
        "volli.agent.attachment",
        "volli.agent.attachment",
        "volli.agent.attention",
        "volli.agent.authority",
        "volli.agent.compaction",
        "volli.agent.turn",
        "volli.observability.dropped",
      ].toSorted(),
    );

    // The usage a token/cost dashboard is built on, round-tripped through the
    // GenAI attribute names rather than Volli's own.
    const attempt = spans.find((span) => span.operationName === "chat claude-sonnet-4");
    expect(tag(attempt, "gen_ai.provider.name")).toBe("anthropic");
    expect(tag(attempt, "gen_ai.usage.input_tokens")).toBe(12_400);
    expect(tag(attempt, "gen_ai.usage.cache_read.input_tokens")).toBe(11_800);
    // A list on the wire, as the convention types it. How a collector renders a
    // list tag back is its own business — Jaeger has used both a JSON string and
    // a repeated tag — so this checks the value survived, not its spelling.
    expect(JSON.stringify(tag(attempt, "gen_ai.response.finish_reasons"))).toContain("toolUse");
    expect(tag(attempt, "volli.usage.cost_usd")).toBeCloseTo(0.0271, 6);
    // Jaeger reports duration in microseconds; the attempt was measured at
    // 1420ms, so a zero here means timing did not survive the wire.
    expect(attempt?.duration).toBe(1_420_000);

    // A failed tool is red in the UI; a refusal and a drop report are not.
    const failedTool = spans.find((span) => span.operationName === "execute_tool bash");
    expect(tag(failedTool, "error")).toBe(true);
    expect(
      tag(
        spans.find((span) => span.operationName === "volli.agent.authority"),
        "error",
      ),
    ).toBe(undefined);
    const dropped = spans.find((span) => span.operationName === "volli.observability.dropped");
    expect(tag(dropped, "volli.dropped.count")).toBe(7);
    expect(tag(dropped, "error")).toBe(undefined);

    await sink.shutdown(5000);
  }, 60_000);

  it("carries no identity beyond the opaque run id", async () => {
    const runId = `smoke-${randomUUID()}`;
    const exporter = new OtlpObservabilityExporter({
      endpoint: COLLECTOR,
      serviceVersion: "0.0.0-smoke",
    });
    const sink = new QueuedObservabilitySink({ exporter });
    for (const event of syntheticRun(runId)) sink.record(event);
    await sink.flush(10_000);

    const spans = await fetchTrace(traceIdForRun(runId));
    expect(spans.length).toBeGreaterThan(0);
    // The whole trace, as the collector actually stored it. Nothing about the
    // machine, the profile, or a Session may be findable in it.
    const stored = JSON.stringify(spans).toLowerCase();
    for (const forbidden of ["session", "ticket", "worktree", "hostname", "/users/", "prompt"]) {
      expect(stored).not.toContain(forbidden);
    }
    // The run id is the one correlation id, and it is the one this test minted.
    expect(stored).toContain(runId.toLowerCase());

    await sink.shutdown(5000);
  }, 60_000);
});
