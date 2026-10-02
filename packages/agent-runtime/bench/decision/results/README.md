# VC-478 decision benchmark — results (2026-10-01)

Raw data: `jev-1.13-free.json` (3 trials). Chat model `anthropic/claude-haiku-4-5`
(no reasoning), classifier `opencode/jev-1.13-free`, concurrency 4.

**Only trial 1 is a clean classifier run.** The free Jev tier rate-limited the
account part-way into trial 2 (429, "retry in 42,602 s"), so trials 2–3 of
the classify arm are mostly failures; the paid `opencode/jev-1.13` failed
every call with 402 (account unfunded) and is not reported. The chat rows are
the same across all three trials. Local llama.cpp was not measured (no
`llama-server` installed and no model download approved).

## Trial 1

| task    | arm        | model            | decisions | correct | failed | p50/decision |   wall | input tok | output tok |     cost |
| ------- | ---------- | ---------------- | --------: | ------: | -----: | -----------: | -----: | --------: | ---------: | -------: |
| browser | chat       | claude-haiku-4-5 |        28 |  100.0% |      0 |       747 ms |  5.6 s |    14,510 |        556 | $0.01729 |
| browser | classify   | jev-1.13-free    |        28 |  100.0% |      0 |       520 ms |  7.6 s |    20,370 |      2,809 | $0.00226 |
| triage  | chat       | claude-haiku-4-5 |       200 |   99.5% |      0 |       689 ms | 36.9 s |    40,181 |      2,800 | $0.05418 |
| triage  | chat-batch | claude-haiku-4-5 |       200 |  31.0%* |     31 |            — |  6.1 s |     4,379 |        865 | $0.00980 |
| triage  | classify   | jev-1.13-free    |       200 |  100.0% |      0 |       567 ms | 33.3 s |    84,578 |     10,680 | $0.00162 |
| control | chat       | claude-haiku-4-5 |        20 |   80.0% |      0 |       702 ms |  3.7 s |     2,334 |        260 | $0.00363 |
| control | classify   | jev-1.13-free    |        20 |  100.0% |      0 |       595 ms |  5.6 s |     6,467 |        592 | $0.00111 |

The classify rows include the one chat call that writes the decision loop
(once per run; Haiku): browser 317 in / 389 out ($0.00226), triage 222 / 280
($0.00162), control 153 / 192 ($0.00111). The free classifier itself cost $0,
so every classify cost above is that one call.

\* The model returned fewer labels than items and this run scored labels by
position, so one missing label shifted the rest; the harness now asks for
labels keyed by index. Treat the chat-batch accuracy as a harness artefact,
not the model's.

## Per decision, classifier alone

| task    | classifier tokens / decision | at paid Jev's catalog price ($0.042/M in) | chat cost / decision |
| ------- | ---------------------------- | ----------------------------------------: | -------------------: |
| browser | 716 in / 86 out              |                                 $0.000030 |             $0.00062 |
| triage  | 422 in / 52 out              |                                 $0.000018 |             $0.00027 |
| control | 316 in / 20 out              |                                 $0.000013 |             $0.00018 |

The paid column is an estimate (same token counts, catalog price), not a
measurement.

## Reading it

- **Correctness:** classify was as good or better on all three tasks, including
  the arithmetic control meant to show its limit (20/20 in the one clean
  trial — too small a sample to say more than "no regression").
- **Latency:** about 120–230 ms faster per decision (15–30%), not an order of
  magnitude: Jev's round trip is ~0.5 s from here. On small tasks the one-off
  loop-writing call makes total wall time longer (browser 7.6 s vs 5.6 s).
- **Cost:** the decisions themselves are 14–20× cheaper per decision at paid
  Jev's price, and free on the free tier; most of the classify arm's bill is
  the single chat call that writes the loop.
- **Tokens:** a classifier reads more input per decision than a terse chat
  prompt (the state is rendered once per question), but at a price two orders
  of magnitude lower.

To rerun with three clean trials: wait for the free-tier limit to reset, or
fund the OpenCode account and use `PI_BENCH_CLASSIFIER=opencode/jev-1.13`:

```sh
PI_LIVE_BENCH=1 pnpm -C packages/agent-runtime run bench:live -- bench/decision
```
