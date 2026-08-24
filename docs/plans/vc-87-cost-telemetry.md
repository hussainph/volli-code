# VC-87 — cost telemetry scope and delivery plan

Validated against `origin/main` at `8e8a17c0` after VC-164 and VC-119 merged.

## Status

**Slice A shipped. Slice B shipped except the legacy backfill. Slices C and D
not started**, by explicit scope decision: the owner's call was to land the
ledger and its read model first, and to hold the agent-facing read surface back
rather than put spend routing in an agent's hands before a person has looked at
the numbers.

What exists now:

| Piece | Where |
| --- | --- |
| `SessionUsage`, `CostBasis`, `summarizeSessionUsage` | `packages/shared/src/session-usage.ts` |
| `reportSessionUsage`, scopes and groupings | `packages/shared/src/session-usage-report.ts` |
| `usage.recorded` payload, codec, scrub | `packages/shared/src/session-{ledger,event-codec}.ts` |
| `SessionProjection.usage` | `projectSession` |
| Capture at `message_end`, compaction, utility | `packages/agent-runtime/src/pi/{runtime,compaction,transcript}.ts` |
| `usage` observation, marker, translation | `@volli/shared`, `packages/session-engine/src/observation-translation.ts` |
| `session_usage` table and indexes | migration 025 |
| Projection write, indexed read, rebuild | `apps/desktop/src/main/session-control/sqlite-ledger.ts` |
| `SessionEngine.reportUsage` | `packages/session-engine/src/session-engine.ts` |

Three decisions were taken during implementation and are recorded below where
they change what the rest of the plan should do:

1. **Cost basis is derived from Pi's API family**, keyed by `KnownApi` so a Pi
   upgrade that adds an adapter fails to compile. All nine direct adapters are
   `catalog-estimate`; `pi-messages` is `provider-reported`; anything else is
   `unavailable`. See `costBasisForApi`.
2. **Attribution is copied at write time, not joined at read time.**
   `sessions.ticket_id` is `ON DELETE SET NULL`, so a live join would move a
   deleted Ticket's whole bill into unticketed Project spend.
3. **The plan's `source: "runtime" | "legacy-transcript"` field was not added.**
   Nothing writes a legacy row yet, and `SessionEventProvenance` already
   distinguishes who wrote a fact. The backfill slice should decide whether
   provenance is enough or whether the projection needs its own column —
   see the open question below.

### Still open, in the order it matters

- **Legacy transcript backfill.** Deliberately deferred rather than rushed. It
  has a real design question the rest of the work did not: a settled transcript
  artifact carries `providerId`, `modelId`, `cost` and token counts, but **no
  API family** — so a backfilled row cannot derive its own cost basis. The
  conservative answer is `unavailable` with the cost preserved, which reads as
  "a real number whose kind we cannot vouch for" and is true. Confirm that
  before writing rows, because they are immutable once written.
- **Partial historical coverage** needs somewhere to live once backfill exists.
  Tool-use-only, failed, compaction and utility spend was never recoverable
  from transcript artifacts, so a backfilled Session's total is a floor.
- **Slice C (`volli cost`, `session list` columns)** and **Slice D (app
  surfaces)** are unchanged by the above; both consume `reportUsage`.

---

## Decision summary

VC-87 is feasible, but the original premise is only partly true: some usage data is already durable, while a meaningful share of model spend is not. The work must start at the Agent Runtime boundary, not in the CLI or renderer.

Ship three distinct facts without blending them:

1. **Volli Session usage** — model requests attributable to a Volli Session. Immediate and local. This is VC-87.
2. **Provider account spend** — an optional, separately authorized provider or gateway snapshot with an `asOf`. This is a follow-up capability, not a dependency of VC-87.
3. **Budget policy** — a cap and its watchdog. This remains with VC-44/VC-85, not telemetry.

Within VC-87, use immutable usage facts as the source and a rebuildable SQLite projection for reads. Do not scan transcript files for every `session list`, `cost`, or renderer query.

The first UI should be a compact Usage trigger in the trailing side of the app Chrome. It opens a card; the card itself should not permanently occupy the 36px drag band. Per-Session and per-Ticket summaries belong in the existing right-rail `Now` pages, with a compact running-cost read beside the existing context meter when there is room.

## What the current code actually records

| Path | Durable Session usage today? | Consequence |
| --- | --- | --- |
| Successful assistant message with text or reasoning | Yes, inside transcript artifact `UIMessage.metadata` | Input, output, cache-read, cache-write, model, and `cost` can be recovered. |
| Tool-use-only assistant response | No | `classifyAssistantMessage` returns `ignored`; this can be a large part of an agentic turn. |
| Failed or aborted assistant response | No | The sidecar keeps the Pi message, but no settled transcript artifact is emitted. |
| Context Compaction | Not in the Session ledger | Pi's `CompactionEntry` carries aggregate usage, but `context.compacted` drops it. |
| Auto-title utility completion | No | `completeUtility` returns only text and explicitly creates no ledger entry. |
| Manual terminal companion (Claude Code, Codex, shell, etc.) | No reliable model usage | Volli does not mediate those provider requests. Show unavailable, never zero. |
| VC-119 OpenTelemetry side channel | Not a product source | It is opt-in, best-effort, bounded/droppable, and correlated by opaque `runId` rather than Session/Ticket identity. |

Relevant seams:

- `packages/agent-runtime/src/pi/transcript.ts`
- `packages/shared/src/agent-runtime.ts`
- `packages/session-engine/src/observation-translation.ts`
- `packages/session-engine/src/session-runtime.ts`
- `packages/shared/src/session-ledger.ts`
- `apps/desktop/src/main/session-control/sqlite-ledger.ts`
- `apps/desktop/src/main/session-runtime/transcript-artifacts.ts`

### Cost is not yet a bill

At the pinned Pi version, most built-in adapters calculate `usage.cost.total` by multiplying provider token counts by the model catalog's prices. The generic `pi-messages` protocol can instead carry backend-supplied usage. Volli currently drops that provenance and exposes only `costUsd`.

Add a tested API-family-to-basis mapping at the Pi adapter. Known catalog-priced adapters emit `catalog-estimate`; a protocol that explicitly carries backend usage may emit `provider-reported`; an unknown/custom API defaults to `unavailable`, never a guessed basis. A Pi upgrade must update the mapping test when an adapter's behavior changes.

Therefore the product must not label the local total as “provider spend.” It is **Estimated cost** unless its row explicitly carries a reported basis. Subscription-backed models are the strongest example: Pi can calculate their list-price value even when the person's marginal invoice is not that amount.

### VC-164 is a predictor, not the meter

VC-164 added Cache Classes to `prompt baseline` and stabilized the Cache Prefix. Cache Class predicts how often bytes should be reused. VC-87 must report what the provider actually returned:

- uncached input tokens;
- cache-read input tokens;
- cache-write input tokens; and
- output tokens.

Use **cached input share** for the UI, defined as:

```text
cacheRead / (input + cacheRead + cacheWrite)
```

Do not call it a request “cache hit rate”; providers report token categories, not one universal hit/miss bit.

## Scope ruling

### In VC-87

- Capture every attributable Agent Runtime model operation, including tool-use-only, failed/aborted responses when usage exists, Context Compaction, and auto-title utility work.
- Preserve provider/model, event time, Session/Ticket/Project attribution, token categories, cost, cost basis, and operation cause.
- Add an immutable `usage.recorded` Session fact.
- Maintain a rebuildable, indexed usage projection.
- Backfill the settled transcript usage already on disk, while marking historical coverage as partial.
- Add a read-tier `volli cost` query and token/cost fields on `volli session list`.
- Expose the same query through the host-neutral Session interface and Session RPC.
- Add local usage surfaces: app-Chrome overview, Ticket/Session right-rail summaries, and a compact running Session read.
- Keep missing and partial data visible as missing/partial.

### Explicitly out of VC-87

- Provider Admin/Billing API connectors.
- Reusing inference/OAuth credentials for account billing reads.
- Scraping provider dashboards or undocumented subscription endpoints.
- Setting or enforcing a budget cap.
- A watch loop for budget events.
- Cost attribution for manual terminal companions that do not report usage to Volli.
- A full analytics/dashboard product before the compact card proves the need.

### “Pass” is not a first-class product identity yet

`Pass` is not in Volli's domain model or ledger. Until Runs/Automations are implemented, “what did this pass cost?” means a composable query over a time window and optional Ticket/Session filters. Do not add a `pass_id` invented only for this report.

## Truth model

### Immutable usage record

Add a product-owned shape in `@volli/shared`, approximately:

```ts
type CostBasis = "provider-reported" | "catalog-estimate" | "unavailable";

type UsageCause = "assistant" | "compaction" | "utility.auto-title";

interface SessionUsageRecord {
  id: string;
  sessionId: string;
  attachmentId: string | null;
  occurredAt: number;
  cause: UsageCause;
  providerId: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  costBasis: CostBasis;
  source: "runtime" | "legacy-transcript";
}
```

Final names can move, but these invariants cannot:

- Token categories are separate and non-overlapping under the Pi usage contract.
- Missing is `null`/absent, never `0`.
- Cost is captured at request time; historical values are never re-priced from today's catalog.
- Every record has a stable id so recovery/replay cannot double-count it.
- Provider and model ids are stored; display labels are resolved at read time.
- Usage is metadata-only and contains no prompt, response, path, credential, account identity, or provider error prose.

### Session Event

Add `usage.recorded` to `SessionEventPayload` and its codec/scrub tables. It is a Session Semantic Fact, not an observability export.

Capture regular Agent calls from the ordered `message_end` path in `packages/agent-runtime/src/pi/runtime.ts`, before transcript classification. That path sees text replies, tool-use-only replies, and failed/aborted replies, and it can persist a recovery marker before the Session Engine commits the fact.

For Context Compaction, carry the sanitized `CompactionEntry.usage` through the existing compaction observation. Pi may make more than one summarization request; its compaction result already provides the aggregate.

For auto-title, change `completeUtility` to return text plus sanitized usage. The auto-titler already owns the target Session id, so it can append one system-provenance usage fact without creating a fake attachment or transcript row.

Do not derive the durable path from VC-119's `ProviderAttemptEvent`. The two paths may share pure sanitization helpers and parity tests, but the OpenTelemetry sink must remain optional and droppable while product usage must be durable and attributable.

### Session projection

Fold a small `usage` summary into `SessionProjection` and `SessionPresentationProjection`:

```ts
interface SessionUsageSummary {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  knownCostUsd: number | null;
  costCoverage: "complete" | "partial" | "unavailable";
  costBasis: "provider-reported" | "catalog-estimate" | "mixed" | "unavailable";
  cachedInputShare: number | null;
}
```

This makes the live Session read cheap and lets the existing Session stream update the renderer without polling.

A usage fact should not move `lastActivityAt`: telemetry being backfilled or reprojected is not new agent work.

### SQLite projection

Add one projection row per usage event, not one mutable aggregate blob. Suggested columns:

```text
usage_event_id (primary key)
session_id / project_id / ticket_id
occurred_at
cause
provider_id / model_id
input_tokens / output_tokens / cache_read_tokens / cache_write_tokens
cost_usd / cost_basis / source
```

Maintain it in the same SQLite transaction that appends `usage.recorded`. Index:

- `(project_id, occurred_at)`
- `(ticket_id, occurred_at)`
- `(session_id, occurred_at)`
- `(provider_id, model_id, occurred_at)`

The projection is a fact index. Ticket, Session, model, and time rollups remain query-time aggregation over indexed rows.

Expose one deep query interface from the Session Engine. Use a tagged scope (`all`, `project`, `ticket`, or `session`) rather than several optional ids whose combinations callers must interpret. Return completeness counts with every aggregate:

```text
requestCount
sessionCount
pricedRequestCount
tokenRequestCount
historicalCoverage: complete | partial
```

A mixed report must render `$1.23 known` or `$1.23+`, not an exact-looking `$1.23`. All-unpriced must render `—`, not `$0.00`.

### Historical backfill

The Ticket's original premise should pay off for existing Sessions:

1. After the schema migration, run an idempotent app-owned repair.
2. Read prior `transcript.referenced` events and their content-addressed artifacts.
3. Convert assistant metadata into deterministic `usage.recorded` events with `source: legacy-transcript`.
4. Use an id derived from the original Session/event identity so reruns dedupe.
5. Record the point from which complete capture began.

Historical coverage remains partial: tool-use-only, failed/aborted, compaction, and auto-title usage was not all recoverable from transcript artifacts. The UI must be able to say “Earlier usage may be incomplete.”

## Read-tier CLI

### `volli cost`

Add a `cost` entry to the Verb Registry with `accessModes: ["cli"]`, `actor: "any"`, and `group: "Read"`. It remains a shell read, not an always-loaded Agent Tool.

Proposed v1:

```text
volli cost
volli cost --ticket VC-87
volli cost --session 3622a893
volli cost --model anthropic/claude-opus-4-1
volli cost --since 2026-08-01T00:00:00Z --until 2026-09-01T00:00:00Z
volli cost --group-by ticket|session|model|day
volli cost --json
```

One group dimension per invocation is enough for v1; filters compose, and JSON callers can join reports. Do not build an arbitrary SQL cube into the first interface.

Plain output should right-align tabular figures and keep all token classes visible:

```text
MODEL                         REQUESTS  INPUT  CACHE READ  CACHE WRITE  OUTPUT  EST. COST
anthropic/claude-opus-4-1           18   92k       1.24M          41k     22k      ~$8.42
openai/gpt-5.3-codex                 7   18k        420k          12k      9k      ~$1.76
```

JSON returns ids, raw numbers, bases, and coverage; text may format them.

Time buckets should be UTC in the CLI. The renderer may localize labels without changing the underlying interval.

### `volli session list`

Add a structured `usage` object to every row. Plain output adds compact token/cost columns:

- `1.4M tok`
- `~$4.18` for catalog estimates
- `$4.18` only for reported request costs
- `—` when unavailable
- `+$4.18`/`$4.18 known` when partial

Manual terminal companions remain in the list with unavailable usage. The CLI must not imply that their zero is known.

The current handler has separate terminal and structured-chat paths. Join both against one Session usage summary keyed by Session id; do not scan transcript artifacts in the handler.

## Product surfaces

### 1. App Chrome — global overview trigger and card

**Recommendation: yes to the location, no to a permanently mounted large card.**

`ChromeBar` is a 36px drag band with a centered 380px search trigger and an intentionally empty trailing slot. Add a small `app-region-no-drag` Usage trigger on the right. Hide it in terminal-focus mode, where the band deliberately contains only the Session breadcrumb and exit control.

The trigger can show the rolling estimated cost (`~$12.48`) with a chart icon. Clicking it opens a `Popover`/`shadow-overlay` card around 360–400px wide.

Suggested hierarchy:

```text
Usage                                      Last 30 days

~$12.48
Estimated cost · 47/49 requests priced

38 Sessions run       24 metered
4.6M tokens            78% cached input

Most used models
Claude Opus 4.1       12 Sessions        ~$8.10
GPT-5.3 Codex          9 Sessions        ~$3.42
Gemini 3 Pro           5 Sessions        ~$0.96

All projects · Earlier usage may be incomplete
```

Design notes:

- Say **Most used models**, not “favorite models.” Rank by distinct metered Sessions in v1 (request count breaks ties) and show cost beside it.
- `Sessions run` counts every durable Session; `metered` counts Sessions with at least one usage fact. Keeping both prevents manual terminal companions from disappearing into the cost total.
- Scope and window are always visible. Default to `All projects · Last 30 days`; offer 7d/30d/All and current-project filtering inside the card.
- Use tabular figures, semantic tokens, one border, and the existing overlay shadow. No bespoke gradient or hard-coded provider colors.
- The hero cost is prefixed with `~` whenever any catalog estimate contributes.
- A card with no metered calls says “No metered model calls yet,” not `$0.00`.
- Do not combine provider account balances into this number later. Add a visibly separate account section with its own `asOf`.

### 2. Session surface — running cost

The existing composer footer already has a Context Usage pill sourced from the latest metered reply. Add a compact peer for cumulative Session cost only after the projection exists. Its popover shows:

- estimated/reported cost and basis;
- uncached input, cache reads, cache writes, and output;
- cached input share; and
- model breakdown when the Session switched models.

Keep the existing context-window meter separate: occupancy answers “will this Session fit?”, cumulative usage answers “what has this Session consumed?”

### 3. Home right rail — active Project Session

`HomeRail` → `Now` already has Venue and Session blocks. Add a Usage block under Session for the active chat:

- Cost
- Tokens
- Cached input

For a Board/file/terminal tab, show no fabricated Session usage block. A manual terminal may show “Usage unavailable” only if the user explicitly opens its details; silence is better in the default rail.

### 4. Ticket right rail — cost per Ticket

`TicketRail` → `Now` is the correct place for the owner question “what did this Ticket cost?” Add a Ticket Usage card between Properties and Sessions:

- aggregate estimated cost;
- token total and cached input share;
- metered Session count;
- top model.

Selecting/opening a chat exposes its per-Session details in the composer or active-session subview. Do not add a second trailing figure to every narrow Session roster row: current status/attention and historical age are higher-priority navigation facts, and those rows were deliberately reduced to one line.

### 5. Home/Ticket Session lists

Carry `usage` on `SessionListingRow` so every list reads the same data, but render compactly:

- Home Sessions may use `~$0.24 · 2h` in its trailing text.
- Ticket History may include cost in a tooltip/details popover rather than displacing age.
- Active rows keep Working/Waiting/Idle visible.

This preserves the current calm roster while making cost inspectable.

### 6. Settings → Models — provider account telemetry later

Provider account connectors belong beside provider Accounts in Settings → Models, not in Settings → Telemetry. The existing Telemetry category configures developer OTLP export; turning it into a billing report would merge two unrelated user tasks.

A future provider row may show a separately authorized account snapshot, its scope, `asOf`, staleness, and enforcement kind. Unsupported providers show `Account usage unavailable` with a provider-owned link. Local Session estimates remain separate.

### Rejected placements

- **Every Board card:** visually noisy, weak for in-progress work, and duplicates the Ticket rail.
- **Every sidebar Session row:** the rows already spend their narrow second line on identity, attention, and recency.
- **A permanent large object in the Chrome band:** breaks the drag region and competes with global search.
- **Settings → Telemetry:** that surface is export configuration, not a user usage report.

## Delivery sequence

This is too wide for one undifferentiated implementation pass. Land it as dependent slices (or split them into child tickets before coding).

### Slice A — capture contract and immutable facts

Files centered in `@volli/shared`, `@volli/agent-runtime`, and `@volli/session-engine`.

- Define usage, cost-basis, cause, aggregate, and coverage vocabulary.
- Capture every Agent `message_end` before transcript classification.
- Carry compaction usage.
- Return and attribute utility-completion usage.
- Add `usage.recorded`, codec/scrub coverage, recovery markers, and projection fold.
- Prove reattach/reconcile idempotence.

**Exit proof:** a scripted Session with a tool-use response, a final text response, a failed response, a compaction, and an auto-title produces exactly one usage record per model operation and survives reattach without increasing its total.

### Slice B — durable projection, rebuild, and query interface

Files centered in the Session Engine ledger ports and desktop SQLite adapter.

- Add projection migration/table/indexes.
- Project inside the event append transaction.
- Add the tagged usage query and aggregate/coverage semantics.
- Add idempotent legacy transcript backfill.
- Add a projection rebuild parity test.

**Exit proof:** rebuilding from immutable usage facts yields byte-equivalent query results; `session list` and a 30-day model rollup perform no transcript artifact reads.

### Slice C — CLI read surface

Files centered in the Verb Registry, CLI parser/help/render, and `agent-commands.ts`.

- Add `volli cost` and its JSON/text contracts.
- Add usage fields/columns to `session list`.
- Cover context resolution, Ticket/Session/model filters, UTC windows, partial/unavailable values, and shell-safe output.

**Exit proof:** `volli cost --ticket VC-87 --group-by model --json` returns raw token categories, bases, and coverage; plain text never prints missing cost as zero.

### Slice D — app query and local surfaces

Files centered in Session RPC, renderer stores, ChromeBar, rails, and chat usage components.

- Add host-neutral usage query/subscription procedures; no raw one-off IPC.
- Add one event-driven renderer store. No polling.
- Prototype the Chrome card in the UI lab before wiring it to production.
- Ship Chrome overview, Ticket aggregate, active Session summary, and running-cost popover.
- Test narrow width, long model names, light/dark themes, reduced motion, no data, partial data, and unavailable cost.

**Exit proof:** a live Session's successful reply updates its running cost, Ticket card, and Chrome card once without reopening the surface or polling.

### Follow-up — provider account meters

Create separate connector tickets by provider/gateway. Start with read-only, opt-in Anthropic API, OpenAI API, and configured gateways. Each connector owns its authorization, scope, cache/staleness, and source link. Do not block Slices A–D on these.

## Required tests and failure cases

- Successful text response is counted once.
- Tool-use-only response is counted once.
- Failed and aborted response with usage is counted once.
- Context Compaction aggregate is counted once.
- Auto-title is attributed to its Session with `utility.auto-title`.
- Model switch splits model groups while preserving the Session total.
- Cache read/write/input/output remain separate.
- Zero cost is distinguishable from unavailable cost.
- A mixed priced/unpriced report is partial.
- A catalog estimate never renders as provider account spend.
- Manual terminal companion renders unavailable.
- Recovery marker replay and Session reattach do not duplicate usage.
- Projection rebuild matches the live projection.
- Legacy transcript backfill is idempotent and marks partial historical coverage.
- Ticket deletion does not silently turn old Ticket usage into Project Session usage.
- Chrome/rail subscriptions stop cleanly and never poll.

## Open choices that can wait until their slice

- Exact compact formatter thresholds for CLI/UI.
- Whether the Chrome trigger shows cost or a neutral chart icon when the report is partial.
- Whether a full Usage destination is justified after the card ships.
- Which provider account connector ships first.

The architecture and scope decisions above should not wait: local usage is a durable Session fact; its read model is a rebuildable projection; provider account spend and budget policy remain separate planes.
