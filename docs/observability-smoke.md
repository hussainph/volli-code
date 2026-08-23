# Running the agent-observability smoke path

Volli's agent runtime emits a metadata-only observability side channel (VC-119).
Export is **off by default**; when it is on, events go to a local OTLP collector
and nowhere else. This note is how to see them.

## What you need

Jaeger all-in-one, which is one container with the collector, the store and the
UI in it. Traces live in memory, so a restart is a clean slate — which is what
you want for a developer session.

```sh
docker run --rm --name volli-jaeger \
  -p 16686:16686 -p 4317:4317 -p 4318:4318 \
  jaegertracing/jaeger:2.18.0
```

- `4318` — OTLP over HTTP. **This is the port Volli uses for traces and metrics.**
- `4317` — OTLP over gRPC. Volli does not use it; it is exposed because the
  quickstart does.
- `16686` — the UI, at <http://localhost:16686>.

## The smoke test

Synthetic data, no app, no Session, no model call. It drives the real sink and
the real OTLP transport, then reads the trace back out of Jaeger's query API.

```sh
VOLLI_JAEGER_INTEGRATION=1 pnpm -C apps/desktop exec vp test run \
  src/main/observability/jaeger.integration.test.ts
```

It is skipped unless `VOLLI_JAEGER_INTEGRATION=1`, so `pnpm test` and CI never
try to reach a collector. Point it elsewhere with `VOLLI_JAEGER_OTLP` and
`VOLLI_JAEGER_QUERY`.

What it proves that the unit tests cannot: that a collector **accepts** Volli's
trace stream. A span the OTLP transformer serializes wrongly, an attribute type a
backend rejects, or a trace id the protocol calls invalid all pass an
`InMemorySpanExporter` and fail here. The adjacent OTLP unit test drives the real
meter provider with an `InMemoryMetricExporter`, covering the `/v1/metrics` wire
and every counter/histogram family without requiring a metrics backend in this
Jaeger smoke path.

It also asserts the boundary from the outside — it pulls the stored trace back
and fails if the words `session`, `ticket`, `worktree`, `hostname`, `/users/` or
`prompt` appear anywhere in it.

## From the app

Settings → General → Agent telemetry. Turn **Export** on and leave **Collector**
at `http://localhost:4318`. Then run a Session and open
<http://localhost:16686>, service `volli`.

Turning it off returns the runtime to the no-op sink; nothing is buffered, and
nothing is sent.

## Reading a trace

One Session run is one trace. The trace id is derived from the run's opaque,
process-local id, so every event of a run groups together without Volli holding
any per-run state. Events are sibling roots rather than a nested tree — the
event stream says a tool call and a turn belong to the same run, not that one
happened inside the other.

| Span | What it is |
| --- | --- |
| `chat <model>` | One physical provider request: usage, cache splits, cost, TTFT, stop reason |
| `execute_tool <activity kind>` | One executed tool, by Volli's bounded `ActivityKind`; duration excludes an approval wait |
| `volli.agent.turn` | One finished runtime turn |
| `volli.agent.authority` | An allowed or denied authority decision; an approval wait is its duration |
| `volli.agent.compaction` | A compaction, with tokens before and after |
| `volli.agent.attachment` / `volli.agent.attention` | Lifecycle and recovery facts |
| `volli.observability.dropped` | Telemetry the pipeline itself lost, and why |

Provider usage is under the OpenTelemetry GenAI names
(`gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.response.finish_reasons`, …). Anything the convention has no word for is
under `volli.` — cost is the clearest case.

## Metrics

The same opt-in Settings row sends OTLP metrics to `/v1/metrics`; metrics carry
no `runId`, so they cannot correlate a Session. The mapper emits:

- tool-call counters by bounded `ActivityKind` and outcome, plus execution and
  approval-wait histograms;
- model-request counters and operation-duration histograms by provider, requested
  model, stop reason, and bounded provider error class;
- input, output, cache-read, cache-write, and reasoning token counters, plus cost;
- authority-decision, compaction, and dropped-telemetry counters.

No logs signal is configured.

`volli.observability.dropped` is not an error. It is the successful report of a
loss: a full queue, or an exporter that threw. If you see it, the collector is
not keeping up and the events around it are incomplete.

## What is deliberately not here

- **Nothing about a person, a machine, or a Session.** The event vocabulary in
  `packages/shared/src/agent-observability.ts` has no free-form string in it, so
  there is no prompt, path, command, tool argument or diagnostic to redact. The
  only correlation id is a per-attachment UUID minted at attach.
- **No `OTEL_*` anywhere near a tool.** Volli configures its trace and metric
  exporters from the Settings row, never from the environment, and never writes `OTEL_*` into
  `process.env`. `piExecutionEnv`'s allowlist is the second line;
  `execution-env.test.ts` and `observability/containment.test.ts` hold both.
- **No exporter in the renderer.** OpenTelemetry is initialized in
  `apps/desktop/src/main/observability` and nowhere else, which
  `containment.test.ts` enforces against the source tree.
- **No collector credential.** A collector address with a username or password
  in it is refused rather than stored, because Settings reads the address back
  and shows it.

## When something is wrong

- **"Volli could not start exporting to this address."** The transport could not
  be built. Check the address.
- **"Nothing is answering at this address."** The first batch did not land —
  usually Jaeger is not running, or is on another port. Said once, in Settings,
  and never as a toast: a collector that has gone away fails on every batch, and
  a repeated toast would be worse than the outage.

Neither is ever raised at a turn. A collector outage costs measurements and
nothing else — the queue drops, counts the drop, and the agent does not wait.

## Background

`docs/research/agent-observability-oss-options.md` — why Jaeger, why not a
hosted LLM-ops product, and the boundary this implements.

`docs/research/competitor-agent-observability.md` — the competitor evidence and
why this PR adds metrics while keeping evaluation work out of VC-119.
