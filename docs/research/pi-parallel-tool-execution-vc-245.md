# Pi's built-in parallel tool execution, measured (VC-245)

**Status:** research. Nothing here changes product behaviour; `toolExecution` is
still `"sequential"` on this branch.

**Subject:** one line — `packages/agent-runtime/src/pi/runtime.ts:1310`, where
Volli opts out of Pi's default. This note is the baseline VC-245 asks for
before any Code Mode work: what does flipping that line actually buy, and what
does it cost?

**Evidence, two lanes:**

- **Offline** — `packages/agent-runtime/bench/parallel-tools/`, run with
  `pnpm -C packages/agent-runtime run bench`. Pi's real `Agent`, its real
  batching, preflight, `beforeToolCall` gate and result ordering all run
  unmodified. Only the provider call and the tools are faked, and the tool
  latencies are measured rather than guessed (`bench:probe`). Reaches no
  provider, spends nothing.
- **Live** — `bench:live`, gated behind `PI_LIVE_BENCH=1`. Real models against
  Volli's real composed system prompt, measuring the one thing the offline
  lane cannot: how often a model actually batches. ~$0.64 total spend across
  claude-haiku-4-5 and claude-sonnet-4-5.

---

## The short answer

**Volli is currently paying the full token cost of batching while throwing away
all of its time benefit, and the fix is one line.**

Models already batch independent tool calls without being asked — measured at
**100% of independent-task replies on both haiku and sonnet**. So Volli already
gets the token saving that batching produces. It then executes those batches
one call at a time, which discards the 23–51% of turn wall-clock that the same
batch would have saved under Pi's default.

| Lever | Saves time | Saves tokens | Headroom left |
|---|---|---|---|
| `toolExecution: "parallel"` | **yes, 23–51% of batched turns** | no, exactly zero | **all of it — unharvested today** |
| Getting the model to batch | only under parallel mode | yes | **none — already ~100%** |
| Code Mode (not measured here) | yes | yes | unknown, large build |

The middle row was my initial reading and the live lane refuted it: there is no
prompt-level token win available, because the models are already doing it. The
remaining token question belongs entirely to Code Mode. The remaining *time*
win is sitting behind a one-line flag.

---

## What Pi actually does

Read from `dist/agent-loop.js` at the pinned 0.84.3, not from the README alone:

- `"parallel"` is Pi's **default**. Volli explicitly opted out.
- Parallel mode runs **preflight serially** — `tool_execution_start`, argument
  parsing and `beforeToolCall` for every call in the batch, one at a time —
  then starts all approved calls together under one `Promise.all`.
- Persisted `toolResult` messages are emitted in **assistant source order** in
  both modes. Completion events follow completion order.
- **One tool carrying `executionMode: "sequential"` forces the entire batch
  sequential**, not just that call.

`executionMode` currently appears nowhere in Volli's source.

---

## Benchmark

Median of 3 runs. Tool latencies from `profile.measured.json`
(darwin-arm64, Node 24.18): local file 0.1ms, subprocess 1.4ms, network
719.5ms measured over five real HTTPS round trips, `session.start` 5.6ms
measured as write+fsync. Browser (900ms) and provider (1400ms) are **declared
assumptions**, not measurements — neither can be measured from this package —
and both are swept below.

| scenario | batched | tools | model calls | tokens | seq ms | par ms | saved | speedup |
|---|---|---|---|---|---|---|---|---|
| control-single-call | no | 1 | 2 | 2120 | 2809 | 2807 | 2ms | 1.00× |
| browser-tabs-batched | yes | 4 | 2 | 2120 | 6414 | 3708 | 2706ms | **1.73×** |
| browser-tabs-unbatched | no | 4 | 5 | 5300 | 10620 | 10618 | 2ms | 1.00× |
| repeat-search-filter | yes | 6 | 2 | 2120 | 7132 | 3526 | 3606ms | **2.02×** |
| session-fanout | yes | 6 | 3 | 3180 | 6390 | 4936 | 1454ms | 1.29× |
| mixed-batch-poisoned | yes | 4 | 2 | 2120 | 5519 | 5519 | 0ms | 1.00× |

Share of the whole turn, provider latency included:

| scenario | turn (seq) | saved | share of turn |
|---|---|---|---|
| browser-tabs-batched | 6414ms | 2706ms | **42%** |
| repeat-search-filter | 7132ms | 3606ms | **51%** |
| session-fanout | 6390ms | 1454ms | 23% |
| control / unbatched / poisoned | — | ~0ms | **0%** |

Sensitivity — wall-clock saved, by batch size and per-call latency:

| tool latency | n=2 | n=3 | n=5 | n=8 |
|---|---|---|---|---|
| 5ms | 8ms | 15ms | 26ms | 44ms |
| 50ms | 52ms | 104ms | 205ms | 367ms |
| 250ms | 253ms | 502ms | 1007ms | 1763ms |
| 900ms | 903ms | 1806ms | 3612ms | 6316ms |

The saving is `(n-1) × latency`, as expected. It is only worth reaching for on
tools in the hundreds of milliseconds — browser, web fetch, web search. It is
worth nothing on `read`/`edit`/`write`, which measured at 0.1ms.

## Live batch rate

Volli's real composed system prompt, latency-only stand-in tools, two trials
per cell. Arm B adds one sentence permitting batching of independent calls.

| model | arm | batched replies | overlappable calls | model calls | input tok |
|---|---|---|---|---|---|
| haiku-4-5 | A: as shipped | 100% | 65% | 2.8 | 4165 |
| haiku-4-5 | B: + permission | 100% | 65% | 2.6 | 3937 |
| sonnet-4-5 | A: as shipped | 100% | 65% | 2.9 | — |
| sonnet-4-5 | B: + permission | 97% | 64% | 2.9 | — |

Independent tasks only. The sonnet token column is omitted because that run
predates the cache-aware token fix; its batch-rate figures are unaffected.

Per-task, arm A, haiku:

| task | shape | batched replies | tool time seq → par |
|---|---|---|---|
| four-tabs-enumerated | independent | 100% | 3600ms → 900ms |
| three-searches-enumerated | independent | 100% | 1200ms → 400ms |
| implicit-config-check | independent | 100% | 6ms → 2ms |
| implicit-research | independent | 100% | 4200ms → 2350ms |
| dependent-chain | **dependent** | **0%** | 4ms → 4ms |
| single-call-control | single | 0% | 2ms → 2ms |

---

## Six findings

### 1. The mode is token-neutral. Asserted, not assumed.

Every scenario reports identical `totalTokens` and identical model-call counts
in both modes, and the bench **fails** if that ever stops being true. Pi
executes whatever batch the model already emitted; it returns the same results
in the same order either way. Nothing about context, spend or compaction
pressure moves.

Any claim that parallel execution saves tokens is wrong. That is Code Mode's
job, and it remains unproven.

### 2. The win is conditional on batching — and models already batch, at ~100%.

Offline, `browser-tabs-batched` and `browser-tabs-unbatched` do the same four
tab reads. The first saves 2.7s; the second saves **2ms**. The difference is
not the mode — both ran in parallel mode — it is whether the four calls
arrived in one assistant reply or four. So the flag is worth exactly the
fraction of real turns where the model emits two or more independent calls in
one reply.

The live lane measured that fraction against Volli's own system prompt:

| model | batched replies (independent tasks) | overlappable calls | dependent-chain control |
|---|---|---|---|
| claude-haiku-4-5 | **100%** | 65% | **0%** |
| claude-sonnet-4-5 | **100%** | 65% | **0%** |

"Overlappable calls" is `(calls - replies) / calls` — the share of tool calls
that arrived alongside another and could therefore have run concurrently.
Across the whole task set, roughly **two thirds of tool calls are already
arriving in overlappable batches** and Volli is running every one of them
serially.

The rate held on naturally-phrased tasks, not just enumerated ones. "Do our
package.json, tsconfig.json and README.md still agree about the version?"
never names three reads, and both models batched three reads anyway.

### 3. There is no token headroom in batching. That was my error, and the live lane caught it.

Offline, the two browser scenarios needed **2 model calls vs 5** for identical
work, which made batching look like a large, cheap, flag-independent token win
— and Volli's system prompt says nothing about batching in either direction,
so the win looked available.

It is not available, because it is already taken. Arm B added one sentence
giving explicit permission to batch independent calls. It changed nothing:

| arm | batched replies | overlappable calls | model calls | input tokens |
|---|---|---|---|---|
| A: Volli prompt as shipped | 100% | 65% | 2.8 | 4165 |
| B: + batch permission | 100% | 65% | 2.6 | 3937 |

Within noise on every axis, on both models. **Do not ship the nudge** — it
buys nothing and costs a sentence in every system prompt forever.

The consequence for VC-245 is the important part: since batching is already
saturated and the mode is token-neutral, **no token saving is reachable
without Code Mode**. Code Mode's case rests entirely on keeping intermediate
results out of context, and it must be judged against a baseline that already
batches at 100%.

### 4. The obvious safety lever is a trap.

Marking side-effecting tools `executionMode: "sequential"` looks like the way
to keep `session.start` from overlapping. It is not: Pi applies it to the
**whole batch**. `mixed-batch-poisoned` — three 900ms browser reads batched
with one guarded `session.start` — saved **0ms**, peak concurrency 1.

One guarded tool anywhere in a reply silently removes the win from every other
call in it. If we adopt parallel mode, eligibility cannot be expressed this
way; it has to be expressed as *which tools may appear in a batch together*,
or not at all.

### 5. Approvals are already safe, but they head-of-line block.

Measured, both halves:

- **No stampede.** Pi's preflight loop is serial, so at most **one** approval
  prompt is ever live, even in parallel mode. VC-245's worry about several
  simultaneous prompts does not arise on this path.
- **But** preflight for the entire batch completes before *any* call in it
  starts. A call that was allowed instantly still waited the full 200ms for its
  batch-mate's approval to settle. Approvals delay the whole batch, not just
  the call they guard.

That is acceptable, but it should be a stated property rather than something
discovered later.

### 6. Ordering is safe for history; activity sees something different.

Persisted tool-result order was assistant source order in both modes, in every
scenario. The transcript, Session history and compaction are unaffected.
Completion order can differ from persisted order in parallel mode — that is
what the activity stream observes, and it is the one place a reader could see
results "out of order".

### 7. Models decline to batch calls that depend on each other.

The live set includes a control that *must not* batch: read `package.json`,
find the path under its `main` field, then read that file. A model that
batched there would be issuing a call on a result it does not yet have, and
parallel mode would execute that mistake concurrently instead of catching it.

Both models batched it **0% of the time**, in both arms. The hazard parallel
mode would amplify is one the models are not producing.

This is evidence, not a guarantee — six tasks, two models, one provider. It
does mean the risk of flipping the flag sits in *our* tools tolerating
concurrency, not in the model asking for nonsense.

---

## What this does not answer

1. **Whether Volli's tools tolerate concurrency.** This is now the only thing
   standing between the measurement and the flag. A quick read suggests
   `ScopedExecutionEnv` is fine (per-call `mkdtemp`, own child process,
   readonly `cwd`), and that browser tools are the live hazard: refs are valid
   only for a snapshot `generation`, so two concurrent `browser_act` calls on
   one tab can race. Reads across *different* tabs look safe. This needs a
   real audit, not a skim.
2. **Other providers.** Both live models were Anthropic. OpenAI- and
   Gemini-backed Sessions may batch at different rates; the lane takes
   `PI_BENCH_MODEL`, so this is a cheap follow-up rather than new work.
3. **Code Mode itself.** Untouched by this note. Findings 1–3 sharpen what it
   would have to justify: it must beat *a 100%-batching model under parallel
   mode*, not beat today's sequential baseline.

## Recommendation

**Flip `toolExecution` to `"parallel"`, gated on a tool concurrency audit.**
The measurement is unusually clean: the win is large (23–51% of turn time),
free in tokens, available on two thirds of tool calls today, requires no
prompt change, and the models already decline to batch the dependent calls
that would make concurrency unsafe.

Ordered next steps:

1. **Audit tool concurrency safety**, browser tools first (`generation` races
   on one tab), then anything holding process-wide or Session-wide state.
   This is the blocker.
2. **Flip the flag** behind that audit. Note that per-tool
   `executionMode: "sequential"` is not the escape hatch it looks like
   (finding 4) — if some tool must not overlap, the answer is batch
   eligibility, not a per-tool marking.
3. **Do not ship the batch nudge.** Measured as a no-op on both models.
4. **Re-baseline Code Mode against parallel mode**, not against today's
   sequential behaviour, before spending more on it. Its remaining
   justification is tokens, and tokens is the axis the flag does not touch.

## Reproducing

Offline — free, reaches nothing, ~4 minutes:

```
pnpm -C packages/agent-runtime run bench:probe   # re-measure tool latencies
pnpm -C packages/agent-runtime run bench         # prints the tables, asserts the invariants
```

Live — spends money, needs the developer's own Pi credentials, ~3 minutes and
about $0.13 per model at two trials:

```
PI_LIVE_BENCH=1 pnpm -C packages/agent-runtime run bench:live
PI_LIVE_BENCH=1 PI_BENCH_MODEL=anthropic/claude-sonnet-4-5 PI_BENCH_TRIALS=2 \
  pnpm -C packages/agent-runtime run bench:live
```

Both are out of the default `test` lane: the offline bench because it sleeps
for real time, the live lane because it costs money and is skipped unless
`PI_LIVE_BENCH=1`.

## Measurement caveats

- Browser (900ms) and provider (1400ms) latencies in the offline bench are
  **declared assumptions**, not measurements; the sensitivity sweep is there so
  the conclusion does not depend on either. Every other latency was measured.
- The live lane's tools are latency-only stand-ins with honest names and
  descriptions. No page is fetched and no Session is started, so batching is
  measured against realistic tool *shapes* rather than realistic tool *results*.
- Live wall-clock is reported as a modelled counterfactual: each trial runs
  once in parallel mode, and the sequential number is computed from the same
  measured latencies. This is exact for latency-only tools and avoids paying
  for a second run, and it rests on the offline finding that the model cannot
  observe the execution mode.
- Live token accounting sums `input + cacheRead + cacheWrite`. Counting
  `usage.input` alone understates a cached turn by orders of magnitude on
  Anthropic — a cached sonnet turn reports single-digit `input` for a prompt of
  thousands of tokens.
