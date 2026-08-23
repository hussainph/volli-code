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
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
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
  options: { onDeliveryFailure?: (error: unknown) => void } = {},
): OtlpObservabilityExporter {
  const exporter = new OtlpObservabilityExporter({
    endpoint: "http://localhost:4318",
    serviceVersion: "0.0.0-test",
    spanExporterFactory: () => inner,
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
  it("appends the traces path to the address a person configured", () => {
    const urls: string[] = [];
    const exporter = new OtlpObservabilityExporter({
      endpoint: "http://localhost:4318",
      serviceVersion: "0.0.0-test",
      spanExporterFactory: (url) => {
        urls.push(url);
        return new InMemorySpanExporter();
      },
    });
    built.push(exporter);
    expect(urls).toEqual(["http://localhost:4318/v1/traces"]);
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
    exporter.export([at({ kind: "authority-denied", cause: "call.unreadable" }, 5000)]);
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
