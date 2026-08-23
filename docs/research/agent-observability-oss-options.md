# Local-first agent observability options

_Research note — 2026-08-22. This is a recommendation, not an implementation change._

## Recommendation

Use a small, split stack rather than adopt a hosted LLM-ops product:

1. **Instrument Volli itself with a product-owned OpenTelemetry adapter**, using Pi's existing vendor-neutral telemetry context for model requests and Volli's `RuntimeObservation` stream for tools, authority, turns, and compaction.
2. **Use self-hosted Jaeger as the first trace viewer** during development. It is a single local all-in-one process and accepts OTLP.
3. **Use Promptfoo for versioned, fixture-only regression evals and model matrices.** Its custom TypeScript provider can call Volli's actual runtime rather than a lookalike prompt.
4. **Pilot OpenLIT only if a shared, self-hosted dashboard plus built-in eval UI becomes worth its three-service footprint.** It is the strongest fully Apache-2.0 all-in-one candidate found.

This keeps execution independent of observability, does not rewrite provider endpoints, and does not create a second copy of user prompts, answers, tool arguments, file paths, commands, diffs, or tool output.

## Shortlist

| Software | License / installation | Best use for Volli | Recommendation |
| --- | --- | --- | --- |
| [Pi telemetry](https://github.com/earendil-works/pi/tree/v0.84.1/packages/telemetry) | MIT; already transitive to Pi core | Typed, passive in-process model-request instrumentation | **Adopt as the runtime seam** |
| [OpenTelemetry + Jaeger](https://www.jaegertracing.io/docs/2.18/getting-started/) | Apache-2.0; Jaeger all-in-one is one local container with transient storage | Trace tree and latency debugging without SaaS | **Start here** |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | MIT; Node CLI/library | Model-by-model, task-by-task regression evals in CI | **Adopt for evals** |
| [OpenLIT](https://github.com/openlit/openlit) | Apache-2.0; self-hosted OpenLIT + ClickHouse + OTel Collector | Shared traces, cost dashboards, and self-hosted eval UI | **Pilot later** |
| [Langfuse OSS](https://github.com/langfuse/langfuse) | MIT outside its `ee/` paths | Mature JS/TS dataset and experiment workflow | **Defer: operationally heavy** |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) | MIT; Python | External-harness and sandboxed benchmark validation | **Optional, fixture-only** |

### Why these are the fit

- **Pi telemetry is already near the exact boundary Volli needs.** Pi's telemetry package is deliberately callback-based, has a no-op context and in-memory reference implementation, contains no exporter, and requires recording to be passive and non-throwing. Pi 0.84.1 propagates `telemetryContext` through provider request options; its `pi.ai.request` schema includes provider/model, input/output/cache tokens, total cost, stream chunks, time to first chunk, stop reason, and a low-cardinality error type. [Pi telemetry README](https://github.com/earendil-works/pi/tree/v0.84.1/packages/telemetry), [Pi AI change](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md), [Pi schema](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/docs/telemetry-schema.md).
- **Jaeger is the lightest useful local viewer.** Its all-in-one image combines collector and query/UI, accepts OTLP on ports 4317/4318, and stores traces in memory for a disposable developer session. It is not an eval platform, which is a feature here: it adds no competing prompt, dataset, or user-data store. [Jaeger documentation](https://www.jaegertracing.io/docs/2.18/getting-started/).
- **Promptfoo is a local-first eval runner, not a telemetry backend.** It supports custom JS/TS providers, so its evaluation matrix can invoke Volli's actual `AgentRuntime` and return outcome, usage, cost, and safe metadata. By default, its OSS runner executes locally and sends configured calls directly to the selected model provider; results are local. Disable its own usage telemetry and update check in Volli's eval command environment. [Custom provider API](https://www.promptfoo.dev/docs/providers/custom-api/), [data handling FAQ](https://www.promptfoo.dev/docs/faq/), [telemetry configuration](https://www.promptfoo.dev/docs/configuration/telemetry/).
- **OpenLIT is the best all-in-one strict-OSS candidate found.** It is Apache-2.0, OpenTelemetry-native, self-hosts as OpenLIT + ClickHouse + an OTel Collector, and offers tracing, cost views, programmatic/online evaluations, and TypeScript support. Its automatic instrumentation records prompt and completion content by default, so Volli must use its own content-free spans rather than turn on automatic provider instrumentation. [License](https://github.com/openlit/openlit/blob/main/LICENSE), [self-hosting](https://docs.openlit.io/latest/openlit/installation), [content-capture behavior](https://docs.openlit.io/latest/sdk/features/tracing).
- **Langfuse is capable but does not meet the initial lightweight bar.** Its self-hosted architecture has web and worker containers plus Postgres, ClickHouse, Redis/Valkey, and blob storage. Its JS/TS experiment runner is useful if Volli later needs shared datasets, comparisons, and labels. [Self-hosting architecture](https://langfuse.com/self-hosting), [JS/TS experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk), [license split](https://github.com/langfuse/langfuse/blob/main/LICENSE).
- **Inspect AI is useful for an external comparison lane, not for live-product telemetry.** It supports custom/sandboxed agent bridges, checkpointing, token/message/time limits, and local evaluation logs. Its logs retain samples and by default retain raw API requests/responses for initial calls and errors, so run it only against synthetic fixtures and pass `--no-log-model-api`. [Agents](https://inspect.aisi.org.uk/agents.html), [agent bridge](https://inspect.aisi.org.uk/agent-bridge.html), [log behavior](https://inspect.aisi.org.uk/eval-logs.html).

## Do not choose by default

- **Arize Phoenix is source-available, not strict OSS.** Its current repository is Elastic License 2.0, which restricts providing it as a managed service. Do not label it an OSS dependency for Volli. [License](https://github.com/Arize-ai/phoenix/blob/main/LICENSE).
- **Do not put an LLM proxy/gateway in the first runtime path.** It changes provider routing, credentials, failure modes, streaming, and cache behavior—the very things this ticket should measure. OTLP side-channel export does not.
- **Do not enable automatic instrumentation blindly.** The AI SDK records inputs and outputs by default once telemetry is registered; OpenLIT also captures prompts/completions by default. That conflicts with the product requirement even when the collector is local. [AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry), [OpenLIT tracing](https://docs.openlit.io/latest/sdk/features/tracing).
- **Do not run LLM-as-a-judge on real Session traces.** OpenLIT's online evaluator is configured with a judge provider and API key; it is appropriate for synthetic eval fixtures or an explicitly approved local judge, not customer inputs. [OpenLIT evaluator configuration](https://docs.openlit.io/latest/openlit/evaluations/llm-as-a-judge).

## What other harnesses get right

| Harness / library | Useful pattern | Volli adaptation |
| --- | --- | --- |
| [Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/observability) | OTLP is opt-in; it separates metrics, logs, and traces; structural telemetry omits content unless explicit content flags are set; exporter failure does not stop the agent. | Make telemetry disabled by default, emit metadata-only spans, and make the exporter best-effort. |
| [Pi telemetry](https://github.com/earendil-works/pi/tree/v0.84.1/packages/telemetry) | An explicit context is passed through the call graph; a no-op context has no behavioral effect; adapters must suppress backend failures. | Keep a product-owned `ObservabilityContext`/sink at the runtime boundary rather than using global monkey patches. |
| [Vercel AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) | A telemetry integration can observe model and tool lifecycle events, but captures inputs and outputs by default. | Borrow the lifecycle separation, not the default capture policy. Default every Volli content field to absent. |

## Implementation shape

### 1. Keep Volli vocabulary canonical

Do **not** turn a tracing vendor's span model into Session history. `RuntimeObservation` remains the product boundary and the Session Engine remains the durable owner.

The current runtime already has the necessary safe signal sources:

- `activity` has start/completion/failure, `ActivityKind`, timestamps, and a sanitized descriptor;
- `authority` records a denied tool before it executes;
- `turn`, `attention`, and `compaction` record lifecycle and recovery facts;
- `message-settled` already carries model, input/output/cache tokens, and cost when Pi reports them.

See [`@volli/shared` runtime observations](../../packages/shared/src/agent-runtime.ts), [`ActivityKind`](../../packages/shared/src/session-activity.ts), and the Pi event adapter in [`runtime.ts`](../../packages/agent-runtime/src/pi/runtime.ts).

Add a **side-channel observer** after these observations are accepted. It may produce telemetry, but it must never decide whether an observation is persisted, whether a tool is allowed, or whether a turn completes.

### 2. Use Pi for model-request spans, Volli for product spans

The current runtime supplies `models.streamSimple.bind(models)` to Pi's `Agent`. Pi's ordinary `Agent` constructor has no telemetry option, but its `StreamFn` receives `SimpleStreamOptions`, and Pi's provider request options accept `telemetryContext`.

Wrap that stream function at the Volli boundary and inject a child Pi telemetry context. This gives each physical provider request a Pi `pi.ai.request` span with provider-reported usage and stream timing. Do not replace the current Agent with Pi's separate `AgentHarness` API just to gain its additional harness spans.

Emit product-owned spans and metrics from Volli observations:

| Boundary | Span / metric | Safe dimensions |
| --- | --- | --- |
| One runtime turn | `volli.agent.turn` / duration | role, model provider/id, reasoning level, terminal state |
| One provider request | mapped Pi `pi.ai.request` / GenAI metrics | provider, model, stop reason, input/output/cache token counts, cost, latency |
| One executed tool | `volli.agent.tool` / duration, calls, failures | **Volli `ActivityKind`**, fixed tool capability class, outcome |
| Authority decision | `volli.agent.authority` event/counter | allow/deny/ask, fixed denial cause, tool category |
| Compaction | `volli.agent.compaction` event | threshold/overflow/manual, tokens before/after |
| Export pressure | `volli.observability.dropped` counter | bounded reason such as `queue_full` or `exporter_unavailable` |

Map to [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai) only in the exporter adapter. Those conventions are currently marked Development. Keep `RuntimeObservation` and Volli's schema versioned independently so an external semantic-convention rename cannot become a migration of durable Session data.

### 3. Export only structural data

**Allowed by default**

- role; a bounded model/provider identifier; reasoning level;
- `ActivityKind`, fixed authority cause/outcome, and fixed compaction reason;
- durations, counts, token splits, cache read/write values, cost, and low-cardinality error class;
- an opaque per-process trace ID only for nesting during the local export lifecycle.

**Never export by default**

- Session, Ticket, project, worktree, user, account, provider response, or tool-call identifiers;
- prompts, system prompt, model output, reasoning, attachments, tool schemas, arguments, results, command strings, paths, URLs, diffs, file contents, or raw diagnostics;
- headers, credentials, model-access data, or arbitrary custom-tool names.

Do not rely on regex redaction as the policy. Do not add sensitive fields to a span in the first place. In particular, filter Pi's high-cardinality `pi.session.id`, `pi.operation.id`, `pi.tool.call_id`, and provider response ID before an OpenTelemetry exporter sees them.

### 4. Make observability unable to disturb a run

- Initialize exporters in Electron main only, never the renderer or a model-visible tool process.
- Use an explicit no-op sink when disabled; make self-hosted destination setup an opt-in developer/admin setting.
- Record into a bounded in-memory queue. A full queue drops telemetry and increments a local drop counter; it never back-pressures a model stream or tool call.
- Never await export on the agent path. Flush only during controlled app shutdown with a bounded timeout.
- Surface a failed user-requested exporter configuration in Settings, but do not convert later collector outages into an agent failure or a repeated toast.
- Do not send `OTEL_*` variables into Bash, web, MCP, or other tool environments. Claude Code similarly keeps its exporter settings out of spawned tools. [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage).

### 5. Build evaluation separately from live telemetry

Create a versioned, synthetic `evals/` corpus. Each case should declare:

- task fixture/worktree and a deterministic verifier;
- intended role, tool bundle, authority policy, model, and reasoning level;
- runtime/prompt/tool-policy revision identifiers;
- expected outcome plus deterministic checks: tool category/order where relevant, denied-action behavior, worktree diff, tests, elapsed budget, and cost/token caps;
- optional human or judge rubric, explicitly separate from deterministic score.

Implement a Promptfoo custom TypeScript provider that starts the **real** `AgentRuntime` against that fixture. Return only fixture output plus derived usage/cost/tool-summary metadata to Promptfoo. Run the same matrix across models in CI and write artifacts to a local ignored directory or CI artifact store.

For external validation, add Inspect only after the Volli eval adapter can run the actual runtime in a sandbox. Pin the task set, worktree image, tool policy, model version, concurrency, token budget, and scoring version for every comparison. A headline pass rate without those controls compares different harnesses rather than model behavior.

## Suggested order of work

1. Add a no-op/product-owned observability port and tests proving it cannot alter delivery, authority, persistence, cancellation, or retry behavior.
2. Add metadata-only observation reduction plus a Pi `TelemetryContext` adapter. Test every allowed and forbidden attribute.
3. Run a local Jaeger developer smoke test with synthetic data; verify tool spans, authority denials, Pi token/cache/cost values, compaction, and exporter-drop behavior.
4. Add the minimal `evals/` fixture corpus and Promptfoo provider. Gate pull requests on deterministic cases first; report cost and reliability deltas without making an LLM judge a merge requirement.
5. Decide whether OpenLIT's shared UI/eval workflows justify its ClickHouse + Collector deployment. If not, continue with Jaeger plus Promptfoo.

## Validation addendum — 2026-08-23

The local claims above were re-verified against the pinned dependencies before
implementation. One finding materially adjusts the implementation shape:

- `pi-ai` 0.84.2 **accepts and threads** `telemetryContext` through every
  provider adapter's request options (`buildBaseOptions`), but **no adapter
  records to it** — there is no `startSpan` call anywhere in its shipped
  runtime code. Span emission, including the `pi.ai.request` schema, lives in
  `pi-agent-core`'s harness layer (`dist/harness/telemetry.js`,
  `AI_TELEMETRY_SCHEMA`), which Volli's plain-`Agent` runtime deliberately does
  not use.
- Injecting a child telemetry context through `streamSimple` therefore
  produces zero spans at these pins. The first implementation slice instead
  **derives the attempt envelope at Volli's own stream boundary**
  (`packages/agent-runtime/src/pi/observability.ts`), observing the
  `AssistantMessageEventStream` the runtime already owns and mirroring the
  field vocabulary of Pi's `pi.ai.request` span. When a future Pi release
  records natively, adopting its spans is an exporter change, not a vocabulary
  migration.
- Everything else held: the telemetry package is a transitive dependency at
  0.84.1/0.84.2 and exports the context/span types with `sensitive` and
  `cardinality` attribute metadata; `RuntimeObservation` carries the safe
  signal sources listed above; the `Agent` constructor has no telemetry
  option.

The shipped vocabulary and reduction live in
`packages/shared/src/agent-observability.ts`; the runtime tee and stream
instrument live in `packages/agent-runtime/src/pi/observability.ts`.

## Implementation addendum — Phase 2 exporter

The OTLP side channel is shipped, opt-in and off by default. It lives entirely
in `apps/desktop/src/main/observability/`, and it confirmed the shape above with
three adjustments worth recording:

- **No Pi telemetry context is injected, and no OTel global is registered.**
  Following the 2026-08-23 finding, spans are built from Volli's own event
  stream. `TracerProvider` is constructed and held as an object —
  `provider.register()` is never called, no context manager or propagator is
  installed, and `diag` keeps its no-op logger — so "observability is off" means
  nothing is running rather than a tracer sampling into a void.
- **One Session run is one trace, with sibling roots.** The plan's "opaque
  per-process trace ID only for nesting" is implemented by hashing the
  per-attachment `runId` into a trace id staged on the SDK's `IdGenerator`
  immediately before each synchronous `startSpan`. Events are sibling roots
  rather than a nested tree, because the event stream establishes that a tool
  call and a turn share a run — not that one happened inside the other.
- **Convention attribute names are inlined literals, not imported symbols.**
  `@opentelemetry/semantic-conventions` exports the GenAI names only from its
  explicitly unstable `/incubating` entrypoint, so importing them would let a
  patch bump change what Volli emits. The names are quoted from
  semantic-conventions 1.43.0 in `observability/genai.ts` and are the whole of
  Volli's dependence on the convention. `gen_ai.system` is emitted beside
  `gen_ai.provider.name` because the ecosystem has not finished that rename.

The current direct OTel dependencies are `@opentelemetry/api`,
`@opentelemetry/otlp-exporter-base`, `@opentelemetry/otlp-transformer`,
`@opentelemetry/resources`, `@opentelemetry/sdk-trace`, and
`@opentelemetry/sdk-metrics`. They are all pure JavaScript and bundled into the
packed main chunk. `docs/observability-smoke.md` is the Jaeger developer path;
`observability/jaeger.integration.test.ts` is its executable form, verified
against `jaegertracing/jaeger:2.18.0`.

## Implementation addendum — metrics signal

The same opt-in Settings owner now builds an OTLP meter provider beside the
trace provider, with the same explicitly configured collector origin. The
adapter sends counters and histograms to `/v1/metrics`; it does not read or
write `OTEL_*`, register a global provider, add a logs signal, or pass trace
context into tools.

The canonical mapper is still the only translation point. It emits bounded
labels for tool calls, model requests, token type, cost, authority decisions,
compactions, and dropped telemetry; `runId` remains trace-only. Authority now
has allowed and denied observability arms, an approval wait is separated from
tool execution, and provider prose reduces locally to a closed error class.

`@opentelemetry/otlp-exporter-base`, `@opentelemetry/otlp-transformer`, and
`@opentelemetry/sdk-metrics` are bundled into the Electron-main packed chunk.
The real meter provider is covered by an in-memory exporter test.

## Implementation addendum — convention conformance and tool identity

A review pass against the published GenAI conventions found three places where
Volli borrowed a convention name without meeting the convention's contract, and
one place where the vocabulary was coarser than this ticket needs.

- **`gen_ai.client.token.usage` is a histogram, not a counter.** The convention
  defines the instrument type, and a sum emitted under a name a backend reads as
  a distribution is misreported rather than rejected. Both borrowed metric names
  now also carry the convention's prescribed `ExplicitBucketBoundaries`; without
  them the SDK applies HTTP-latency defaults that put every token count in the
  overflow bucket.
- **`gen_ai.operation.name` is Required on both borrowed metrics** and was set on
  spans only. It is now on both metric families.
- **`gen_ai.response.finish_reasons` is typed as a list** by the convention. It
  was emitted as a scalar; `SpanAttributes` now has a list arm used by that one
  attribute, and the privacy property is checked element-by-element so the arm
  cannot become a looser second channel.
- **Tools are named, from a closed allowlist.** `ActivityKind` answers "which
  capability class" but collapses `web_fetch` and `web_search`, which makes the
  ticket's per-tool call and failure rates unanswerable. `OBSERVED_TOOL_IDS` in
  `@volli/shared` lists the tools Volli ships; a name on it is spoken, and
  anything else — an MCP tool, a future Pi tool, a name a model invented — is
  counted under its capability class and never exported. The harness's
  `nativeToolName` is sanitized but not bounded, so it is never the thing sent.

The rule this pass settles: borrow a convention name only together with its
instrument type and its required attributes, or else keep the measurement under
`volli.`. A near-miss is worse than a custom name, because a dashboard consumes
it silently.

## Evals are not part of VC-119

No Promptfoo provider and no fixture corpus were added. The recommendation above
stands and is now tracked as **VC-171**, rather than living only in this note.

The split is not just scheduling. Telemetry answers what an agent did in one
run; evals answer whether it is getting better across runs, which needs a fixed
corpus, repeatable inputs, and retained outputs to judge. The privacy boundary
that makes this side channel safe — no prompt, no path, no tool argument, no
output — is precisely what an eval needs, so evals must run against synthetic
fixtures rather than over recorded Session traces.

## Source index

Primary project/repository sources used above:

- [Pi telemetry package](https://github.com/earendil-works/pi/tree/v0.84.1/packages/telemetry), [Pi AI telemetry propagation](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/CHANGELOG.md), and [Pi agent telemetry schema](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/docs/telemetry-schema.md).
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai).
- [Jaeger all-in-one OTLP setup](https://www.jaegertracing.io/docs/2.18/getting-started/).
- [Promptfoo repository](https://github.com/promptfoo/promptfoo), [custom JS/TS provider](https://www.promptfoo.dev/docs/providers/custom-api/), and [local data handling](https://www.promptfoo.dev/docs/faq/).
- [OpenLIT repository and Apache-2.0 license](https://github.com/openlit/openlit), [self-hosting](https://docs.openlit.io/latest/openlit/installation), and [tracing content capture](https://docs.openlit.io/latest/sdk/features/tracing).
- [Langfuse self-hosting architecture](https://langfuse.com/self-hosting) and [JS/TS experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk).
- [Inspect AI repository](https://github.com/UKGovernmentBEIS/inspect_ai), [agent bridge](https://inspect.aisi.org.uk/agent-bridge.html), and [eval log controls](https://inspect.aisi.org.uk/eval-logs.html).
- [Claude Code OpenTelemetry model](https://code.claude.com/docs/en/agent-sdk/observability) and [AI SDK telemetry behavior](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).
- [Phoenix current ELv2 license](https://github.com/Arize-ai/phoenix/blob/main/LICENSE).
