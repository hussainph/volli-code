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
> **1.2% of tool time**, not the 32–45% the synthetic tasks suggested — and
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
| Code Mode | addresses **24–27%** of all billed context after narrowing (54% ceiling) | **the real opportunity** |

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
| **wall-clock saved** | **1.57h** (upper bound) |
| total tool time across all Sessions | 127.56h |
| **saved as share of all tool time** | **1.2%** |

That 1.57h is an **upper bound**, not a point estimate. The gap between two
tool results contains whatever happened in between, including any approval
wait — and Pi's preflight is serial even in parallel mode, so approval time is
precisely what concurrency cannot recover. The bound errs in favour of parallel
mode while the conclusion drawn from it is against parallel mode, so a tighter
measurement could only weaken the case further.

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
(darwin-arm64, Node 24.18): local file 0.4ms, subprocess 5.1ms, network
554.5ms measured over five real HTTPS round trips, `session.start` 8ms
measured as write+fsync, `ticket.await` 130,600ms measured by the transcript
audit over 241 real calls. Browser (900ms) and provider (1400ms) are
**declared assumptions**, not measurements — neither can be measured from this
package — and both are swept below. Network latency varies run to run, so
absolute milliseconds move between runs; the ratios do not.

| scenario | batched | tools | model calls | tokens | seq ms | par ms | saved | speedup |
|---|---|---|---|---|---|---|---|---|
| control-single-call | no | 1 | 2 | 2120 | 2806 | 2806 | 0ms | 1.00× |
| browser-tabs-batched | yes | 4 | 2 | 2120 | 6413 | 3706 | 2707ms | **1.73×** |
| browser-tabs-unbatched | no | 4 | 5 | 5300 | 10629 | 10612 | 17ms | 1.00× |
| repeat-search-filter | yes | 6 | 2 | 2120 | 6140 | 3381 | 2759ms | **1.82×** |
| session-fanout | yes | 6 | 3 | 3180 | 8157 | 5528 | 2629ms | 1.48× |
| mixed-batch-poisoned | yes | 4 | 2 | 2120 | 5517 | 5518 | -1ms | 1.00× |

`session-fanout` runs its waits at 1/100 scale (see caveats); unscaled, the
three overlapped 131s waits would save ~262s.

Share of the whole turn, provider latency included:

| scenario | turn (seq) | saved | share of turn |
|---|---|---|---|
| browser-tabs-batched | 6417ms | 2713ms | **42%** |
| repeat-search-filter | 6140ms | 2782ms | **45%** |
| session-fanout | 8155ms | 2622ms | 32% |
| control / unbatched / poisoned | — | ~0ms | **0%** |

Sensitivity — wall-clock saved, by batch size and per-call latency:

| tool latency | n=2 | n=3 | n=5 | n=8 |
|---|---|---|---|---|
| 5ms | 6ms | 12ms | 27ms | 49ms |
| 50ms | 51ms | 103ms | 205ms | 357ms |
| 250ms | 249ms | 504ms | 1007ms | 1764ms |
| 900ms | 901ms | 1805ms | 3607ms | 6309ms |

The saving is `(n-1) × latency`, as expected. It is only worth reaching for on
tools in the hundreds of milliseconds — browser, web fetch, web search. It is
worth nothing on `read`/`edit`/`write`, which measured at 0.4ms.

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

### 1. The mode is token-neutral.

Every scenario reports identical `totalTokens` and identical model-call counts
in both modes, and the bench **fails** if that ever stops being true. Pi
executes whatever batch the model already emitted; it returns the same results
in the same order either way. Nothing about context, spend or compaction
pressure moves.

**What that assertion does and does not show.** The scripted provider charges a
fixed usage per reply and the bench tools return constant text, so the token
check is, strictly, the model-call check wearing a second hat: it proves the
mode neither adds nor drops a provider round trip. It could not detect token
movement caused by *result content* differing between modes. Nothing in Pi's
loop varies result content by mode — `executeToolCallsParallel` and
`executeToolCallsSequential` build identical `toolResult` messages — so the
conclusion holds; but it rests on that reading of the source, with the
assertion guarding the round-trip half.

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
2. **Whether a program can actually reduce those results.** Structural signals
   narrow the 58.5% ceiling to a ~24–27%-of-context capture band, but
   "homogeneous and barely discussed" is a proxy for programmable, not a
   measurement of it. Only a prototype turns the band into a number.
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

### Narrowing the ceiling

58.5% is what a program *could* absorb, not what it *would*. Two structural
signals bracket the real capture rate — neither is proof, and reporting the
band beats quoting a point estimate that would be repeated as fact:

| signal | share of fan-out volume | reading |
|---|---|---|
| **homogeneous** — every call in the reply hit one tool | **59.9%** | 7,234 of 9,577 fan-out replies; the loop shape Code Mode exists for |
| **transient** — consuming reply wrote <600 chars of prose | **87.8%** | results the model barely spoke about before moving on |
| mean prose written about a fan-out's results | — | **544 characters** |

That 544-character mean is the striking one. The model reads a fan-out's
results, says about two sentences, and proceeds — those tokens then sit in
context for the rest of the turn. That is precisely the volume a program would
have consumed in-process and never sent.

Taking the product of both signals as the conservative reading and the smaller
of them as the generous one:

| | capture rate | context tokens | share of all billed context |
|---|---|---|---|
| conservative | 52.6% of fan-out | 868M | **23.7%** |
| generous | 59.9% of fan-out | 988M | **27.0%** |

**So the honest headline is ~24–27% of all billed context, not 48%.** The case
survives the narrowing, at roughly half its ceiling.

Homogeneous loops are **69.3% `bash` and 26.3% `read`** — 95.6% between them,
confirming the constraint below on the loop shape specifically.

**Two caveats that matter, both against the optimistic reading:**

1. **Cost ≠ tokens.** The cache split is 3.29B read against 72M written, so
   re-sent context is ~97% cache reads, billed near a tenth of fresh input.
   The token saving is real for *context-window pressure* — which is what
   limits session length and drives compaction — but the dollar saving is a
   fraction of the token saving.
2. **The capture band rests on two heuristics.** "Homogeneous" and "transient"
   are structural proxies for programmability, not measurements of it. The
   600-character prose threshold is a judgement call. A prototype is what
   turns the band into a number.

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

## Ticket coverage

This note covers VC-245 **§1 (establish the baseline)** and the **decision**.
It deliberately stops there, because the baseline reversed the premise the rest
of the ticket was scoped against.

Not covered, and still open: §1's local Code Mode prototype and
provider-hosted programmatic tool calling; **§2 entirely** (the three product
shapes and its eight design questions); **§3 entirely** (the twelve safety and
lifecycle rules, which need a prototype to demonstrate); the tested prototype;
and the Code Mode column of the benchmark table, which here is modelled from
real transcripts rather than measured from a build. The design note also does
not yet map onto the Agent Tool Surface, Verb Registry or authority checks —
that mapping belongs with the product shape in §2.

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
- The live lane reports **means** of 2–3 trials, not medians. With n=2–3 the
  distinction is largely cosmetic, but the ticket asks for medians and this is
  not one.
- Retries are not recorded anywhere in any lane, and the ticket asks for them.
  No lane observed a retry, but none would have counted it.
- `session-fanout` runs its `ticket.await` calls at 1/100 scale so the bench
  stays runnable; the real measured wait is ~131s, so the true saving on that
  shape is ~262s rather than the scaled figure in the table.
