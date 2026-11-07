# CI lanes

What each CI workflow runs and when. The working rules for agents (what to run locally, pushing, watching CI, merging) stay in `AGENTS.md` under **CI is the gate**; smoke retry, reporting and quarantine rules are in [smoke-tests.md](smoke-tests.md).

## Lanes

every PR runs Linux `Check + Build`, the desktop Vitest suite as `Test (desktop i/3)` shards, `Coverage (desktop)` (merges the shards and enforces the thresholds), `Test (packages)`, `Convex (codegen + backend)`, `N-1 compatibility (base)` (VC-633), `Build (host container)` when host inputs change, and **one macOS job, `Smoke (core e2e)`**; **`CI gate` is the one check that sums them**, and all must be green before shipping. PRs touching only prose/website/docs, `convex/`, `apps/gateway/` or `packages/shared/src/` (never a manifest) skip core e2e; the unit suites still run, and core e2e runs again after merge. The heavy lanes moved, not deleted (VC-934): **`ci-extended.yml`** runs the rest smoke tier (every other non-quarantined journey), flag-on remote acceptance, and the two-Mac cloud wake acceptance (separate `Smoke (cloud wake acceptance)` job, simulated sleep), the move engine's kill/resume matrix (`Move to Volli Cloud`, Linux, `convex-test`), the guarded desktop move (`Move to Volli Cloud (app path)`, macOS, pinned backend and signature-checking bucket, full history-URL wait), and the large-profile backup → restore round trip (`Backup restore rehearsal`, Linux), and the newest released app's own live cloud suites against this backend (`Older app (live)`, Linux) on every main push, nightly, and on demand for any branch (`gh workflow run ci-extended.yml --ref <branch>` — do this before merging a PR that changes a journey's area or the cloud path); its results show on the commit, do not gate PRs, and **are required by the release guard**. The N-1 fixed and rolling tags (release, latest canary, `v0.2.1`, `v0.2.2-canary.1`) run in `ci.yml` on main pushes and nightly, and on a PR only when it touches the data layer older builds read back (`packages/host-core/src/db/`, `backup/`, `session-control/`, `session-runtime/`, blob store, ticket commands) or the N-1 harness. Superseded runs cancel, on PRs and on main; on main a running `ci-extended.yml` run is never cancelled — a queued one is replaced by the newer commit's. The smoke runner GLOBS `apps/desktop/e2e/*-smoke.mjs` and subtracts explicit credential/legacy exclusions plus measured quarantines in `apps/desktop/scripts/run-smokes.mjs`, so **a smoke you add joins the extended lane with no registration step**. A person can run the same thing on a dev Mac: `node apps/desktop/scripts/run-smokes.mjs` (add `--tier core` for core e2e, `--list` to see the selection). `act pull_request --container-architecture linux/amd64` mirrors the Linux jobs locally, for a person debugging the workflow — not a pre-PR step. The Pi smokes stay local-only — they drive a live model turn, so they are structurally credential-gated and need `pnpm smoke:pi` with a display and a real `~/.pi/agent/auth.json`.

## Core e2e

**Core e2e** (`run-smokes.mjs --tier core`; `boot` is an alias) gates every desktop-relevant PR and runs after main merges: `board`, `composer-basics`, `terminal`, `worktree`, `agent-socket`, `session-rpc-transport`, `agent-cli-roundtrip`, `database-recovery`, and `canvas-theming` (`-smoke.mjs` filenames). The other non-quarantined journeys run in `ci-extended.yml` (`Smoke (rest tier)`) after each main merge, nightly and on dispatch; new smokes join by default. **A red `CI extended` on main is a regression**: it blocks releases, so treat it like a red main — name it in a ticket and fix it on its own branch rather than re-running until green. A failure retries **once in a fresh profile**; retry-green is explicitly **FLAKY** in stdout, the job summary and 30-day both-attempt artifacts. Two failures or a native quiet-window violation remain red. `smoke-quarantine.yml` runs measured repeat flakers nightly with visible non-gating observations and one Backlog fix ticket each. Quarantine requires measured repeat failures, retained coverage, a tracked repair, and explicit return criteria. Smoke consolidation or deletion requires maintainer approval; this policy does not authorize deleting smoke coverage.

## Linux host boundary

`Test (packages)` is the plain-Node Linux host lane, pinned by `.nvmrc`; new host
packages must provide `test:coverage`. `Check + Build` enforces zero Electron
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
`N-1 compatibility (release|latest-canary|base)` runs the latest `vX.Y.Z` release,
the latest `vX.Y.Z-canary.N` canary and the PR's base against a head-migrated
profile (VC-633, `packages/host-core/README.md`). Fixed `v0.2.1` and
`v0.2.2-canary.1` lanes preserve the 0.2.2 downgrade promises alongside those
rolling lanes; rolling tags must not replace that proof. A PR runs `base` alone
unless it touches the data layer older builds read back (migrations, backup,
ledger, blobs; the list is in `ci.yml`'s Scope) or the N-1 harness, which run every lane; main pushes and the nightly run always run every lane.
Host development image, native ABI isolation and inventory commands:
`docs/development/host-linux.md`.

### Worker exit evidence

`Test (packages)` retains `host-core-worker-diagnostics-<attempt>` and each
`Test (desktop i/3)` shard retains `desktop-worker-diagnostics-<shard>-<attempt>`
for 30 days, including failures. Both lanes opt into the same Node preload and
active-test hook; both desktop projects (main and renderer) participate.
`coverage.log` retains a byte-bounded raw-output tail including native stderr;
`pipefail` preserves the producer's failing exit status or signal status.
The preload writes synchronous JSONL by PID and thread id, independently of
Vitest's buffered output:

- `test-start` / `test-finished` identify the test active through teardown.
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

For a focused local capture, set `VOLLI_TEST_DIAGNOSTICS` to an absolute
workspace-local directory under `.tmp/` and append
`--require="<workspace>/scripts/host-test-diagnostics.cjs"` to `NODE_OPTIONS`,
then run only the relevant test file with coverage **from `packages/host-core`
or `apps/desktop`**. The preload is inert outside those working directories or
without that variable. These captures are evidence, not public source; do not
commit them.
