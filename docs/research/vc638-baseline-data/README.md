# VC-638 baseline data — core e2e `database-recovery` + board 11.5, main CI

Read-only CI baseline gathered 2026-10-05 ~08:00–08:30 UTC via the GitHub REST API
(`gh api`, repo `hussainph/volli-code`, workflow `ci.yml` "CI"). No source edits; no
re-runs triggered. Companion files:

- `runs-inventory.md` — every main run examined, lane totals, first-attempt smoke failures.
- `database-recovery-incidents.md` — the 4 `database-recovery-smoke.mjs` incidents: exact
  signatures, per-attempt durations, reconstructed concurrent peers.

Board check 11.5 incident evidence is recorded on the **VC-655** board-flakes
follow-up. After recovery was moved to the serial pool,
[run 37292128058](https://github.com/hussainph/volli-code/actions/runs/37292128058),
attempts **1–18**, recorded **18/18 first-attempt recovery passes**, compared with
this census's **4/17 first-attempt recovery failures**. These are separate small
populations, not a statistical elimination claim.

## Window and method

- All `push` → `main` CI runs from 2026-10-04T12:10Z to 2026-10-05T08:01Z: **17 runs**
  (IDs and SHAs in `runs-inventory.md`). Every one executed the `Smoke (core e2e)` job:
  the path gate forces `desktop=true` for push events, so docs-only merges still run the
  core lane on main; the only lane that skips is `Smoke (shards)`, which is PR-only by
  design and out of scope here. No core lane was skipped in the window.
- Core lane = 9 smokes (board, composer-basics, terminal, worktree, agent-socket,
  session-rpc-transport, agent-cli-roundtrip, database-recovery, canvas-theming): eight
  run in the 4-worker pool (`--jobs 4`, alphabetical queue), then terminal runs alone. Each failed smoke retries ONCE in the
  same job (fresh profile): `PASS` = first-attempt green, `FLAKY` = retry green, `FAIL` =
  both attempts failed.
- Per smoke: statuses and totals from job logs; exact per-attempt durations/exit codes from
  the `smoke-results-core-attempt-N` artifacts (`results.json`); failure output from the
  `::group::` blocks the runner prints for failed/flaky smokes.

## Headline counts (17 main runs)

| Metric | Count |
|---|---|
| `database-recovery-smoke.mjs` first-attempt failures | **4 / 17 runs (23.5%)** — 2× FLAKY (retry green in-job), 2× FAIL (retry also failed → job failed) |
| Board smoke check 11.5 first-attempt failures | **2 / 17 runs (11.8%)** — both FLAKY (one of them in a run that also had the db-recovery FAIL) |
| Runs with ≥1 core-lane smoke first-attempt failure | 5 / 17 (29.4%) |
| Jobs that failed their whole first attempt on the core lane | 2 / 17 (11.8%): 37238273461 (b460a63d0) and 37279817811 (3abede2fd) |
| Both failed jobs after one full re-run | all 9 smokes PASS first-attempt (verified from re-run artifacts) |
| Core lane wall clock (single-attempt runs) | 130.5–240.1s, median 167.5s (n=15); affected runs are not the slowest |

One signature dominates: **all four** `database-recovery` first-attempt failures are the
identical

```
RECOVERY SMOKE FAILED: page.screenshot: Timeout 5000ms exceeded.
  - waiting for fonts to load...
  - fonts loaded
at screenshot (apps/desktop/e2e/database-recovery-smoke.mjs:328:18)
at apps/desktop/e2e/database-recovery-smoke.mjs:631:13
```

— the `run.page.screenshot({ timeout: 5000 })` helper at line 328, called at line 631
(`await screenshot(second, "healthy-restored-bootstrap")`, committed HEAD 3abede2fd), i.e.
the diagnostic screenshot of the **fresh restored launch** inside check 4 ("fresh launch
has healthy real bootstrap and the latest-clean saved marker"), always after recovery
checks 1–3 had already passed and the degraded-restore launch had closed gracefully.
Playwright reports fonts loaded and then the capture itself never returns inside 5s.

The single divergent retry outcome: 37279817811 attempt 2 failed differently —
`AssertionError: degraded restore launch did not quit cleanly` (`app.close timed out after
20000ms` → SIGTERM). This resembles VC-635's outward quit-timeout signature, but
without a native sample its underlying wait is not established.

Timing pattern (exact attempt durations from artifacts):

| run | attempt 1 | attempt 2 | outcome |
|---|---:|---:|---|
| 37236600318 a1 | 31.0s ✗ screenshot | 47.4s ✓ | FLAKY |
| 37246336411 a1 | 50.2s ✗ screenshot | 63.4s ✓ | FLAKY |
| 37238273461 a1 | 49.9s ✗ screenshot | 28.3s ✗ same screenshot | FAIL |
| 37279817811 a1 | 64.5s ✗ screenshot | 29.9s ✗ quit-stall | FAIL |

The two retries that passed took **longer** than their failed attempt 1 (47.4 vs 31.0s;
63.4 vs 50.2s). Peers remained during green retries, but a successful attempt runs
all seven launches rather than stopping at launch two. Total duration alone cannot
establish or exclude a quieter retry or contention.

## Concurrent peers at failure (reconstructed)

The artifact's `results.json` records each attempt's start and finish directly.
The first failed recovery attempts lie wholly inside the board, composer-basics
and canvas-theming attempt windows. This proves smoke-process overlap, not that
each peer was consuming CPU or I/O throughout:

- All 4 db-recovery first-attempt failures ran with **3 peer smokes** (4 concurrent
  Electron-bearing probes): board, composer-basics and canvas-theming were the common
  set, because board (90–160s) and canvas-theming (~60–120s) occupy two pool slots for
  most of the lane and composer-basics is queued fifth.
- Board attempt 1 overlapped the whole db-recovery failure window in all 4 incidents —
  expected by construction (jobs=4, 9 smokes), so "they ran together" is the base rate,
  not evidence of causation. Same in reverse: in both board-11.5 incidents,
  db-recovery was a concurrent peer.
- At recovery attempt 2's **finish** in 37238273461, active peers were board
  (ending 2s later) and worktree; in 37279817811 they were board, session-rpc and
  worktree. The screenshot/quit failure itself precedes attempt finish; its exact
  timestamp is not present, so these are not exact failure-time peer inventories.

## PR #748 (VC-635 fix) context

- PR #748 ("fix(ci): isolate fresh-database shutdown smoke from pool contention"), merged
  c9c1b5b45 at 2026-10-05T07:16Z, touched: `ci.yml`, `database-newer-version-smoke.mjs`,
  `lib/shutdown-trace.*`, `run-smokes.mjs` (+test), `docs/research/database-quit-stall-vc635.md`.
  It moved `database-newer-version-smoke.mjs` to the exclusive (serial) pool;
  `database-recovery-smoke.mjs` stays in the concurrent pool.
- PR #748's own validation lane: 9 CI runs on its branch, 8 green; the single failure
  (run 37251480378 attempt 3) was `Smoke (shard 2/3)` — a **rest**-shard lane, not core.
  Core e2e passed on all 9 of its validation runs.
- Post-#748 main runs at time of writing: 37276837280 (clean), 37277879791 (core clean;
  re-run was for a `Test (packages)` codemode flake), 37278791428 (clean),
  37279817811 (**db-recovery FAIL ×2** → re-run green). The other 3 db-recovery incidents
  and both board-11.5 incidents pre-date #748's merge.

## Limits of evidence

1. **Small n.** 17 runs over ~20h. Rates are indicative, not statistical.
2. **PR lanes not swept.** Only PR #748's own runs were enumerated. Same-signature
   failures on other PRs' core lanes would not appear in these counts (PR core lanes run
   the same 9 smokes, so they exist if they exist).
3. **Intra-smoke timing is bounded, not measured.** Per-attempt totals are exact
   (results.json), but there are no per-check timestamps inside a smoke, so we know the
   screenshot gave up at exactly 5s, not how long the renderer had been quiet before it.
4. **No runner telemetry.** Logs carry no CPU/IO/memory samples; the contention story
   (3-vCPU macOS runners starving compositor/`TaskTracker::CompleteShutdown`) remains a
   hypothesis consistent with, not proven by, this data.
5. **No native/PNG evidence for these failures.** The `smoke-results-core-attempt-*`
   artifacts for all six incidents are 12–15KB — attempt logs + results.json +
   quiet-window.json (cursor-stationarity) only. Native sampling in the recovery smoke is
   opt-in (`VOLLI_RECOVERY_TRACE=1` in the baseline) and was off; screenshot PNGs live
   in the smoke's own scratch dir and are not uploaded. The diagnostic PR corrects
   that artifact-root omission and separates quiet tracing from intrusive sampling.
6. **Smoke-process intervals are measured**, from `results.json` start/finish fields.
   Exact per-check times and CPU/I/O consumption inside those intervals are unknown.
7. **Line numbers refer to baseline main `3abede2fd`**, the most recent failing
   run in this census, not the diagnostic/fix PR head.
8. **`database-newer-version-smoke.mjs` is out of scope** (different smoke, VC-635); its
   serialization is nonetheless the nearest prior fix and the reason db-recovery's own
   concurrency exposure is now the open question.
