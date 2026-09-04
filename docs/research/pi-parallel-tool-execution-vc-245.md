# Pi's built-in parallel tool execution, measured (VC-245)

**Status:** research. Nothing here changes product behaviour; `toolExecution` is
still `"sequential"` on this branch.

**Subject:** one line — `packages/agent-runtime/src/pi/runtime.ts:1310`, where
Volli opts out of Pi's default. This note is the baseline VC-245 asks for
before any Code Mode work: what does flipping that line actually buy, and what
does it cost?

> **Correction, and it reverses this note's original recommendation.** The
> first two lanes were synthetic, and they were measuring a workload that does
> not exist. An audit of 671 real Sessions shows parallel mode would have saved
> **1.2% of tool time**, not the 23–51% the synthetic tasks suggested — and
> that the token problem the synthetic lanes said was fully harvested is in
> fact the largest thing in the system. **Do not flip the flag on the strength
> of the synthetic numbers.** See [The real workload](#the-real-workload).

**Evidence, three lanes:**

- **Offline** — `packages/agent-runtime/bench/parallel-tools/`, run with
  `pnpm -C packages/agent-runtime run bench`. Pi's real `Agent`, its real
  batching, preflight, `beforeToolCall` gate and result ordering all run
  unmodified. Only the provider call and the tools are faked, and the tool
  latencies are measured rather than guessed (`bench:probe`). Reaches no
  provider, spends nothing.
- **Live** — `bench:live`, gated behind `PI_LIVE_BENCH=1`. Real models against
  Volli's real composed system prompt, measuring how often a model batches
  *when handed a batchable task*. ~$0.64 total spend across claude-haiku-4-5
  and claude-sonnet-4-5.
- **Real** — `transcript-audit.ts`, over **671 local Sessions, 1,745 turns,
  72,459 tool calls, $3,253 of recorded spend**. Read-only and aggregate-only.
  This is the lane that matters; the other two are hypotheticals it corrects.

---

## The short answer

**Parallel mode is not worth doing. Code Mode probably is.** That is the
opposite of what the synthetic lanes implied, and the real audit is why.

| Lever | Real measured effect | Verdict |
|---|---|---|
| `toolExecution: "parallel"` | saves **1.2%** of tool time (1.57h of 127.6h), 84% of it on `bash` | **not worth the concurrency risk** |
| Prompting for batching | no change on either model | **no-op, do not ship** |
| Code Mode | addresses **54%** of all billed context; saves **27–51%** after overheads | **the real opportunity** |

The single most important number in this note: **tool results are 92.6% of
everything Volli ever sends a model.** Billed context across those Sessions was
3.40 billion tokens, and roughly 3.15 billion of it was tool results being
re-sent round after round. Latency was never the expensive axis.

---

## The real workload

The synthetic lanes asked "what would parallel mode save on four independent
browser tabs?". Real Sessions almost never do that. They run `bash`, read a
file, edit it, run `bash` again — a dependent chain.

| | synthetic lanes | real Sessions |
|---|---|---|
| replies carrying 2+ calls | 100% | **16.9%** |
| tool calls that could overlap | 65% | **23.6%** |
| dominant tool | browser / web | **`bash` (49,616 calls, 68% of all)** |
| mean tool duration | 900ms assumed | **`bash` 8,242ms measured** |

Because Volli executes sequentially today, consecutive tool-result timestamps
*are* the per-call durations. So the wall-clock question needed no model at
all — for every batch ever issued, sequential cost is the sum of its durations
and parallel cost is the largest:

| quantity | measured |
|---|---|
| time batched replies actually took | 8.53h |
| time they would take overlapped | 6.95h |
| **wall-clock saved** | **1.57h** |
| total tool time across all Sessions | 127.56h |
| **saved as share of all tool time** | **1.2%** |

1.57 hours spread over 671 Sessions is **~8 seconds per Session**. And 84% of
it is `bash` — the one tool where concurrency is genuinely dangerous, since
two commands share a worktree and a git index. The saving is both negligible
and concentrated in the riskiest possible place.

**The 100% batch rate in the live lane was an artefact of writing batchable
tasks.** Given real work, models batch 17% of the time — correctly, because
real work is mostly dependent.

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

## Seven findings from the synthetic lanes

These hold as statements about Pi's mechanism. Findings 2 and 3 also made
claims about *how often the mechanism applies*, and the real-Session audit
corrects both — flagged inline.

### 1. The mode is token-neutral. Asserted, not assumed.

Every scenario reports identical `totalTokens` and identical model-call counts
in both modes, and the bench **fails** if that ever stops being true. Pi
executes whatever batch the model already emitted; it returns the same results
in the same order either way. Nothing about context, spend or compaction
pressure moves.

Any claim that parallel execution saves tokens is wrong. That is Code Mode's
job, and it remains unproven.

### 2. The win is conditional on batching. ~~Models already batch at ~100%.~~ *(corrected)*

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

> **Corrected by the real audit.** 100% was an artefact of writing tasks that
> *had* independent subtasks. Across 72,459 real tool calls the batch rate is
> **16.9% of replies and 23.6% of calls**, because real coding work is a
> dependent chain. The mechanism claim survives; the frequency claim does not.

### 3. There is no token headroom in *batching*. ~~So no token saving is reachable without Code Mode.~~ *(half corrected)*

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

The nudge finding stands: it is a measured no-op and should not ship.

> **Corrected by the real audit.** The conclusion drawn from it — "no token
> saving is reachable without Code Mode" — was right in letter and badly wrong
> in spirit. It read as *there is little token saving available*. There is an
> enormous one: tool results are **92.6% of all billed context**, and Code Mode
> addresses roughly half of it. See [The Code Mode case](#the-code-mode-case).

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

1. **Whether one developer's Sessions generalise.** All 671 are from a single
   machine and a single working style. The `bash`/`read` dominance and the 17%
   batch rate are behavioural, and both headline conclusions depend on them.
2. **Whether a program can actually reduce those results.** The 58.5% fan-out
   pool is a ceiling. Nothing here measures how much of it survives contact
   with a real reduction — that is what the prototype is for.
3. **Whether `bash` can be safely called from generated code.** The audit says
   Code Mode is only worth building if it can. This note does not answer
   whether it may.
4. **Other providers.** Both live models were Anthropic. The lane takes
   `PI_BENCH_MODEL`, so this is a cheap follow-up.

## The Code Mode case

The same audit measures what Code Mode would be buying, and here the numbers
are large.

**Context is almost entirely tool results.** Modelling the re-send rule over
the real transcripts lands within **11%** of what the provider actually billed
(3.77B modelled vs 3.40B billed), so the decomposition is trustworthy —
compaction is rare enough (46 events across 671 Sessions) not to distort it.

| quantity | tokens |
|---|---|
| billed context (ground truth) | 3,401,671,705 |
| tool results produced once | 65,983,265 |
|  of which intermediate | 65,829,259 (99.8%) |
|  of which from fan-out replies | 38,620,859 (58.5%) |
| **tool-result share of all context** | **92.6%** |

A result produced once is re-sent on every later round of its turn. That is
why 66M tokens of tool output becomes ~3.15B tokens of billed context.

**The counterfactual, with overheads charged.** For the fan-out replies that
really happened, a program pays two costs the naive figure ignores: the source
the model must write, and whatever the program returns, which still enters
context and is still re-sent. Sweeping how much a program condenses:

| program returns | context tokens saved | share of all billed context |
|---|---|---|
| 5% of results | 1,731,544,193 | **50.9%** |
| 10% | 1,640,286,367 | **48.2%** |
| 25% | 1,366,512,889 | **40.2%** |
| 50% (pessimistic) | 910,223,760 | **26.8%** |

9,418 fan-out replies × ~250 tokens of program source = 2.35M output tokens of
overhead, already subtracted.

Even at a deliberately pessimistic 50% condensation, Code Mode addresses **more
than a quarter of everything Volli sends a model**.

**Two caveats that matter, both against the optimistic reading:**

1. **Cost ≠ tokens.** The cache split is 3.29B read against 72M written, so
   re-sent context is ~97% cache reads, billed near a tenth of fresh input.
   The token saving is real for *context-window pressure* — which is what
   limits session length and drives compaction — but the dollar saving is a
   fraction of the token saving.
2. **"Fan-out" is a ceiling, not a capture rate.** It counts results from
   replies that issued 2+ calls. A program only captures those if it can
   perform the reduction the model would have done. Semantic comparison
   ("do these three files agree?") does not reduce in code; extraction and
   filtering does.

**And the design constraint the audit settles.** 95% of fan-out volume is two
tools:

| tool | fan-out result tokens | share of fan-out | share of that tool's own output |
|---|---|---|---|
| `bash` | 21,949,292 | 56.8% | 51.6% |
| `read` | 14,796,307 | 38.3% | 70.5% |
| `web_fetch` | 1,503,729 | 3.9% | 91.4% |
| `web_search` | 333,318 | 0.9% | 95.5% |

**A Code Mode that excludes `bash` and `read` captures almost none of the
value.** That is a much harder security conversation than the browser and web
tools the ticket's framing centres on, and it should be confronted directly
rather than discovered during a build.

---

## Recommendation

**Do not flip the flag. Do scope Code Mode — around `bash` and `read`.**

1. **Drop the parallel-mode work.** 1.2% of tool time, ~8 seconds per Session,
   84% of it concentrated in the one tool where concurrent execution can
   corrupt a worktree. The concurrency audit it would require costs more than
   the saving is worth. Leave `toolExecution: "sequential"` alone.
2. **Do not ship the batch nudge.** Measured no-op on both models.
3. **Take Code Mode seriously, and scope it to the reduction shape.** The
   target is fan-out replies whose results a program can filter or extract
   without semantic judgement. Design for `bash` and `read` from the start or
   do not build it — the browser and web tools are 5% of the opportunity.
4. **Frame the win as context-window pressure first, cost second.** Caching
   already discounts the re-send by ~10×. The compelling argument is longer
   Sessions before compaction, not the invoice.
5. **Re-run the audit on other people's Sessions before committing.** These
   671 Sessions are one developer's. The batch rate and the `bash`/`read`
   dominance are behavioural, and could differ across users.

## Suggested follow-up tickets

- **Scope a Code Mode prototype around `bash` and `read`** — the loop/filter
  workflow the ticket asks for, aimed at the 58.5% fan-out pool.
- **Decide the `bash`-from-code security position.** This is the blocker for
  anything worth building, and the ticket's current framing does not address
  it.
- **Close the parallel-execution question** with this note as the evidence, so
  it is not re-opened on the strength of the synthetic numbers.
- **Land `transcript-audit.ts` as a standing measurement**, so context
  composition can be re-checked after any prompt or tool change.

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

Real-Session audit — free, read-only, ~2 minutes. Reads the developer's own
local Pi session logs and prints aggregates only; it never retains or emits
message text, tool arguments, command lines, paths or session ids:

```
node --experimental-strip-types \
  packages/agent-runtime/bench/parallel-tools/transcript-audit.ts
VOLLI_PI_SESSIONS="/path/to/pi-sessions" node --experimental-strip-types ...
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
