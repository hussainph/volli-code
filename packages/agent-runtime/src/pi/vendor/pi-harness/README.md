# Owned Pi harness compatibility (VC-496)

Pi 1.0 removed the experimental harness from `@earendil-works/pi-agent-core`.
Volli retains only the pieces used by its existing executor and compatibility
tests. **Session Engine remains the durability authority**; these modules are
private executor sidecar machinery, not a second Session engine. There is no
`pi-durable` dependency, durable harness reducer, or new resume policy.

## Provenance and license

- Upstream: https://github.com/earendil-works/pi/tree/v0.99.2/packages/agent/src/harness
- Version: `@earendil-works/pi-agent-core@0.99.2`.
- npm `gitHead`: `005af57d88ee23b33778f343a9595b32e67ff788`.
- Source: `sourcesContent` from the published package's `dist/harness/**/*.js.map`.
  Those maps contain the original TypeScript; no decompilation or behavior rewrite
  was needed. The maps describe **unpatched** sources, so both local core patches
  were then applied explicitly in TypeScript as described below.
- Published tarball integrity:
  `sha512-VX0QMcg8HKBsv1bYP2NwmutBYa44OrwmtqR6Dq7QC3Ln8X/IlpHhUxB5L1JgnXNUUkTm8Wg/HZhzS797NBDMCQ==`.
- MIT, copyright (c) 2025 Mario Zechner. Full text is
  `packages/agent-runtime/notices/pi-harness.LICENSE.txt`, copied from
  https://raw.githubusercontent.com/earendil-works/pi/v0.99.2/LICENSE.
  `package.json`'s `volli.notices` enumerates the copied files and includes this
  notice in the generated desktop notices. Volli's original code remains Apache-2.0.

## Narrow replacement seams

Consumers use `src/pi/harness-session.ts`, `harness-compaction.ts`, and
`harness-env.ts`; provider/loop types and `Agent` still come from core's root.
`pi-context.ts` uses `Context` and cancellation directly from `chord@1.0.0`.
VC-497 can replace sidecar storage without changing the Session Engine or taking
ownership of Pi's deleted harness orchestration.

## Retained modules and why

Paths below are relative to this directory. Renames are explicit.

| Modules                                                                    | Reason retained                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.ts`                                                               | Chord cancellation exports and the original no-op telemetry parent used by summary requests. Unused context helpers are omitted.                                                                          |
| `types.ts`                                                                 | File/shell capabilities, typed failures/results, four-tool execution contract and stream-option shape referenced by legacy stored lane configuration. Skill/resource and unused helper types are omitted. |
| `messages.ts`                                                              | Existing custom/bash/branch/compaction message augmentation, summary framing, and `convertToLlm` conversion. These affect transcript/provider replay.                                                     |
| `env/nodejs.ts`                                                            | Existing Node filesystem/process implementation behind Volli's scoped execution and authority checks.                                                                                                     |
| `utils/truncate.ts`                                                        | Exact UTF-8 byte, line, head/tail truncation and size formatting semantics.                                                                                                                               |
| `execution/output-capture.ts` (upstream `utils/output-capture.ts`)         | Source-side bounded shell capture, spilling, sanitation and updates.                                                                                                                                      |
| `execution/adaptive-publisher.ts` (upstream `utils/adaptive-publisher.ts`) | Existing capture update batching/publication.                                                                                                                                                             |
| `execution/shell-output.ts` (upstream `utils/shell-output.ts`)             | Shell capture adapter used by scoped execution.                                                                                                                                                           |
| `tools/read.ts`, `write.ts`, `edit.ts`, `bash.ts`                          | The four existing coding tools, with unchanged schemas, descriptions, progress and result details.                                                                                                        |
| `tools/edit-diff.ts`                                                       | Existing fuzzy edit matching, multi-edit application and diff generation.                                                                                                                                 |
| `tools/file-mutation-queue.ts`                                             | Serializes mutations by canonical file path, including symlink aliases.                                                                                                                                   |
| `tools/path-utils.ts`                                                      | Existing addressed/canonical tool-path resolution. Volli's policy remains outside this module.                                                                                                            |
| `tools/image.ts`                                                           | MIME detection and encoding needed by read's image path.                                                                                                                                                  |
| `tools/tool-context.ts`                                                    | Injected execution environment contract for the four tools.                                                                                                                                               |
| `tools/index.ts`                                                           | Four-tool-only export facade (no other harness tools).                                                                                                                                                    |
| `compaction/compaction.ts`                                                 | Original thresholds, partition/cut rules, iterative/split-turn prompts and summary generation, plus the estimator patch.                                                                                  |
| `compaction/utils.ts`                                                      | File-operation accounting and exact conversation serialization for summaries.                                                                                                                             |
| `compaction/branch-summarization.ts`                                       | **Type only**: `BranchPreparation` shape referenced by legacy stored lane operations. Branch-summary execution is not copied.                                                                             |
| `session/types.ts`, `values.ts`                                            | Existing entry/storage/session contracts and value-store addresses; legacy lane shapes remain decodable.                                                                                                  |
| `session/commit.ts`                                                        | Transaction preparation/validation and original sequence/id semantics.                                                                                                                                    |
| `session/in-memory-storage-state.ts`                                       | JSONL replay's existing indexed state, list/value/usage projection, scans and fork state. Not a new memory durability authority.                                                                          |
| `session/mutation-line.ts`                                                 | Existing mutation serialization and close/admission ordering.                                                                                                                                             |
| `session/session.ts`                                                       | Storage-backed Session/Branch facade used by the current runtime.                                                                                                                                         |
| `session/context.ts`                                                       | Existing branch/compaction context reconstruction.                                                                                                                                                        |
| `session/fork-policy.ts`                                                   | Fork selection/projection used by JSONL and indexed storage, including existing conformance tests.                                                                                                        |
| `session/usage.ts` (upstream `utils/usage.ts`)                             | Usage aggregation shared by replay, legacy migration and compaction; copied once.                                                                                                                         |
| `session/jsonl/types.ts`                                                   | Original v4/storage-version-1 header and repo metadata contracts.                                                                                                                                         |
| `session/jsonl/codec.ts`                                                   | Existing v3/v4 header detection and validation.                                                                                                                                                           |
| `session/jsonl/io.ts`                                                      | Transaction framing, complete-line reads and atomic publication/repair.                                                                                                                                   |
| `session/jsonl/legacy-v3.ts`                                               | Existing v3 read/migration compatibility; old on-disk sessions must still open.                                                                                                                           |
| `session/jsonl/storage.ts`                                                 | Existing v4 replay, append, sequence and torn-tail behavior, including the event-loop-yield patch.                                                                                                        |
| `session/jsonl/repo.ts`                                                    | Existing sidecar discovery/open/create/close and filename/directory rules.                                                                                                                                |
| `session/jsonl/fork.ts`                                                    | Streaming fork implementation required by repo/conformance behavior.                                                                                                                                      |
| `session/testing/types.ts`, `session/testing/conformance/session-repo.ts`  | **Test only**: existing repo conformance used by `sidecar-load.test.ts`. No production import reaches these.                                                                                              |
| `test-fixtures/pi-0.99.2-memory.ts` (outside this directory)               | **Test only**: old memory repo supporting compaction tests, rather than shipping an unused production backend.                                                                                            |
| `test-fixtures/pi-0.99.2-prompt-templates.ts` (outside this directory)     | **Test only**: the three pure grammar functions, frozen as the oracle for the existing renderer-safe port in `@volli/shared`. No template loader is copied.                                               |

Omitted: `AgentHarness`, harness event bus, reducer/durable runtime, pico3,
assistant/tool orchestration, effect gates, skills, filesystem prompt-template
loader, system-prompt helpers, search, telemetry schemas, unused tools and
branch-summary execution. `Agent`/agent loop are **not** vendored.

## Local divergences

1. Internal imports are relocated. Core message/loop/tool types use the supported
   1.0 root; context uses chord directly. Tool/output helpers moved from upstream
   `utils/` into `execution/`; usage helpers are shared under `session/`.
2. **Former estimator patch:** `findCutPoint` and `prepareCompaction` accept the
   optional estimator. Both the retained-tail cut and `tokensBefore` use it.
   Without it, upstream token/usage behavior is unchanged.
3. **Former JSONL patch:** V4 replay reads binary bytes, decodes newline-terminated
   batches around 256 KiB, and yields after 8 ms. Complete UTF-8 lines, leading
   BOM, torn-tail repair and `line N` errors retain the patched 0.99.2 behavior.
4. Only needed exports/types remain; a few narrow lint suppressions preserve
   upstream control flow rather than changing it to satisfy repository lint.
   File/shell/tool executable code was checked for emitted-JavaScript parity.
5. The copied core patch is deleted; ownership now lives here. Codemode is not
   vendored: its output/call-size patch is retained on 1.0.0 because upstream
   still lacks those limits.

## Compatibility evidence

`fixtures/pi-0.99.2-sidecar.jsonl` was produced by the saved, patched 0.99.2
installed build before upgrading. It is a **synthetic, credential-free profile**,
not a copied user's profile: v4/storageVersion 1, both branch tips, signed
assistant content, custom entry, retained-tail compaction, opaque details,
identity, list values and a usage row. The storage test reopens and continues it;
`pi-0.99.2-reattach.test.ts` also attaches through the new runtime, submits a
scripted-provider turn and verifies append-only preservation of its original
bytes (only the workspace path is relocated). The older genuine 0.87.1 runtime
fixture remains in the suite.

A manual workspace-only check additionally copied the 0.99.2 profile, opened it
using the new repo, appended a message, closed/reopened it, and confirmed the
original JSONL prefix stayed byte-identical. Live authenticated Electron smoke
verification is separate; it must not be inferred from these scripted checks.
