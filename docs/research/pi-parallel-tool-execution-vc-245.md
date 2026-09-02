# Pi's built-in parallel tool execution, measured (VC-245)

**Status:** research. Nothing here changes product behaviour; `toolExecution` is
still `"sequential"` on this branch.

**Subject:** one line — `packages/agent-runtime/src/pi/runtime.ts:1310`, where
Volli opts out of Pi's default. This note is the baseline VC-245 asks for
before any Code Mode work: what does flipping that line actually buy, and what
does it cost?

**Evidence:** `packages/agent-runtime/bench/parallel-tools/`, run with
`pnpm -C packages/agent-runtime run bench`. Pi's real `Agent`, its real
batching, preflight, `beforeToolCall` gate and result ordering all run
unmodified. Only the provider call and the tools are faked, and the tool
latencies are measured rather than guessed (`bench:probe`). No provider is
reached and no money is spent.

---

## The short answer

Parallel mode is **a scheduler change and nothing else**. It saves
**23–51% of turn wall-clock on turns where the model batches its tool calls**,
and it saves **exactly zero tokens, zero model calls and zero dollars** — in
every scenario, in both modes, those three numbers were identical.

That makes it a real but narrow win, and it is **not** the thing that answers
the token half of VC-245. Two separate levers came out of the measurement:

| Lever | Saves time | Saves tokens | Works today |
|---|---|---|---|
| `toolExecution: "parallel"` | yes, 23–51% of batched turns | **no, zero** | one-line flag |
| Getting the model to **batch** at all | only in parallel mode | **yes, substantially** | prompt-level, no flag needed |
| Code Mode (not measured here) | yes | yes | large build |

The second row is the surprise, and it is the cheaper half. See
[Batching is the token lever](#batching-is-the-token-lever-not-the-mode).

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

### 2. The entire win is conditional on the model batching.

`browser-tabs-batched` and `browser-tabs-unbatched` do the same four tab reads.
The first saves 2.7s; the second saves **2ms**. The difference is not the mode
— both ran in parallel mode — it is whether the four calls arrived in one
assistant reply or four.

So the flag is worth exactly *the fraction of real turns where the model emits
two or more independent calls in one reply*. **This bench cannot measure that
number**; only real models can. It is the single biggest open input to the
decision.

### 3. Batching is the token lever, not the mode.

The two browser scenarios needed **2 model calls vs 5** for identical work.
At the bench's fixed 1,060 tokens per reply that is 2,120 vs 5,300 tokens.

The real gap is *wider* than that: the bench charges a constant per reply,
whereas a real extra round trip re-sends a context that has itself grown. The
ratio is the honest part; the absolute numbers are a modelling artefact and
should not be quoted.

This is the important strategic point. **Batching saves tokens whether or not
the flag is flipped** — sequential mode still executes a batch, just one call
at a time. And Volli's system prompt currently says nothing about batching in
either direction. So there is a cheap, token-positive, flag-independent change
available: tell the model it may issue independent read-only calls together.
Flipping the flag is what converts that saving from tokens-only into
tokens-and-time.

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

---

## What this does not answer

1. **Real batch rate per model and provider.** Finding 2 makes this decisive.
   Needs a live-model lane (`smoke/`-style, spends money).
2. **Whether Volli's tools tolerate concurrency.** A quick read suggests
   `ScopedExecutionEnv` is fine (per-call `mkdtemp`, own child process,
   readonly `cwd`), and that browser tools are the live hazard: refs are valid
   only for a snapshot `generation`, so two concurrent `browser_act` calls on
   one tab can race. Reads across *different* tabs look safe. This needs a
   real audit before the flag moves, not a skim.
3. **Code Mode itself.** Untouched by this note. Findings 1 and 3 sharpen what
   it would have to justify: it must beat *batching plus parallel mode*, not
   beat today's sequential baseline.

## Suggested next steps

- Measure real batch rate across the models Volli ships against. Cheap, and it
  converts finding 2 from an unknown into a number.
- Audit tool concurrency safety, browser tools first.
- Consider the prompt change independently of the flag — it is the
  token-positive half and carries none of the concurrency risk.
- Only then decide on the flag, and only then judge Code Mode against the new
  baseline.

## Reproducing

```
pnpm -C packages/agent-runtime run bench:probe   # re-measure latencies
pnpm -C packages/agent-runtime run bench         # ~4 min, prints the tables
```

The bench is out of the default `test` lane because it sleeps for real time.
It reaches no provider and costs nothing.
