# Agent turn critical path under 1 / 5 / 15 / 20 concurrent Sessions (VC-441)

**Finding: this measurement found no runtime-layer bottleneck, so VC-441 opens
no follow-up ticket.** A scripted turn takes the same time (±2%) whether one
synthetic Session is running or twenty. The only part that grows with
concurrency is a ~2 ms wait behind other Sessions' synchronous work on the
shared event loop. That is about 1.5% of a 142 ms turn, and far below anything
worth changing the scheduler for. Contention in the real Electron main
process, with attached Pi contexts, IPC, SQLite and renderer traffic, is
outside this fixture and belongs to **VC-445**.

Generated artifacts beside this file, in `vc-441-agent-turn-time/`:
`benchmark.md` (per-arm table plus method and limits), `benchmark.json` (raw
aggregates, parameters, environment) and `run-manifest.json`. The generator
rewrites that directory, so this report is kept outside it.

## Reproduction

```sh
pnpm -C packages/agent-runtime bench:turn-to-completion -- \
  --output ../../docs/research/perf/vc-441-agent-turn-time \
  --repetitions 20 --concurrencies 1,5,15,20
```

The tests run in the bench lane, not the default one (`include: ["src/**/*.test.ts"]`):

```sh
pnpm -C packages/agent-runtime exec vp test run --config vite.bench.config.ts bench/turn-to-completion/
```

Fixture `vc441-turn-critical-path-v1`. The recorded run used source commit
`80f0fb7a` (clean tree), Node v24.18.0, macOS (darwin 25.5.0), an Apple M1 with 8
logical cores and 16 GiB of RAM. That machine was shared and busy: the 1-minute load
average was about 9.5–10 on 8 cores for the whole run. Since then the branch
has been synced with `main`. The only change on `main` that touches the measured
path (`instrumentStreamFn`, `ObservabilityReducer`, `teeObservationsToSink`) added
one `AttentionEvent` reason, `transport`, which the fixture never emits. The
published numbers were not regenerated. A post-sync smoke run at 1 and 20
Sessions (20 waves each) matched them: first message → done p50/p95 was
141.8/143.3 ms and 145.0/149.7 ms, and authority wait p50 was 11.7 ms and
15.0 ms.

## What the fixture measures

Each synthetic Session runs one scripted turn through Volli's real VC-119
metadata-only instrumentation. A local in-process stream stands in for the
provider, so the run opens no socket, makes no provider call, enables no OTLP
exporter and reads no profile. One turn contains:

- 3 model attempts: tool use, then a synthetic invalid-request error, then success.
- One tool round with `read`, `bash`, and an MCP-like batch of 3 concurrent timers
  at 18, 26 and 34 ms.
- 1 authority wait of 12 ms.
- 1 overflow compaction.
- 1 retry.

Every turn is checked against those counts. Any drift, an event out of order,
or a missing span fails the run.

| Sessions | Turns (n) | First message → done p50 / p95 | Submit → turn start p50 / p95 | Authority wait p50 / p95 | Unaccounted gap p50 / p95 | Loop delay p95 / max | Runner CPU (% one core) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 141.9 / 143.6 ms | 1.19 / 1.30 ms | 11.9 / 12.7 ms | 8.55 / 9.77 ms | 1.35 / 3.1 ms | 2.2 |
| 5 | 100 | 141.9 / 144.7 ms | 1.19 / 1.53 ms | 12.3 / 13.7 ms | 8.46 / 9.51 ms | 1.29 / 3.5 ms | 3.6 |
| 15 | 300 | 143.9 / 149.4 ms | 1.20 / 1.85 ms | 14.1 / 17.3 ms | 8.57 / 9.51 ms | 1.33 / 22.9 ms | 6.5 |
| 20 | 400 | 144.1 / 146.4 ms | 1.21 / 1.32 ms | 14.2 / 16.6 ms | 8.56 / 9.08 ms | 1.31 / 6.6 ms | 6.4 |

All 820 turns had complete accounting and none had an ordering violation. Provider
attempt duration (p50 ≈ 30.4 ms) and TTFT (p50 ≈ 9.2–9.3 ms) do not move
with concurrency. Neither does the MCP-like batch (p50 ≈ 33.1–33.2 ms, which is
its longest child, so the children really overlapped). The full columns are in
`benchmark.md`.

## Bottlenecks (the ticket allows at most two)

**None qualifies in the runtime layer.** The candidates, and why each was ruled out:

1. **Queueing behind other Sessions on one event loop.** This is the only
   signal that grows with concurrency. Authority wait p50 rises from 11.9 ms to
   14.2 ms between 1 and 20 Sessions, and p95 from 12.7 ms to 16.6 ms. Timer
   lateness measured inside the timer callbacks stays at 0 (p95). So the extra
   time comes after the timer fires, while the continuation waits behind other
   Sessions' synchronous tool and compaction work. The effect is real but only
   ~2 ms per wait. It does not justify a scheduler change.
2. **Dispatch (submit → turn start)** holds flat at ~1.2 ms p50 at every
   concurrency level, so there is no queue in front of the turn.
3. **The unaccounted gap** holds flat at ~8.5 ms p50. That is the scripted 6 ms
   retry backoff, the fixture's compaction CPU work, and orchestration. The
   VC-119 compaction event has no duration, so compaction time cannot be
   separated from the gap. See "Missing data" below.

The single 22.9 ms event-loop-delay maximum in the 15-Session arm is one
sample on a machine at load ~9.5. It does not show up in any turn p95, and I
treat it as host noise, not a trend.

**Where contention would actually appear: VC-445.** This fixture runs all
Sessions in one Node process doing very little else. Volli binds Pi contexts
in Electron main, next to IPC, SQLite, the browser host, and renderer
coordination. VC-445 measures loop delay, IPC round trip, heap/GC and RSS for 1 / 5 / 10 / 20
bound Pi contexts in that process. VC-441 deliberately measures none of it.

## Real provider and tool time: VC-443 answers most of it

The ticket's optional real-metadata breakdown was **not run here**. Doing it
would mean enabling the VC-119 OTLP exporter or reading a person's local
Session data, and neither was consented to for this ticket. VC-443 (Done,
[`merged-ticket-time-to-merge.md`](merged-ticket-time-to-merge.md)) already
analysed real local metadata read-only, without exporting content. This report
does not repeat that work. What it covers and what it leaves open:

- **Answered by VC-443, for real data:**
  - Where a ticket's time goes. 9% is an agent producing, 4% is an agent silent
    inside a turn, 5% is failure-blocked, and 82% is waiting on people, review
    or the queue.
  - Real tool-call durations, by tool and by bash category, from 106,758 Pi
    tool calls. Waiting tools (`ask_user`, sleep polling, `ticket_await`, CI
    watching) are 60% of tool hours. Tests, coverage, e2e and typecheck are 28%.
  - Provider-side external failures: 96.5 h of transient-network blocking and
    49.9 h of quota blocking. Changes for both shipped with that ticket.
- **Still unanswered:** real per-attempt provider inference duration and TTFT,
  and real authority-wait durations inside a turn. VC-443 works at ticket
  scale from ledger write gaps, not from VC-119 spans. Answering this needs a
  person to opt in to local VC-119 metadata collection. The instrumentation
  this fixture exercises is the same code that would record it, so no new
  measurement is needed, only consent and a collection window.

## What synthetic timing cannot prove

The provider stand-in is a set of fixed local timers. It says nothing about:

- real inference time,
- provider-side queueing,
- per-account or per-organization quotas and rate limits,
- 429 or overload behaviour under 20 real parallel requests,
- network variance,
- how real tool commands (tests, builds, browser, remote MCP or serverless)
  scale when they share CPU and disk.

The fixture tools are tiny CPU loops (`read` about 0.06 ms, `bash` about 0.15 ms),
so the fixture cannot show CPU contention between heavy real tools. Running 20
real provider calls was out of scope and was not done.

## Uncertainty and missing data

- Turns in one wave share a host interval, so they are not independent samples.
  Percentiles are nearest-rank, and no confidence interval is claimed.
- The host was heavily loaded (load ~9.5–10 on 8 cores) during the run. That
  adds noise but makes an understated contention effect less likely.
- CPU, RSS and heap figures are for the benchmark runner process, not for
  Electron or a production Session.
- VC-119's compaction event has no duration, so compaction and retry backoff
  fall into the unaccounted gap. A missing span keeps that span's value `null`
  and marks the gap incomplete. It is never counted as zero (covered by tests).

## Tests

`packages/agent-runtime/bench/turn-to-completion/analysis.bench.test.ts` runs in
the bench lane only. It covers:

- **Ordering and missing spans.** An out-of-order turn envelope is flagged, and
  absent provider, tool, authority and retry spans stay `null`, with the gap
  marked incomplete.
- **Privacy, per sample.** A fixture turn whose prompt, stream deltas, tool
  subject, input and output all carry a canary string produces a sample
  without the canary or the native MCP tool name.
- **Privacy, published artifacts.** A full benchmark run is written to a temp
  directory, and all three published files are checked to be free of the canary,
  the native tool name, and tool call ids.
- **Statistics.** The p50/p95 are nearest-rank.

## Coordination

- **VC-318** owns the broad 1/4/10 resource matrix and the eviction policy.
- **VC-366** and its follow-up **VC-445** own process topology and Electron-main
  contention.
- **VC-245** (Done) owns the parallel-tool baseline in `bench/parallel-tools/`.
  This fixture shares no code with it beyond the bench vitest config.
- **VC-442** and **VC-444** report task latency for their own prototypes. This
  fixture is not a baseline for them.
