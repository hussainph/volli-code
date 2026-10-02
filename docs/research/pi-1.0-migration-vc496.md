# VC-496: Pi 1.0 migration verification

## Boundary

Pi AI, core and codemode are exact-pinned to 1.0.0. Core supplies only Agent,
loop/proxy and types. Removed 0.99.2 environment, four tools, compaction and
JSONL sidecar code are owned behind three private agent-runtime facades.
Session Engine remains the durability authority; no pi-durable dependency or
storage-format change is introduced.

The complete copied-module inventory, rationale, source-map provenance,
upstream revision, MIT text and local divergences are in
[`pi-harness/README.md`](../../packages/agent-runtime/src/pi/vendor/pi-harness/README.md).
The release-by-release API/behavior audit is in
[`UPSTREAM.md`](../../packages/agent-runtime/UPSTREAM.md#the-10-bump-vc-496).

## Compatibility checks

- The former core patch is folded into TypeScript: model-aware compaction cut
  estimation and 8 ms JSONL replay yields with complete UTF-8 line decoding.
- Four-tool/environment/output helpers: 15/15 modules emit identical JavaScript
  to the published 0.99.2 source maps after normalizing relocated imports.
- Codemode patch retained on 1.0.0: patch content and patched host/worker/types
  are identical to the saved patched baseline; upstream still lacks output
  and serialized-call limits.
- Genuine 0.99.2-generated sidecar: synthetic, credential-free fixture with
  v4/storageVersion 1, sequences 1–16, two branch tips, assistant signatures,
  custom/compaction entries, identity, list and usage. See the fixture README.
  Storage coverage verifies non-mutating reads and sequence-17 continuation;
  runtime coverage reattaches and submits a scripted-provider turn.
- Manual check: copied that synthetic profile inside the ticket workspace,
  opened it through the owned repo, appended a user message, closed and
  reopened it. The continuation remained readable and the original JSONL
  prefix remained byte-identical. No real user profile or credentials were
  read or copied. This is not evidence of an authenticated Electron turn.
- Older genuine 0.87.1 sidecar and v3 migration coverage remain.
- Pi 1.0 grammar-tool replay and missing computed-member diagnostics have
  focused tests. Capacity retry is still **Unreleased** upstream, not claimed
  as part of the published 1.0.0 release.

## Checks on the integrated tree

- `pnpm typecheck`: passed (root and all workspace typechecks).
- `pnpm build`: passed, including standalone preload and packed-require checks.
- `vp check`: passed on the full workspace (2,546 formatted files; no lint
  errors or warnings in 2,473 inputs). Scratch evidence is kept in ignored
  `.bench-tmp/pi-migration-vc496/`.
- `pnpm check:notices`: passed; generated notice includes copied MIT sources.
- `pnpm check:workspace-licenses`: passed.
- `git diff --check`: passed.
- Focused compatibility run: 55 passed, one existing upstream-race skip.
  Storage agent's two-file run: 55 passed, same existing skip. Codemode and
  1.0 replay run: 58 passed. Desktop adapter run: 159 passed.
- `pnpm test`: passed all nine workspace test tasks: 20,272 tests passed,
  six skipped. Earlier full runs hit the same desktop approval-card timing
  assumption; its helper now waits for the durable condition instead of a
  fixed number of mock ticks.
- `pnpm smoke:pi`: build passed, live smoke aborted before the turn because
  isolated HOME had no Pi credentials. A secure credential request was
  declined. The owner must run this with their working login; it is not green.

## Benchmark evidence

`pnpm -C packages/agent-runtime bench:runtime` ran before upgrading and after
integration. All four work-count assertions passed each time. The default
probe uses five samples at 0.2× scale on an Apple M1, Node 24.18.0, with
`VOLLI_CONCURRENCY_HINT=1`.

| Hot path | Before p50 µs | After p50 µs | Before RSD | After RSD |
| --- | ---: | ---: | ---: | ---: |
| System prompt | 17.0 | 16.0 | 8.8% | 140.2% |
| First message | 4.5 | 4.8 | 8.0% | 7.7% |
| Context projection/model switch | 89.9 | 93.2 | 39.8% | 25.1% |
| Activity normalization | 1291.6 | 1561.0 | 9.1% | 14.9% |

The noisy default probe does **not** establish timing non-regression. A paired
repeat ran sequentially after the full test/build jobs finished, using the
published arm (20 samples, 20× scale). The baseline used sources extracted from
`1fdaafda223ae7e0c65f1a437f947632e951667f` inside the workspace and the saved
patched core/AI 0.99.2 packages with their original resolved dependencies;
unchanged shared code and benchmark tooling used the workspace install.

| Hot path | Baseline p50 µs | Integrated p50 µs | Baseline RSD | Integrated RSD |
| --- | ---: | ---: | ---: | ---: |
| System prompt | 14.2 | 14.2 | 1.4% | 1.0% |
| First message | 2.9 | 2.9 | 0.7% | 0.8% |
| Context projection/model switch | 14.1 | 13.1 | 26.1% | 33.4% |
| Activity normalization | 1125.7 | 1134.1 | 0.7% | 0.3% |

Both runs passed 4/4 work-count assertions. The apparent activity gap fell from
21% in the default probe to under 1% in the paired run; there is no material
regression observed in that path. Context projection still exceeds the bench's
20% RSD threshold in both arms, so the strict whole-benchmark acceptance
criterion remains unverified rather than being reported green.
