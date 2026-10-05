# VC-635: database smoke close stalls

Investigation in draft PR [#748](https://github.com/hussainph/volli-code/pull/748).
The ticket's baseline was approximately 11/23 first-attempt failures (48%) on
unrelated PR branches. Local baseline was 18/18 passes, including concurrent runs.

## Reproductions

All runs below use Electron 44.0.0, Chromium 152.0.7977.54, ARM64 macOS 15.7.9.
The shutdown grace remains 20 seconds; the asynchronous app drain remains 15
seconds. Forced cleanup is a failure, even when the runner's one fresh-profile
retry passes. Every listed CI job finished green **with a FLAKY newer-database
smoke**, not a first-attempt green observation.

| CI run / SHA | First-attempt close | Trace / native evidence |
| --- | --- | --- |
| [37246547328](https://github.com/hussainph/volli-code/actions/runs/37246547328), `9c5e35c04` | Incompatible PID 16848: SIGTERM after 20s | Drain 4ms; `app.exit(0)` returned after 425ms; debugger disconnected; only main remained at +10s. Sampler collected stacks but its initial 7s symbolication budget expired before it wrote the report. |
| [37247136262](https://github.com/hussainph/volli-code/actions/runs/37247136262), `19b23a584` | Seed PID 7033: SIGTERM after 20s | Drain 70ms; `app.exit(0)` returned after 2.031s; debugger disconnected. All 882 main-thread samples wait for Chromium ThreadPool shutdown; its background worker is blocked in `fsync`. |
| [37247781400](https://github.com/hussainph/volli-code/actions/runs/37247781400), `07580b406` | Compatible PID 11798: screenshot timeout, then SIGTERM cleanup after 20s | Drain 3ms; native exit returned after 81ms. All 888 main-thread samples wait for ThreadPool shutdown; the background worker again waits in `fsync`. Open-file snapshot includes Chromium `DIPS`/WAL and a zero-byte `declarative_performance_observer.db` with its 512-byte journal. No application `volli.db` is open in this snapshot. |

Artifacts: each run's `smoke-results-rest-2-attempt-1`, including **both smoke
attempts** and their separate `newer-db-*` evidence directories. Traces record
parent quit request, main quit invocation/return, `before-quit`, drain
start/settlement, native-exit entry/return, `will-quit`/`quit`, Node's exit event,
and the parent's actual observed child exit. Native samples select only the
tracked main PID and its descendants; a slow close also records scoped open files.

The second and third captures locate the failed cleanup **after** the application
shutdown drain and `app.exit()` return, in Chromium's native persistence teardown.
They do not support attributing these occurrences to Playwright's close
acknowledgement or VC-536's previously captured synchronous GPU/Viz window
teardown wait. A code-zero child exit is already accepted by `closeAppBounded`
even if the Playwright acknowledgement times out.

`drain-settled` by itself is not proof of a successful drain: the aggregate also
settles on its deadline/error path. These captures have no drain deadline or
coordination/RPC-close error. Electron's Node `exit` and app `quit` events occur
before actual process termination and must not be substituted for child exit.

## Separate slow successful sample

Run 37246547328's successful retry, compatible PID 20034, lasted 12.177s from
quit request to observed code-zero exit. Its main sample waits in
`BrowserProcessIOThread::ProcessHostCleanUp()` for the Network Service peer,
then in `TaskTracker::CompleteShutdown()`. Matching UUID and disassembly identify
the network wait as the existing bounded 10-second cookie/cache-flush wait.
This successful occurrence is not evidence that that wait caused the failed
20-second closes. Nearest-export sample labels such as c-ares DNS, V8 printing,
and V8 integer allocation are misleading for the stripped Chromium image.

Pinned source:
- [Network Service shutdown wait](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/browser_process_io_thread.cc)
- [ThreadPool shutdown barrier](https://github.com/chromium/chromium/blob/152.0.7977.54/base/task/thread_pool/task_tracker.cc)
- [VC-536 evidence and limits](smoke-flakes-2026-10.md#vc-536-database-recovery-native-shutdown-investigation)

## First identified writer and partial mitigation

UUID-matched disassembly of failed PID 7033 maps its background task to:

```text
DeclarativePerformanceObserverStore::Backend::LoadPoliciesOnDbSequence
  → InitOnDbSequence → sql::MetaTable::Init → COMMIT
  → sqlite3PagerCommitPhaseOne → syncJournal → unixSync → fsync
```

The sampled `syncJournal` return PC (rebased `0x1ade068`) syncs the rollback
journal handle, not Volli's database. The `fsync` return PC is `0x2522008`.
The archived observer database is empty and its journal is a valid 512-byte
header for a new 4096-byte-page database. The third capture's open-file inventory
independently corroborates those files, although no syscall-entry numeric fd was
recorded. The underlying reason macOS CI storage stalls inside this sync is not
established.

Chromium constructs the observer store for every persistent partition when its
**browser base feature** is enabled. Its default runner is `MayBlock`,
`BEST_EFFORT`, `BLOCK_SHUTDOWN`; loading immediately initializes an absent store.
The browser base feature is enabled by default even though the webpage API is
experimental/origin-trial controlled. Thus a fresh app boot with no observer
policy starts an unnecessary durable write that native shutdown must wait for.
Closing the store cannot leapfrog its initialization on the same sequenced runner.

The current partial mitigation disables `DeclarativePerformanceObserver` before any partition exists,
merging rather than replacing existing `disable-features`. It applies equally to
packaged/development apps and smokes. Volli has no integration with this
experimental HTTP performance-reporting feature. Third-party pages in its browser
lose this optional telemetry, not ordinary browsing or JavaScript
`PerformanceObserver`. **DIPS/bounce-tracking protection remains enabled.**
Application SQLite, cookies/cache and other Chromium persistence keep their sync
settings and shutdown barriers. The product quit coordinator/socket fallback are
unchanged; no native watchdog, grace increase or forced-cleanup success is used.
This avoids the identified unnecessary initialization, not every possible native
exit stall or the underlying filesystem condition.

Pinned ownership sources:
- [Observer store and task traits](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/declarative_performance_observer/declarative_performance_observer_store.cc)
- [Partition feature gate](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/content/browser/storage_partition_impl.cc#1613)
- [Browser base feature vs experimental renderer API](https://chromium.googlesource.com/chromium/src/+/152.0.7977.54/third_party/blink/renderer/platform/runtime_enabled_features.json5#2228)

A later [upstream priority change](https://github.com/chromium/chromium/commit/347bdfa8acbcd5895566dd53d2dbd9d02fdb2427)
raises this runner from BEST_EFFORT to USER_VISIBLE to address delayed data-clearing
work. It preserves BLOCK_SHUTDOWN and is not proof of a fix for a running fsync.

Temporary product instrumentation is removed. Smoke-only breadcrumbs/native
samples are retained only on failure, under the existing CI artifact directory;
local tracing is opt-in via `VOLLI_NEWER_DB_TRACE=1`. Diagnostic I/O is
best-effort and cannot prevent the original native exit or reject successful
cleanup; failure-injection tests cover both. The built smoke verifies the
feature switch and absence of the observer DB/journal at launch and after clean
exit, in all three profiles.

Initial candidate `67802aa7a`, [run 37249244261](https://github.com/hussainph/volli-code/actions/runs/37249244261),
passed the full CI gate and newer-database on its first attempt (three graceful
code-zero closes, no shard-2 FLAKY results). Local build, desktop typecheck,
`vp check`, 32 product tests and 31 helper tests passed; the new feature policy has
100% focused coverage. Local newer-database and recovery journeys passed all
8 and 11 checks, respectively, with 10/10 graceful exits. A second local
newer-database journey with final smoke-only tracing also passed (3/3 closes).
The candidate is **not sufficient**. Final-head CI run 37249888674 on
`331a5a547` failed its first workflow attempt; its diagnostic rerun is job-green
only because of a retry (`FLAKY`). The clean pass streak is **0/8**. The first
workflow attempt's second smoke attempt had three graceful exits but failed a
compatible-page screenshot timeout, a separate uncorrected failure.

## Remaining writer: Bounce Tracking Mitigation (DIPS)

Run 37249888674 attempt 1, incompatible PID 7192, verified no observer DB but
still needed SIGTERM after 20 seconds. Native-exit returned at +133ms. Matching
the same framework UUID at this sample's own load base (`0x10ed84000`) maps all
979 main samples to `TaskTracker::CompleteShutdown` and the background worker to:

```text
BtmStorage → BtmDatabase constructor → Init → InitImpl → OpenDatabase
  → sql::Database::OpenInternal → PRAGMA journal_mode=WAL
  → sqlite3PagerCommitPhaseOne → syncJournal → unixSync
```

The journal sync call is the same `0x1ade068` as the observer-store failure,
but the caller is a different store. All 979 worker samples are within that
sync. Only 29 samples are inside `fsync`; the remaining 950 stop at instruction
`0x2522028` after successful fsync, before opening the parent directory for its
sync. This is **not proof of 20 seconds blocked in a single fsync**. A thread
stopped at a user instruction could be unscheduled, kernel-held or faulting;
`sample` alone cannot distinguish them. Scoped lsof shows only `DIPS` (zero
bytes) and `DIPS-journal` (512 bytes), with no `volli.db` or observer store. The
archived DIPS header later contains a WAL-mode page, showing some progress
before the forced cleanup.

The diagnostic workflow rerun (attempt 2) first fails seed PID 7757: native-exit
returned at +2.201s, SIGTERM at +20.047s, all 968 worker samples in the same
BTM database initializer's SQLite sync. DIPS/DIPS-journal are
again the only open browser-profile databases; its fresh-profile retry passes.

Chromium's BTM runner is `BEST_EFFORT`, `PREFER_BACKGROUND`, default
`SKIP_ON_SHUTDOWN`. An already-running SKIP task still blocks shutdown. On macOS
this background thread type maps to `QOS_CLASS_BACKGROUND`. Low-priority I/O,
App Nap and loaded-VM scheduling remain hypotheses, not captured causes. New
failure-only CI stackshots are intended to distinguish those explanations.
Disabling DIPS globally would remove a browser privacy feature and is **not
applied**. App SQLite durability, native shutdown and the grace stay unchanged.

Pinned sources:
- [BTM service and task traits](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/btm/btm_service_impl.cc)
- [BTM database initialization](https://github.com/chromium/chromium/blob/152.0.7977.54/content/browser/btm/btm_database.cc)
- [macOS thread-type mapping](https://github.com/chromium/chromium/blob/152.0.7977.54/base/threading/platform_thread_apple.mm)
- [Running SKIP tasks block shutdown](https://github.com/chromium/chromium/blob/152.0.7977.54/base/task/thread_pool/task_tracker.cc)

Candidate CI artifacts also show **all 17 gating smokes that call
`closeAppBounded` passed on their first attempt**, including database recovery,
browser recovery/trace, the eight Automation journeys, provisional chat,
settings search, split view, ticket-open IPC and contrast. The helper's 27 tests
still hold child ownership, deadlines, natural-exit races and signal escalation.
Five other callers remain outside the gate under unchanged existing policy:
credentialed Pi project/ticket chat, legacy settings-fill/global-artifacts, and
the hour-long reflow research matrix. Those were not run and are not claimed green.

`quit-window-lifecycle-smoke.mjs` is legacy denied for a **second launch that never
reports a ready window**, not part of the measured nightly quarantine. It shares
the product shutdown path, but bypasses Playwright context-close for its normal
quit. A temporary non-gating observation in candidate run 37249244261 passed
checks 1–4: dirty editor, Cancel preserving app/socket, then accepted Discard
exiting code zero with its socket removed. The second launch returned a ready
window, then failed **seeded project selection** (`waitForSeededProjectReady`,
line 619), before check 5. This remaining relaunch/UI-readiness failure is not
fixed by suppressing observer storage and has not been shown to share VC-635's
native-close cause. The temporary observation hook is removed.
