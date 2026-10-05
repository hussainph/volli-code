# `database-recovery-smoke.mjs` first-attempt failures — 4 incidents, exact data

All times UTC. Per-attempt durations/exit codes are from each run's
`smoke-results-core-attempt-1` artifact (`results.json`); failure text is the runner's
`::group::` block from the job log. Line numbers match committed HEAD `3abede2fd`
(CI stack traces are from the runners).

The smoke creates several Electron instances in sequence; the failing screenshot is of
the **fresh restored launch** (`second`), taken inside check 4 after the degraded-restore
launch was closed and byte-preservation was re-asserted. Helper under failure:

```js
// apps/desktop/e2e/database-recovery-smoke.mjs:327-329 (HEAD 3abede2fd)
async function screenshot(run, name) {
  await run.page.screenshot({ path: join(scratch, `${name}.png`), timeout: 5000 });
}
// called at :631 inside check 4:
//   await screenshot(second, "healthy-restored-bootstrap");
```

---

## Incident 1 — run 37236600318 (b44821ffc, #732 merge), 2026-10-04 21:33–21:39, FLAKY

- Job: `Smoke (core e2e)` attempt 1, success overall; core phase 151.3s.
- db-recovery: attempt 1 **31.0s exit 1** → attempt 2 **47.4s exit 0** → FLAKY.
- Attempt-1 signature (identical in all incidents):

```
PASS: fault UI + real IPC list newest damaged, latest clean WAL v2, older clean WAL v1
PASS: exact primary action restores and paints success; real timer calls relaunch then quit
PASS: restoration preserves raw DB/WAL/SHM evidence and every original backup byte
CLEANUP: degraded restore launch: {"kind":"graceful",...,"closeFailures":[]}
RECOVERY SMOKE FAILED: page.screenshot: Timeout 5000ms exceeded.
Call log:
  - taking page screenshot
  - waiting for fonts to load...
  - fonts loaded
    at screenshot (apps/desktop/e2e/database-recovery-smoke.mjs:328:18)
    at apps/desktop/e2e/database-recovery-smoke.mjs:631:13
    at async check (…:55:5) / recoveryScenario (…:597:3) / …:858:3
```

- Attempt 2 passed every remaining check (fresh-launch bootstrap, malformed-header
  preserve/refuse, no-backups/no-clean, interrupted-restore marker, resume-heal), all
  launches closed `"graceful"`.
- Peer windows (`results.json` attempt timestamps): db-recovery ran
  21:37:47.6→21:39:06.0; throughout attempt 1 (→21:38:18.6) peers were **board a1**
  (21:37:19.7→21:38:53.4),
  **canvas-theming** (→21:38:21.3), **composer-basics** (21:37:43.4→21:38:29.2).
  Attempt 2 overlapped board + composer tail + session-rpc + worktree.

## Incident 2 — run 37246336411 (4eee188e8, #742 merge), 2026-10-05 00:08–00:14, FLAKY

- Core phase 201.5s. db-recovery: attempt 1 **50.2s exit 1** → attempt 2 **63.4s exit 0**.
- Same screenshot signature at the same check; attempts 1–3 checks PASS, degraded launch
  closed graceful, fonts loaded, capture stalled.
- Peers during attempt 1 (00:12:07.3→00:12:57.5): **canvas-theming** (→00:12:59.5),
  **composer-basics** (00:12:06.7→00:13:04.2), **board** (00:11:30.4→00:13:35.1).
  Attempt 2 (→00:14:00.9) overlapped board, session-rpc, worktree, then board alone.
- Note: attempt 2 was slower (63.4s) than the failed attempt 1 (50.2s).

## Incident 3 — run 37238273461 (b460a63d0, #744 merge), 2026-10-04 21:59–22:11, FAIL → re-run green

- Core job attempt 1 **failed**: "7 first-attempt passes; 1 flakes; 1 failures".
  `FAILED: database-recovery-smoke.mjs`, `FLAKY (passed on retry): board-smoke.mjs`.
- db-recovery: attempt 1 **49.9s exit 1**, attempt 2 **28.3s exit 1** — **the identical
  screenshot timeout on both attempts** (first-attempt-1 also shows
  `[transcript-repack] scanned=0 repacked=0 skipped=0` in the fresh-launch stdout).
- Board (see `board-115-incidents.md`): attempt 1 117.7s exit 1 with check 11.5 failed
  (`highAfterMutation=0 highAfterReload=1`); attempt 2 45.6s exit 0.
- Windows: db-recovery 22:03:12.6→22:04:30.8 (a1 →22:04:02.5). Attempt-1 peers:
  **board a1** (22:02:34.9→22:04:32.5), **composer-basics** (22:03:12.6→22:04:21.3),
  **canvas-theming** (→22:04:05.4). At attempt 2's finish (22:04:30.8), peers were:
  **board a1** (2s from its own end), **worktree** (22:04:17.3→22:04:34.3).
- Full job re-run (attempt 2, job 22:07:21→22:11:41): all 9 PASS first-attempt;
  db-recovery 68.3s.

## Incident 4 — run 37279817811 (3abede2fd, #751 merge), 2026-10-05 07:48–07:55, FAIL → re-run green

- Core job attempt 1 failed: `FAILED: database-recovery-smoke.mjs`; 8/9 passed in 214.7s;
  no other smoke flaked (board PASSED first attempt, 156.2s).
- db-recovery: attempt 1 **64.5s exit 1** — the same screenshot timeout.
  Attempt 2 **29.9s exit 1** — a **different** signature, outwardly similar to
  VC-635's shutdown timeout but with no native sample to identify its wait:

```
##[group]FAILED database-recovery-smoke.mjs attempt 2 (exit 1)
…
CLEANUP: degraded restore launch: {"kind":"sigterm","pid":9863,"exit":{"code":null,"signal":"SIGTERM"},
  "closeFailures":["app.close timed out after 20000ms"]}
RECOVERY SMOKE FAILED: AssertionError [ERR_ASSERTION]: degraded restore launch did not quit cleanly
CLEANUP: degraded restore launch: {"kind":"already-exited","pid":9863,…}
CLEANUP FAILED: AssertionError [ERR_ASSERTION]: degraded restore launch did not quit cleanly
```

- Windows: smokes began 07:51:37.5. db-recovery 07:52:31.6→07:54:05.9 (a1 →07:53:36.0).
  Attempt-1 peers: **composer-basics** (07:52:31.0→07:53:39.2), **canvas-theming**
  (→07:53:40.1), **board** (07:51:37.5→07:54:13.7). At attempt 2's finish
  (07:54:05.9), active peers were **board** + **session-rpc** (07:53:39.2→07:54:09.1) + **worktree**
  (07:53:40.1→07:54:09.8); composer-basics had just ended.
- Full job re-run (attempt 2, 08:01:29→08:06:49): all 9 PASS first-attempt;
  db-recovery 84.9s.

## Cross-incident observations (data, not conclusions)

1. One dominant signature (4/4 first attempts): Playwright `page.screenshot` 5000ms
   timeout on the fresh-restored-launch capture, fonts already loaded, after a graceful
   degraded-launch close. Always in check 4; checks 1–3 always passed.
2. Attempt 2 outcomes: 2 passed (47.4s, 63.4s), 1 same-signature (28.3s), 1 quit-stall
   (29.9s). Passing retries were not faster; peers were still present.
3. Each first failed attempt was wholly overlapped by 3 peer smoke processes
   (pool full, 4-way). This does not measure peer CPU/I/O activity.
   Retry failure timestamps are not recorded separately from attempt finish.
4. Both job-level failures required a full runner re-run to clear; each re-run was a
   9/9 first-attempt pass.
5. Artifact evidence for all incidents contains no PNG/native samples
   (`VOLLI_RECOVERY_SAMPLE` opt-in was off); quiet-window cursor checks were ok.
