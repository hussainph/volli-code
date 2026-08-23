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
 * batch processor and returns; delivery happens on the processor's own timer,
 * and a failure reaches {@link OtlpExporterOptions.onDeliveryFailure} once, so
 * Settings can say so without anything ever being raised at a turn.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  RandomIdGenerator,
  TracerProvider,
  type IdGenerator,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";

import { observabilitySpan } from "./genai";
import type { ObservabilityExporter, RecordedObservabilityEvent } from "./sink";

/** The instrumentation scope every Volli span is attributed to. */
const SCOPE_NAME = "volli.agent";

/**
 * The Volli-side version of the span shapes, bumped when the mapping changes.
 *
 * Deliberately not the app version: this names the *vocabulary* a stored trace
 * was written under, so a reader can tell whether two traces are comparable.
 */
const SCOPE_VERSION = "1";

/** OTLP over HTTP puts each signal on its own path. */
const TRACES_PATH = "/v1/traces";

/**
 * Success, in the shape the SDK reports it.
 *
 * Compared as a literal rather than imported from `@opentelemetry/core`: the
 * enum member is `0` and stable in the protocol, and structural comparison keeps
 * this module's direct dependency list to the four packages it actually needs.
 */
const EXPORT_SUCCESS = 0;

export interface OtlpExporterOptions {
  /**
   * The collector's OTLP/HTTP base address, e.g. `http://localhost:4318`.
   * Already validated by the settings owner; `/v1/traces` is appended here so
   * the setting stays an address a person can read off a Jaeger quickstart.
   */
  endpoint: string;
  /** Stamped on the resource so one collector can serve several Volli builds. */
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
class ReportingSpanExporter implements SpanExporter {
  #reported = false;

  constructor(
    private readonly inner: SpanExporter,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    this.inner.export(spans, (result) => {
      if (result.code !== EXPORT_SUCCESS && !this.#reported) {
        this.#reported = true;
        try {
          this.onFailure(result.error);
        } catch {
          // The report is a courtesy to Settings; it cannot be allowed to
          // break the export path it is reporting on.
        }
      }
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
  readonly #idGenerator = new RunScopedIdGenerator();

  constructor(options: OtlpExporterOptions) {
    const url = new URL(TRACES_PATH, options.endpoint).toString();
    const inner =
      options.spanExporterFactory?.(url) ??
      new OTLPTraceExporter({
        url,
        // Bounded so a collector that accepts a connection and then stops
        // answering cannot pin batches in memory indefinitely.
        timeoutMillis: 10_000,
        concurrencyLimit: 4,
      });
    const onFailure = options.onDeliveryFailure;
    this.#provider = new TracerProvider({
      resource: resourceFromAttributes({
        // Fixed, not derived from anything about this machine or profile: a
        // hostname or a user name here would be the identity the whole
        // vocabulary is built to leave out.
        "service.name": "volli",
        "service.version": options.serviceVersion,
      }),
      idGenerator: this.#idGenerator,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: onFailure === undefined ? inner : new ReportingSpanExporter(inner, onFailure),
        }),
      ],
    });
    this.#tracer = this.#provider.getTracer(SCOPE_NAME, SCOPE_VERSION);
  }

  /**
   * One batch of Volli events as one batch of spans.
   *
   * Synchronous and unawaited: `startSpan`/`end` only hand the span to the batch
   * processor's buffer, and the HTTP request happens on that processor's timer,
   * off every caller's stack. Each event is wrapped on its own so one malformed
   * event costs one span rather than the batch.
   */
  export(batch: readonly RecordedObservabilityEvent[]): void {
    for (const entry of batch) {
      try {
        this.#emit(entry);
      } catch {
        // A lost span. The sink counts a thrown batch; a single span that
        // could not be built is simply gone, which is the cheaper failure.
      }
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    await withTimeout(this.#provider.forceFlush(), timeoutMs);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    await withTimeout(this.#provider.shutdown(), timeoutMs);
  }

  #emit(entry: RecordedObservabilityEvent): void {
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
