# VC-638: recovery screenshot and native-quit CI flake

Investigation/fix PR: [#756](https://github.com/hussainph/volli-code/pull/756).
**Scheduling result:** [run 37292128058](https://github.com/hussainph/volli-code/actions/runs/37292128058),
attempts **1–18**, has **18/18 first-attempt recovery passes**, compared with
**4/17 first-attempt recovery failures** in the main census.
Current failure-window evidence is insufficient to identify a specific native
wait or prove that VC-638 shares VC-635's low-priority starvation cause.

## Baseline

The [17-run main census](vc638-baseline-data/README.md) has **4/17 recovery
first-attempt failures** (two retry-green, two retry-red) and **2/17 board 11.5
first-attempt failures**. All four recovery first failures occur in the second,
fresh restored launch's screenshot, after checks 1–3 and a graceful degraded
launch close. Playwright reports fonts loaded before its 5-second timeout.
Run [37279817811](https://github.com/hussainph/volli-code/actions/runs/37279817811)
also fails its fresh-profile retry on a 20-second degraded-launch quit timeout.

Artifact attempt timestamps establish that board, composer-basics and
canvas-theming overlap each first failed recovery attempt in its entirety.
That is process overlap, not proof of CPU/I/O starvation. Per-check timestamps
and native stacks are absent in the baseline artifacts; retry duration alone
cannot establish or exclude a quieter retry.

[VC-635](database-quit-stall-vc635.md) captured a native ThreadPool shutdown wait
and low-priority background non-execution/I/O throttling, then isolated the
**different** newer-version database smoke. Historical
[VC-536](smoke-flakes-2026-10.md#vc-536-database-recovery-native-shutdown-investigation)
instead captured a synchronous GPU/Viz frame-sink teardown wait in recovery.
Neither prior capture establishes the cause of the new recovery occurrences.

## Diagnostic head

Commit `438817abb` preserves scheduling, product behavior, all recovery
assertions, 5-second screenshots, 20-second close grace and actual code-zero
child-exit requirements. The draft temporarily opts into native sampling to
identify the wait. Sampling is intrusive, so these observations are **not**
final-head acceptance evidence.

- Reuses `shutdown-trace.mjs`: quit request, app events, native exit entry/return,
  debugger-disconnect wait and actual child exit. Native exit return is not
  process termination; no app drain-settlement claim is inferred from it.
- Failed screenshot: bounded independent renderer/document/font/rAF, Electron
  window/webContents/process metrics and tracked-process CPU/state probes.
  Missing rAF alone is not proof of the native compositor's cause.
- Explicit diagnostic sampling selects only the tracked main and descendants.
  It never chooses all processes matching an Electron name.
- Recovery now writes evidence beneath `VOLLI_SMOKE_REPORT_DIR`; baseline
  recovery scratch directories were outside CI's uploaded artifact root.
- Every diagnostic rejection/timeout/write failure is non-gating; the original
  screenshot failure is rethrown unchanged. The screenshot itself stays gating.
  Successful runs remove shutdown trace files and emit no diagnostic output.

## Captured recurrence and scheduling decision

Diagnostic head `438817abbb149fa429a10fb6f0d004fd756d1890`,
[run 37282549767](https://github.com/hussainph/volli-code/actions/runs/37282549767),
workflow attempts **1–10**: nine complete first-attempt core passes and one
recovery FLAKY observation (attempt 9); no other smoke retried. Each artifact's
results and actual recovery exits were checked. These are diagnostic-head
observations, not final scheduling-head proof.

Attempt 9, [core job 111693058516](https://github.com/hussainph/volli-code/actions/runs/37282549767/job/111693058516):

- The same healthy-restored screenshot fails after fonts loaded and checks 1–3.
  Failure breadcrumb: **09:16:40.784Z**. Board, composer-basics and canvas-theming
  span the whole nominal five-second capture window and remain active then.
- At +643ms main answers: window visible, not minimized, webContents not loading
  or crashed. At +715ms the renderer answers with complete DOM, loaded fonts,
  the mounted healthy "Add your first project" UI and a **4ms rAF** callback.
- Main/GPU/network/renderer samples start about **1.7s after timeout**. They
  cannot establish what was blocked or unscheduled during the failed capture.
  Post-timeout recovery is not proof of a dead compositor or an App Nap cause.
  Main, GPU/Viz and renderer/compositor foreground threads are idle in these
  later samples, not in the VC-536 frame-sink teardown wait.
- Main has two background database initializers still in flight. UUID-matched
  disassembly (framework `4C4C448B-5555-3144-A179-5775D5EF8BF6`, main load base
  `0x10cfb4000`) identifies thread **35881**: all **1376** samples in DIPS'
  `PRAGMA journal_mode=WAL` main-database-file sync → `fsync` (return site
  rebased `0x2522008`). Thread **36458** has all 1376 samples at one user
  instruction (`0x1e7fdb4`), in the observer store's first-boot CREATE TABLE
  execution. This is consistent with prolonged non-execution, but `sample`
  cannot distinguish scheduling, a code-page fault or a kernel-held thread.
  The capture has no per-thread QoS/kernel throttling evidence. These native
  initializers match VC-635's contention pattern; no known screenshot dependency
  on them is established. Misleading nearest-export labels are not used as
  ownership evidence.
- The failure-handler screenshot subsequently succeeds. Main's native exit
  returns in 12ms; actual code-zero child exit is observed 404ms after quit
  request. This occurrence does **not** reproduce a native shutdown stall.
- Recovery's fresh-profile retry passes all 11 checks/seven closes in 62.964s;
  the failing attempt took 54.918s. Job color alone would hide this recurrence.

Artifact: `smoke-results-core-attempt-9/recovery-2qy6fH`, including screenshot
JSONL, tracked PID samples, quiet shutdown JSONL and the successful failure PNG.
The baseline retry quit failure still has no native sample identifying its wait.

The narrow, reversible scheduling change follows VC-635's measured same-runner
starvation evidence: run **database recovery alone after its lane's concurrent
pool drains**.
The recurrence establishes a transient capture failure under the same full-pool
exposure, not its exact native mechanism. This is containment of that test regime,
**not a proven product bug or a claimed upstream compositor/quit fix**. No feature,
persistence setting, product behavior, assertion, screenshot timeout, close grace,
retry policy or gate is changed. No sleeps, pre-seeding or quarantine are added.

Final CI disables intrusive sampling; only quiet, bounded failure breadcrumbs
remain. Per-capture paths prevent a later failure-handler sample from replacing
an earlier capture's evidence, and captured start/failure timestamps distinguish
capture duration from subsequent diagnostic work. Opt-in native sampling skips
an exited/missing tracked root rather than attaching by stale PID.

## Board 11.5

The context-menu action calls `setTicketPriority`; its store writes the new
priority synchronously before awaiting IPC, then patches the returned ticket by
id. The smoke instead sleeps 400ms and takes one non-polling DOM count before
reload. A bounded projection-readiness observation is appropriate; persistence
is still checked independently after reload. No product bug is established by
the historical single-sample failure.

Board production code, tests and smoke are **unchanged**. The historical 11.5
failure is not proven to share the native screenshot/quit cause; bounded
DOM-projection readiness and the separate 8.5 multi-drag flake are tracked in
**VC-655**, including the historical board incident evidence.

## Scheduling-head results and limits

[Run 37292128058](https://github.com/hussainph/volli-code/actions/runs/37292128058),
attempts **1–18**, used scheduling head
`317717c1a387faf956f415e2abb7fc35763bad42` and fixed checkout
`f8b1d3d020d7602dcd3f618f9077d614212d2b05`, with native sampling off.
Recovery passed **18/18 first attempts**. Each uploaded artifact records all
11 recovery checks, exactly seven graceful/natural code-zero exits with null
signals and no close failures, and a passing quiet-window verdict.

Attempts **11–18** are eight consecutive observations with **all nine core
smokes first-attempt PASS**, verified from results, recovery logs and quiet-window
JSON rather than job color. Earlier core streaks ended with retry-green board
failures: 11.5 on attempt 4 (`highAfterMutation=0 highAfterReload=1`) and 8.5 on
attempt 10 (`slotted=false`, slots `settled=false`). Neither counts toward the
eight-pass core streak; recovery still passed first attempt in both.

The main census (**4/17 recovery first failures**), diagnostic observations
(**1/10 recovery FLAKY**), and scheduling-head observations (**0/18 recovery first
failures**) are separate small populations, not statistically proven elimination
or evidence of the original screenshot's precise native dependency. Lane-local
serialization cannot prevent other OS/VM load, and native exit remains unbounded
(the **VC-652** follow-up). Board's separate flakes are not fixed here.
