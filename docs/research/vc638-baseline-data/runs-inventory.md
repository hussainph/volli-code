# Runs inventory — main pushes, CI workflow `ci.yml`, 2026-10-04T12:10Z → 2026-10-05T08:01Z

All 17 `push`→`main` CI runs in the window. "core total" is the smoke phase only
(`Running 9 smoke(s)` → `passed in`), from job logs. Attempt-1 core-lane smoke
first-attempt failures are listed; "clean" = all 9 PASS first attempt.

| run id | head SHA | created (UTC) | attempts | core job (final) | core total (a1) | first-attempt smoke failures in attempt 1 |
|---|---|---|---|---|---:|---|
| 37279817811 | `3abede2fd` (#751 merge) | 10-05 07:48 | 2 | a1 FAIL / a2 SUCCESS | 214.7s | **database-recovery FAIL ×2** (screenshot 64.5s; quit-stall 29.9s) |
| 37278791428 | `9ee1d8189` (#749 merge) | 10-05 07:37 | 1 | SUCCESS | 147.4s | clean |
| 37277879791 | `3966e6233` (#750 merge) | 10-05 07:27 | 2 | SUCCESS both | 130.5s | core clean (a2 re-ran `Test (packages)`: codemode `tool.test.ts` flake) |
| 37276837280 | `c9c1b5b45` (#748 merge, VC-635 fix) | 10-05 07:16 | 1 | SUCCESS | 167.5s | clean |
| 37246809217 | `43df7f1e0` (#737 merge) | 10-05 00:15 | 1 | SUCCESS | 240.1s | clean |
| 37246336411 | `4eee188e8` (#742 merge) | 10-05 00:08 | 1 | SUCCESS | 201.5s | **database-recovery FLAKY** (screenshot 50.2s → retry 63.4s ✓) |
| 37245313602 | `6090d726a` (#740 merge) | 10-04 23:52 | 1 | SUCCESS | 220.1s | clean |
| 37244217503 | `e31efa11b` (#743 merge) | 10-04 23:34 | 1 | SUCCESS | 208.5s | **board FLAKY** (11.5 indicator, 108.6s → retry 49.4s ✓) |
| 37240492529 | `a17176b67` (#746 merge) | 10-04 22:33 | 2 | SUCCESS both | 154.0s | core clean (a2 re-ran another lane) |
| 37238273461 | `b460a63d0` (#744 merge) | 10-04 21:59 | 2 | a1 FAIL / a2 SUCCESS | 216.3s | **database-recovery FAIL ×2** (49.9s + 28.3s, both screenshot) **and board FLAKY** (11.5 indicator, 117.7s → 45.6s ✓) |
| 37236611420 | `3c7dcd106` (#733 merge) | 10-04 21:34 | 1 | SUCCESS | 177.5s | clean |
| 37236600318 | `b44821ffc` (#732 merge) | 10-04 21:33 | 1 | SUCCESS | 151.3s | **database-recovery FLAKY** (screenshot 31.0s → retry 47.4s ✓) |
| 37235199677 | `ff6a22e51` (#741 merge) | 10-04 21:13 | 1 | SUCCESS | 186.9s | clean |
| 37229525266 | `bdc0e925b` (#739 merge) | 10-04 19:46 | 1 | SUCCESS | 172.8s | clean |
| 37223743178 | `c887bc4c4` (#738 merge) | 10-04 18:15 | 1 | SUCCESS | 158.6s | clean |
| 37221620963 | `f9c6bfc5f` (#736 merge) | 10-04 17:43 | 1 | SUCCESS | 138.9s | clean |
| 37220075580 | `d4c15713b` (#735 merge) | 10-04 17:19 | 1 | SUCCESS | 135.2s | clean |

Notes:

- Core lane totals across the 15 single-window clean/FLAKY runs: 130.5–240.1s, median
  167.5s. The 37246809217 (240.1s) and 37245313602 (220.1s) lanes were the slowest and
  were clean; duration alone does not predict the flake.
- Failed-job artifact summaries: 37238273461 has 7 first-attempt passes, 1 flake
  and 1 failure; 37279817811 has 8 first-attempt passes, no flakes and 1 failure.
  Both have no unfinished smokes.
- Re-run (attempt 2) of both failed jobs: all 9 smokes PASS first-attempt —
  database-recovery 68.3s (37238273461 a2) and 84.9s (37279817811 a2); board 91.5s / 111.2s.
- No core lane was skipped in this window (push events force `desktop=true`); the
  PR-only `Smoke (shards)` lane is skipped on every main run by design.
- Two of the 17 runs needed a re-run for NON-core reasons (37277879791, 37240492529);
  included here for rerun-noise context only.
