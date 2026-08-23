# How other coding agents observe themselves

_Research note — 2026-08-23. Evidence and a set of Phase 3/Phase 4 decisions, not an implementation change._

## Bottom line

Fourteen products, read against their own docs and source on 2026-08-23. Three
shapes exist, and only one of them is what VC-119 built:

1. **User-configurable OTel export.** Claude Code, Gemini CLI, Copilot Chat,
   Codex, and Cline emit OTLP to a destination the user or the org picks.
   Volli is in this group.
2. **Vendor-collected product analytics.** Cursor, Zed, Roo Code, Aider, Amp,
   Windsurf, Devin collect to their own backends; the user's control is a
   switch, not a destination.
3. **Undocumented.** OpenCode ships no first-party telemetry surface its docs
   describe.

Within group 1, **every competitor ships a content-capture flag and Volli does
not**. Claude Code has five, up to `OTEL_LOG_RAW_API_BODIES=file:<dir>` which
writes untruncated Anthropic Messages bodies — the whole conversation — to disk.
Copilot Chat's `captureContent` adds prompts, system instructions, tool
arguments and tool results "in full with no truncation". Gemini CLI's
`logPrompts` **defaults to true**, so the standard enabled configuration exports
prompt text. Volli's event union has no free-form string in it, so there is no
flag to set and nothing to redact. That is the sharpest difference and it is
structural, not a policy Volli chose to state.

Volli is behind in one dimension that matters directly to this ticket:
**Volli emits spans only.** Every serious competitor emits counters and
histograms too, and "frequency of tool calls, nature and failure rates" is a
metrics question. Jaeger cannot answer it; a `tool.call.count{kind,outcome}`
counter can. That is Phase 4's first job.

Volli is also behind on **outcome measurement**. Copilot Chat measures edit
survival at 5s/30s/2m/5m/10m/15m after acceptance; Cursor matches AI line
signatures against later commits on-device. Nobody's telemetry answers "did the
agent's work stick" except through that kind of measurement, and Volli's
worktree model can compute it locally without exporting a path or a language id.

## What Volli ships, for comparison

Established from the workspace, not from memory:

- **Vocabulary.** `ObservabilityEvent` is a closed union of eight event kinds —
  `provider-attempt`, `turn`, `tool`, `authority-denied`, `compaction`,
  `attachment`, `attention`, `dropped`. Every field is a closed vocabulary word,
  a count, a duration, or a configuration identifier. There is no free-form
  string in the union. [`agent-observability.ts`](../../packages/shared/src/agent-observability.ts)
- **Signals.** Traces only. `@opentelemetry/exporter-trace-otlp-http`; no meter,
  no logger. [`otlp.ts`](../../apps/desktop/src/main/observability/otlp.ts)
- **Default.** Off, and off means `NOOP_OBSERVABILITY_SINK` rather than an idle
  exporter. No `OTEL_*` variable can switch it on; the endpoint is passed
  explicitly from a Settings row. [`settings.ts`](../../apps/desktop/src/main/observability/settings.ts)
- **Destination.** A user-typed OTLP/HTTP endpoint, defaulting to
  `http://localhost:4318` (Jaeger all-in-one). An address with credentials in it
  is refused rather than stored. [`docs/observability-smoke.md`](../observability-smoke.md)
- **Correlation.** One opaque per-attachment `runId`, hashed into a trace id. No
  Session, Ticket, worktree, project, user or account identifier is exported.
- **Convention.** GenAI names are inlined literals quoted from
  semantic-conventions 1.43.0, in one adapter. Cost, API family, reasoning level
  and chunk count go under `volli.` because the convention has no word for them.
  [`genai.ts`](../../apps/desktop/src/main/observability/genai.ts)
- **Containment.** No file outside `src/main/observability` names an
  `@opentelemetry` package; no desktop source writes `OTEL_*` into `process.env`;
  `piExecutionEnv` is an allowlist. Both held by tests.
  [`containment.test.ts`](../../apps/desktop/src/main/observability/containment.test.ts)
- **Back-pressure.** Bounded queue; a full queue drops the newest and counts it;
  the count becomes a `dropped` event at the head of the next batch.
- **Evals.** Planned (Phase 3): fixture-based Promptfoo runs over the real
  `AgentRuntime`. Not started.

## Comparison — signals, default, content, destination

| Product | 1. What is emitted, over which standard | 2. Default and how it is enabled | 3. Content policy | 4. Destination and reader |
| --- | --- | --- | --- | --- |
| **Volli** | Traces only. Volli-canonical events; GenAI names applied at the exporter | **Off.** Settings row only; no env activation path | **Metadata-only by construction.** No content flag exists; no free-form string in the event union | User-typed OTLP/HTTP collector, Jaeger as dev viewer. Local-first; no vendor endpoint |
| **Claude Code** (+ Agent SDK) | Metrics, log events, traces (beta). OTel | **Off.** `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus per-signal exporter env vars; traces need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. Admins set the same env through managed settings | Structural by default. Five opt-in flags: prompts, assistant responses, tool details, tool content, raw API bodies (inline ≤60 KB or untruncated `file:<dir>`) | Any OTLP backend; managed settings can lock the destination and strip developer-set overrides. Separate Anthropic-side dashboards and Enterprise Analytics API |
| **OpenAI Codex CLI** | Log events, traces, metrics. OTel | Log/trace export **off** (`exporter = "none"`); `[otel]` in user-level `config.toml`, ignored in project config. **Metrics default to Statsig** in release builds; separate `[analytics] enabled = false` opt-out | `log_user_prompt = false` by default; `codex.tool_result` carries an output snippet; session metadata carries `account_id`, `account_email`, `conversation_id`, `auth_mode`, `originator` | User OTLP (http/grpc, headers, TLS) — and, by default for metrics, `https://ab.chatgpt.com/otlp/v1/metrics` with a baked-in key |
| **Gemini CLI** | Logs, metrics, traces. Custom `gemini_cli.*` plus GenAI convention metrics | **Off** (`telemetry.enabled = false`); settings.json, env, or CLI flags; `target` is `local` or `gcp` | **`logPrompts` defaults to `true`** — prompt text on `user_prompt`, `request_text`/`response_text` on API events. `sessionId` on every log and metric | Local file, local collector/Jaeger (`npm run telemetry`), or direct export to Google Cloud Logging/Monitoring/Trace |
| **Copilot Chat / VS Code** | Traces, GenAI metrics, `copilot_chat.*` metrics, log events. OTel, GenAI conventions | **Off** (`github.copilot.chat.otel.enabled`) — but also activates automatically **when `OTEL_EXPORTER_OTLP_ENDPOINT` is set** | Metadata by default. `captureContent` adds input/output messages, system instructions, tool definitions, tool arguments and results, "in full with no truncation" | User-chosen OTLP, file, or console; docs demo Aspire Dashboard locally. Separately, GitHub org/enterprise usage-metrics APIs with per-user rows |
| **Cursor** | No user-configurable telemetry export documented. Admin dashboard plus Analytics API | Dashboard is on for Team/Enterprise; **Conversation Insights is on by default for Enterprise**, disabled in team settings | AI-line attribution and conversation classification run **on-device**; only counts and aggregate labels leave. Insights API "returns aggregate insights, not raw conversation exports" | Cursor's cloud, read by team admins (all users) and members (self, plus leaderboards) |
| **Cline** | Metrics and logs. OTLP. **No traces** ("not yet implemented") | Opt-in, configured through Cline's **cloud dashboard remote configuration**, not a local file | Docs: exported data "doesn't include code content, file paths, or sensitive information" | Org-chosen OTLP collector (Datadog/New Relic/Grafana examples); plus Cline's own PostHog telemetry |
| **Roo Code** | Product analytics only (PostHog) | **On by default**, opt out in settings | VS Code machine ID, feature usage, exception reports; no code, no prompts | Roo's PostHog |
| **Aider** | Product analytics only (PostHog) | **Opt-in**, with a random subset prompted to opt in; `--analytics-disable` is permanent | Models used and token counts, edit formats, feature/command usage, exceptions; explicitly no code, prompts, chats or keys | Aider's PostHog — or your own, via `--analytics-posthog-host` / project key. `--analytics-log` writes a local audit file |
| **Zed** | Product telemetry (diagnostics + metrics) | **On, opt-out** via `telemetry.diagnostics` / `telemetry.metrics` | File extensions, features used, project statistics, frameworks; crash minidumps. Telemetry ID may be linked to your email if authenticated | Sentry, Snowflake, Hex, Amplitude. Local audit via `zed: open telemetry log` |
| **Amp** | Server-side by construction | Not a switch: threads sync to Amp Server | **Thread data is prompts, model responses, code snippets, tool results and attachments**, stored server-side. Secret redaction runs before transmission | ampcode.com (GCP, multi-tenant). Enterprise workspaces own their members' threads; admin access to private threads is passkey-gated and audit-logged |
| **Windsurf** | Admin analytics dashboards and REST analytics API | Enterprise/admin feature; some feature toggles "require storing additional data or telemetry", shipped off by default | Conversation sharing uploads conversations to Windsurf servers when enabled | Windsurf cloud, read by admins and (with a custom analytics-view role) team leads |
| **Devin** | Enterprise v3 API: audit logs, ACU consumption, session metrics, session insights | Vendor-hosted; RBAC-scoped service users (`ViewAccountSessions`, `ViewAccountMetrics`) | Session insights include **AI-generated analysis**: issues, timeline, note usage, and a `suggested_prompt` object carrying `original_prompt` | Devin's cloud (or a dedicated enterprise deployment), read by enterprise admins |
| **OpenCode** | **Nothing documented.** No telemetry or OTLP surface in its config or enterprise docs | — | — | — |

## Comparison — cost, tools, evals, env hygiene

| Product | 5. Token / cost / cache visibility | 6. Tool-call and failure observability | 7. Evals and regression infrastructure disclosed | 8. Process isolation and env hygiene |
| --- | --- | --- | --- | --- |
| **Volli** | Per attempt: input/output/cache-read/cache-write/reasoning tokens, cost in USD, TTFT, chunk count. **No rollup, no in-app cost view, no admin surface** | `execute_tool <ActivityKind>` spans with outcome and duration; `authority-denied` with a bounded cause; bounded `error.type`, never a message. **No counters** | Phase 3 planned: Promptfoo fixtures over the real `AgentRuntime`. **Nothing shipped** | Exporter lives only in Electron main; structural test forbids `@opentelemetry` elsewhere; no `OTEL_*` written to `process.env`; `piExecutionEnv` allowlist; no trace context propagated into tools |
| **Claude Code** | Metric counters for tokens and cost; `/analytics` dashboards with spend per user; Enterprise Analytics API cost reports | `tool_decision` and `tool_result` events; `claude_code.tool` span with a `blocked_on_user` child separated from `execution`; `api_error` events | Not disclosed on the monitoring or SDK pages | Documented: `OTEL_*` is **not** passed to spawned subprocesses (Bash, hooks, MCP servers, language servers). But when trace propagation is on, the CLI **forwards `TRACEPARENT` to every Bash and PowerShell command** |
| **Codex CLI** | `gen_ai.usage.input_tokens`, `cache_read.input_tokens`, `output_tokens`, plus `codex.usage.reasoning_output_tokens` / `total_tokens` on spans. No cost metric in the catalog | `codex.tool.call` counter and duration histogram tagged `tool`+`success`; `codex.tool_decision` (approved/denied, config vs user); `api_request` counter by status/success | Not disclosed in the config docs or the otel crate | Telemetry is configured from `config.toml`, not env, and `otel` keys are ignored in project-local config. `shell_environment_policy` governs what spawned commands inherit; `ignore_default_excludes` defaults to `true`, so `KEY`/`SECRET`/`TOKEN` names are **not** auto-stripped |
| **Gemini CLI** | `gemini_cli.token.usage` by type `input`/`output`/`thought`/`cache`/`tool`; `cached_content_token_count` on API responses; `gen_ai.client.token.usage`. No cost | `tool.call.count` with `function_name`, `success`, **`decision` (accept/reject/auto_accept/modify)**, `tool_type`; latency histogram; `tool_output_truncated`; `api_error` with `error_type` and `status_code` | Not disclosed on the telemetry page | Not documented |
| **Copilot Chat** | GenAI token histograms; `copilot_chat.time_to_first_token`; org API reports `ai_credits_used` per user per period | `copilot_chat.tool.call.count{gen_ai.tool.name,success}` and duration histogram; `error.type` on spans; `execute_tool` spans; permission and hook spans for the CLI agent | **Yes, and it is the best disclosure in the survey.** Simulation tests run each test 10× against real endpoints, snapshot results into a committed `test/simulation/baseline.json`, cache model responses in-repo for determinism, and **PRs fail on an unpopulated cache or an uncommitted baseline change** | Subagent spans are parented via trace context. Terminal CLI sessions get `COPILOT_OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT` **forwarded into the child process** |
| **Cursor** | Model usage by messages and users; Conversation Insights inference is billed at the Cursor Token Rate. No token/cost telemetry surface for a user's own runs | MCP adoption per `tool_name`/`mcp_server_name`; skills adoption per `skill_name`; commands adoption. **No failure or error taxonomy documented** | Not disclosed | Not applicable — no local exporter |
| **Cline** | "Feature usage counts, task execution metrics, error rates and types, performance measurements" | Error rates and types are named as exported metrics; no per-tool schema published on the OTel page | Not disclosed on these pages | `TEL_DEBUG_DIAGNOSTICS=true` for exporter debugging; no statement about tool subprocess env |
| **Roo Code** | Not published | Exception reports only | Not disclosed in PRIVACY.md | Not documented |
| **Aider** | "Which LLMs are used and with how many tokens" | Feature/command usage and exception events | **Yes**: an in-repo Docker benchmark harness over Exercism polyglot exercises, reporting `pass_rate_1/2`, `percent_cases_well_formed`, malformed-response counts, `exhausted_context_windows`, `test_timeouts`, `seconds_per_case`, `total_cost`, pinned to a commit hash | Benchmark runs inside Docker precisely because it executes LLM-written code unsupervised |
| **Zed** | Server-side token usage for billing/rate limiting | Not published as a tool taxonomy | Not disclosed on the telemetry page | Not documented |
| **Amp** | Per-user cost controls on Enterprise; usage tracking on Amp Server | Thread storage preserves tool calls and results as an audit trail; a data-management API exposes workspace analytics and thread data to security teams | Not disclosed | No self-hosting; the client executes tools and returns results to Amp Server |
| **Windsurf** | Credit usage in the Admin Portal; analytics API | Per-feature analytics (autocomplete, chat, command, Cascade); no failure taxonomy documented | Not disclosed | Not documented |
| **Devin** | `acus_consumed` per session; daily ACU consumption; session metrics grouped by category | Session status detail vocabulary (`waiting_for_approval`, `usage_limit_exceeded`, …); audit logs include `ai_guardrail_violation` | Not disclosed in the API reference | Not applicable — vendor-hosted |
| **OpenCode** | Not documented | Not documented | Not disclosed | Not documented |

## Evidence by product

### Claude Code — the closest neighbour, and the widest content surface

Claude Code exports metrics over the OTel metrics protocol, events over the
logs protocol, and traces in beta. Telemetry is off until
`CLAUDE_CODE_ENABLE_TELEMETRY=1` and at least one exporter is chosen; the
Agent SDK does not instrument anything itself, it passes environment variables
through to the same CLI. Trace spans are `claude_code.interaction`,
`claude_code.llm_request`, `claude_code.tool` (with `blocked_on_user` and
`execution` children) and `claude_code.hook`.
[Monitoring](https://code.claude.com/docs/en/monitoring-usage),
[Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability).

Three details are worth taking seriously:

- **Content is a five-flag surface.** `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES` each add content; the
  last emits the entire Messages API request and response, inline truncated at
  60 KB or, as `file:<dir>`, untruncated onto disk with a `body_ref` pointer.
  The docs say enabling it "implies consent to everything the three variables
  above would reveal". This is a well-designed opt-in ladder — and it is exactly
  the surface Volli does not have, because Volli's events cannot carry the data.
- **Identity is a first-class attribute.** Spans carry `session.id` by default,
  identity attributes are attached from the calling credential, and the SDK
  guide recommends injecting `enduser.id` and `tenant.id` as resource
  attributes so `tool_decision`/`tool_result` become "a per-user audit trail you
  can forward to a SIEM".
- **Env hygiene is documented and then partially reversed.** `OTEL_*` is not
  passed to the Bash tool, hooks, MCP servers or language servers — the same
  rule Volli enforces with a test. But with trace propagation enabled, the CLI
  "forwards `TRACEPARENT` to every Bash and PowerShell command it runs", so a
  command's own spans nest under the tool span. That is a deliberate, useful
  feature and also a channel from telemetry configuration into a
  model-influenced process.

Admin-side, Anthropic's own dashboards carry lines-of-code accepted, suggestion
accept rate, DAU/sessions, spend per user, and PR attribution built by matching
normalized session output lines against merged PR diffs within a 21-day window.
[Analytics](https://code.claude.com/docs/en/analytics).

### OpenAI Codex CLI — opt-in logs, default-on vendor metrics

The `[otel]` table lives in user-level `config.toml`; project-local `.codex/`
config cannot set it, and Codex prints a startup warning if it tries. Log export
is off (`exporter = "none"`), `log_user_prompt = false`, and the documented
event set is `codex.conversation_starts`, `api_request`, `sse_event`,
`websocket_request`/`websocket_event`, `user_prompt`, `tool_decision`,
`tool_result` (duration, success, **output snippet**).
[Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
(the `developers.openai.com` copies of these pages 308-redirect, so the
ChatGPT-hosted originals are cited).

The source says something the prose does not lead with. `resolve_config` defaults
`metrics_exporter` to `OtelExporterKind::Statsig`, and `resolve_exporter` turns
`Statsig` into an OTLP/HTTP JSON exporter pointed at
`https://ab.chatgpt.com/otlp/v1/metrics` with a hardcoded `statsig-api-key` —
suppressed in debug builds only, with a test asserting that suppression.
[`config/otel.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/otel.rs),
[`otel/src/config.rs`](https://github.com/openai/codex/blob/main/codex-rs/otel/src/config.rs).
The docs describe this honestly as anonymous usage and health data with a
separate `[analytics] enabled = false` opt-out, but the shape is: **metrics go
to the vendor unless you turn them off**, which is the inverse of Volli's
default.

`SessionTelemetryMetadata` carries `conversation_id`, `account_id`,
`account_email`, `auth_mode`, `originator`, `terminal_type`, `model`, and
reasoning effort; token usage is recorded onto spans as
`gen_ai.usage.input_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.output_tokens` plus `codex.usage.*`.
[`events/session_telemetry.rs` @ `f1affbac`](https://github.com/openai/codex/blob/f1affbac/codex-rs/otel/src/events/session_telemetry.rs),
[`otel/README.md`](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md).

### Gemini CLI — the local-first path, with prompts on by default

Telemetry is off by default and configured in `.gemini/settings.json`, by
`GEMINI_TELEMETRY_*` env vars, or by CLI flags. `target` chooses `local`
(file, or a scripted local collector plus Jaeger on :16686) or `gcp` (direct
export to Cloud Logging/Monitoring/Trace). The metric set is genuinely close to
what VC-119 asked for: `tool.call.count` and `.latency`, `api.request.count` and
`.latency`, `token.usage` split by `input`/`output`/`thought`/`cache`/`tool`,
`chat_compression` with tokens before and after, plus the GenAI convention
`gen_ai.client.token.usage` and `gen_ai.client.operation.duration`.
[Observability with OpenTelemetry](https://google-gemini.github.io/gemini-cli/docs/cli/telemetry.html).

But `logPrompts` **defaults to `true`**. In the default enabled configuration,
`gemini_cli.user_prompt` carries the prompt, and `api_request`/`api_response`
carry `request_text`/`response_text` where applicable. Turning telemetry on and
content off is two decisions, and only one of them has a safe default. It is the
clearest available argument for Volli's "no field to set" construction.

### GitHub Copilot Chat — nearest to Volli's span shape, opposite content default

The extension emits `invoke_agent` → `chat` / `execute_tool` span trees under
GenAI conventions, GenAI metrics, `copilot_chat.*` metrics, and log events. Off
by default via `github.copilot.chat.otel.enabled`, **or on automatically when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set** — an ambient activation path Volli
deliberately does not have. Content is metadata-only until `captureContent`,
which then captures prompts, outputs, system instructions, tool definitions,
tool arguments and tool results "in full with no truncation".
[Monitoring agent usage with OpenTelemetry](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md),
linked from [VS Code telemetry](https://code.visualstudio.com/docs/configure/telemetry).

Two things here are worth stealing and one is worth refusing.

- Worth stealing: the **outcome metric family** — `edit.acceptance.count`,
  `chat_edit.outcome.count`, `lines_of_code.count`,
  `edit.survival.four_gram` and `edit.survival.no_revert` sampled at 5s, 30s,
  2m, 5m, 10m and 15m after an accepted edit, `agent.summarization.count`
  (applied/failed), `user.feedback.count`.
- Worth stealing: the **simulation-test discipline** — each test runs 10 times,
  results snapshot into a committed baseline, model responses are cached in-repo
  so reruns are deterministic and cheap, and a PR fails both on an unpopulated
  cache and on an uncommitted baseline change.
  [CONTRIBUTING.md](https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md).
- Worth refusing: telemetry env crossing a process boundary. Terminal CLI
  sessions receive `COPILOT_OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT`
  forwarded into the child process.

Org-side, GitHub's usage-metrics reports are per-user rows with `user_login`,
`ai_credits_used`, `loc_added_sum`/`loc_deleted_sum`, `used_agent`/`used_cli`
flags and an adoption-phase cohort.
[Data available in Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics).

### Cursor — no exporter, and classification instead of content export

Cursor publishes no user-configurable telemetry export. What exists is a
Team/Enterprise dashboard and an Enterprise Analytics API keyed by admin
credentials, with per-user leaderboards carrying emails and profile pictures.
Two design choices are relevant to Volli:

- **On-device derivation.** AI-line attribution stores line signatures locally
  and compares them against later commits; "all the AI detection is done on
  device, and never leaves the user's computer. We store the line counts as
  metadata". Conversation Insights likewise classifies on-device, with
  "default classifiers ensure no PII or sensitive data leaves the machine",
  and the API "returns aggregate insights, not raw conversation exports".
- **Content-derived labels are still exported.** Categories, complexity,
  guidance level and work type are derived from the conversation. Cursor's
  answer to the privacy problem is to run the derivation locally and export the
  label — a middle path between Volli's "no content-derived field at all" and
  Claude Code's "flag to export the content".

[Usage analytics](https://cursor.com/docs/account/teams/analytics),
[Analytics API](https://cursor.com/docs/account/teams/analytics-api).

### Cline — OTLP, but the org owns the switch

Cline supports opt-in OTLP metrics and logs (gRPC, HTTP/protobuf, HTTP/JSON),
explicitly **no distributed tracing yet**, no custom instrumentation API, and no
sampling configuration. Configuration is not a local file: it is done through
Cline's cloud dashboard as remote configuration, with endpoint, protocol,
intervals, batch sizes and auth headers. The docs state that exported data "is
already anonymous and doesn't include code content, file paths, or sensitive
information".
[OpenTelemetry integration](https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry),
[Cline telemetry](https://docs.cline.bot/enterprise-solutions/monitoring/telemetry).

### Roo Code, Aider, Zed — product analytics with three different defaults

- **Roo Code**: PostHog, enabled by default, opt out in settings; VS Code
  machine ID, feature usage, exception reports; no code or prompts.
  [PRIVACY.md](https://github.com/RooCodeInc/Roo-Code/blob/main/PRIVACY.md).
- **Aider**: opt-in, with a randomly selected subset asked to opt in;
  `aider --analytics-disable` is permanent; collects which LLMs and how many
  tokens, edit formats, feature and command usage, exceptions. Two properties
  worth borrowing: `--analytics-log filename.jsonl` lets a user audit exactly
  what would be sent, and `--analytics-posthog-host` lets an org point the same
  stream at its own installation.
  [Analytics](https://aider.chat/docs/more/analytics.html).
- **Zed**: on by default with `telemetry.diagnostics` / `telemetry.metrics`
  switches; file extensions, features used, project statistics, detected
  frameworks; the random telemetry ID "may be linked to your email" if you have
  authenticated; `zed: open telemetry log` is the local audit.
  [Telemetry in Zed](https://zed.dev/docs/telemetry).

### Amp — the fully server-side end of the spectrum

Amp has no local observability story because it has no local execution story to
observe in isolation: the client collects context and the server drives the
loop. "Thread data includes user messages, LLM responses, snippets of or entire
code files used as context, tool call results, and attachments", stored in
Postgres on GCP. In Enterprise workspaces threads are owned by the enterprise,
not the author, and survive the author's departure. Admin access to private
threads is passkey-gated and audit-logged. Application audit logs exist but are
"not currently exposed to Workspace Admins" — available on request. Amp's
prompt-injection defence explicitly counts the thread store as an audit trail.
Secret redaction runs before anything reaches the model, the local cache, or the
server.
[Security reference](https://ampcode.com/security), [Owner's manual](https://ampcode.com/manual).

### Windsurf and Devin — admin analytics, and AI analysis of sessions

Windsurf's admin surface is a portal plus a REST analytics API behind scoped
service keys, with teams as the analytics grouping and an explicit note that
"new major features with data privacy implications are released in the 'off'
state by default". Conversation sharing uploads conversations to Windsurf
servers when enabled.
[Windsurf guide for enterprise admins](https://docs.devin.ai/windsurf/plugins/guide-for-admins).

Devin's v3 API is the most analytical of the surveyed products: enterprise audit
logs (including an `ai_guardrail_violation` action), daily ACU consumption,
session metrics grouped by category, and a session-insights endpoint returning
`acus_consumed`, message counts, a `session_size` class, a use-case `category`
from a fixed enum, and an `analysis` object with issues, action items, a
timeline, note usage, and a `suggested_prompt` carrying the session's
`original_prompt`. That last field is the boundary Volli's vocabulary forbids by
construction.
[List sessions with insights](https://docs.devin.ai/api-reference/v3/sessions/enterprise-sessions-insights).

### OpenCode — nothing documented

OpenCode's configuration reference documents server, tools, models, policies,
permissions, compaction, formatters, LSP, agents and managed settings, and its
enterprise page covers central config, SSO, internal gateways and the `/share`
feature — none of them a telemetry or OTLP surface.
[Config](https://opencode.ai/docs/config/), [Enterprise](https://opencode.ai/docs/enterprise/).
Requests for native OTLP export are open in the project's own tracker, one of
which reports an `experimental.openTelemetry` flag producing no spans for
`opencode run`. Treat OpenCode as **undocumented**, not as "has none": there may
be an experimental path, but no first-party documentation stands behind it.

## What this changes for Volli

### Phase 3 (evals) — adopt

1. **Repeat each case, snapshot a baseline, gate the PR on baseline drift.**
   Copilot Chat runs each simulation test 10× and commits
   `test/simulation/baseline.json`; a PR fails on uncommitted baseline changes.
   Volli's Promptfoo corpus should do the same: k runs per fixture, a committed
   baseline of pass rates per (fixture × model × role), and a check that fails
   when the baseline moves without being accepted. This is what makes "consistent
   internal evaluations over time" a gate rather than a report.
2. **Cache provider responses in-repo for determinism and cost.** Same source.
   The constraint Volli must add: caches are built **only** from synthetic
   fixtures, and the cache is reviewable material in the repo — the metadata-only
   rule governs the export path, not an eval artifact, so the fixture corpus has
   to be synthetic by policy instead.
3. **Adopt Aider's report schema wholesale.** `pass_rate_1/2`,
   `percent_cases_well_formed`, `num_malformed_responses`,
   `exhausted_context_windows`, `test_timeouts`, `seconds_per_case`,
   `total_cost`, plus the commit hash and every setting in effect, so a run is
   reproducible from its own record. Volli's equivalents of `edit_format` are
   role, tool bundle, authority policy, model and reasoning level — the fields
   the Phase 1 vocabulary already names.
4. **Run fixture verification in a container, as Aider does**, because the
   harness executes model-written code without review. Volli's worktree
   isolation is not a substitute for that.
5. **Score compaction.** Gemini CLI counts `chat_compression` with tokens before
   and after; Volli already emits exactly this event. Make compaction count and
   token delta a scored dimension of an eval run rather than only a span.

### Phase 3 — reject

- **LLM-as-judge over real Sessions** (already rejected in the 2026-08-22 note;
  nothing found here changes it).
- **Devin-style session analysis and Cursor-style conversation classification as
  a Volli feature.** Devin's insights carry `original_prompt`; Cursor keeps the
  classifier on-device and still ships derived labels. Even the on-device form
  creates a content-derived export path, and Volli's guarantee is that no such
  field exists. If Volli ever wants work-type analytics, it belongs in the app's
  own durable Session data, never in the observability side channel.

### Phase 4 (rollups) — adopt

1. **Add a metrics signal.** This is the largest gap. Ticket asks for
   "frequency of tool calls, nature and failure rates"; Volli exports spans and
   nothing counts them. The convergent minimum, present in Gemini CLI, Codex and
   Copilot Chat alike: `tool.call.count{kind,outcome}`,
   `tool.call.duration{kind}`, `api.request.count{outcome}`,
   `token.usage{type}`, plus `gen_ai.client.operation.duration` and
   `gen_ai.client.token.usage` under convention names so external dashboards
   line up. `gen_ai.token.type` values are `input`/`output`; Gemini extends the
   custom metric with `thought`, `cache`, `tool` — Volli's cache-read,
   cache-write and reasoning splits map onto that pattern directly.
2. **Make authority a decision dimension, not only a denial event.** Gemini
   tags every tool call with `decision` ∈ accept/reject/auto_accept/modify;
   Claude Code emits `tool_decision` with the approver and separates a
   `blocked_on_user` span from execution. Volli emits `authority-denied` and
   nothing for the allowed paths, so the denial rate has no denominator and an
   approval wait is billed as tool duration. Phase 4 should add a bounded
   authority outcome (auto-allowed / asked-then-allowed / denied) and split
   waiting from executing in the tool event.
3. **Add a bounded provider-error class.** Volli currently reduces a failed
   attempt to `stopReason: "error"`. Gemini carries `error_type` and
   `status_code`; Codex tags counters with `status` and `success`. A closed
   error-class vocabulary (auth, rate-limit, overloaded, timeout, transport,
   invalid-request, unknown) is low cardinality, carries no prose, and is what a
   failure-rate dashboard actually needs.
4. **Derive cache-hit rate in the rollup.** The inputs already exist per
   attempt. Codex records `gen_ai.usage.cache_read.input_tokens`, Gemini has a
   `cache` token type — the durable projection should carry the ratio, not
   leave every consumer to recompute it.
5. **Measure whether the work stuck.** Copilot Chat's edit-survival and
   acceptance metrics, and Cursor's on-device line-signature attribution, are
   the industry's answer to "was the agent any good". Volli owns the worktree
   and the diff, so it can compute survival locally. Export it as counts and
   ratios only — Cursor exports file extensions and Copilot exports
   `language_id`, and both are content-derived dimensions Volli should not add.
6. **Give the user their own cost view before giving anyone else one.** Claude
   Code, Cursor, Copilot and Devin all surface cost primarily to admins. Volli's
   cost data already exists per attempt and is visible to no one unless a
   collector is running. An in-app per-Session token/cost/cache rollup is the
   local-first version of the same feature and needs no exporter at all.
7. **If Volli ever ships managed policy, lock the destination, not the
   content.** Claude Code's managed settings remove developer-set
   `OTEL_EXPORTER_OTLP_*` variables so a developer cannot redirect a signal to
   another collector, and the docs are careful that this "changes where
   telemetry is delivered, not what Claude Code collects". That separation is
   the right one for Volli, whose content answer is already fixed at zero.

### Phase 4 — reject

- **Any identity attribute.** Claude Code recommends `enduser.id`/`tenant.id`;
  Codex ships `account_email` in session metadata; Cursor's leaderboards are
  keyed by email; Amp's enterprise threads retain author attribution after the
  author leaves. Volli's opaque `runId` stays the only correlation id.
- **Default-on export to anyone.** Codex's `metrics_exporter` defaults to
  Statsig in release builds; Roo Code's PostHog is on by default. Volli's
  default stays off, and off stays a no-op sink.
- **Ambient activation.** Copilot Chat turns itself on when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is present in the environment. Volli reads no
  `OTEL_*`, and that should survive the metrics work: a meter provider must be
  constructed from the same Settings row, not from `process.env`.
- **Trace-context propagation into tools.** Claude Code forwards `TRACEPARENT`
  into Bash and PowerShell; Copilot Chat forwards `COPILOT_OTEL_ENABLED` and the
  OTLP endpoint into its terminal CLI child. Both buy nested traces at the cost
  of the property `containment.test.ts` exists to hold. Sibling roots under one
  run id remain the honest and safer shape.
- **Remote-configured telemetry as the only path**, as Cline does. An org
  dashboard that turns on a developer's exporter is a different product decision
  from an export switch the developer owns; if Volli ever needs it, it arrives
  after a local switch, not instead of one.

### Where Volli stands

**Ahead:** metadata-only by construction rather than by flag or redaction — no
competitor in the survey can say that; no identity export; no ambient
activation; exporter confined to one directory in Electron main with structural
tests; no `OTEL_*` in tool environments and no trace context either; a
first-class counted `dropped` event where Claude Code documents silent
best-effort export and everyone else says nothing about loss.

**Behind:** no metrics and no events, only spans, so tool frequency and failure
rate cannot be answered without a trace store doing aggregation it is bad at; no
eval harness at all while Copilot gates PRs on a baseline and Aider publishes a
reproducible benchmark; no authority-decision denominator and no separation of
approval wait from execution; no bounded provider-error class; no user-facing
cost or cache rollup; no measurement of whether an agent's edits survived.

## Source ledger

All external claims above are from first-party documentation, repositories or
source files, read on 2026-08-23:

- Anthropic — [Monitoring](https://code.claude.com/docs/en/monitoring-usage),
  [Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability),
  [Track team usage with analytics](https://code.claude.com/docs/en/analytics).
- OpenAI — Codex [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
  and [sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample)
  (the `developers.openai.com/codex/*` copies 308-redirect);
  [`codex-rs/core/src/config/otel.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/otel.rs),
  [`codex-rs/otel/src/config.rs`](https://github.com/openai/codex/blob/main/codex-rs/otel/src/config.rs),
  [`codex-rs/otel/README.md`](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md),
  [`codex-rs/otel/src/events/session_telemetry.rs` @ `f1affbac`](https://github.com/openai/codex/blob/f1affbac/codex-rs/otel/src/events/session_telemetry.rs).
- Google — [Gemini CLI observability with OpenTelemetry](https://google-gemini.github.io/gemini-cli/docs/cli/telemetry.html).
- Microsoft / GitHub — [Copilot Chat agent monitoring](https://github.com/microsoft/vscode-copilot-chat/blob/main/docs/monitoring/agent_monitoring.md),
  [Copilot Chat CONTRIBUTING.md](https://github.com/microsoft/vscode-copilot-chat/blob/main/CONTRIBUTING.md),
  [VS Code telemetry](https://code.visualstudio.com/docs/configure/telemetry),
  [Data available in Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics).
- Cursor — [Usage analytics](https://cursor.com/docs/account/teams/analytics),
  [Analytics API](https://cursor.com/docs/account/teams/analytics-api).
- Cline — [OpenTelemetry integration](https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry),
  [Cline telemetry](https://docs.cline.bot/enterprise-solutions/monitoring/telemetry).
- Roo Code — [PRIVACY.md](https://github.com/RooCodeInc/Roo-Code/blob/main/PRIVACY.md).
- Aider — [Analytics](https://aider.chat/docs/more/analytics.html),
  [benchmark harness README](https://github.com/aider-ai/aider/blob/main/benchmark/README.md).
- Zed — [Telemetry in Zed](https://zed.dev/docs/telemetry).
- Amp — [Security reference](https://ampcode.com/security),
  [Owner's manual](https://ampcode.com/manual).
- Windsurf / Cognition — [Windsurf guide for enterprise admins](https://docs.devin.ai/windsurf/plugins/guide-for-admins).
- Devin — [List sessions with insights (v3)](https://docs.devin.ai/api-reference/v3/sessions/enterprise-sessions-insights).
- OpenCode — [Config](https://opencode.ai/docs/config/),
  [Enterprise](https://opencode.ai/docs/enterprise/).

Volli-side claims are read from this worktree:
[`packages/shared/src/agent-observability.ts`](../../packages/shared/src/agent-observability.ts),
[`apps/desktop/src/main/observability/`](../../apps/desktop/src/main/observability/),
[`docs/observability-smoke.md`](../observability-smoke.md), and
[`docs/research/agent-observability-oss-options.md`](./agent-observability-oss-options.md).
