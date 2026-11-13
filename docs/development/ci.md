# CI lanes

What each CI workflow runs and when. The working rules for agents (what to run locally, pushing, watching CI, merging) stay in `AGENTS.md` under **CI is the gate**; smoke retry, reporting and quarantine rules are in [smoke-tests.md](smoke-tests.md).

## Lanes

every PR runs Linux `Check + Build`, the desktop Vitest suite as `Test (desktop i/4)` shards, `Coverage (desktop)`, `Test (host-core i/2)` shards, `Coverage (host-core)` (each merge requires every blob and enforces its suite’s unchanged thresholds once), `Test (packages)` (remaining suites, dependency-independent and CPU-bounded), `Convex (codegen + backend)`, `N-1 compatibility` (base lane; VC-633), `Build (host container)` when host inputs change, and **one macOS job, `Smoke (core e2e)`**; **`CI gate` is the one check that sums them**, and all must be green before shipping. PRs touching only prose/website/docs, `convex/`, `apps/gateway/` or `packages/shared/src/` (never a manifest) skip core e2e; the unit suites still run, and core e2e runs again after merge. The heavy lanes moved, not deleted (VC-934): **`ci-extended.yml`** runs the rest smoke tier (every other non-quarantined journey), flag-on remote acceptance, and the two-Mac cloud wake acceptance (separate `Smoke (cloud wake acceptance)` job, simulated sleep), the move engine's kill/resume matrix (`Move to Volli Cloud`, Linux, `convex-test`), the guarded desktop move (`Move to Volli Cloud (app path)`, macOS, pinned backend and signature-checking bucket, full history-URL wait), the large-profile backup → restore round trip (`Backup restore rehearsal`, Linux), the newest released app's own live cloud suites against this backend (`Older app (live)`, Linux), and the BYO runner artifact, install matrix and acceptance lanes (Linux) at release on the **exact commit being shipped**, on path-filtered PRs that change the extended lane definitions, smoke runner or older-app live harness, and on manual dispatch for any branch (`gh workflow run ci-extended.yml --ref <branch>`). It does **not** run on main pushes or nightly. Dispatching a risky branch is an exception, not a routine pre-merge requirement. Extended results do not gate ordinary PRs; **the release workflow runs extended and requires success before tagging, signing or publishing**, unless the explicit `require_green=false` escape hatch is used. The N-1 fixed and rolling tags (release, latest canary, `v0.2.1`, `v0.2.2-canary.1`) run in `ci.yml` on main pushes and nightly, and on a PR only when it touches the data layer older builds read back (`packages/host-core/src/db/`, `backup/`, `session-control/`, `session-runtime/`, blob store, ticket commands) or the N-1 harness. All selected N-1 lanes run sequentially in one job; scope is unchanged. A PR's newer push cancels its older runs. On main, `ci.yml` runs once per commit, never cancelled or queued behind the previous commit. Extended's four macOS lanes run in parallel, not sequentially. The smoke runner GLOBS `apps/desktop/e2e/*-smoke.mjs` and subtracts explicit credential/legacy exclusions plus measured quarantines in `apps/desktop/scripts/run-smokes.mjs`, so **a smoke you add joins the extended lane with no registration step**. A person can run the same thing on a dev Mac: `node apps/desktop/scripts/run-smokes.mjs` (add `--tier core` for core e2e, `--list` to see the selection). `act pull_request --container-architecture linux/amd64` mirrors the Linux jobs locally, for a person debugging the workflow — not a pre-PR step. The Pi smokes stay local-only — they drive a live model turn, so they are structurally credential-gated and need `pnpm smoke:pi` with a display and a real `~/.pi/agent/auth.json`.

CodeQL runs on main pushes and weekly, not PRs, with TRAP caching disabled.

### Test shard capacity

Desktop uses four duration-balanced shards; host-core uses two. The desktop
sequencer assigns only Vitest's live discoveries, using the measured expensive
file costs in `apps/desktop/scripts/test-durations.json` and per-project means
for remaining/new files. Costs include tests, collection, environment, setup
and preparation. Stale entries never add tests; timing drift affects balance,
not coverage or selection. Refresh the costly-file sample from green CI blobs
when the tail shifts. Local unsharded test order remains Vitest's default.

Keep the fewest shards that hold the longest test lane near the other required
lanes (~6–7 minutes): surplus shards cost every queued PR a runner slot.
There are 16 CI jobs (including Scope and CI gate), whether the base-only or
all-five N-1 lanes are selected: those lanes share one sequential job. Main
before host-core sharding has 12 jobs with either selection. CodeQL does not
run on PRs.

## Core e2e

**Core e2e** (`run-smokes.mjs --tier core`; `boot` is an alias) gates every desktop-relevant PR and runs after main merges: `board`, `composer-basics`, `terminal`, `worktree`, `agent-cli-roundtrip`, `database-recovery`, and `canvas-theming` (`-smoke.mjs` filenames). The other non-quarantined journeys run in `ci-extended.yml` (`Smoke (rest tier)`) at release on the exact shipped commit, on path-filtered lane-definition PRs and on manual dispatch, not after main merges or nightly; new smokes join by default. Manual dispatch for a risky branch is an exception, not a pre-merge norm. **A red `CI extended` at release blocks the release** before tagging, signing or publishing (unless `require_green=false` is explicitly chosen): name the regression in a ticket and fix it on its own branch rather than re-running until green. A failure retries **once in a fresh profile**; retry-green is explicitly **FLAKY** in stdout, the job summary and 30-day both-attempt artifacts. Two failures or a native quiet-window violation remain red. `smoke-quarantine.yml` runs measured repeat flakers nightly with visible non-gating observations and one Backlog fix ticket each. Quarantine requires measured repeat failures, retained coverage, a tracked repair, and explicit return criteria. Smoke consolidation or deletion requires maintainer approval; this policy does not authorize deleting smoke coverage.

## Linux host boundary

`Test (host-core i/2)` and `Test (packages)` are the plain-Node Linux host lanes,
pinned by `.nvmrc`; new host packages must provide `test:coverage`. Host-core
shards alone set up Node-native PTY and sandboxed Chromium. The remaining
package tasks run with `--parallel` and a CPU-sized concurrency limit. `Check + Build` enforces zero Electron
imports across all packages, hostd, the runner, `convex/` and `apps/gateway`, including
transitive relative imports. `Convex (codegen + backend)`
is the `convex/` lane: on Linux, beside the desktop lanes, it regenerates
`convex/functions/_generated` against the pinned local backend and fails on
drift, then runs the unit (`convex-test`) and real-backend suites. `Check + Build`
also enforces the committed public Convex API snapshot against both the base
and newest released app tag (`scripts/convex-api/`). CI extended's
`Older app (live)` runs that released tag's own clients against this backend;
see `convex/README.md` for both cross-version checks.
`Build (host container)` is path-filtered and required by `CI gate` when selected;
it also builds the hostd linux-x64 artifact in that image and boots it.
`N-1 compatibility` runs the latest `vX.Y.Z` release,
the latest `vX.Y.Z-canary.N` canary and the PR's base against a head-migrated
profile (VC-633, `packages/host-core/README.md`). Fixed `v0.2.1` and
`v0.2.2-canary.1` lanes preserve the 0.2.2 downgrade promises alongside those
rolling lanes; rolling tags must not replace that proof. A PR runs `base` alone
unless it touches the data layer older builds read back (migrations, backup,
ledger, blobs; the list is in `ci.yml`'s Scope) or the N-1 harness, which run every lane; main pushes and the nightly run always run every lane. The selected lanes (up to all five) run sequentially in one job, not as separate matrix jobs; selection scope and downgrade coverage are unchanged.
Host development image, native ABI isolation and inventory commands:
`docs/development/host-linux.md`.

### Worker exit evidence

Each `Test (host-core i/2)` shard retains `host-core-worker-diagnostics-<shard>-<attempt>` and each
`Test (desktop i/4)` shard retains `desktop-worker-diagnostics-<shard>-<attempt>`
for 30 days, including failures. Both lanes opt into the same Node preload and
active-test hook; both desktop projects (main and renderer) participate.
`coverage.log` retains a byte-bounded raw-output tail including native stderr;
`pipefail` preserves the producer's failing exit status or signal status.
The preload writes synchronous JSONL by PID and thread id, independently of
Vitest's buffered output:

- `test-start` / `test-finished` identify the test active through teardown.
- `test-trace` is a failed test's own phase trace, published by suites that keep
  one (today `crash-recovery.integration.test.ts`, VC-1220): the awaits still
  pending when it failed, then its newest marks. At most 400 lines of 256
  characters, strings only; the suite keeps them to step names, bound reads,
  error names and timings, never messages or payloads.
- `child-exit` records the child's PID, raw exit code and signal in its surviving
  parent. Match that PID to the child's event file; nearby suite output is not
  attribution. A parent-local `childId` also correlates spawn failures where no
  PID exists.
- `worker-start` / `worker-exit` identify nested threads and their resource
  limits. Thread exit code 1 can be the expected result of `terminate()`, not a
  crashed Vitest fork. Restore crash-proof and cancellation markers distinguish
  those requests from spontaneous exits.
- Memory samples include process RSS, the current isolate's heap and available
  memory. Process start/exit also capture root cgroup memory counters where
  available. A sample alone is not evidence of OOM.

Each observer keeps at most two 1 MiB JSONL generations; the raw coverage
capture keeps at most two 8 MiB generations per job. The older generation has
`.previous` appended to its filename. Rotation writes an explicit truncation
marker and retains the useful tail; an oversized JSONL record is omitted whole
rather than leaving invalid JSON. These are per-observer/job limits, not a
single aggregate budget across every process. The coverage sink keeps draining
and forwarding input after truncation or capture failure; a closed console does
not give the producer EPIPE. Forwarding observes backpressure rather than
building an unbounded stdout buffer.

The JSONL contains only allowlisted metadata: no argv, environment, worker
payloads or error messages. No heap dumps or cores are collected. Full Node
fatal reports are deliberately not enabled: even excluding environment/network data leaves command-line and
other metadata outside that allowlist. Native CHECKs and uncatchable signals
cannot run JS exit hooks; use the raw stack in `coverage.log` and the surviving
parent's signal record. No test/host error is consumed, cancellation changed,
or test retried. Synchronous writes and memory sampling can
perturb test timing; this is observation, not a timing-neutral experiment.
Upload is best-effort: job timeout or cancellation can prevent the artifact
step from running, so preserve the job's console log while it is available.

The package job also attempts read-only symbolization of the retained Node
24.22.1 Linux frames. It verifies the pinned setup-node archive checksum and
requires its extracted binary to match the job's Node byte-for-byte before
using preinstalled `readelf`, `addr2line` and `nm`. Hashes, build-id and bounded
symbol output are retained; the extracted binary is never executed or uploaded.
Nearest preceding symbols and stripped binaries are explicitly not treated as
cause attribution. A diagnostic failure keeps the job red while still allowing
the real coverage step to run and report its own result. The pin is specific
to those retained frames, not a promise that addresses survive a Node update.

**Known cause of the fork exits.** On Node 24 every retained "Worker exited
unexpectedly" in these lanes has been V8's `Check failed: jit_page.has_value()`
(SIGTRAP in the child's parent record). Its frames run from
`Runtime_TierUpWasmToJSWrapper` through `WasmImportWrapperCache::Free` to
`ThreadIsolation::UnregisterWasmAllocation`. That is nodejs/node#66366: V8 13.6
can free a shared Wasm import wrapper twice when Wasm code GC races a thread
that is adding it to its ref scope. The backport, nodejs/node#66376, is in no
24.x release yet. Desktop and host-core forks therefore run with
`--no-wasm-code-gc` on Node 24 (`vitest.node-flags.ts`), which removes the race.
Remove the flag when `.nvmrc` moves to a Node with the backport. Another
package whose forks abort the same way spreads `TEST_WORKER_NODE_FLAGS` the same
way.

**Runner health.** Each shard also writes `runner-health.log` into its
diagnostics artifact (`scripts/ci-runner-health.sh`): every 5 s, the CPU split
including steal and I/O wait, runnable and blocked tasks, available memory and
`/proc/pressure` averages. A stall that shows steal, I/O wait or pressure is the
VM. A stall on an idle machine is the test. A degraded runner also shows before
any test runs: compare the job's `Checkout` and `Setup Vite+` durations with
other jobs in the same workflow run.

**`abandoned`.** `CI gate` prints this when GitHub never assigned a lane a
runner. The job has no steps and no log, and its annotations say "The job was
not acquired by Runner of type hosted even after multiple attempts". GitHub
gives up after 15 to 35 minutes. This has hit the macOS lane while GitHub
reported limited macOS arm64 capacity. No step ran, so the result says nothing
about the commit.

**`CI re-request`** (`ci-rerun-abandoned.yml`) handles it. When a `ci.yml`
run completes, it re-runs that run's failed jobs once, but only if all of
these hold:

- the run is attempt 1 and still on attempt 1;
- it concluded `failure`, not `cancelled`;
- at least one job never started: `cancelled`, no runner (`runner_id` 0 or
  empty, empty runner name) and zero steps;
- every other job that did not pass is `CI gate` and the gate ran;
- outside push runs, no newer `ci.yml` run exists for the same event, branch
  and head repository, because a re-run would cancel the newer PR run.

If any other job failed, timed out or was cancelled after it ran, nothing is
re-requested and the run stays red for a person. The re-run executes the same
commit and the gate judges every lane again, so it cannot hide a result. It
applies to PR (fork PRs included), main-push, scheduled and dispatched runs.
The release guard is unchanged: it still needs a `success` conclusion on the
shipped commit, and a run that went green on its second attempt has one. If
the second attempt is not acquired either, the run stays red: re-run it by
hand, or wait for the next run.

The predicate is `scripts/ci-rerun-abandoned.mjs`, tested against recorded
run payloads. It reads only GitHub's run and job records, never logs,
artifacts or code from the run. Its `Decide` job (`actions: read`,
`contents: read`) checks out that one script from the default branch. A
separate job holds `actions: write`, runs no repository code and makes the
re-run call. Dispatching the workflow with a `run_id` reports the decision for
any past run without re-running it. A `workflow_run` workflow only runs from
the default branch, so a change to it takes effect only after it merges.

For a focused local capture, set `VOLLI_TEST_DIAGNOSTICS` to an absolute
workspace-local directory under `.tmp/` and append
`--require="<workspace>/scripts/host-test-diagnostics.cjs"` to `NODE_OPTIONS`,
then run only the relevant test file with coverage **from `packages/host-core`
or `apps/desktop`**. The preload is inert outside those working directories or
without that variable. These captures are evidence, not public source; do not
commit them.
