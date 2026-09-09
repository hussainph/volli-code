# Context compaction (VC-331)

## Findings

- Volli was checking automatic compaction only ahead of an idle user prompt. A single agent run could fill its context with tool traffic without checking the threshold again.
- The check used the last assistant's usage alone, ignoring incoming input and tool results not yet measured by a provider.
- Pi's compaction cut selection used characters / 4. That is particularly inaccurate for code, JSON, CJK and emoji.
- Session cost records already use provider usage, not the character heuristic. Catalog dollar estimates remain distinct from provider-reported invoice amounts. Token estimates must not be substituted into bills.

## Implementation

- Local OpenAI text counting uses `gpt-tokenizer`'s published `o200k_base` and `cl100k_base` vocabularies. Framing and image costs remain estimates; unknown model families use an explicit conservative Unicode-aware fallback. No tokenizer downloads at runtime. Normal requests also receive a model-aware output ceiling before Pi's adapter-specific budgeting.
- A request budget combines current-model provider usage (input, cached input and output) with the unmeasured suffix. System/tool definitions are included when there is no measurement. Retained replies have their **live context** usage cleared after compaction; their durable messages and bills are unchanged.
- Checks run before incoming prompts and at Pi's `prepareNextTurnWithContext` boundary after tool results settle. The hook replaces both Agent state and the loop's separate context snapshot. Queued messages count toward the next budget. Headroom is `max(16,384, 10% of the window)`; summary output still uses Pi's smaller default reserve.
- The small `pi-agent-core@0.85.0` patch adds an optional estimator parameter to `findCutPoint` and `prepareCompaction`. Pi still owns partitioning, tool-call/result grouping, previous-summary handling and file metadata. Unpatched-default callers retain upstream behavior. Retest/refit this patch on Pi upgrades.
- Overflow recovery remains one-shot, and automatic-off still allows explicit `/compact` and recovery after an actual provider context refusal.

## Provider support

| Provider route | Mechanism |
| --- | --- |
| Direct OpenAI Responses API | Stateless `/v1/responses/compact`. Persist and replay the **entire canonical output window**, including opaque encrypted state and provider-retained items. |
| Direct Claude API, documented compaction-capable models, API-key auth | `/v1/messages/count_tokens` checks the 50,000-token minimum without generating a response. Then `compact-2026-01-12`, `compact_20260112` and `pause_after_compaction: true` capture the native block. |
| Codex OAuth, Claude OAuth, gateways, Azure, Bedrock/Vertex, other APIs/models | Tokenizer-aware local Pi summarization. Wire compatibility alone is not a native-compaction capability claim. |

Native compaction replaces the older prefix; a safely grouped recent tail remains verbatim. This does not prune OpenAI's returned window. Pi cannot represent native blocks, so they live in the durable compaction entry's `details` and an `onPayload` projection substitutes them for the summary placeholder. Claude projections preserve resources/images/user text coalesced into that same wire message.

Opaque state is model-bound, not a portable text summary. Model changes and native-to-local fallback reconstruct the original durable history rather than summarizing a placeholder. Requests fail closed if a native checkpoint is malformed or missing from the outgoing payload. Native HTTP work uses existing Pi auth resolution, first-party HTTPS endpoint checks (including auth overrides), cancellation, timeout and no redirects.

Native usage uses catalog **per-million** pricing, OpenAI cached input is not double-counted, and Claude compaction iterations are added separately (the API excludes them from top-level usage). A metered failed native attempt remains part of maintenance spend when falling back.

## Validation and boundaries

Tests mock provider HTTP; no live credential or billable API smoke has been performed. Regression coverage exercises 264k Codex tool loops, unmeasured tool/input growth, Unicode, native persistence/restart/model switching, canonical-window chaining, cancellation, malformed responses, usage and fallback.

Before the next provider measurement, OpenAI checkpoint occupancy is conservatively estimated from its serialized canonical window, not its tiny text placeholder; opaque payloads have no published exact local token count.

These changes do not promise that arbitrary oversized single messages or tool results can fit a model, nor do they make unknown tokenizers or image counts exact. Pi's local fallback still uses its summary-generation mechanism. Provider catalog window metadata must be accurate; an undeclared provider-specific smaller limit can still require overflow recovery.

References read:
- https://developers.openai.com/api/docs/guides/compaction
- https://platform.claude.com/docs/en/build-with-claude/compaction
- Installed Pi 0.85.0, OpenAI 6.40.0 and Anthropic SDK 0.123.0 types (standalone compact request fields, native block shape and iteration-usage semantics).
