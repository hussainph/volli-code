# VC-638: recovery screenshot and native-quit CI flake

Investigation/fix PR: [#756](https://github.com/hussainph/volli-code/pull/756).
**Scheduling candidate; final-head acceptance is recorded on the PR.**
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

Under the owner's ten-observation investigation budget, apply the narrow,
reversible scheduling candidate that VC-635's measured same-runner starvation
supports: run **database recovery alone after its lane's concurrent pool drains**.
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

This PR leaves board production code, tests and smoke **unchanged**, following
owner steering to avoid widening the recovery fix. A prepared readiness-only
smoke change and pending-IPC store-test enhancement were locally verified but
removed from the diff. The historical 11.5 failure is not proven to share the
native screenshot/quit cause; bounded DOM-projection readiness belongs in a
separate follow-up.

## Verification so far (local, not CI acceptance)

- Offline frozen install with scripts ignored; Electron install and native
  rebuild: pass. Desktop build passes with existing chunk-size warnings.
- Desktop typecheck (four configs): pass.
- Final candidate runner/quiet-window/close/shutdown/screenshot helper tests:
  **67/67** pass, including stale-PID guards and capture timing.
- Exploratory board store tests: 142/142; built board journey: all checks pass,
  including 11.5. The exploratory changes are not retained in this PR.
- Earlier built diagnostic recovery with quiet tracing: 11/11 checks, seven
  graceful code-zero exits. Success retains screenshots/result but no shutdown
  traces/profiles.
- Candidate validation on the shared local machine: a combined verification
  command exhausted its outer 180-second wall budget during launch (not an
  assertion outcome); only its tracked orphan app/helpers were terminated.
  A standalone recovery then failed degraded-launch close after three checks:
  native exit returned in 34ms, but actual child exit required SIGTERM at 20s.
  This remains a real failure, not a pass. Lane-local serialization cannot
  prevent contention from other Sessions/OS work; there is no upstream bounded
  native-exit guarantee. An explicit opt-in local native capture is separate
  from the CI acceptance streak.
- `vp check` and `git diff --check`: pass after focused formatting/lint fixes.

## Final-head acceptance method

Acceptance requires at least **eight consecutive core observations with all
nine smokes first-attempt PASS on one unchanged scheduling head**, verified from
the uploaded artifacts rather than job color. The PR tracks completion and exact
results; native sampling must remain off.
Each observation must have all 11 recovery checks, seven graceful code-zero exits
with no close failures/signals, and a passing quiet-window verdict. Record
run/attempt/job IDs and the exact head on the PR without changing code mid-streak.

The 17-main-run baseline (4/17 first failures), ten diagnostic observations
(1/10 FLAKY), and the final small acceptance streak are separate populations.
Do not pool them or claim statistically proven elimination/improvement. Other
OS/VM load remains possible even with no local smoke peers. Board's separate
single-sample failure is not fixed here. The owner performs independent review
and merge; this Session must not merge the PR.
