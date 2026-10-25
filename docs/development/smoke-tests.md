# Desktop smoke tests

`apps/desktop/scripts/run-smokes.mjs` is the smoke inventory and runner.
New `*-smoke.mjs` files join automatically unless explicitly excluded for
credentials, a runner limitation or measured quarantine. Filename count is not
coverage; retain unique assertions and reload/isolation boundaries.

## CI lanes

Core e2e gates every desktop-relevant PR (`ci.yml`, `Smoke (core e2e)`) and runs
after main merges. `--tier boot` is a compatibility alias for `--tier core`.

| Journey | Core probes (`-smoke.mjs` omitted) |
|---|---|
| Boot, board, persistence | board |
| Session/composer transport | composer-basics, session-rpc-transport |
| Terminal and worktree | terminal, worktree |
| Agent socket and real CLI | agent-socket, agent-cli-roundtrip |
| Degraded database, restore and relaunch | database-recovery |
| Tokens, appearance, inheritance and persistence | canvas-theming |

Other non-quarantined probes are the rest tier: `ci-extended.yml` runs it as one
macOS job (`Smoke (rest tier)`) after every main merge, nightly, and on demand
for any branch (`gh workflow run ci-extended.yml --ref <branch>`). It does not
gate PRs, but the release guard requires it green on the released commit.
Dispatch it before merging a PR that changes a journey's area. The runner's `SERIAL` set runs one probe at a time
after its lane's concurrent work drains. Do not quarantine a sole core journey
based on historical flakes or weaken graceful-exit assertions.

## Retry and reports

- At most two new processes: first attempt, then one retry only on failure.
  No nested workflow or quiet-window retry; cancellation starts no retry.
- Remove inherited `VOLLI_SMOKE_DIR` for both attempts. Each creates a fresh
  scratch DB/profile. Direct individual invocation may use debugging overrides.
- PASS is first-attempt green. FLAKY is fail then pass and counts green visibly.
  FAIL is two failures and stays red. Native quiet-window failures remain red,
  even when the probe retry passed.
- Checkpoint `results.json` on each attempt/result: name, status, exit code,
  signal, timestamps, runtime, log path, lane, SHA and workflow run/attempt.
  Stream logs as bytes arrive, preserving the first failed attempt.
- Summaries show both durations; ordered stdout replays both attempts for
  FLAKY/FAIL. `quiet-window.json` retains the native sampler verdict. Incomplete
  checkpoints retain pending/running entries and `completed: false`, not passes.
- CI uploads core/rest/quarantine result artifacts for 30 days, including
  failures/cancellation when upload remains possible. Attempt-specific names
  avoid collisions. An unstarted lane cannot manufacture artifacts or passes.
- Local reports use fresh ignored `.tmp/smoke-results-*`; CI sets
  `VOLLI_SMOKE_REPORT_DIR`. Preserve needed evidence before artifact expiry;
  do not commit investigation reports to the public repository.
- Jobs obey `min(requested jobs, VOLLI_CONCURRENCY_HINT)` when a Session budget
  exists. Local focused runs should pass that budget explicitly where required.

## Measured quarantine

`.github/workflows/smoke-quarantine.yml` observes measured entries nightly or
manually, separately from `CI gate`. Each entry has a tracked fix. Outcomes,
logs and quiet-window verdicts stay visible; setup/build/upload failures can
still fail the workflow. The runner refuses an empty green lane rather than
manufacturing passes. Membership is defined only by `SMOKE_QUARANTINE` in the
runner, not by a historical table.

Screen initial workflow opportunities only: at least **50 observations**, at
least **3 distinct SHAs with confirmed recovery**, and a **95% Wilson lower
bound above 2%**. Confirmed recovery is retry-green or a genuine same-run/SHA
rerun recovery, counted once per initial opportunity. Deterministic failures,
unrelated-diff suspicions and inherited rerun jobs do not count as recovered
flakes. This is a conservative operational screen, not a claim that samples
are independent or stationary.

Return a probe after fixing the root cause and preserving all assertions:
record at least **50 post-fix fresh-profile opportunities across 3+ SHAs with
no FAIL/FLAKY**, including CI observations, then remove only its quarantine
entry. Restart the evidence window after the fix. Historical probe-specific
exceptions do not relax this ordinary bar.

Consolidation requires maintainer approval before deleting a file or duplicate
assertion. Map old checks to retained journey sections, preserve unique door,
reload, second-launch and isolation checks, and verify changed journeys before
removing the old probe. Boot sharing is not permission to delete coverage.
Keep real database restored-relaunch/shutdown, theming first-paint/inheritance,
raw socket NDJSON/mode checks and stale browser refs on their distinct doors.
Credentials-dependent live-model journeys stay outside unattended CI.
