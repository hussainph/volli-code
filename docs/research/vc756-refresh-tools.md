# VC-756: additions-only Session tool refresh

## Before changing storage

Measured on `795aec3f9` (0.2.2-canary.3).

- `session.input.recorded` with `input.kind = tool-surface` stores ordered tool IDs, sanitized MCP definitions, `mcpManagementNames`, `askUserQuestions`, and Code Mode routes, limits, mode, nudge and description version. It does **not** store arbitrary built-in tool JSON schemas or descriptions.
- `SessionEngine.getOrRecordSessionInput` runs a ledger transaction and returns the first record with the same input kind. The birth surface is append-once, not a mutable database column.
- `assembly.recordedToolSurface` / `recordedMcpTools` and `context.ts` read that first record. The context resolver backfills only pre-VC-164 Sessions, without new grants or Code Mode. The Pi adapter reconstructs executable bindings from these recorded names and asserts their ordered IDs match the recorded surface.
- `agent-tool-surface.ts` resolves capability membership, Role verbs and birth grants in canonical vocabulary order. Subagents are bounded by their parent's recorded capabilities and inherit its MCP definitions; their own Role excludes orchestration verbs.
- `fixtures/main-surface-baseline.ts` is a frozen, historical birth-membership oracle over 336 combinations. Refresh must not rewrite that historical evidence or change birth membership merely to manufacture a refresh.
- `decodeSessionToolIds` rejects unknown built-in names **inside the known birth event**, causing every Session read to fail. Unknown **outer event kinds** instead raise `UnknownSessionEventKindError` and are skipped by the ledger reader. Therefore refresh must use a new outer event kind, never rewrite or append a second known birth input containing new names.

## Design

Keep the birth event intact. Record additions under a new outer event kind, with trigger, added/changed names and a host-only delta: definitions for exactly the added MCP names, new route entries, first-acquisition Code Mode declaration, and supported version/marker flips. Retained MCP definitions are never copied into later refresh events or edited. Current builds replay the latest bindable effective surface and, separately, the last cold declaration epoch. Warm additions never publish declarations on reattach. Pre-feature builds skip the new fact and retain the birth surface. Readers with this feature preserve future refresh notices but bind the last compatible epoch when a future builtin is unknown. No migration is needed. New births and compatible cold refreshes carry a host-only `refreshDescriptions: true` marker; without it, the original built-in wording is reconstructed verbatim.

### Measurements

The historical baseline has 48 distinct surfaces over 336 combinations, with 3–37 IDs. No checked-in regeneration script exists; its provenance is the reference-only a1 scratch verifier. Birth membership remains unchanged, so preserve that oracle and test refresh separately.

Real tool-builder measurements (all capability ports, no MCP, Code Mode `both`, flat ask_user held fixed; local o200k tokenizer, not billed provider tokens):

| Role | IDs/declarations | Tool JSON bytes | Tokens |
| --- | ---: | ---: | ---: |
| Project | 37 | 47,665 | 10,647 |
| Ticket | 25 | 30,950 | 7,012 |
| Subagent | 20 | 20,512 | 4,634 |

Legacy Code Mode → image-capable wording adds 658 description bytes / 149 tokens, or 679 serialized-array bytes / 166 tokens. Refresh purchases the affected prefix and following context, not just this delta. Recorded membership/configuration occupies approximately 932–1,529 bytes before event envelope/MCP definitions. A real scripted Pi request upgrading legacy Code Mode and adding `todo_write` estimated its leading provider message at 2,405 → 2,998 tokens (+593); the warm prefix delta was zero bytes. These are local context estimates, not billed usage.

Four actual shipped decoders were probed from git objects: stable `f6ec540c`, canary.1 `5ef341e6`, canary.2 `6aba3ce9`, canary.3 `795aec3f`. All decode known births, reject an unknown built-in or inner input kind with a plain Error, and classify a new outer refresh kind as skippable. These initial probes used current external dependencies. Local prepared shipped-lockfile open/attach/replay tests subsequently passed for all four tags, and the behavioral future-builtin test also passed against the feature reader. The normal release/latest-canary/base CI lanes remain the merge gate.

### Cache rule and triggers

No provider exposes a reliable expiry observation. The runtime uses the longest configured/provider-supported retention rather than asserting that a cache hit occurred: Anthropic Messages waits one hour; other providers currently use a conservative 24-hour window. Recovery reads the last durable Pi activity rather than treating every reattach as cold. Compaction and actual model/reasoning-pair switches are explicit paid boundaries. Re-selecting the unchanged pair uses the ordinary TTL rule, not permission to rewrite a warm declaration. Code Mode checks immediately before each new program, which makes a preceding server_install visible without another user turn. Warm checks preserve provider declarations and append namespace/count discovery messages keyed by their durable refresh event IDs. The receipt travels on the Pi sidecar message itself; attach replays missing receipts, including a crash between ledger commit and sidecar append. Ambiguous append failures reread receipts before retrying. MCP announcements append `MCP_UNTRUSTED_DATA_WARNING`; no prefix bytes change.

Per-program checks use an attachment-lifetime desired-context memo, invalidated by project MCP catalog/selection revisions, web-setting/key revisions, the bounded Code Mode policy fingerprint, classify availability, the requested model and the parent's indexed event high-water mark. Unchanged root checks read no Session history and enter no refresh write transaction. Cold/warm-turn, compaction and model-switch checks still fully re-evaluate. Identical desired context/spec references avoid rebinding or serializing large schemas, but only a successful runtime adoption/announcement is memoized; failures remain retryable. Release drains outstanding refresh work, refuses late port adoption and drops the memo before cleanup.

### Review-round benchmark

`assembly.test.ts` contains the reproducible fixture: 10,000 historical events and 100 MCP definitions. It drives the production assembly callback; `warm-turn` bypasses the gate but uses the identical warm-addition policy, representing the previous full-check path. The steady `code-mode` path asserts zero history reads and zero `recordToolRefresh` calls, then verifies revision invalidation. Measurements exclude fixture setup and providers, include async callback overhead, and are local wall-clock observations rather than CI timing requirements.

The post-main-merge uninstrumented run measured full-check p50/p95 **250.50/264.92 ms** (10 samples), versus steady revision-hit **0.00196/0.00292 ms** (100 samples). A marker-only refresh on the same catalog serialized to **128 bytes**, versus **808,406 bytes** for the former full-surface payload (payload only; identical event envelope excluded). This is the no-additions case; a delta that adds an MCP definition necessarily stores that new definition once.

Exact verification results are recorded in the PR.

## Decisions to confirm

- Preserve every existing route and wire spelling; a cold refresh adds capabilities without changing a tool from direct to Code Mode or vice versa. A model switch is not permission to remove a named tool.
- Retain a removed upstream MCP definition. Calling a removed/unavailable server should return its named unavailable error, not make the whole Session unattachable.
- Keep older ask_user declarations flat: the current questions schema does not accept every old input, so it is not a compatible refresh. Newly added ask_user tools and new births get questions. Existing MCP schemas/descriptions, wire spelling, limits and routes are retained verbatim, including when upstream changes them.
- Keep the historical surface baseline unchanged: membership at new birth is unchanged; the original reference-only generator is not installed.
- Version only compatible wording for `server_install`, `server_enable`, `server_disable`, `server_tools`, `server_remove` and `session_delegate`, without changing their inputs or wire spellings. Legacy Code Mode's `descriptionVersion: 2` upgrade adds image results while preserving valid programs. Arbitrary upstream MCP schema changes remain deferred, even at a cold boundary.
- Providers without explicit expiry evidence use the conservative 24-hour eligibility window; this is not a claim that the provider actually cached or evicted the prompt.
