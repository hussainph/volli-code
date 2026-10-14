# PR #865 fix-round item 3: targeted N−1 proof

## Implementation

- `packages/host-core/src/db/fixtures/silent-end-session.ts`: generates both fixtures with HEAD's actual Session runtime, SQLite ledger, file artifact store, native Pi adapter and Pi runtime. Only provider output and the fatal runtime callback are injected; no ledger events or sidecar records are hand-authored.
  - **Fatal live attachment:** hold a real provider turn open, invoke its fatal observation callback, and capture Attention with the diagnostic **before** `attachment.closed: failed`, without a substitute `turn.interrupted`.
  - **Stop racing finish:** the scripted provider returns a normal `stop` finish when its signal is aborted. HEAD writes `turn.interrupted`, including the real `volli.observation.v1` Pi sidecar marker, with no completed turn or failure Attention.
  - Both capture DB/sidecar bytes before teardown and restore those bytes afterward. Closing/draining the real Pi handle cannot accidentally manufacture the fixture's ending.
- `packages/host-core/src/db/n1-compatibility.test.ts`: checks HEAD fixture provenance even without an N−1 manifest; the prepared-build tests run both scenarios through the previous build.
- `packages/host-core/scripts/n1/silent-end-child.mjs`: runs under the discovered `scripts/n1/{prepare,hooks}.mjs` machinery, beside the existing general `child.mjs`. All database/engine/adapter/runtime and scripted-provider imports resolve into the extracted previous tree with its own installed lockfile. Nothing falls back to HEAD source.
  - Read/replay HEAD history and artifacts before attaching.
  - Fatal: attach through real `context_replay`; stopped binding: cold reconcile with real `native_resume`.
  - Continue with the next message, then retry the same accepted command.
  - Close the live host/DB connection, reopen with a fresh engine, and cold replay again.
  - Assert named failure diagnostic, idle/replayable/attached/continued behavior, exactly one original and next user message in replay and provider context, one provider request, one accepted next receipt, no pending queue, and no duplicate after retry or cold reopen. No exact older decoded-event/sidecar shape assertions. Exact marker assertions apply only to HEAD fixture provenance.
- `.github/workflows/ci.yml`: adds fixed `v0.2.1` and `v0.2.2-canary.1` matrix entries beside rolling release/latest-canary/base. Each uses `--ref "$LANE"` and the existing complete N−1 test-file step. The existing `CI gate` still requires the aggregate `n1-compat` result to be `success`; no waiver/skip/continue-on-error was added.
- `packages/host-core/src/db/n1-prepare.test.ts`: asserts fixed refs remain in that non-waived matrix, use the exact ref preparation branch, execute the compatibility test file, and stay required by `CI gate`.
- `scripts/ci-host-lane.test.mjs`: the existing root workflow contract also checks the full five-entry matrix and fixed-ref preparation. The first fix-round CI exposed its stale three-entry expectation; after correction all 11 root contract tests passed. All five actual N−1 lanes had already passed on that run.

No new ledger types, migrations, production exports, or production runtime changes in this subtask. Presentation/client/desktop tests and `silent-ends.integration.test.ts` were not edited by this subagent.

## Versions actually exercised

| Previous build | Exact extracted commit | Result |
| --- | --- | --- |
| `v0.2.1` | `f6ec540ca7ff14c6e403a4c8a91e840bba46dd1b` | Both targeted scenarios passed; complete two-file focused run: **21 passed** |
| `v0.2.2-canary.1` | `5ef341e6d95cf02f6e44c363b712b00efacb926f` | Both targeted scenarios passed; complete two-file focused run: **21 passed** |
| Feature-containing PR HEAD | `73e436ef0cf5fcb9cb44db886043e80a3ba787a1` | Both targeted scenarios and all two-file assertions passed (**21**); scoped fixture coverage command exited 1 on the unchanged 100% thresholds, below |

The feature-containing previous-build run also checks that these assertions do not depend on pre-feature decoding (VC-751). It extracts the committed HEAD, not concurrent uncommitted parent changes. HEAD fixture generation always uses the current working runtime.

## Exact checks and commands

Run from the ticket worktree; `VOLLI_CONCURRENCY_HINT=1`. Trees/logs are ignored workspace-local `.scratch/n1-vc758*`; no extraction into the main checkout or outside this workspace.

```sh
mkdir -p .scratch
node packages/host-core/scripts/n1/prepare.mjs --ref v0.2.1 --out .scratch/n1-vc758 > .scratch/n1-vc758-release.log 2>&1
node packages/host-core/scripts/n1/prepare.mjs --ref v0.2.2-canary.1 --out .scratch/n1-vc758 > .scratch/n1-vc758-canary1.log 2>&1
node packages/host-core/scripts/n1/prepare.mjs --ref HEAD --out .scratch/n1-vc758 > .scratch/n1-vc758-feature.log 2>&1
```

All three preparations passed; install ran with lifecycle scripts off. An initial attempt to redirect the release log before creating `.scratch` failed (`No such file or directory`); the commands above corrected it.

For each of release/canary1:

```sh
export VOLLI_N1_MANIFEST="$(tail -1 .scratch/n1-vc758-release.log)" # or n1-vc758-canary1.log
cd packages/host-core
vp test run src/db/n1-compatibility.test.ts src/db/n1-prepare.test.ts --maxWorkers=$VOLLI_CONCURRENCY_HINT
```

Final runs: **21/21 passed on each tag**, no skipped tests. Earlier scenario-only runs passed 4 tests on each tag (12 unrelated tests filtered out); the no-manifest scenario-only run passed the 2 HEAD provenance tests.

```sh
export VOLLI_N1_MANIFEST="$(tail -1 .scratch/n1-vc758-feature.log)"
cd packages/host-core
vp test run src/db/n1-compatibility.test.ts src/db/n1-prepare.test.ts --coverage --coverage.include=src/db/fixtures/silent-end-session.ts --maxWorkers=$VOLLI_CONCURRENCY_HINT
```

**21/21 assertions passed, command exit 1 on coverage:** fixture statements 94.66%, branches 75%, functions 93.75%, lines 98.52%. The uncalled explicit no-network callback and defensive fixture failure/optional cleanup branches are not exercised. This test-only fixture is not on the protected production coverage include list; explicitly adding it for this diagnostic run applied the package's unchanged global 100% thresholds. No threshold or exclusion was changed. The earlier scenario-only coverage run had the same metrics and exit 1. Neither is a green coverage-gate claim.

From the workspace root:

```sh
vp fmt packages/host-core/src/db/n1-compatibility.test.ts packages/host-core/src/db/fixtures/silent-end-session.ts packages/host-core/scripts/n1/silent-end-child.mjs .github/workflows/ci.yml
vp fmt packages/host-core/src/db/n1-prepare.test.ts
vp fmt --check .github/workflows/ci.yml packages/host-core/scripts/n1/silent-end-child.mjs packages/host-core/src/db/fixtures/silent-end-session.ts packages/host-core/src/db/n1-compatibility.test.ts packages/host-core/src/db/n1-prepare.test.ts
vp lint packages/host-core/src/db/n1-compatibility.test.ts packages/host-core/src/db/n1-prepare.test.ts packages/host-core/src/db/fixtures/silent-end-session.ts packages/host-core/scripts/n1/silent-end-child.mjs
node --check packages/host-core/scripts/n1/silent-end-child.mjs
node --check packages/host-core/scripts/n1/prepare.mjs
node --check packages/host-core/scripts/n1/child.mjs
node --check packages/host-core/scripts/n1/hooks.mjs
vp run --filter @volli/host-core typecheck
```

Formatting, final lint (**0 errors, 0 warnings**), all four syntax checks and final host typecheck passed. Initial lint identified two function-scoping findings in new helpers; both were corrected. An earlier host typecheck observed concurrent parent-owned support-file errors (unused `isSessionStreamQueue`, tracked-stream tuple typing); the final invocation passed without this subagent editing those files. Scoped `git diff --check` passed. A subsequent `vp fmt docs/research/VC-758/n1-fixround.md` returned `Expected at least one target file` because research Markdown is excluded by the repository's formatter ignores; no Markdown formatting pass is claimed.

## Limits / remaining gate

- No Electron, Docker, SSH, keychain/security commands, provider sign-in, real model requests, commits or pushes.
- No full package/workspace suites or smoke matrix. Only the two N−1 files were run.
- CI execution of the new five-entry matrix and the full protected coverage gate remains for CI on the final parent head. The static lane/gate assertion passed locally; no claim that remote CI is green.
- Scoped test-fixture instrumentation remains below 100%, explicitly reported above. Production coverage thresholds remain untouched.
