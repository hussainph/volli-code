/**
 * The OTLP transport, and the whole of Volli's contact with an OpenTelemetry
 * SDK (VC-119, Phase 2).
 *
 * **Electron main only.** OpenTelemetry is initialized here and nowhere else:
 * not in the renderer, not in preload, and not in any process a model's tools
 * can see. The renderer has no reason to hold a tracer and every reason not to
 * — it would put an exporter behind a surface that renders untrusted model
 * output — so the import graph is the enforcement: nothing under `src/renderer`
 * or `src/preload` reaches this module.
 *
 * **No global is touched.** `provider.register()` is never called, no context
 * manager is installed, no propagator is set, and `diag` keeps its default
 * no-op logger. The provider is an object this module holds, and the only way
 * to a span is through {@link OtlpObservabilityExporter.export}. That is what
 * makes "observability is off" mean genuinely nothing is running rather than a
 * tracer quietly sampling to a no-op.
 *
 * **The endpoint is Volli's setting, never the ambient environment.** The URL is
 * passed explicitly on construction so `OTEL_EXPORTER_OTLP_ENDPOINT` in a
 * developer's shell cannot redirect a Session's telemetry somewhere the setting
 * does not name. Nothing in this file writes to `process.env`, which is the
 * other half of keeping `OTEL_*` out of the environments Volli hands to Bash and
 * the web tools — see `piExecutionEnv`, whose allowlist is the enforcing side.
 *
 * **A collector outage is not an agent failure.** `export` hands spans to a
 * batch processor and metric reader and returns; delivery happens on their own timers,
 * and a failure reaches {@link OtlpExporterOptions.onDeliveryFailure} once, so
 * Settings can say so without anything ever being raised at a turn.
 */

import { OTLPExporterBase } from "@opentelemetry/otlp-exporter-base";
import {
  createOtlpHttpExportDelegate,
  httpAgentFactoryFromOptions,
} from "@opentelemetry/otlp-exporter-base/node-http";
import {
  JsonMetricsSerializer,
  JsonTraceSerializer,
  MetricsExporterMetricsHelper,
  TraceExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  RandomIdGenerator,
  TracerProvider,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import {
  SpanKind,
  SpanStatusCode,
  type Counter,
  type Histogram,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";

import { observabilityMetrics, observabilitySpan, type ObservabilityMetric } from "./genai";
import type { ObservabilityExporter, RecordedObservabilityEvent } from "./sink";

/** The instrumentation scope every Volli trace and metric is attributed to. */
const SCOPE_NAME = "volli.agent";

/**
 * The Volli-side version of the span shapes, bumped when the mapping changes.
 *
 * Deliberately not the app version: this names the *vocabulary* a stored trace
 * was written under, so a reader can tell whether two traces are comparable.
 */
const SCOPE_VERSION = "2";

/** OTLP over HTTP puts each signal on its own path. */
const TRACES_PATH = "/v1/traces";
const METRICS_PATH = "/v1/metrics";

/**
 * Success, in the shape the SDK reports it.
 *
 * Compared as a literal rather than imported from `@opentelemetry/core`: the
 * enum member is `0` and stable in the protocol, and structural comparison avoids
 * taking a direct dependency on `@opentelemetry/core`.
 */
const EXPORT_SUCCESS = 0;
const OTLP_TIMEOUT_MS = 10_000;
const OTLP_CONCURRENCY_LIMIT = 4;

/**
 * A fully specified OTLP/HTTP delegate, with no ambient configuration lookup.
 *
 * The public OTel exporter constructors merge `OTEL_*` values even when a URL
 * is passed. Volli cannot let a shell-provided header, certificate, timeout, or
 * endpoint influence its opt-in Settings row, so the adapter constructs the
 * lower-level delegate from these fixed values instead.
 */
function fixedOtlpHttpConfiguration(url: string) {
  return {
    url,
    headers: async () => ({ "Content-Type": "application/json" }),
    timeoutMillis: OTLP_TIMEOUT_MS,
    concurrencyLimit: OTLP_CONCURRENCY_LIMIT,
    compression: "none" as const,
    agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
  };
}

/** Product-owned trace transport over the fixed HTTP delegate above. */
class FixedOtlpTraceExporter extends OTLPExporterBase<ReadableSpan[]> implements SpanExporter {
  constructor(url: string) {
    super(
      createOtlpHttpExportDelegate(
        fixedOtlpHttpConfiguration(url),
        JsonTraceSerializer,
        "volli.otlp.trace",
        TraceExporterMetricsHelper,
        undefined,
      ),
    );
  }
}

/** Product-owned metric transport over the same fixed HTTP delegate. */
class FixedOtlpMetricExporter
  extends OTLPExporterBase<ResourceMetrics>
  implements PushMetricExporter
{
  constructor(url: string) {
    super(
      createOtlpHttpExportDelegate(
        fixedOtlpHttpConfiguration(url),
        JsonMetricsSerializer,
        "volli.otlp.metric",
        MetricsExporterMetricsHelper,
        undefined,
      ),
    );
  }
}

export interface OtlpExporterOptions {
  /**
   * The collector's OTLP/HTTP base address, e.g. `http://localhost:4318`.
   * Already validated by the settings owner; `/v1/traces` and `/v1/metrics`
   * are appended here so the setting stays an address a person can read off a
   * Jaeger quickstart.
   */
  endpoint: string;
  /** Stamped on both signal resources so one collector can serve several Volli builds. */
  serviceVersion: string;
  /**
   * Told once, on the first delivery that did not land.
   *
   * Once is the entire contract. A collector that has gone away fails on every
   * batch, and a callback that fired each time would become the repeated toast
   * this design exists to prevent; the owner latches it into a line Settings
   * can show and nothing else ever raises it.
   */
  onDeliveryFailure?: (error: unknown) => void;
  /** Injected in tests so nothing has to open a socket. */
  spanExporterFactory?: (url: string) => SpanExporter;
  /** Injected in tests so metric aggregation can be inspected without a socket. */
  metricExporterFactory?: (url: string) => PushMetricExporter;
}

/**
 * Turns a run id into a stable trace id, so one Session run is one Jaeger trace.
 *
 * FNV-1a over the id, twice with different offsets, to fill 16 bytes. A hash
 * rather than a lookup table because the alternative is per-run state in a
 * process that must not accumulate any, and this is not a security boundary: the
 * run id is already opaque and process-local, and a collision only means two
 * runs share a trace view.
 *
 * Events land as sibling roots inside that trace rather than as a nested tree.
 * That is the honest shape — the event stream says a tool call and a turn
 * belong to the same run, not that one happened inside the other — and it is
 * what a Jaeger trace view renders correctly.
 */
export function traceIdForRun(runId: string): string {
  const half = (offset: number): string => {
    let hash = offset;
    for (let i = 0; i < runId.length; i += 1) {
      hash ^= runId.charCodeAt(i);
      hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  // Two 8-hex halves each doubled: 32 lowercase hex characters, never all zero
  // (the offsets are non-zero and FNV-1a of any input from them is too).
  return `${half(0x811c_9dc5)}${half(0x01000193)}${half(0xdead_beef)}${half(0xcafe_babe)}`;
}

/**
 * Hands the tracer a caller-chosen trace id for the next root span.
 *
 * The SDK asks its generator for a trace id exactly once per root span, inside
 * the synchronous `startSpan` call. Setting the id immediately before that call
 * is therefore deterministic — no other span can interleave — and it is the
 * supported seam for exactly this: correlating spans a process did not create
 * under a live context. When nothing has been staged (an event with no run id),
 * it falls through to the SDK's own random generator.
 */
class RunScopedIdGenerator implements IdGenerator {
  readonly #random = new RandomIdGenerator();
  #staged: string | null = null;

  stage(traceId: string | null): void {
    this.#staged = traceId;
  }

  generateTraceId(): string {
    const staged = this.#staged;
    this.#staged = null;
    return staged ?? this.#random.generateTraceId();
  }

  generateSpanId(): string {
    return this.#random.generateSpanId();
  }
}

/**
 * Reports the first delivery that failed, and otherwise stays out of the way.
 *
 * A thin delegate rather than a subclass: the batch processor swallows export
 * results by design, so the only place to see one is between it and the real
 * exporter. It changes nothing about the result it observes.
 */
class DeliveryFailureReporter {
  #reported = false;

  constructor(private readonly onFailure: (error: unknown) => void) {}

  report(error: unknown): void {
    if (this.#reported) return;
    this.#reported = true;
    try {
      this.onFailure(error);
    } catch {
      // The report is a courtesy to Settings; it cannot be allowed to break
      // either signal path it is reporting on.
    }
  }
}

class ReportingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly reporter: DeliveryFailureReporter,
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    this.inner.export(spans, (result) => {
      if (result.code !== EXPORT_SUCCESS) this.reporter.report(result.error);
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** Same one-shot delivery report for the metric reader's exporter. */
class ReportingMetricExporter implements PushMetricExporter {
  constructor(
    private readonly inner: PushMetricExporter,
    private readonly reporter: DeliveryFailureReporter,
  ) {}

  export(...args: Parameters<PushMetricExporter["export"]>): void {
    const [metrics, resultCallback] = args;
    this.inner.export(metrics, (result) => {
      if (result.code !== EXPORT_SUCCESS) this.reporter.report(result.error);
      resultCallback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Millisecond wall clock, in the SDK's `[seconds, nanos]` form. */
function hrTime(epochMs: number): [number, number] {
  const seconds = Math.floor(epochMs / 1000);
  return [seconds, Math.round((epochMs - seconds * 1000) * 1e6)];
}

/**
 * The live OTLP transport behind {@link ObservabilityExporter}.
 *
 * Construction can throw — a URL the SDK refuses, a transport it cannot build —
 * and that throw is the *configuration* failure the settings owner surfaces
 * once. Everything after construction is best-effort by design.
 */
export class OtlpObservabilityExporter implements ObservabilityExporter {
  readonly #provider: TracerProvider;
  readonly #tracer: Tracer;
  readonly #meterProvider: MeterProvider;
  readonly #meter: Meter;
  readonly #counters = new Map<string, Counter>();
  readonly #histograms = new Map<string, Histogram>();
  readonly #idGenerator = new RunScopedIdGenerator();

  constructor(options: OtlpExporterOptions) {
    const traceUrl = new URL(TRACES_PATH, options.endpoint).toString();
    const metricUrl = new URL(METRICS_PATH, options.endpoint).toString();
    const traceInner =
      options.spanExporterFactory?.(traceUrl) ?? new FixedOtlpTraceExporter(traceUrl);
    const metricInner =
      options.metricExporterFactory?.(metricUrl) ?? new FixedOtlpMetricExporter(metricUrl);
    const reporter =
      options.onDeliveryFailure === undefined
        ? undefined
        : new DeliveryFailureReporter(options.onDeliveryFailure);
    const resource = resourceFromAttributes({
      // Fixed, not derived from anything about this machine or profile: a
      // hostname or a user name here would be the identity the whole
      // vocabulary is built to leave out.
      "service.name": "volli",
      "service.version": options.serviceVersion,
    });
    this.#provider = new TracerProvider({
      resource,
      idGenerator: this.#idGenerator,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter:
            reporter === undefined ? traceInner : new ReportingSpanExporter(traceInner, reporter),
        }),
      ],
    });
    this.#meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter:
            reporter === undefined
              ? metricInner
              : new ReportingMetricExporter(metricInner, reporter),
          // Events already travel through the sink's bounded queue. The reader
          // aggregates them on a quiet cadence instead of putting another timer
          // or network request on the agent path.
          exportIntervalMillis: 30_000,
          exportTimeoutMillis: 10_000,
        }),
      ],
    });
    this.#tracer = this.#provider.getTracer(SCOPE_NAME, SCOPE_VERSION);
    this.#meter = this.#meterProvider.getMeter(SCOPE_NAME, SCOPE_VERSION);
  }

  /**
   * One batch of Volli events as spans and aggregated metric updates.
   *
   * Synchronous and unawaited: spans enter the batch processor and metric values
   * enter the reader's aggregator; both HTTP paths run later, off every caller's
   * stack. Each signal is isolated so one malformed mapping costs only that
   * signal for one event.
   */
  export(batch: readonly RecordedObservabilityEvent[]): void {
    for (const entry of batch) {
      try {
        this.#emitSpan(entry);
      } catch {
        // A lost span must not cost the metric beside it.
      }
      try {
        this.#emitMetrics(entry.event);
      } catch {
        // A broken instrument or mapper costs one metric update, never a span
        // and never an agent turn.
      }
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    await withTimeout(
      Promise.all([this.#provider.forceFlush(), this.#meterProvider.forceFlush()]).then(
        () => undefined,
      ),
      timeoutMs,
    );
  }

  async shutdown(timeoutMs: number): Promise<void> {
    await withTimeout(
      Promise.all([this.#provider.shutdown(), this.#meterProvider.shutdown()]).then(
        () => undefined,
      ),
      timeoutMs,
    );
  }

  #emitSpan(entry: RecordedObservabilityEvent): void {
    const span = observabilitySpan(entry.event);
    // Measured backwards from when the event settled: the vocabulary carries a
    // duration, not a start, because a start is a clock reading the runtime had
    // no reason to keep.
    const endedAt = entry.recordedAt;
    const startedAt = endedAt - span.durationMs;
    this.#idGenerator.stage(
      entry.event.runId === undefined ? null : traceIdForRun(entry.event.runId),
    );
    const started = this.#tracer.startSpan(span.name, {
      kind: span.kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL,
      startTime: hrTime(startedAt),
      attributes: span.attributes,
    });
    // Code only. `SpanStatus.message` is free-form, and `error.type` already
    // carries the bounded word that says what went wrong.
    if (span.failed) started.setStatus({ code: SpanStatusCode.ERROR });
    started.end(hrTime(endedAt));
  }

  #emitMetrics(event: Parameters<typeof observabilityMetrics>[0]): void {
    for (const measurement of observabilityMetrics(event)) {
      if (measurement.instrument === "counter") {
        this.#counter(measurement).add(measurement.value, measurement.attributes);
      } else {
        this.#histogram(measurement).record(measurement.value, measurement.attributes);
      }
    }
  }

  #counter(measurement: ObservabilityMetric): Counter {
    const existing = this.#counters.get(measurement.name);
    if (existing !== undefined) return existing;
    const counter = this.#meter.createCounter(measurement.name, { unit: measurement.unit });
    this.#counters.set(measurement.name, counter);
    return counter;
  }

  #histogram(measurement: ObservabilityMetric): Histogram {
    const existing = this.#histograms.get(measurement.name);
    if (existing !== undefined) return existing;
    const histogram = this.#meter.createHistogram(measurement.name, { unit: measurement.unit });
    this.#histograms.set(measurement.name, histogram);
    return histogram;
  }
}

/**
 * Resolves when the work does or when the bound expires, whichever is first.
 *
 * Shutdown must not be able to hold Electron's quit open: the SDK's own flush
 * has a timeout, but it is configured in seconds and applies per batch, and the
 * quit gate needs one deadline it can actually count on.
 */
async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work.catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}
