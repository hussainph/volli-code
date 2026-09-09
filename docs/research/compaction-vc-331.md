# Context compaction (VC-331)

## Findings

- Volli was checking automatic compaction only ahead of an idle user prompt. A single agent run could fill its context with tool traffic without checking the threshold again.
- The check used the last assistant's usage alone, ignoring incoming input and tool results not yet measured by a provider.
- The threshold read the executor's flat 16,384-token reserve on every window. That is a sensible allowance at 200k and a rounding error at 1M, where a Session has less than one dense tool result of room left when it finally trips.
- Pi's compaction cut selection used characters / 4. That is particularly inaccurate for code, JSON, CJK and emoji.
- Session cost records already use provider usage, not the character heuristic. Catalog dollar estimates remain distinct from provider-reported invoice amounts. Token estimates must not be substituted into bills.

## Implementation

- Local OpenAI text counting uses `gpt-tokenizer`'s published `o200k_base` and `cl100k_base` vocabularies. Framing and image costs remain estimates; unknown model families use an explicit conservative Unicode-aware fallback. No tokenizer downloads at runtime. Normal requests also receive a model-aware output ceiling before Pi's adapter-specific budgeting; that ceiling has a floor, so a conservative estimate can never shrink a reply to an unusable size — below the floor the provider refuses and overflow recovery answers.
- A request budget combines current-model provider usage (input, cached input and output) with the unmeasured suffix. System/tool definitions are included when there is no measurement. Retained replies have their **live context** usage cleared after compaction; their durable messages and bills are unchanged.
- Checks run before incoming prompts and at Pi's `prepareNextTurnWithContext` boundary after tool results settle. The hook replaces both Agent state and the loop's separate context snapshot. Queued messages count toward the next budget.
- Threshold headroom is `max(executor reserve, 10% of the window)`. This is derived, never configured: per-model reserve settings stay retired (VC-155) and no question is added to Settings. Pi's summary **generation** keeps the unwidened reserve, which bounds how long a summary may be — a 1M-window model has no reason to write an 80,000-token one. `CONTEXT.md` and `@volli/shared`'s compaction policy carry the same statement.
- The small `pi-agent-core@0.85.0` patch adds an optional estimator parameter to `findCutPoint` and `prepareCompaction`. Pi still owns partitioning, tool-call/result grouping, previous-summary handling and file metadata. Unpatched-default callers retain upstream behavior. Retest/refit this patch on Pi upgrades.
- Overflow recovery remains one-shot, and automatic-off still allows explicit `/compact` and recovery after an actual provider context refusal.

## Provider support

| Provider route | Mechanism |
| --- | --- |
| Direct OpenAI Responses API | Stateless `/v1/responses/compact`. Persist and replay the **entire canonical output window**, including opaque encrypted state and provider-retained items. |
| Direct Claude API, documented compaction-capable models, API-key auth | `/v1/messages/count_tokens` checks the 50,000-token minimum without generating a response. Then `compact-2026-01-12`, `compact_20260112` and `pause_after_compaction: true` capture the native block. |
| Claude OAuth, Codex OAuth, gateways, other APIs/models | Tokenizer-aware local Pi summarization. Wire compatibility alone is not a native-compaction capability claim. |
| Amazon Bedrock, Google Cloud/Vertex, Microsoft Foundry | Local summarization, and **not** because these platforms lack the feature — Anthropic documents compaction on all three. Volli cannot reach it through today's provider/auth boundaries: Pi surfaces Claude on Bedrock only as `bedrock-converse-stream` (Converse has no `context_management` field, and the raw Anthropic-bodied path needs SigV4 signing that `Models.getAuth` does not produce), Vertex only as `google-vertex` (`:rawPredict`, `anthropic_version` in the body, no `model` field, Google OAuth), and ships no Foundry catalog exposing `anthropic-messages` at all. Tracked as VC-342. |

Eligibility is decided by the **resolved** route, not the catalog entry: `getAuth` is consulted at attach and at model selection, so a Session whose credential became an OAuth subscription or an endpoint override reconstructs its original durable history instead of replaying opaque state at a backend that never minted it.

The Claude compaction request is built from Pi's exported `transformMessages` plus a faithful restatement of its `anthropic-messages` wire conversion: signed `thinking` blocks, `redacted_thinking` payloads, synthesized results for orphaned tool calls, normalized tool-call ids, string-valued text-only tool results, and image downgrade for text-only deployments. Anthropic refuses a turn whose thinking was filtered out beside a `tool_use`, and refuses a `tool_use` with no matching `tool_result`; either would take the whole compaction with it.

Native compaction replaces the older prefix; a safely grouped recent tail remains verbatim. This does not prune OpenAI's returned window. Pi cannot represent native blocks, so they live in the durable compaction entry's `details` and an `onPayload` projection substitutes them for the summary placeholder. Claude projections preserve resources/images/user text coalesced into that same wire message.

Opaque state is model-bound, not a portable text summary. Model changes and native-to-local fallback reconstruct the original durable history rather than summarizing a placeholder. Outgoing requests fail closed if a native checkpoint is malformed or missing from the payload; **attaching does not** — a checkpoint that cannot be read is dropped, the Session is rebuilt from the history the checkpoint replaced, and the sanitized reason is recorded once as a runtime context marker. A native attempt that failed while local summarization succeeded leaves its sanitized reason in the durable compaction entry.

Native HTTP work uses existing Pi auth resolution, first-party HTTPS endpoint checks (including auth overrides), cancellation, timeout, no redirects, and bounded response bodies. Each native call reports itself to the attachment's instrumentation seam, so the passive Usage Window header read and the provider-attempt envelope cover the one model call that does not go through `streamSimple`.

Native usage uses catalog **per-million** pricing, OpenAI cached input is not double-counted, and Claude compaction iterations are added separately (the API excludes them from top-level usage). A token class the provider did not report stays **null** on the Session's bill rather than becoming a zero; the zero-filled Pi `Usage` exists only where Pi's durable entry shape demands one. A metered failed native attempt remains part of maintenance spend when falling back.

## Estimates and their bounds

An OpenAI checkpoint's occupancy is estimated from its serialized canonical window rather than its short text placeholder: the ordinary items OpenAI retained are real text and are counted, and each opaque `encrypted_content` blob counts up to a ceiling and no further. Ciphertext has no published local token count and no fixed ratio to what it encodes, so an unbounded tokenization of a multi-megabyte blob is not an estimate of anything — and a budget built on one would conclude a freshly compacted Session had no room left. Small checkpoints cost what they serialize; large ones cost the cap; the provider's next reply replaces the whole estimate with a measurement.

`@volli/session-presentation`'s context breakdown deliberately keeps a heuristic rather than a tokenizer. That package is client presentation — a desktop renderer today and whatever web or mobile client comes next — and a published BPE vocabulary is megabytes of table per family. Nothing there decides anything: the measured total, the costs and the bill all come from the provider, and the module only apportions a number it was handed, normalized so the parts sum to the measured whole. The heuristic is now encoding-aware (amortized ASCII, UTF-8 bytes for everything else) because the split is normalized and understating a CJK segment silently inflated every segment beside it. A model-aware per-segment occupancy of record would be a runtime-computed fact crossing the Session boundary, not a tokenizer added to a client package.

## Validation and boundaries

Tests mock provider HTTP; no live credential or billable API smoke has been performed. Regression coverage exercises 264k Codex tool loops sized to distinguish the proportional headroom from the flat reserve, unmeasured tool/input growth, Unicode, thinking and tool-result wire shape, large opaque checkpoints, native persistence across restart with no duplicate usage record, restart under OAuth and endpoint-override credentials, unreadable-checkpoint recovery, model switching, canonical-window chaining, cancellation that depends on the supplied signal, malformed responses, usage and fallback.

These changes do not promise that arbitrary oversized single messages or tool results can fit a model, nor do they make unknown tokenizers or image counts exact. A tool result larger than the whole keep-recent budget makes compaction a no-op for that request, because Pi has no valid cut point after it; the overflow path is what answers that. Pi's local fallback still uses its summary-generation mechanism. Provider catalog window metadata must be accurate; an undeclared provider-specific smaller limit can still require overflow recovery. A credential swapped mid-Session changes checkpoint eligibility at the next attach or model selection, not mid-turn.

References read:
- https://developers.openai.com/api/docs/guides/compaction
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
- Installed Pi 0.85.0, OpenAI 6.40.0 and Anthropic SDK 0.123.0 types and adapter sources (standalone compact request fields, `transformMessages`, the `anthropic-messages` wire conversion, native block shape and iteration-usage semantics).
