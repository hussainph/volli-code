/**
 * The OTLP adapter against the real OpenTelemetry SDK, with the network
 * replaced.
 *
 * `spanExporterFactory` swaps only the transport: the tracer provider, the batch
 * processor, the id generator and the span construction under test are the ones
 * that run in production. What is proven here is what the collector would
 * otherwise have to be running to show — trace grouping, timing, status, and
 * that a delivery failure is reported once and never raised.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer } from "node:http";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import type { ObservabilityEvent } from "@volli/shared";

import { OtlpObservabilityExporter, traceIdForRun } from "./otlp";
import type { RecordedObservabilityEvent } from "./sink";

const at = (event: ObservabilityEvent, recordedAt: number): RecordedObservabilityEvent => ({
  event,
  recordedAt,
});

/** Every exporter built by a test, torn down so no batch timer outlives it. */
const built: OtlpObservabilityExporter[] = [];

function exporterOver(
  inner: SpanExporter,
  options: {
    onDeliveryFailure?: (error: unknown) => void;
    metricExporter?: PushMetricExporter;
  } = {},
): OtlpObservabilityExporter {
  const metricExporter =
    options.metricExporter ?? new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const exporter = new OtlpObservabilityExporter({
    endpoint: "http://localhost:4318",
    serviceVersion: "0.0.0-test",
    spanExporterFactory: () => inner,
    metricExporterFactory: () => metricExporter,
    ...options,
  });
  built.push(exporter);
  return exporter;
}

/** Pushes the batch processor's buffer through, then reads what landed. */
async function spansFrom(
  exporter: OtlpObservabilityExporter,
  memory: InMemorySpanExporter,
): Promise<ReadableSpan[]> {
  await exporter.flush(2000);
  return memory.getFinishedSpans();
}

afterEach(async () => {
  await Promise.all(built.splice(0).map((exporter) => exporter.shutdown(1000)));
});

async function localCollector(): Promise<{
  endpoint: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(request.url ?? "");
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Collector did not bind TCP.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("traceIdForRun", () => {
  it("produces a 32-character lowercase hex id", () => {
    expect(traceIdForRun("run-1")).toMatch(/^[\da-f]{32}$/);
  });

  it("is stable for one run and differs between runs", () => {
    expect(traceIdForRun("run-1")).toBe(traceIdForRun("run-1"));
    expect(traceIdForRun("run-1")).not.toBe(traceIdForRun("run-2"));
  });

  it("is never the all-zero id the protocol treats as invalid", () => {
    for (const runId of ["", "a", "run-1", "0", "\u0000"]) {
      expect(traceIdForRun(runId)).not.toBe("0".repeat(32));
    }
  });
});

describe("OtlpObservabilityExporter", () => {
  it("appends both signal paths to the address a person configured", () => {
    const urls: string[] = [];
    const exporter = new OtlpObservabilityExporter({
      endpoint: "http://localhost:4318",
      serviceVersion: "0.0.0-test",
      spanExporterFactory: (url) => {
        urls.push(url);
        return new InMemorySpanExporter();
      },
      metricExporterFactory: (url) => {
        urls.push(url);
        return new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      },
    });
    built.push(exporter);
    expect(urls).toEqual(["http://localhost:4318/v1/traces", "http://localhost:4318/v1/metrics"]);
  });

  it("uses a fixed, explicit transport for both signal paths", async () => {
    const collector = await localCollector();
    const exporter = new OtlpObservabilityExporter({
      endpoint: collector.endpoint,
      serviceVersion: "0.0.0-test",
    });
    built.push(exporter);
    try {
      exporter.export([
        at({ kind: "tool", activityKind: "read-file", outcome: "completed", durationMs: 10 }, 1000),
      ]);
      await exporter.flush(2000);
      expect(collector.requests.toSorted()).toEqual(["/v1/metrics", "/v1/traces"]);
    } finally {
      await exporter.shutdown(1000);
      await collector.close();
    }
  });

  it("puts every event of one run into one trace", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at({ kind: "turn", outcome: "completed", durationMs: 50, runId: "run-a" }, 1000),
      at({ kind: "tool", activityKind: "read-file", outcome: "completed", runId: "run-a" }, 1000),
      at({ kind: "turn", outcome: "completed", durationMs: 10, runId: "run-b" }, 1000),
    ]);
    const spans = await spansFrom(exporter, memory);
    const traceIds = spans.map((span) => span.spanContext().traceId);
    expect(traceIds[0]).toBe(traceIdForRun("run-a"));
    expect(traceIds[1]).toBe(traceIdForRun("run-a"));
    expect(traceIds[2]).toBe(traceIdForRun("run-b"));
    expect(new Set(spans.map((span) => span.spanContext().spanId)).size).toBe(3);
  });

  it("exports counters and histograms through the same configured owner", async () => {
    const spans = new InMemorySpanExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const exporter = exporterOver(spans, { metricExporter: metrics });
    exporter.export([
      at(
        {
          kind: "provider-attempt",
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
          api: "anthropic-messages",
          stopReason: "error",
          providerErrorClass: "rate-limit",
          durationMs: 1_200,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
          costUsd: 0.0042,
          runId: "run-a",
        },
        1000,
      ),
      at(
        {
          kind: "tool",
          activityKind: "read-file",
          outcome: "failed",
          durationMs: 240,
          waitDurationMs: 60,
          runId: "run-a",
        },
        1000,
      ),
      at({ kind: "authority", outcome: "allowed", runId: "run-a" }, 1000),
      at({ kind: "compaction", outcome: "compacted", reason: "threshold", runId: "run-a" }, 1000),
      at({ kind: "dropped", reason: "queue-full", count: 3, runId: "run-a" }, 1000),
    ]);

    await exporter.flush(2000);
    const exported = metrics
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(exported.map((metric) => metric.descriptor.name).toSorted()).toEqual([
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "volli.agent.authority.decision.count",
      "volli.agent.compaction.count",
      "volli.agent.cost.usage",
      "volli.agent.model.request.count",
      "volli.agent.tool.call.count",
      "volli.agent.tool.execution.duration",
      "volli.agent.tool.wait.duration",
      "volli.observability.dropped.count",
    ]);

    const byName = (name: string): MetricData =>
      exported.find((metric) => metric.descriptor.name === name)!;
    expect(byName("volli.agent.tool.call.count").dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: {
          "gen_ai.tool.name": "read-file",
          "volli.tool.kind": "read-file",
          "volli.tool.outcome": "failed",
        },
        value: 1,
      }),
    );
    expect(byName("volli.agent.tool.wait.duration").dataPoints).toContainEqual(
      expect.objectContaining({ value: expect.objectContaining({ count: 1, sum: 0.06 }) }),
    );
    expect(byName("volli.agent.model.request.count").dataPoints).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "anthropic",
          "gen_ai.request.model": "claude-sonnet-4",
          "gen_ai.response.finish_reasons": ["error"],
          "error.type": "rate-limit",
        }),
        value: 1,
      }),
    );
    // The convention's bucket boundaries survive the trip through the SDK: an
    // instrument created without them silently falls back to the default
    // latency buckets, which put every token count in the overflow.
    const tokenBuckets = byName("gen_ai.client.token.usage").dataPoints[0]?.value;
    expect((tokenBuckets as { buckets: { boundaries: number[] } }).buckets.boundaries).toEqual([
      1, 4, 16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
      67_108_864,
    ]);
    expect(JSON.stringify(exported)).not.toContain("run-a");
  });

  it("gives an event with no run id its own random trace", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at({ kind: "dropped", reason: "queue-full", count: 3 }, 1000),
      at({ kind: "dropped", reason: "sink-error", count: 1 }, 1000),
    ]);
    const spans = await spansFrom(exporter, memory);
    const [first, second] = spans;
    expect(first?.spanContext().traceId).toMatch(/^[\da-f]{32}$/);
    expect(first?.spanContext().traceId).not.toBe(second?.spanContext().traceId);
  });

  it("measures a span backwards from the moment the event settled", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at({ kind: "turn", outcome: "completed", durationMs: 1500, runId: "run-a" }, 10_000),
    ]);
    const [span] = await spansFrom(exporter, memory);
    expect(span?.startTime).toEqual([8, 500_000_000]);
    expect(span?.endTime).toEqual([10, 0]);
  });

  it("gives a point-in-time fact a zero-length span rather than inventing a duration", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([at({ kind: "authority", outcome: "denied", cause: "call.unreadable" }, 5000)]);
    const [span] = await spansFrom(exporter, memory);
    expect(span?.startTime).toEqual(span?.endTime);
  });

  it("marks a provider request a client span and everything else internal", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at(
        {
          kind: "provider-attempt",
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
          api: "anthropic-messages",
          stopReason: "stop",
          durationMs: 100,
        },
        1000,
      ),
      at({ kind: "turn", outcome: "completed", durationMs: 10 }, 1000),
    ]);
    const spans = await spansFrom(exporter, memory);
    expect(spans[0]?.kind).toBe(SpanKind.CLIENT);
    expect(spans[1]?.kind).toBe(SpanKind.INTERNAL);
  });

  it("sets an error status with no message on a failed event", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at({ kind: "tool", activityKind: "edit-file", outcome: "failed" }, 1000),
      at({ kind: "tool", activityKind: "edit-file", outcome: "completed" }, 1000),
    ]);
    const spans = await spansFrom(exporter, memory);
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(spans[0]?.status.message).toBeUndefined();
    expect(spans[1]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("carries the mapped attributes and the fixed, identity-free resource", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    exporter.export([
      at({ kind: "tool", activityKind: "search", outcome: "completed", runId: "run-a" }, 1000),
    ]);
    const [span] = await spansFrom(exporter, memory);
    expect(span?.name).toBe("execute_tool search");
    expect(span?.attributes["gen_ai.tool.name"]).toBe("search");
    expect(span?.attributes["volli.run.id"]).toBe("run-a");
    expect(span?.resource.attributes["service.name"]).toBe("volli");
    expect(span?.resource.attributes["service.version"]).toBe("0.0.0-test");
  });

  it("loses one malformed event rather than the batch around it", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = exporterOver(memory);
    const malformed = at({ kind: "turn", outcome: "completed" }, 1000);
    // A run id the trace-id derivation cannot read: the throw must not reach
    // the caller or cost the events beside it.
    Object.defineProperty(malformed.event, "runId", {
      get() {
        throw new Error("unreadable");
      },
    });
    expect(() =>
      exporter.export([
        at({ kind: "turn", outcome: "completed", durationMs: 1, runId: "before" }, 1000),
        malformed,
        at({ kind: "turn", outcome: "completed", durationMs: 1, runId: "after" }, 1000),
      ]),
    ).not.toThrow();
    const spans = await spansFrom(exporter, memory);
    expect(spans.map((span) => span.attributes["volli.run.id"])).toEqual(["before", "after"]);
  });

  it("reports the first delivery failure once and never again", async () => {
    const failures: unknown[] = [];
    const broken: SpanExporter = {
      export: (_spans, resultCallback) => {
        resultCallback({ code: 1, error: new Error("collector unreachable") });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    const exporter = exporterOver(broken, {
      onDeliveryFailure: (error) => void failures.push(error),
    });
    for (let batch = 0; batch < 3; batch += 1) {
      exporter.export([at({ kind: "turn", outcome: "completed", durationMs: 1 }, 1000)]);
      await exporter.flush(2000);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });

  it("reports a metric delivery failure through the same once-only Settings callback", async () => {
    const failures: unknown[] = [];
    const brokenMetric: PushMetricExporter = {
      export: (_metrics, resultCallback) =>
        resultCallback({ code: 1, error: new Error("metrics collector unreachable") }),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    };
    const exporter = exporterOver(new InMemorySpanExporter(), {
      onDeliveryFailure: (error) => void failures.push(error),
      metricExporter: brokenMetric,
    });

    exporter.export([at({ kind: "tool", activityKind: "read-file", outcome: "completed" }, 1000)]);
    await exporter.flush(2000);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
  });

  it("does not let a throwing failure reporter break the export path", async () => {
    const broken: SpanExporter = {
      export: (_spans, resultCallback) => {
        resultCallback({ code: 1 });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };
    const exporter = exporterOver(broken, {
      onDeliveryFailure: () => {
        throw new Error("settings owner blew up");
      },
    });
    exporter.export([at({ kind: "turn", outcome: "completed", durationMs: 1 }, 1000)]);
    await expect(exporter.flush(2000)).resolves.toBeUndefined();
  });

  it("works without a failure reporter at all", async () => {
    const memory = new InMemorySpanExporter();
    const exporter = new OtlpObservabilityExporter({
      endpoint: "http://localhost:4318",
      serviceVersion: "0.0.0-test",
      spanExporterFactory: () => memory,
    });
    built.push(exporter);
    exporter.export([at({ kind: "turn", outcome: "completed", durationMs: 1 }, 1000)]);
    expect(await spansFrom(exporter, memory)).toHaveLength(1);
  });

  it("gives up on a flush that never settles rather than holding the quit open", async () => {
    const stuck: SpanExporter = {
      export: (_spans, resultCallback) => {
        // Never calls back: the batch processor's flush promise stays pending.
        void resultCallback;
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => new Promise<void>(() => {}),
    };
    const exporter = exporterOver(stuck);
    exporter.export([at({ kind: "turn", outcome: "completed", durationMs: 1 }, 1000)]);
    const startedAt = Date.now();
    await exporter.flush(50);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("survives a transport whose shutdown rejects", async () => {
    const hostile: SpanExporter = {
      export: (_spans, resultCallback) => resultCallback({ code: 0 }),
      shutdown: () => Promise.reject(new Error("already gone")),
      forceFlush: () => Promise.resolve(),
    };
    const exporter = new OtlpObservabilityExporter({
      endpoint: "http://localhost:4318",
      serviceVersion: "0.0.0-test",
      spanExporterFactory: () => hostile,
    });
    await expect(exporter.shutdown(500)).resolves.toBeUndefined();
  });

  it("refuses an address that is not one, at construction", () => {
    expect(
      () =>
        new OtlpObservabilityExporter({
          endpoint: "not an address",
          serviceVersion: "0.0.0-test",
          spanExporterFactory: () => new InMemorySpanExporter(),
        }),
    ).toThrow();
  });
});
