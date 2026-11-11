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
| Session/composer transport | composer-basics (includes Session RPC exposure/refusals) |
| Terminal and worktree | terminal, worktree |
| Agent socket and real CLI | agent-cli-roundtrip (includes private socket/raw NDJSON/shim) |
| Degraded database, restore and relaunch | database-recovery |
| Tokens, appearance, inheritance and persistence | canvas-theming |

Other non-quarantined probes are the rest tier: `ci-extended.yml` runs it as one
macOS job (`Smoke (rest tier)`) at release, on path-filtered PRs that change the
extended lane definitions, smoke runner or older-app live harness, and on manual
dispatch for any branch (`gh workflow run ci-extended.yml --ref <branch>`). It
does not run after main merges or nightly and does not gate ordinary PRs.
Dispatching a risky branch is an exception, not a routine pre-merge requirement.
The four extended macOS lanes run in parallel; the rest tier remains one job.

The release workflow runs extended on the **exact commit being shipped** and
requires success before tagging, signing or publishing, unless the explicit
`require_green=false` escape hatch is used. An ancestor's extended result is not
a substitute. A red extended run at release blocks the release: track the
regression in a ticket and fix it on its own branch, rather than re-running
until green.

The runner's `SERIAL` set runs one probe at a time after its lane's concurrent
work drains.
Do not quarantine a sole core journey based on historical flakes or weaken
graceful-exit assertions.

## Consolidated journeys

Standalone probes share a boot only when their original assertion doors and
fixture boundaries remain explicit:

| Retained journey | Assertions carried from the former standalone probe |
|---|---|
| agent-installer | background-install: live CLI status/profile-local executable link, independent skipped-install profile; three installed-profile generations plus the skipped profile |
| agent-cli-roundtrip | agent-socket: actual socket type/mode, raw NDJSON identity, executable generated launcher, before authority grants |
| automations-page | automations: CRUD readbacks, invalid-create no-write, exact Run refusal/no Run or Session; automations-rail: genuinely empty rail before creation, geometry, offers/arming, inspection/native Settings recovery, context menus |
| changeset-diff-tabs | changeset-navigators: referenced context/worktree hierarchy, refresh focus retention, Changes/Files/rail screenshot evidence |
| project-files | quick-open: real shortcuts, ranking, preview/pin, Main/worktree index isolation and Ticket destination, without changing the existing two-boot File-tab restore checkpoint |
| done-flow | retention: separate branch-only discovery, Keep, real archive/branch survival, independent dirty refusal; not merely cleanup of the published ticket |
| composer-basics | session-rpc-transport: installed bridge shape, real router validation and withheld-procedure refusal before project seeding |

The real-node-pty supervisor test in
`packages/host-core/src/pty/manager.pty.test.ts` covers two finite high-output
rounds, consuming acknowledgments and a subsequent command. The retained
terminal journey still checks actual renderer output, scrollback and shell
continuity. Neither is a replacement memory benchmark.

### Deliberately retired coverage

The following standalone workloads are not part of smoke acceptance:

- **memory:** per-process RSS/heap snapshots, idle/residency comparisons, the
  exact eight-Claude workload and two 16 MB output dumps. These recorded no
  memory budget or plateau oracle. Finite-output stream correctness is retained
  in the real-PTY test; hardware memory/performance observations are not.
- **peek-summary-readability:** real Chromium overflow/last-line reachability,
  fixed header/footer geometry and viewport containment in both appearances.
  Component tests retain full text, non-shrinking rows, bounded scrollers and
  header/footer placement, not a real layout oracle.
- **automations-picker:** actual Alt/pointer/dnd-kit hit testing, rendered
  collapsed/expanded targets and empty-column picker interaction. Deterministic
  picker/model/board-dispatch tests retain selection, Move only, cancellation
  and empty-column rules; arming retains real countdown/CLI-arrival checks.
- **composer-draft:** full-app Escape/overlay draft restoration, restored-draft
  creation/reset and cold-relaunch editor restoration. Draft serialization,
  latest-revision/consumption and composer-form tests remain; these do not prove
  SQLite-to-editor restoration across Electron lifetimes.

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
