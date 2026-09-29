# VC-442 — fixture-only read-result reduction prototype

## Recommendation

**Stop. Do not ship any of this surface, and file no production follow-up from this evidence.** The ticket's bar is correctness *and* security *and* a meaningful task-level gain. Only the third is shown, and only on scripted fixtures.

- **Closed filter program (`filter_lines`): stop shipping, but the shape is promising.**
  - It is the only lane that removed a model round on the dependent task: it follows the index inside one call, so the task took 2 rounds instead of 3.
  - It cut result bytes 99.3% and input tokens 93.2% on the noisy log.
  - Its 401-token schema costs input on every simple task: +195% on the single lookup and +21% on the multi-read.
  - Correctness is an evidence oracle over fixtures. In this harness the right filter terms are handed to the tool, and a wrong term would drop evidence silently. Whether a real model picks good terms is unmeasured, and measuring it needs paid model calls, which this ticket excludes.
  - The security boundary is a fixture key map, not a real filesystem or `bash` boundary.
- **Fixed compound tool (`read_many`): stop.** It needs the same rounds as batching direct `read` calls, adds 129 schema tokens to every request and returns more bytes.
- **`bash` from generated code: not built.** A genuine boundary was infeasible here; see [Assessing `bash`](#assessing-bash).
- **Global Pi `toolExecution: "parallel"`: unchanged**, and not re-audited.
- **Read-only selective parallelism (the MCP direction): the scheduler question belongs to VC-454.** VC-444 ran the MCP parallel pilot and filed VC-454 ("Opt-in parallel MCP reads: host allowlist, per-server bound, sequential fallback") to implement it. This note adds one input VC-454 lacks, measured below: **batching propensity is the gate.** The saving is `(calls − replies) × network wait`. It is large when a model batches independent high-latency calls and exactly zero when it does not.

The prototype is off by default and lives entirely in `packages/agent-runtime/bench/read-only-reduction/`. No runtime module imports it, and it does not touch any Session's Agent Tool Surface, Pi's sequential setting, permissions, durable history or Session behaviour.

## Scope and reproduction

Run `pnpm -C packages/agent-runtime run bench:reduction`. It uses `vite.bench.config.ts` (one worker, `bench/**` only). The package's default `test` lane includes only `src/**/*.test.ts`, so CI type-checks and lints the bench but never runs it. The figures below come from one run on this branch after merging `main` at `e9a74349`, on an Apple-silicon Mac under shared-machine load. Three repeats per row, medians reported. Wall times are observational and vary by a few ms. Tokens, evidence and closed-form figures are deterministic.

All inputs are fixed in-memory fixtures. The run makes no provider or model calls, and there were **no paid provider calls**. It uses no MCP client, network, credentials, filesystem, process or shell, and reads no user or Session data. Scripted provider rounds take 35 ms and fixture reads 8 ms. Tokens are cl100k BPE over the serialized requests and results (the runtime itself counts with o200k). Cache read/write counts cover only the fixed system+tool prefix. They make no claim about billing.

**Scripted vs real-model.** The harness preselects every lane's tool calls and filter terms. No model plans the calls or interprets the results. Round counts, token volume and evidence retention are therefore properties of the *strategy*. They do not predict how often, or how correctly, a model would choose it. VC-245's live runs measured a 17% batch rate, and the propensity sweep below is where that gap enters the decision.

**Retries** are not a measured column. The harness has no retry path (a failed call fails the whole run), so "zero retries" is true by construction.

**Metrics alignment with VC-441.** This bench reports turn wall time, provider rounds, calls/reads, tool time, input/cache/result tokens, result bytes and evidence/answer correctness. I committed to this set on VC-441. VC-441's own bench (`bench/turn-to-completion/`) measures a different axis: the turn critical path under concurrent Sessions. The two are complementary, and neither edits the other's files.

Tasks: a single lookup, three independent reads, an index-dependent shard loop, and a 500-line noisy log. Lanes: direct sequential reads, a batch of direct reads dispatched serially, the same batch dispatched in parallel, fixed `read_many`, and the closed filter program. All 20 task/lane rows kept every required line of evidence and passed the answer oracle.

## Task results

| Task | Lane | p50 ms | Rounds | Calls/reads | Evidence | Input/result tok | Cache R/W tok | Result bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| single-call | direct-sequential | 81.9 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | safe-batch-serial | 81.0 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | safe-batch-parallel | 81.9 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | fixed-read-many | 82.3 | 2 | 1/1 | 1/1 | 591/29 | 249/249 | 126 |
| single-call | filter-program | 82.6 | 2 | 1/1 | 1/1 | 953/26 | 421/421 | 105 |
| independent-multi-read | direct-sequential | 172.1 | 4 | 3/3 | 3/3 | 845/58 | 360/120 | 259 |
| independent-multi-read | safe-batch-serial | 98.7 | 2 | 3/3 | 3/3 | 407/58 | 120/120 | 259 |
| independent-multi-read | safe-batch-parallel | 81.4 | 2 | 3/3 | 3/3 | 407/58 | 120/120 | 259 |
| independent-multi-read | fixed-read-many | 97.9 | 2 | 1/3 | 3/3 | 653/79 | 249/249 | 344 |
| independent-multi-read | filter-program | 98.9 | 2 | 1/3 | 3/3 | 1023/73 | 421/421 | 293 |
| dependent-loop-filter | direct-sequential | 218.0 | 5 | 4/4 | 2/2 | 1308/107 | 480/120 | 392 |
| dependent-loop-filter | safe-batch-serial | 144.4 | 3 | 4/4 | 2/2 | 707/107 | 240/120 | 392 |
| dependent-loop-filter | safe-batch-parallel | 128.0 | 3 | 4/4 | 2/2 | 707/107 | 240/120 | 392 |
| dependent-loop-filter | fixed-read-many | 145.5 | 3 | 2/4 | 2/2 | 1086/133 | 498/249 | 484 |
| dependent-loop-filter | filter-program | 108.9 | 2 | 1/4 | 2/2 | 1000/67 | 421/421 | 253 |
| noisy-large-output | direct-sequential | 84.6 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | safe-batch-serial | 88.5 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | safe-batch-parallel | 84.4 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | fixed-read-many | 84.2 | 2 | 1/1 | 3/3 | 15547/14986 | 249/249 | 61886 |
| noisy-large-output | filter-program | 81.2 | 2 | 1/1 | 3/3 | 1044/117 | 421/421 | 420 |

Schema tokens per lane were 100 / 100 / 100 / 229 / 401. Schema build plus JSON serialization took 1–3 µs at p50, which is negligible; the cost that matters is the schema tokens re-sent every round.

### Interpretation

- **Rounds are the main latency lever.** Batching three independent reads takes four rounds down to two, a 42.6% turn saving even with serial dispatch. Parallel dispatch of the same batch saves another 17.3 ms (98.7 → 81.4) with identical rounds and data, and commits results in call order. That saving is overlap of 8 ms reads, so it scales with read latency.
- **Dependencies cap batching, but not a program that follows them.** On the shard loop, every lane that must see the index before naming shards spends a round on it (3 rounds). The filter's `indexPath` source reads the index's fixed `files` field inside the call, and each listed path still passes the capability check and the read budget. That makes it 2 rounds and 108.9 ms, against 144.4 for the serial batch and 128.0 for the parallel batch. This is the "bounded code cuts a model round" case the ticket asked about. It holds only because the dependency is a fixed, declared field.
- **Fewer calls is not less context.** `read_many` and the filter add schema and request tokens. On the single-call and multi-read tasks, both use more input tokens than batching direct reads.
- **The filter wins where output is noisy and the terms are literal and known in advance.** On the noisy log, result bytes fell from 61,859 to 420 and input tokens from 15,278 to 1,044, with all three evidence lines kept.
- **Caveats that cut both ways:**
  - Pi's real `read` truncates at 50 KB / 2,000 lines, so a real direct read of the 61,859-byte log would lose `seq=0441` and need another round. Here the filter looks *weaker* than it would against real Pi.
  - The fixture prefix is ~120 tokens, while a real prefix is thousands and cached, so here the filter's schema overhead looks *larger* than it would in production.
  - Full tool-result history is kept and re-serialized; no compaction is simulated.

## Assessing `bash`

VC-245 found that `bash` produces ~57% of fan-out result tokens, so a reduction surface without it misses most of the prize. This prototype **deliberately exposes no `bash`, and no `bash`-equivalent, to generated code**, because no genuine safety boundary was feasible here:

- **A command string cannot be proven read-only.** Redirection, `tee`, `find -delete`, `sed -i`, `git` hooks and aliases, `xargs`, subshells, `$(…)`, env-sensitive tools and network clients can all write, spawn or exfiltrate. Denylisting shell syntax is not a boundary.
- **A real boundary is a new app-owned capability, not `bash`.** It would need:
  - argv-only execution of an allowlist (for example `rg`, and `git show/log/diff` with fixed flags), with no shell parser;
  - a worktree-confined cwd, a scrubbed environment and no network;
  - time, output and process caps;
  - OS-level enforcement such as a sandbox profile, because argv allowlists alone do not stop a tool from reading `~/.ssh`.

  That is a production security project, not a bench prototype.
- **The reduction shape does not need generated code to run `bash`.** Most of `bash`'s reducible volume is `grep`/`head`/`tail`-style filtering of large output. The closed `select-lines` AST does that over data it is handed, with no execution capability. A later design could apply it to the output of an ordinary, already-approved `bash` call, keeping that call's authority, approval and cancellation. It would carry two costs this note does not solve:
  - The model term-selection risk above.
  - A durable-history change. Today the durable activity output *is* what the model saw: Pi's end-of-tool result is saved as the recovery marker that feeds the transcript artifact. Keeping the full output while the model sees less would need a new stored field, which is frozen once shipped and must pass the transcript validator and artifact digest.

**Search is also out of scope.** Every tool here takes exact, named fixture paths. Path discovery (glob or content search) needs a real filesystem capability, which is the same boundary question as `bash`.

## MCP-first parallel workload (owner direction)

VC-245's 1.2% figure describes legacy `bash`/`read` sessions, and is **not** used here to veto MCP parallelism. The question is when read-only parallel dispatch pays for independent MCP/serverless calls, and what keeps it correct.

**Measured sweep.** The mocked MCP-like tool is an abortable timer returning a fixed per-call value; there is no transport. Four independent calls, batched 4, 2 or 1 per reply, with 35 ms scripted rounds and 3 repeats. Earlier calls in a reply wait 2 ms longer, so parallel replies really do finish out of call order. The test asserts that results are still committed in call order.

| Call wait | Batch | Rounds | Seq p50 (model) | Parallel p50 (model) | Saved | Reduction | Out-of-order finish |
|---:|---:|---:|---:|---:|---:|---:|---|
| 50 ms | 4 | 2 | 287.7 (282) | 127.3 (126) | 160.3 ms | 55.7% | yes |
| 250 ms | 4 | 2 | 1087.8 (1082) | 328.1 (326) | 759.6 ms | 69.8% | yes |
| 900 ms | 4 | 2 | 3688.2 (3682) | 978.8 (976) | 2709.5 ms | 73.5% | yes |
| 50 ms | 2 | 3 | 316.7 (309) | 212.0 (209) | 104.7 ms | 33.1% | yes |
| 250 ms | 2 | 3 | 1115.4 (1109) | 612.7 (609) | 502.7 ms | 45.1% | yes |
| 50 ms | 1 | 5 | 384.9 (375) | 384.9 (375) | 0.0 ms | 0.0% | no |
| 250 ms | 1 | 5 | 1182.2 (1175) | 1184.2 (1175) | −2.0 ms | −0.2% | no |

The model is `(replies + 1) × round + Σ per reply (parallel ? slowest call : all calls)`. The test asserts every measured row sits within a per-timer overshoot band of it. The 900 ms × batch-2/1 cells were not measured, to keep the bench at ~40 s. The model is exact at the other six propensity cells, and those two follow the same arithmetic.

**Closed-form extension** (uniform waits; full tables are printed by the bench). The 2 s provider round is a declared assumption, not a measurement.

| Input | Effect on the decision | Evidence |
|---|---|---|
| **Batching propensity** (calls per model reply) | **The gate.** Saving = `(calls − replies) × wait`. A model that emits one call per reply gets **0** from parallel dispatch at any latency. Pairs get two-thirds of the all-in-one saving (2 of 3 waits saved). | Measured above. At 900 ms and 35 ms rounds: batch 4 saves 2700 ms (73.6%), batch 2 saves 1800 ms (48.6%), batch 1 saves 0. |
| **Network wait** | Scales the absolute saving linearly. Slow real-model rounds dilute the *share* but not the milliseconds. | At 2 s rounds, all-in-one saves 150 ms (3.6%) at 50 ms, 750 ms (15.0%) at 250 ms and 2700 ms (35.5%) at 900 ms. Batching in pairs at 250 ms saves 500 ms (7.1%). |
| **Output volume** | Parallel dispatch changes **no** context volume. Low propensity adds rounds, and each round re-sends every earlier result. Large outputs call for reduction (the filter shape), not parallelism. | 16 KB/call (5,786 tok): 27,144 input tok at batch 4 vs 67,860 at batch 1. 512 B/call: 4,748 vs 11,870. |
| **Correctness** | Only calls that are independent **and** read-only may overlap. With a write or approval-gated call in the reply, today's Pi runs the **whole reply sequentially**: one `executionMode: "sequential"` tool forces it (`agent-loop.js` `executeToolCalls`). Beating that needs a custom barrier dispatcher, where reads before the barrier overlap, the barrier runs alone and later reads wait. Pi does not have one. | Network ms for 4 calls at 900 ms: Pi today 3600; hypothetical barrier at 2nd 2700, barrier last 1800; fully parallel (unsafe) 900. Barrier figures are formula only. |

**What this hands to VC-454.**

- For independent MCP reads at ≥250 ms wait, selective parallel dispatch is a real whole-turn win *when the model batches*. At 2 s rounds that is 15% (all four in one reply) or 7% (pairs) at 250 ms, and 35% or 19% at 900 ms. It is worthless when the model does not batch, so propensity must be measured on real models, not assumed.
- VC-454's per-tool sequential fallback is the correct and simplest design. It inherits Pi's whole-reply fallback, so a reply that mixes a write with reads gets no overlap. Only a dispatcher Volli would own could recover the barrier columns, which is more complexity than this evidence justifies today.
- Placement, to keep hosts thin:
  - the read-only/parallel-safe classification is frozen into the Session's Agent Tool Surface (`McpToolDefinition`);
  - dispatch is chosen in `@volli/agent-runtime`;
  - per-server caps sit behind `RuntimeMcpPort`, in whichever host owns the connections;
  - none of this lives in desktop main, and Pi is not forked.
- **Observability caveat.** In Pi's parallel mode the model-facing tool results are ordered, but durable activity events are written in completion order. Anything that audits order must use the call index.
- **Failure semantics differ from this prototype.** Pi turns a failed call into an error result and lets its siblings finish, which is right for independent reads. This prototype aborts siblings only when a *run-level budget* is exhausted.

## Safety boundaries and bounds (tested)

- **Capability.** The only data source is `FixtureReader`, which accepts exact fixture keys (`Object.hasOwn`). The following are rejected before any read is charged: traversal, absolute host paths, duplicates, and prototype keys such as `constructor` and `__proto__`. A static **tripwire** test (not a sandbox) checks that the three capability modules (`prototype.ts`, `fixtures.ts`, `mcp-decision-sweep.ts`) import only the tokenizer and each other, and mention no `process`, `globalThis`, `require(`, `import(`, `eval`, `Function(`, `fetch(`, `WebSocket`, `child_process` or `node:`. `report.ts` and the test are operator-side and deliberately outside it.
- **Filter program.** A closed, versioned AST: `select-lines`, exactly one source (explicit `paths` or a fixture `indexPath` whose fixed `files` field is re-validated), 1–8 literal terms of ≤80 non-blank chars, and 1–20 max matches. Extra keys, unknown operations or versions, a missing or doubled source, non-string or blank terms and non-integer bounds are rejected. Nothing is compiled or evaluated.
- **Run-time bounds, each tripped by a test:**
  - task time: 2 s, via an abort timer and a synchronous clock check, tested separately;
  - tool calls: 16;
  - nested reads: 16;
  - paths per call: 8;
  - per-read and per-result bytes: 64 KiB, tested separately; a combined `read_many` result trips the per-result cap;
  - aggregate result bytes: 128 KiB;
  - filter lines scanned: 8,192.

  The default limits are also asserted as literal numbers. Memory is bounded through the byte ceilings, because everything held is immutable fixtures plus byte-charged results.
- **Order, cancellation, observability.**
  - Parallel results are committed in call order even when reads finish in reverse (tested with staggered latencies).
  - A caller abort mid-run rejects promptly and records the in-flight read as cancelled.
  - When a run-level budget fails a parallel batch, the in-flight siblings are cancelled, not completed.
  - Every nested read emits `read-start` and then `read-end` or `read-cancelled` to an observer and to the run result.

These checks show that the prototype is contained. They are not a production security review, and not a sandbox for real filesystem, `bash` or MCP access.

## Verification

- `pnpm -C packages/agent-runtime typecheck`: passed.
- `pnpm -C packages/agent-runtime run bench:reduction`: passed, 8 tests. They cover the 20 task/lane invariants, filter AST rejection, ordered commit under out-of-order completion, mid-run and sibling cancellation, default and runtime budgets, the capability tripwire, measured-vs-model agreement, and the propensity/latency/volume/barrier sweep. A spot mutation that removed sibling cancellation was caught.
- `vp check`: passed.
