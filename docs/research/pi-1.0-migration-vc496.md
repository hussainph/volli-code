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
- Genuine 0.99.2-generated sidecars: synthetic, credential-free fixtures. The
  original v4/storageVersion 1 capture verifies non-mutating reads, sequence-17
  continuation, signatures and unknown details; its invalid product checkpoint
  and incomplete settlement marker are explicitly tested as recovery cases.
  New captures generated through the old harness's compaction operation prove
  valid portable/native summary and retained-tail replay across two continuations
  and restart. Native data is structurally valid but synthetic hook input, not
  a real provider response. Captured old-build contexts are independent oracles.
  See the fixture README and committed generation script.
- Manual check: copied that synthetic profile inside the ticket workspace,
  opened it through the owned repo, appended a user message, closed and
  reopened it. The continuation remained readable and the original JSONL
  prefix remained byte-identical. No real user profile or credentials were
  read or copied. This is not evidence of an authenticated Electron turn.
- Older genuine 0.87.1 sidecar and v3 migration coverage remain.
- Pi 1.0 grammar-tool replay and missing computed-member diagnostics have
  focused tests. Capacity retry is still **Unreleased** upstream, not claimed
  as part of the published 1.0.0 release.

## Initial implementation checks (before review fixes)

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
- Initial `pnpm smoke:pi`: build passed, live smoke aborted before the turn
  because isolated HOME had no Pi credentials. This initial acceptance blocker
  was closed by the authenticated follow-up below.

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

## Review follow-up

- Rebased onto `origin/main` (`eacc3faaa`); the ancestry check now passes.
  The desktop conflict preserves main's elapsed-time-bounded durable-card wait
  and the migration branch's shared helper. Its seven protection tests pass.
- `TMPDIR="$PWD/.tmp/pi" pnpm smoke:pi`: **passed**, including the build and
  all three authenticated Electron probes: ticket chat 10/10, project chat
  7/7, Session-host lifecycle 8/8. The ticket turn completed its real `sleep 60`
  call in 67 seconds; both chat probes verified durable history after relaunch.
  The existing helper copied the login file opaquely into each isolated HOME;
  no credential contents were inspected or printed. Staged credentials were
  removed by the helper's exit cleanup.
- Standalone copied-profile runtime check passed with an isolated HOME and
  fresh workspace-local profile:
  `HOME="$PWD/.bench-tmp/pi-migration-vc496/followup-home" FOLLOWUP_MANUAL_ROOT="$PWD/.bench-tmp/pi-migration-vc496/followup-manual-profile-final" node .bench-tmp/pi-migration-vc496/followup-run-manual.mjs`.
  Two fresh
  Agent Runtime instances reattached the same 0.99.2 sidecar and completed one
  scripted-provider turn each, with the first continuation present in the second
  request. Both retained the exact recovery locator and original byte prefix;
  no replacement sidecar or network request occurred. This manually driven
  non-test-framework check covers actual runtime continuation, while the new
  valid-compaction fixtures separately cover successful summary/tail replay.
  The original fixture's malformed-checkpoint recovery is disclosed in the log.
- The benchmark follow-up repeated the original published arm and an explicitly
  labelled 400× arm with unchanged fixtures, operations, assertions and all
  samples retained. Larger equal batches stabilized context measurements:
  Node 24.18 p50 12.7→13.4 µs, RSD 5.6%→3.9%. Other metrics still exceeded
  20% variance under shared-machine load, so this partial evidence does not
  close whole-benchmark acceptance. A quiet paired run remains required; full
  commands, all six runs and baseline provenance are retained in ignored
  `.bench-tmp/pi-migration-vc496/followup-evidence.md`.
- Strengthened grammar replay asserts both correlation IDs independently equal
  `call_saved`, the result is `Returned: 7`, and the incompatible item ID is
  omitted. The three affected compatibility test files pass 44 tests with one
  existing conformance-race skip. Runtime typecheck and scoped formatting/lint
  also pass.
- A first workspace-local smoke attempt used an excessively long temporary
  directory and hit the preserved sidecar directory-name limit before a turn.
  Using the shorter workspace-local `.tmp/pi` path fixed the test setup without
  changing storage naming or format. The passing log is retained in ignored
  `.bench-tmp/pi-migration-vc496/followup-live-smoke-short-path.log`.

## Coverage repair and independent review

Review follow-up added **261 substantive tests**: 104 tool/edit-diff cases,
75 Node environment cases, 53 vendor contract/output/compaction/storage/tool
cases and 29 JSONL validation/failure/fork/lifecycle cases. Assertions cover
exact errors, byte-preserving replay and publication, queue recovery,
cancellation, output bounds, spill files and backpressure rather than simply
calling uncovered functions. No coverage threshold or production source
exclusion was changed.

Unused compatibility exports and provably unreachable private guards were
removed; the vendor README lists the divergences. Test-only conformance moved
to `test-fixtures/pi-0.99.2-session-conformance.ts`, keeping the negative
close-isolation assertion and existing skipped unsupported race. Its unused
fixture type and aggregation wrappers were removed; notices were regenerated
with the new path.

Independent tool-test review found no defects in the 104 tool cases. An
independent production-pruning review found no actionable defects and verified
single child settlement, nonempty spill dispatch, image bounds, synchronous
cancellation, output prefix/trim invariants, filtered compaction/legacy tails
and unchanged conformance case bodies. Its focused run passed 271 tests with
one existing skip and reached 100% in all four metrics for the eleven reviewed
executable files. The separate JSONL focused run passed 71 tests with one
existing skip and reached 100% for all five modules.

Final workspace `pnpm typecheck`, changed-file formatting/lint,
`pnpm check:notices`, `pnpm check:workspace-licenses`, `git diff --check` and the
base-ancestry check pass. Neighboring shared, Session Engine, Session RPC and
CLI coverage suites pass: **3,872 + 344 + 354 + 84 tests**, each at 100% in all
four metrics. Detailed ignored logs are under `.bench-tmp/pi-migration-vc496/`;
CI and whole-runtime final results are recorded separately below when complete.

Final rebase onto `271ad1ab8` (background-shell notices) completed without
conflicts. Integrated `pnpm typecheck` and `pnpm build` pass, including standalone
preload and packed-require checks. The integrated Agent Runtime suite passes
**2,814 tests**, with four existing skips, and **100% statements, branches,
functions and lines** under the unchanged gate. JSONL independent review also
passes: it confirmed real failed-write recovery, once-only reservations and
publication, original errors/cleanup, and preserved persistence/replay behavior.

The final sequential Node 24.18.0, 400× pair passed 4/4 work assertions each
but did not close strict timing acceptance: baseline first-message/context RSD
was 29.0%/24.2%; all integrated figures were below 20%. Complete figures, without
filtering samples:

| Path | Before p50/p95 µs | After p50/p95 µs | Before/after RSD |
| --- | ---: | ---: | ---: |
| System prompt | 19.5 / 26.4 | 19.0 / 25.9 | 15.6% / 18.6% |
| First message | 3.6 / 6.3 | 3.8 / 4.7 | 29.0% / 17.3% |
| Context | 17.4 / 24.4 | 14.1 / 15.0 | 24.2% / 5.3% |
| Activity | 1414.3 / 2023.1 | 1476.9 / 1807.9 | 16.6% / 11.3% |

The local run had no other verification commands from this Session once timing
began; shared-machine load still exists and was captured with `ps -eo
pid,pcpu,comm` before/between/after. Logs: `final-paired-{baseline,current}.log`
and `final-paired-context-{before,between,after}.log` in the ignored evidence
folder. A further equal 800× pair retains the same twenty samples, three warmup
batches, fixtures and work assertions in both arms; only repetition scale changes.
It uses Vite+'s managed Node 24.21.0 for both arms, not mixed versions.

Both equal 800× attempts passed 4/4 work assertions per arm, but **strict timing
acceptance remains blocked by shared-machine variance**. Do not combine rows
from separate pairs or report this as green:

| Pair / path | Before p50/p95 µs | After p50/p95 µs | Before/after RSD |
| --- | ---: | ---: | ---: |
| 800× / System prompt | 9.3 / 11.4 | 7.6 / 8.9 | 14.8% / 9.3% |
| 800× / First message | 2.3 / 4.1 | 1.8 / 1.9 | 30.0% / 4.4% |
| 800× / Context | 13.4 / 15.0 | 12.2 / 12.9 | 7.4% / 2.7% |
| 800× / Activity | 1210.0 / 1595.8 | 1038.9 / 1160.2 | 25.6% / 5.2% |
| 800× repeat / System prompt | 7.2 / 11.0 | 7.5 / 11.2 | 19.5% / 21.2% |
| 800× repeat / First message | 1.8 / 1.8 | 1.9 / 3.9 | 2.1% / 34.0% |
| 800× repeat / Context | 12.9 / 13.7 | 12.5 / 13.6 | 2.8% / 3.6% |
| 800× repeat / Activity | 1049.5 / 1230.9 | 1045.9 / 1622.3 | 10.5% / 17.3% |

The repeat used unchanged inputs after the other Node-heavy process visible
before the first run had exited. Both sides used managed Node 24.21.0. Each
configuration forces a single benchmark file, so the host concurrency hint
changing from one to two did not change timing concurrency. Logs and process
snapshots: `final-800-{baseline,current}.log`,
`final-800-repeat-{baseline,current}.log`, and corresponding `context-*` logs.
All previous failed/noisy runs remain retained. Stable context measurements and
work-count assertions support unchanged work; they do not establish a complete
variance-qualified timing pass. No demonstrated material regression was found,
but satisfying the strict criterion needs a quieter machine, not discarded
samples, threshold changes or unrelated production optimizations.

The owner explicitly accepted this unresolved timing limitation and authorized
merge **only after CI is green**. The acceptance does not turn the variance
failures into passing measurements or change any coverage/benchmark threshold.
