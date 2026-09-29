# Agent turn critical path under 1 / 5 / 15 / 20 concurrent turns (VC-441)

**Finding: no runtime-layer bottleneck showed up, and this fixture could not
have shown one.** A scripted turn run through Volli's VC-119 instrumentation
takes about the same time whether 1 or 20 turns are in flight: first message →
completion p50 went from 141.0 to 143.9 ms. The one component that grows with
concurrency is the authority wait, by about 2 ms at p50. The cause is its timer
firing late while other turns' synchronous tool work runs on the same event
loop.

That is head-of-line blocking. It is small here because the fixture's tools are
tiny CPU loops. The fixture never runs the Session runtime, its input queue, the
Pi agent loop, the authority gate, or the ledger, so a queue in any of those is
absent by construction, not measured as absent. VC-441 therefore names no
bottleneck. It files the two measurement gaps as follow-ups:

- **VC-455** adds compaction duration and submit → turn-start time to VC-119.
- **VC-456** runs this workload through the real runtime path.

Contention in the Electron main process is **VC-445**'s scope.

Generated artifacts beside this file, in `vc-441-agent-turn-time/`:

- `benchmark.md` has the per-arm table plus method and limits.
- `benchmark.json` has the raw aggregates, including signed timer lateness per
  timer kind, the parameters, and the environment.
- `run-manifest.json`.

The generator rewrites that directory, so this report is kept outside it.

## Reproduction

```sh
pnpm -C packages/agent-runtime bench:turn-to-completion -- \
  --output ../../docs/research/perf/vc-441-agent-turn-time \
  --repetitions 20 --concurrencies 1,5,15,20
```

Tests (bench lane):

```sh
pnpm -C packages/agent-runtime exec vp test run --config vite.bench.config.ts bench/turn-to-completion/
```

Fixture `vc441-turn-critical-path-v2`.

- **Source:** commit `94359da1` (clean tree), synced with `main` at `e9a74349`.
- **Machine:** Node v24.18.0, macOS (darwin 25.5.0), Apple M1, 8 logical cores, 16 GiB.
- **Load:** the machine was shared and busy. The 1-minute load average was
  about 8.9–9.4 on 8 cores for the whole run. An earlier v1 run on the same host
  gave the same turn times to within about 1 ms.

## What the fixture measures

Each scripted turn runs through the real VC-119 `instrumentStreamFn`,
`ObservabilityReducer` and `teeObservationsToSink`, with a local in-process stream
standing in for the provider. The run opens no socket, makes no provider call,
enables no OTLP exporter and reads no profile or Session database. A turn is:

- 3 model attempts: `toolUse`, a synthetic invalid-request `error`, then `stop`.
- One tool round with a CPU-fixture `read`, a CPU-fixture `bash`, and an
  MCP-like batch of 3 concurrent 18 / 26 / 34 ms timers.
- A 12 ms authority wait.
- One overflow compaction.
- One retry, with 6 ms of backoff.

Every turn is checked against those counts and against its causal order. Any
drift fails the run. All timers record signed lateness: a negative value means
Node fired the timer before its `performance.now()` target. Up to about 2 ms
early is normal, because libuv caches its loop clock.

| Concurrent turns | Turns (n) | First message → done p50 / p95 | Submit → turn start p50 / p95 | Authority wait p50 / p95 | Authority timer lateness p50 / p95 | Unaccounted gap p50 / p95 | Loop delay p95 / max | Runner CPU (% one core) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 20 | 141.0 / 143.2 ms | 1.18 / 2.29 ms | 11.4 / 12.1 ms | −0.62 / 0.04 ms | 8.46 / 9.54 ms | 1.36 / 5.1 ms | 2.4 |
| 5 | 100 | 142.0 / 145.2 ms | 1.23 / 2.25 ms | 11.7 / 12.8 ms | −0.30 / 0.79 ms | 8.59 / 9.64 ms | 1.38 / 9.7 ms | 4.0 |
| 15 | 300 | 143.7 / 150.4 ms | 1.26 / 2.34 ms | 12.9 / 16.0 ms | +0.89 / 3.97 ms | 8.64 / 10.07 ms | 1.66 / 10.1 ms | 7.3 |
| 20 | 400 | 143.9 / 147.5 ms | 1.24 / 1.44 ms | 13.6 / 16.7 ms | +1.60 / 4.74 ms | 8.65 / 9.84 ms | 1.42 / 7.5 ms | 7.5 |

Other results:

- All 820 turns had complete accounting, exactly one tool round, and no ordering
  violations.
- These did not move with concurrency:
  - provider attempt duration, p50 about 30.3–30.8 ms;
  - TTFT, p50 about 9.3 ms;
  - the MCP-like batch, p50 about 33.1–33.3 ms. That is its longest child, so
    the three children really did overlap.
- The full columns are in `benchmark.md`.

## Bottlenecks (the ticket allows at most two)

**None is named.** What the data does show:

1. **Head-of-line blocking on the shared loop.** This is the only effect that
   grows with concurrency. The authority timer's lateness moves from p50
   −0.6 ms / p95 0.0 ms at 1 turn to +1.6 / 4.7 ms at 20, which accounts for the
   authority wait growing from 11.4 to 13.6 ms p50. Every turn in a wave reaches
   its authority wait at about the same moment. Each turn's callback then runs
   that turn's synchronous `read` / `bash` CPU work (about 0.2 ms) before the
   next turn's callback can fire. At 20 turns that stacks to the ~4–5 ms seen at
   p95. The other timers (TTFT, completion, batch) fire at staggered moments and
   stay near zero.

   At this size the effect is about 1.5% of a turn and not a bottleneck. With
   real synchronous work on the loop (token counting, compaction, parsing large
   tool results) it would scale with that work. Measuring that needs VC-456 in
   this runtime layer and VC-445 in Electron main.
2. **Submit → turn start stays flat at about 1.2 ms p50.** This only times the
   fixture's own 2 ms dispatch timer; libuv fires it early, which is why the p50
   is under 2 ms. It is not evidence about any real queue in front of a turn,
   because the fixture has no such queue. VC-455 adds the real measurement.
3. **The unaccounted gap stays flat at about 8.5 ms p50.** It contains the 6 ms
   retry backoff, the fixture's compaction CPU work, and orchestration. VC-119's
   compaction event has no duration, so compaction can't be separated out. That
   missing measurement is also VC-455.

The runtime-layer measurement the ticket asked for ("the minimal missing
measurement necessary to distinguish queues/host delays") therefore splits in
two:

- **Local host delay** is now measured, in signed form, per timer kind. That is
  what exposed the effect in point 1.
- **The real queue and compaction spans** need VC-119 fields that don't exist
  yet. They are filed as VC-455 rather than added in a measurement ticket.

## Real provider and tool time: VC-443 answers most of it

The ticket's optional real-metadata breakdown was **not run here**. It would
mean enabling the VC-119 OTLP exporter or reading a person's local Session data,
and neither was consented to for this ticket. VC-443 (Done,
[`merged-ticket-time-to-merge.md`](merged-ticket-time-to-merge.md)) already did a
read-only, content-free analysis of real local metadata, so this report
cross-references it rather than repeating it.

- **Answered by VC-443, for real data:**
  - **Where a ticket's time goes.** This comes from Session ledger events: 9% an
    agent producing, 4% an agent silent inside a turn, 5% failure-blocked, and
    82% waiting on people, review or the queue.
  - **Real tool-call durations.** These come from Pi session files: 106,758
    calls. Waiting tools (`ask_user`, sleep polling, `ticket_await`, CI watching)
    are 60% of tool hours. Tests, coverage, e2e and typecheck are 28%.
  - **Provider-side external failures.** 96.5 h of transient-network blocking
    and 49.9 h of quota blocking. VC-443 shipped changes for both.
- **Still unanswered:**
  - Real per-attempt provider inference duration and TTFT.
  - Real authority-wait durations inside a turn.
  - Real queue time before a turn starts.

  VC-443's categories come from gaps between ledger writes, and its tool times
  from Pi's session files. Neither source carries VC-119's per-attempt spans. The
  first two need a person to opt in to a local VC-119 collection window, using
  the same instrumentation this fixture exercises. The third needs VC-455 first.

This fixture reads no Session ledger events. VC-456 adds that, cross-checking
ledger order against VC-119 envelopes on the real runtime path.

## What synthetic timing cannot prove

The provider stand-in is fixed local timers. It says nothing about:

- real inference time;
- provider-side queueing;
- per-account or per-organization quotas and rate limits;
- 429 or overload behaviour under 20 real parallel requests;
- network variance;
- how real tool commands (tests, builds, browser, remote MCP or serverless)
  scale when they share CPU and disk.

The fixture tools are tiny CPU loops: `read` about 0.06 ms, `bash` about 0.15 ms.
No run with 20 real provider calls was made.

## Uncertainty and missing data

- Turns in one wave share a host interval, so they are not independent samples.
- Percentiles are nearest-rank, with rank ceil(q·n). No confidence interval is
  claimed.
- The host was heavily loaded, which adds noise.
- The early-firing timers mean small lateness values sit within about ±2 ms of
  the clock-cache artifact. The authority trend is visible because it rises
  above that floor, and it is consistent across the 15- and 20-turn arms.
- CPU, RSS and heap figures are for the benchmark runner process, not Electron
  or a production Session.
- A missing span keeps its value `null` and marks the gap incomplete. It is
  never counted as zero.

## Tests

`packages/agent-runtime/bench/turn-to-completion/analysis.bench.test.ts` runs in
the bench lane only. The default `src/**/*.test.ts` lane, and so
`vp run -r test` and CI, does not run it.

- **Missing spans.** A tool with no duration, an authority envelope with no wait,
  missing provider attempts, and a turn with no terminal envelope each stay
  `null` and mark the gap incomplete.
- **Event ordering.** The check uses the sink's emission order and the turn's
  causal shape, so it can fail even when every timestamp increases. It fails
  when:
  - a timestamp goes backwards;
  - the turn completes before its final attempt;
  - a tool runs before any `toolUse` attempt, or after the final attempt;
  - an event follows the terminal envelope.

  Tool rounds are derived from that shape, not assumed.
- **Privacy.** The canary is in the system prompt, the user message, the stream
  deltas, the provider error message, and the tool subject, input and output.
  The tests check three places:
  - the raw envelopes VC-119's own reducer and stream instrument emitted (not
    the bench's field allow-list). Forcing the error message into
    `providerErrorClass` in `src/pi/observability.ts` fails this test;
  - the per-turn sample;
  - all three published artifact files.

  None of them may contain the canary, the native MCP tool name, or tool call ids.
- **Guards.** The limit checks on repetitions and concurrency, and the
  output-directory checks, are tested. The output directory is validated before
  the run starts, so a bad destination fails fast.
- **Statistics.** Nearest-rank p50/p95 at n = 10, 11 and 20, where ceil and floor
  rank rules give different answers. Signed mode is tested too.

Known limit: because these tests are bench-lane only, CI would not catch a
regression in them.

## Coordination

- **VC-318** owns the broad 1/4/10 resource matrix and the eviction policy.
- **VC-366**, and its follow-up **VC-445**, own process topology and Electron-main
  contention.
- **VC-245** (Done) owns the parallel-tool baseline in `bench/parallel-tools/`.
  This fixture only reuses its bench vitest config and its esbuild-runner
  pattern.
- **VC-442** and **VC-444** report task latency for their own prototypes. This
  fixture is not their baseline.
- **VC-455** and **VC-456** are the follow-ups filed from this ticket.
