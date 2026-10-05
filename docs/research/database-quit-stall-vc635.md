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

## Root cause and fix

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

The fix disables `DeclarativePerformanceObserver` before any partition exists,
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
local tracing is opt-in via `VOLLI_NEWER_DB_TRACE=1`. The built smoke verifies the
feature switch and absence of the observer DB/journal at launch and after clean
exit, in all three profiles. Requested eight-run CI pass streak is pending.

`quit-window-lifecycle-smoke.mjs` is legacy denied for a **second launch that never
reports a ready window**, not part of the measured nightly quarantine. It shares
the product shutdown path, but bypasses Playwright context-close for its normal
quit and its documented readiness failure has not been shown to share this cause.
