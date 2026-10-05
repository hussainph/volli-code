# Board smoke check 11.5 first-attempt failures — 2 incidents

Check 11.5: "Priority context action: indicator updates immediately and survives reload".
Both observed failures are byte-identical in shape; both recovered on the in-job retry.

## Incident 1 — run 37238273461 (b460a63d0, #744 merge), 2026-10-04, attempt 1

```
[FAIL] 11.5. Priority context action: indicator updates immediately and survives reload
       — before="Priority: Medium" highAfterMutation=0 highAfterReload=1
…
1 CHECK(S) FAILED: 11.5
```

- board attempt 1 **117.7s exit 1** → attempt 2 **45.6s exit 0** (all checks, incl. 11.5
  with `highAfterMutation=1 highAfterReload=1`). FLAKY; the job still failed because
  database-recovery exhausted both attempts (see `database-recovery-incidents.md`).
- Window: board a1 22:02:34.9→22:04:32.5. Check 11.5 sits mid-run (checks 0–23); its
  exact time inside the attempt is not logged. Concurrent peers at that period included
  **database-recovery (attempt 1, itself failing)**, **composer-basics**,
  **canvas-theming**, later **session-rpc/worktree**.
- This is the run the VC-638 ticket was opened for.

## Incident 2 — run 37244217503 (e31efa11b, #743 merge), 2026-10-04 23:34–23:40, FLAKY

```
[FAIL] 11.5. Priority context action: indicator updates immediately and survives reload
       — before="Priority: Medium" highAfterMutation=0 highAfterReload=1
1 CHECK(S) FAILED: 11.5
```

- board attempt 1 **108.6s exit 1** → attempt 2 **49.4s exit 0**. Job green overall
  ("9/9 passed in 208.5s", 1 flake). database-recovery PASSED first attempt (78.6s) in
  this run.
- Window: board a1 23:36:39.9→23:38:28.5 (mid-run ≈23:37:30±). Concurrent peers around
  then: **canvas-theming** (→23:37:58.3), **composer-basics** (23:37:12.0→23:38:00.8),
  **database-recovery** (23:37:15.4→23:38:34.1), **session-rpc** (23:37:58.3→23:38:12.4),
  **worktree** (23:38:00.8→23:38:21.7).

## Reading

- Signature is stable: `highAfterMutation=0` (indicator not updated immediately) with
  `highAfterReload=1` (state correct after reload) — consistent with a slow/late
  optimistic update or projection refresh, not data loss.
- Sample: 2 failures in 17 main runs (~12%), both on lane attempts that were carrying a
  full 4-way pool including database-recovery's repeated app launches.
- Per-check timing inside board-smoke is not logged, so the latency between the context
  action and the immediate-indicator read is unknown from CI evidence.
