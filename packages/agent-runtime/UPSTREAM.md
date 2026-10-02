# Upstream: Pi

`@volli/agent-runtime` is the product-owned boundary; the executor behind it is
Pi, consumed from npm.

- Repository: https://github.com/earendil-works/pi
- Previously `badlogic/pi-mono`, published under the `@mariozechner/*` npm scope.
  Both are stale — the current packages are `@earendil-works/*`.
- Pinned releases: `pi-agent-core`, `pi-ai` and `pi-codemode` at `1.0.0`.
  Keep these aligned on every bump.
- Node floor: `>=22.19.0`. ESM only.

## Packages consumed

Direct dependencies, pinned exactly:

- `@earendil-works/pi-agent-core` `1.0.0` — only `Agent`, the agent loop
  (including `runToolCall`) and their types. The removed harness is owned
  locally; see `src/pi/vendor/pi-harness/README.md`.
- `@earendil-works/pi-ai` `1.0.0` — model catalog, provider streams, and
  message types
- `@earendil-works/pi-codemode` `1.0.0` (VC-471) — the Code Mode sandbox: a
  QuickJS VM (WebAssembly, from its one dependency `quickjs-wasi` 3.6.2, MIT) in
  a worker per run, whose only capability is calling the tools it is handed.
  Standalone: no Pi dependency and no Pi extension API. Used through
  `CodemodeSandbox`, `loadQuickJSWasm`, `renderDeclarations`/`renderToolSample`
  and `parseCodemodeSource`; the coding agent's codemode extension (exposure,
  `tool_search`, the session store) is not. Keep it on the same release as
  `pi-agent-core`. Volli's layer over it is `src/codemode/`, and the design is
  `docs/research/code-mode-vc-471.md`.

`@earendil-works/chord` and `@earendil-works/pi-telemetry` are now direct,
exact-pinned `1.0.0` dependencies for the owned compatibility modules.
Cancellation uses chord's `Context`, `BACKGROUND_CONTEXT` and `withAbortSignal`.
Telemetry remains a no-op in this embedding: no exporter or network code is
added. `diff@8.0.4` and `typebox@1.3.27` are exact baseline dependencies of the
copied edit/tool contracts. The coding-agent TUI, client and protocol packages
remain absent. No `@earendil-works/pi-durable` dependency is introduced; VC-497
owns that investigation. Desktop's independent `pi-mcp` pin is not changed.

## Process sandbox runtime

Direct dependency, pinned exactly to `0.0.74`, used by the injectable
`ScopedExecutionEnv`:

- `@anthropic-ai/sandbox-runtime` — https://github.com/anthropic-experimental/sandbox-runtime,
  Apache-2.0, maintained macOS Seatbelt process boundary used by Claude Code.
  Its access policy is inherited by bash children rather than reimplemented in
  Volli. This is the smallest maintained Node-seam dependency that supplies the
  approved Claude Code-style boundary without building a custom sandbox.

When explicitly injected, `ScopedExecutionEnv` supplies a canonical worktree
and sanitized environment, uses SRT's policy for worktree-only writes,
user-home denial outside that worktree and no network, and fails closed when
the runtime or policy is unavailable. Its sanitized PATH retains fixed
system/global toolchain roots (`/opt/homebrew`, `/usr/local`, and system paths);
user-home toolchains and credentials are excluded.

Ordinary desktop Sessions do not inject this environment. They use
`piExecutionEnv`'s host-native file and command tools, with credential-file
safeguards and a filtered subprocess environment, not filesystem containment.
The working directory is not a sandbox. Host process-group abort, timeout and
close are best-effort lifecycle hygiene only; they do not promise cleanup of
daemonized or reparented descendants.

Upgrade checks: review SRT's exact version, license, macOS Seatbelt policy and
its inheritance by shell children; rerun outside-worktree/user-home write and
network-denial tests; verify the sanitized environment and fail-closed startup
path; and record any policy or API divergence here before bumping the pin.

## Local patches

One Pi patch remains, declared in `pnpm-workspace.yaml` and stored in
`patches/` at the repo root:

- `@earendil-works/pi-codemode@1.0.0` — rebased unchanged from 0.99.2;
  upstream still lacks `maxOutputChars` and `maxCallChars`. Host/worker bounds
  cover text, console/image output, return values, error text and serialized
  call arguments before an oversized worker message reaches Electron main.
  Defaults and failure text remain identical. `src/codemode/tool.test.ts`
  covers each bound and the host/worker path.

The deleted `pi-agent-core@0.99.2` patch is folded into owned TypeScript:

- `vendor/pi-harness/compaction/compaction.ts`: optional `estimateMessage`
  in `findCutPoint` and `prepareCompaction`; the model-aware estimator prices
  both cuts and `tokensBefore`. Omitted, upstream behavior. Covered by
  `src/pi/compaction-preparation.test.ts`.
- `vendor/pi-harness/session/jsonl/storage.ts`: V4 binary/newline-batched replay
  yields after 8 ms, preserving recovered state, UTF-8/BOM, torn-tail repair,
  and corrupt-line numbering. Covered by `src/pi/sidecar-load.test.ts` and
  retained SessionRepo conformance tests. The original write-up remains
  `docs/research/perf/pi-sidecar-rebind-yield-vc462.md`.

All paths above are under `src/pi/`. See the vendor README for npm/source-map
provenance, MIT notice, every retained module and the omitted harness paths.
Session Engine remains the durability authority; JSONL format does not change.

Dropped at the 0.85.1 bump: the `pi-ai` Claude Code identity patch
(`claudeCodeVersion`) added in `a1ce395c`, when pi-ai hardcoded a ~6-month-stale
`2.1.75` and Anthropic's version gate rejected newer models such as Fable 5.1.
Upstream now ships `2.1.251` in `dist/api/anthropic-messages.js` and we ride it
rather than pinning our own number. If a model starts failing with "You need a
newer version than …", that gate is the first place to look.

When bumping the pin, audit each patch against the new tarball before
regenerating it: diff the release against the previous one and check whether
the patched hunk moved or landed upstream. Regenerate through
`pnpm patch <pkg>@<version>` and `pnpm patch-commit`; never hand-edit
`node_modules` as the source of truth.

## Replicated Pi code

`src/pi/tool-path.ts` reproduces `normalizeToolPath` from
`dist/harness/tools/path-utils.js`: it collapses the Unicode spaces
`U+00A0`, `U+2000`–`U+200A`, `U+202F`, `U+205F` and `U+3000` to an ASCII
space and strips one leading `@`. Every Pi
file tool runs its `path` through it before opening anything, so saved-output trust marking must use the same normalization as the
read tool. This replica no longer feeds an authority gate.

Originally copied because the normalization helper was module-private. In Pi
1.0 the four tool implementations are now owned under `src/pi/vendor/pi-harness`;
the output-trust replica remains pure and separately tested.

A copy is a divergence waiting to happen, so it is not trusted on inspection:
`tool-path.test.ts` drives the retained `createWriteTool`/`createEditTool`
against a stub `ExecutionEnv` that records the string Pi passes to
`absolutePath`, and asserts the replica agrees for every transformation. Changes
to the owned normalization code must preserve this agreement.

`src/pi/tool-output.ts` restates a format, not code: the middle cut that
`pi-coding-agent` 0.99's MCP extension applies to long results (Codex's
`…N chars truncated…` marker, half the byte budget from each end, cut on a
character boundary, behind `Warning: truncated output (original token count:
N)`). The coding-agent package is not a dependency, so nothing pins the two
together; if Pi changes its format, this one stays as it is until someone
decides otherwise. What differs on purpose is where the whole text goes and how
long it lives: a directory beside the attachment's sidecar, under a per-file,
per-attachment and runtime-wide bound (oldest removed first), with lines over
16 KiB split so `read` reaches all of it, instead of an unbounded file in the OS
temp directory.

## Transcript-carried prompt and tools (0.86+)

In pi-ai 0.86, provider stream inputs moved from `Context` (`systemPrompt`,
`messages`, `tools`) to normalized `TranscriptContext`: the system prompt and
tool declarations are system messages inside `messages`. The leading system
message carries both; later system messages carry prompt additions and
`toolsAdded`/`toolsRemoved` deltas. `AgentState.systemPrompt` is now a read-only
replay, and `AgentContext` no longer has `systemPrompt`.

`src/pi/transcript-context.ts` restates pi-ai's `createInitialSystemMessage`
as `systemHead` (PI-RESTATED; `transcript-context.test.ts` pins it against the
original). The runtime must prepend this head itself: `Agent` seeds one only
when its input array does not already start with a system message, so arrays
rebuilt from the sidecar during compaction or model switches would otherwise
lose the prompt. The head is never persisted; it is recomposed per attachment.
Tool-change system messages emitted by Pi's loop through `message_end` ARE
persisted and replayed in place, and Pi reconciles them against executable tools
on the next request.

`src/pi/token-counting.ts` prices `system` messages using pi-ai's
`getSystemMessageText` rendered text, tool declarations at the per-tool rate,
and removed names. This makes a normalized transcript cost exactly what the
old `(systemPrompt, tools)` pair cost. The transcript is the ONLY spelling the
estimator accepts: `estimateContextTokens`, `projectedContextTokens` and the
projector take `(messages, model)` and nothing beside them, so there is no
parameter through which the prompt or a declaration could be handed over a
second time. A caller holding a sidecar conversation and the attachment's own
prompt and tools (compaction's `tokensBefore`) composes the head with
`systemHead` and prices `withSystemHead(head, conversation)` — the same array
the runtime sends. A whole-request estimate prices declarations once per name
over the whole transcript, through pi-ai's own `getCurrentTools` (later
declarations win, removed tools are gone) — which is what every adapter is
sent — so a persisted tool-change message that re-declares a tool the head
declares is not counted twice.

Native compaction in `src/pi/provider-compaction.ts` strips system messages from
the conversation sent to `/responses/compact` and Anthropic's compaction
request: those endpoints carry prompts in their own `instructions`/`system` and
`tools` fields.

`ToolCall.arguments` is now `JsonObject`; `ToolResultMessage.details` is
JSON-only (`JsonValue` arrays readonly). Runtime tools already produced JSON,
so only test fixtures needed retyping. `ExecutionEnv` gained
`openTextLineReader`; `ScopedExecutionEnv` returns `not_supported`, as it does
for `readTextLines`.

The optional `Model.inputLimits` and `Model.promptCache` fields (0.87) are used
only by Pi's coding-agent for image resizing and cache warming.
`model-catalog.ts`'s pi.dev-feed allowlist does not admit them, and this runtime
does not read them.

## The 0.99 bump (VC-469)

0.88 through 0.98 were never published; 0.99.0–0.99.2 followed 0.87.1. Audited
against the `pi-agent-core` and `pi-ai` changelogs and a diff of the published
tarballs:

- **Tool results.** `AgentToolResult` gained `structuredContent` (JSON for
  programmatic callers, never sent to the model) and `isError` (report a
  failure without throwing; `details` and `structuredContent` survive), and
  `AgentTool` gained `outputSchema`. Neither reaches a provider:
  `toToolDeclaration` still sends only name, description and parameters, and
  `ToolResultMessage` carries no `structuredContent`, so the sidecar and the
  token estimate are unchanged by them. `afterToolCall` drops a result's
  `structuredContent` when it replaces `content` without it. The MCP wrapper
  uses all three, and follows Codex in also showing the model the structured
  data as compact JSON unless a text block already carries it; see
  `docs/mcp.md`, "What a call returns".
- **`runToolCall`** runs one call through argument preparation, validation and
  both hooks without emitting events. Used by Code Mode for each nested call, preserving argument validation and
  the same bound host tool implementation as direct calls.
- **`thinkingLevel` on assistant messages.** The agent loop now stamps the
  requested level on every assistant message, so new sidecar entries carry it
  and entries written by 0.87.1 do not. Nothing here reads it.
- **`onProviderStreamEvent`.** An optional observer of provider events before
  normalization. Not wired: observability is metadata-only by design.
- **Model types.** Image models joined the regular `Provider`/`Models` surface
  and classifier models were added. `Model` is now the chat member of
  `AnyModel`; unqualified reads stay chat-only. `ModelsStoreEntry.models` and
  `Provider.getAllModels` hold every type, so `withRefreshableCatalog` restores
  only chat entries and answers `getAllModels` with its own chat list beside the
  base provider's other types. Nothing removed (`ImagesModels` and friends) was
  used here.
- **Anthropic workload identity federation** (`ANTHROPIC_FEDERATION_RULE_ID`
  and friends) resolves Anthropic auth from an identity-token file; the test
  setup clears those variables like the other ambient credentials.
- **Sign in with ChatGPT.** The `openai` provider gained an OAuth login that
  sends OpenAI a stable installation UUID as the agent host id, read from
  `LoginOptions.getDeviceId`, and throws before asking anything without one.
  `piSignIn` takes a `deviceId` and passes it; main mints one per installation
  (`installation-id.ts`, kept in `app_state`). `sign-in.integration.test.ts`
  runs the real flow up to the browser step, with and without it.
- **Classifier-only providers.** 0.99.2 ships `typesafe`, which lists a
  classifier and no chat model. Model Access is a chat-model page, so it leaves
  out any provider that lists models but no chat ones (a provider listing
  nothing yet, such as a dynamic one before its first refresh, stays).
  Classifier models get their own Settings slot in VC-478.
- **Transitive:** `openai` 6.40 → 7.19 (pi-ai's OpenAI adapters; this runtime
  does not import it). Notices regenerated.
- **Unchanged and re-checked:** the patched compaction and storage modules,
  `harness/tools/path-utils.js` (so the `normalizeToolPath` replica below still
  holds), the JSONL storage format (a 0.87.1 sidecar reopens unchanged;
  `pi-0.87.1-reattach.test.ts` pins that with a real one).

The 0.99.2 built-in model catalog was generated 2026-09-30 and lists 42
providers (adding `typesafe`, which serves only classifier models).

## The 1.0 bump (VC-496)

Audited all entries after 0.99.2 in the release-tag changelogs for
[agent](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md),
[AI](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md), and
[codemode](https://github.com/earendil-works/pi/blob/v1.0.0/packages/codemode/CHANGELOG.md):

- **Core breaking removal:** `./node`, `./harness/*`, and `./experimental/pico3`
  are gone. All production/test imports now use the root for Agent/loop types,
  chord for cancellation, or the three owned harness facades. Harness events
  were only used to name compaction reasons; these are now a local union of
  the unchanged reasons. `runToolCall`, `AgentContext` and `AgentLoopConfig`
  survive. `convertToLlm` does not: its existing transcript conversion is
  retained locally. Removed orchestration, skills, prompt loader, search,
  telemetry schemas and pico3 were never used and are not copied. The three
  pure prompt grammar functions are a frozen, test-only oracle, not a product
  dependency on deleted exports.
- **AI:** no breaking changes in this interval. Anthropic OAuth gains a
  copy-code choice through the existing login prompt bridge; OAuth browser
  pages change their logo. OpenAI Responses now drops an incompatible `fc_`
  item ID when replaying grammar calls as `custom_tool_call` (which requires
  `ctc_`). `src/pi/pi-1.0-compat.test.ts` exercises same-provider and gateway
  replay, including the corresponding output. No transcript rewrite is needed.
- **Codemode:** new `renderToolOutputType()` is additive; Volli's existing
  declaration renderer stays. Reading a missing tool/global member now throws
  a diagnostic rather than returning `undefined`; supported membership tests
  use `"name" in tools`. Static tool names still fail Volli's admission check
  before execution; computed reads reach the new diagnostic, cannot call a
  tool, and are covered by `src/codemode/tool.test.ts`. The store-size message
  is clearer; limits/host authority are unchanged.
- **Unreleased is not 1.0.0:** upstream main's "Selected model is at capacity"
  retry fix is under `[Unreleased]`, and the published 1.0.0 classifier does
  not contain it. This migration does not claim that fix shipped or silently
  substitute a main-branch build for the exact release pin. The unreleased
  inline-Anthropic-tool beta change is likewise not taken.

## Credentials

Pi owns provider credentials and refresh behavior. `@earendil-works/pi-ai`
ships only `InMemoryCredentialStore` and states that "Apps inject persistent
stores", so `builtinModels()` on its own reports every provider as
unconfigured however a person is logged in.

The persistent store upstream — `AuthStorage` in
`packages/coding-agent/src/core/auth-storage.ts` — is **not exported**: the
published `@earendil-works/pi-coding-agent` `exports` map is `.`,
`./rpc-entry` and `./client`, and the barrel re-exports only
`readStoredCredential`. Depending on that package would also drag in the
coding-agent TUI this boundary deliberately excludes. So `src/pi/models.ts`
implements the `CredentialStore` seam against Pi's own file instead, and
matches Pi's conventions rather than inventing any:

- Path: `$PI_CODING_AGENT_DIR` (leading `~` expanded), else `~/.pi/agent`,
  then `auth.json` — Pi's `getAgentDir()`/`getAuthPath()`.
- Format: `{ "<providerId>": Credential }`, `JSON.stringify(…, null, 2)`.
- Mode: `0600`.
- Lock: Pi 0.84.1's `FileAuthStorageBackend` creates the parent and an empty
  `0600` file first, then locks `auth.json` itself with `proper-lockfile`
  (`realpath: false`, `stale: 30_000`, retrying `ELOCKED` for up to 30 seconds)
  across every async read-modify-write. This store follows that protocol for
  `modify` and `delete`, while retaining its atomic temp-file rename.

Refresh is still Pi's: `Models.getAuth()` runs the OAuth exchange inside
`CredentialStore.modify()`, so a rotated token is written back through this
store by Pi. Nothing here parses, mints, or refreshes a token.

Divergence worth knowing: Pi writes in place while this store writes a `0600`
temporary file and atomically renames it over `auth.json`. Both sides use the
same advisory lock, so each mutation re-reads a settled map and preserves
providers that were updated by the other process.

## Divergence policy

Exact pin, no ranges. Version bumps are deliberate and recorded in the commit
that makes them, together with the tag and commit hash above. Forking or
vendoring Pi requires a concrete, documented need.

## Injectable workspace boundary

`ScopedExecutionEnv` loads the retained `read`, `edit` and `write` tools as
guarded host-native operations, and adds Bash only after the pinned SRT
boundary preflights. SRT protects Bash and its subprocesses, not the native
file tools. Those tools retain Volli's resolved-path/component checks and
direct-symlink guard. Direct-symlink rejection tests compensate for, but do not
eliminate, the accepted TOCTOU limit: an external process with write access to
the worktree could replace a validated component with a symlink before the
delegated filesystem operation opens it. Descriptor-relative `O_NOFOLLOW`
operations are deferred hardening. This optional boundary is not the default
desktop execution path.

## License

Pi is MIT licensed.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
