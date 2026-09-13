# Agent-runtime latency profile (VC-356)

## Scope and method

This profile measures CPU overhead owned by `@volli/agent-runtime`; it does not
replace provider and tool wall-clock measurements. The default fixture makes no
network, browser, model, or paid-provider calls.

The checked-in fixture extends `packages/agent-runtime/bench/parallel-tools/` with
`runtime-cost*` modules. It covers:

- system-prompt and first-message assembly;
- model-switch context projection for 480 messages (about 450 KB) plus 20 tool schemas;
- normalization of one completed tool activity with bounded nested output and a patch;
- steady-state streamed-delta translation.

`pnpm -C packages/agent-runtime bench:runtime` is the short regression probe.
The longer CPU-profile arm is:

```sh
VOLLI_CONCURRENCY_HINT=2 pnpm -C packages/agent-runtime bench:runtime:profile
```

That command bundles the fixture, runs Node with `--cpu-prof`, and prints the
profile's bottom-up self-sample table. The generated bundle, source map, and
`.cpuprofile` are placed in the ignored
`packages/agent-runtime/.runtime-profile/` directory. Open the `.cpuprofile` in
Chrome DevTools' Performance panel to inspect the complete flame chart.

Measurements below used commit `09acc82e67c810d48e791d80b1605e86daa224d9`
plus the indicated before/after working tree, Node 24.18.0, Apple M1 (8 logical
CPUs), 16 GiB RAM, macOS 25.5.0, and `VOLLI_CONCURRENCY_HINT=2`. Each profile
arm used three warm-up batches and 20 measured batches. Values are microseconds
per operation; RSD is the relative standard deviation across batches.

## Ranked findings: the user is waiting

These are runtime-owned CPU costs, ranked by baseline p50. Provider/model and
actual tool execution still dominate wall time at millisecond-to-minute scale;
they are intentionally absent from this deterministic probe.

| Rank | Critical-path work | Before p50 / p95 | Before RSD | After p50 / p95 | After RSD | p50 change | Result |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | Project long context after a model switch | 1,531.9 / 1,845.1 us | 8.0% | 7.5 / 14.8 us | 35.3% | -99.5% | Fixed: attachment-local message, prompt, and tool token estimates are reused by tokenizer family. |
| 2 | Normalize a bounded completed-tool activity | 744.7 / 1,022.9 us | 14.4% | 550.0 / 654.2 us | 8.5% | -26.1% | Fixed: one redaction guard replaces four clean-string scans, JSON length is serialized once, and patch additions/removals share one scan. |
| 3 | Assemble the system prompt | 18.0 / 19.8 us | 5.1% | 2.9 / 3.1 us | 5.4% | -83.9% | Fixed: role-static operating/workspace layers are preassembled and prompt sections are joined without a temporary mapped array. |
| 4 | Assemble the first delivered message | 3.5 / 4.7 us | 13.5% | 3.2 / 3.5 us | 7.6% | noise | Not changed. It runs only for the opening message. |
| 5 | Translate one streaming delta | 0.2 / 0.4 us | 39.1% | 0.3 / 0.6 us | 45.8% | timer noise | Not changed. Deltas remain transient and do no durable write. |

The optimized context result is a steady-state per-turn result: compaction
preflight and provider output-ceiling checks encounter the same settled prefix
in succession. The first projection still computes every estimate. New settled
messages are computed once as the append-only context grows.

### Other critical-path findings not represented as local CPU timings

- Threshold compaction is awaited before `agent.prompt`; overflow compaction is
  awaited before retry. A summarization call is therefore user-waiting work, not
  background work. Its provider latency cannot be represented honestly without
  a live call, so the default fixture does not invent one.
- `SessionEngine.observe` currently reads and folds a Session's complete event
  history for each durable observation. This is O(history) per fact and can
  become O(history squared) across a long turn. VC-355 owns the adjacent
  session-engine work; VC-356 left `observation-translation.ts`, durable event
  shapes, event IDs, and ID derivation untouched after coordinating that
  boundary.
- Transcript subscribers deliberately apply backpressure. A slow listener can
  pace streamed deltas even though those deltas are not persisted. Removing
  that ordering/backpressure is a semantics change, not a safe CPU cleanup.

### Paths ruled out as repeated turn cost

- Model catalog/access resolution is owned by `createPiAgentRuntime` and reused;
  `startSession` awaits the existing `catalogReady` promise. It is not rebuilt
  on each turn.
- `NodeExecutionEnv`, the session tool bundle, and the system prompt are built
  once while attaching a Session, not for every tool call or provider request.
  System-prompt assembly remains in the table because attachment startup is a
  user-waiting boundary, but it is not multiplied by turn count.
- The existing parallel-tools fixture already measures real Pi dispatch.
  VC-245's real-transcript projection found only about 1.2% aggregate tool-time
  savings from parallel mode, so dispatch reordering was not promoted above the
  measured CPU work.

## Ranked findings: background

No meaningful per-turn CPU hotspot in the profiled pipeline is actually
background. The expensive-looking paths are all awaited before the next model
request, tool result, or subscriber delivery:

1. compaction is blocking maintenance;
2. durable observation translation and ledger appends are serialized and
   awaited;
3. transient subscriber fan-out is awaited for backpressure.

The passive observability sink is the relevant non-awaited path, but its cost is
host-defined and the default no-op was below this fixture's useful resolution.
It was not promoted above user-waiting work or “optimized” with an invented
latency.

## CPU flame-chart findings

The profile summarizer aggregates V8 node `hitCount` values (self samples), the
same bottom-up evidence shown by a flame chart. Operation counts are weighted to
make short functions visible, so percentages rank CPU inside this fixture, not
production call frequency.

Before (`5,756` self samples):

- `composeSystemPrompt`: 874 samples (15.2%);
- `conservativeTokens`: 828 (14.4%);
- the four payload-redaction regular expressions: 1,202 combined (20.9%);
- `normalizedString`: 401 (7.0%);
- `countDiffLines`: 335 (5.8%).

After (`2,295` self samples):

- `conservativeTokens`: 5 samples (0.2%); unchanged prefixes no longer dominate;
- `composeSystemPrompt`: no self samples; remaining prompt work is chiefly
  `promptResourceBlock` (117 samples);
- `normalizedString`: 145 samples, down 63.8%;
- `countDiffLines`: 168 samples, down 49.9%;
- the combined redaction guard is now the largest remaining fixture cost (907
  samples). This remains deliberately conservative because removing or
  weakening secret redaction would change the durable activity payload.

Total sampled CPU in the weighted fixture fell from 5,756 to 2,295 self samples
(-60.1%).

## Loaded arm and concurrency

One post-change arm ran while one `yes` process kept a logical CPU busy:

| Work | Loaded p50 / p95 | Loaded RSD |
|---|---:|---:|
| System prompt | 3.7 / 5.5 us | 30.1% |
| First message | 3.6 / 5.6 us | 29.9% |
| Long-context projection | 7.8 / 16.2 us | 58.7% |
| Activity normalization | 739.9 / 948.2 us | 36.9% |
| Delta translation | 0.2 / 0.3 us | 14.1% |

The benchmark config intentionally uses one worker even when
`VOLLI_CONCURRENCY_HINT` is larger: concurrent benchmark files would measure
contention rather than one runtime operation. Runtime tool execution remains
Pi's documented sequential mode. VC-245 found only about 1.2% aggregate
real-transcript tool-time savings from speculative parallel mode, while mixed
side effects still require ordering. `VOLLI_CONCURRENCY_HINT` is therefore not
used as permission to reorder model-issued tool calls; no new runtime fan-out
was introduced by this work.

## Contract notes

- No durable event, activity, or observation shape changed.
- No event or observation ID derivation changed.
- The token cache is attachment-local. It assumes the existing Pi contract that
  settled messages and frozen tool definitions are not mutated in place.
- The activity optimizations retain the exact replacement expressions and the
  exact JSON-size accounting; existing activity tests pin output, redaction,
  bounds, and diff counts.
