# VC-442 — fixture-only read-result reduction prototype

## Recommendation

**Stop. Do not ship this surface, and file no production follow-up from this evidence.**

- **Closed filter / programmatic reduction (`filter_lines`): stop.** It cut result bytes 99.3% and input tokens 94.3% on the noisy-log task, and cost input tokens on every other task, where its larger schema outweighs what it saves. Correctness is an oracle over fixtures, not real model accuracy. A model still has to choose the filter terms, and a wrong term drops evidence silently. The security boundary covers only a fixture capability. So the ticket's bar (correctness, security and a meaningful task-level gain) is **not met**.
- **Fixed compound tool (`read_many`): stop.** It gets the same round reduction as batching direct `read` calls, adds 129 schema tokens to every request and makes each result larger. It buys nothing that ordinary batching does not.
- **`bash` from generated code: not built.** No safe boundary is feasible here; see [Assessing `bash`](#assessing-bash).
- **Global Pi `toolExecution: "parallel"`: unchanged.** This work neither re-audits nor flips it.
- **Read-only selective parallelism, the MCP direction: worth pursuing, and owned by VC-444.** The closed-form sweep below shows the saving is `(calls − replies) × network wait`. It is large for independent high-latency calls when the model batches them, and zero when the model does not. VC-444 owns the MCP parallel pilot, and this note hands it the decision inputs rather than opening a second ticket.

The prototype is off by default and lives entirely in `packages/agent-runtime/bench/read-only-reduction/`. No runtime module imports it, and it does not touch any Session's frozen tool surface, Pi's sequential setting, permissions, durable history or Session behaviour.

## Scope and reproduction

Run `pnpm -C packages/agent-runtime run bench:reduction`. It uses `vite.bench.config.ts` (one worker, `bench/**` only). The default `test` lane includes only `src/**/*.test.ts`, so this bench never runs in it or in CI. The figures below come from a run on the branch after syncing with `main`. Three repeats per task/lane, medians reported. Wall times are observational and vary with host scheduling. Token, evidence and closed-form figures are deterministic.

All inputs are fixed in-memory fixtures. The run makes no provider or model calls and uses no MCP client, network, credentials, filesystem, process or shell. It reads no user or Session data, and there were **no paid provider calls**. Scripted provider rounds take 35 ms and fixture reads 8 ms. Tokens are cl100k BPE over the serialized requests and results. Cache read/write counts cover only the fixed system+tool prefix and make no claim about billing.

**Scripted vs real-model.** Every lane's tool calls and filter terms are preselected by the harness. No model plans the calls or interprets the results. Round counts, token volume and evidence retention are therefore properties of the *strategy*, not predictions of how often a model would choose it or choose it correctly. VC-245's live runs measured a 17% batch rate, and the propensity sweep below is how that gap enters the decision.

Tasks: a single lookup, three independent reads, an index-dependent shard loop, and a 500-line noisy log. Lanes: direct sequential reads, a batch of direct reads dispatched serially, the same batch dispatched in parallel, fixed `read_many`, and a closed literal-only filter program. All 20 task/lane rows kept every required line of evidence, passed the answer oracle and had zero retries.

## Task results

p50 ms is from the benchmark run. Rounds are scripted provider rounds. Calls/reads counts tool calls and underlying fixture reads. Tokens are total serialized input / returned result.

| Task | Lane | p50 ms | Rounds | Calls/reads | Evidence | Input/result tok | Cache R/W tok | Result bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| single-call | direct-sequential | 82.0 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | safe-batch-serial | 81.9 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | safe-batch-parallel | 81.4 | 2 | 1/1 | 1/1 | 323/23 | 120/120 | 100 |
| single-call | fixed-read-many | 81.5 | 2 | 1/1 | 1/1 | 591/29 | 249/249 | 126 |
| single-call | filter-program | 81.3 | 2 | 1/1 | 1/1 | 787/26 | 338/338 | 105 |
| independent-multi-read | direct-sequential | 172.2 | 4 | 3/3 | 3/3 | 845/58 | 360/120 | 259 |
| independent-multi-read | safe-batch-serial | 100.0 | 2 | 3/3 | 3/3 | 407/58 | 120/120 | 259 |
| independent-multi-read | safe-batch-parallel | 80.7 | 2 | 3/3 | 3/3 | 407/58 | 120/120 | 259 |
| independent-multi-read | fixed-read-many | 98.9 | 2 | 1/3 | 3/3 | 653/79 | 249/249 | 344 |
| independent-multi-read | filter-program | 99.4 | 2 | 1/3 | 3/3 | 857/73 | 338/338 | 293 |
| dependent-loop-filter | direct-sequential | 217.2 | 5 | 4/4 | 2/2 | 1308/107 | 480/120 | 392 |
| dependent-loop-filter | safe-batch-serial | 144.9 | 3 | 4/4 | 2/2 | 707/107 | 240/120 | 392 |
| dependent-loop-filter | safe-batch-parallel | 126.1 | 3 | 4/4 | 2/2 | 707/107 | 240/120 | 392 |
| dependent-loop-filter | fixed-read-many | 143.7 | 3 | 2/4 | 2/2 | 1086/133 | 498/249 | 484 |
| dependent-loop-filter | filter-program | 144.4 | 3 | 2/4 | 2/2 | 1351/109 | 676/338 | 393 |
| noisy-large-output | direct-sequential | 86.4 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | safe-batch-serial | 87.3 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | safe-batch-parallel | 86.3 | 2 | 1/1 | 3/3 | 15278/14979 | 120/120 | 61859 |
| noisy-large-output | fixed-read-many | 86.9 | 2 | 1/1 | 3/3 | 15547/14986 | 249/249 | 61886 |
| noisy-large-output | filter-program | 81.3 | 2 | 1/1 | 3/3 | 878/117 | 338/338 | 420 |

Schema tokens per lane were 100 / 100 / 100 / 229 / 318, and schema build+JSON p50 was 1–3 µs, which is negligible. The token cost of a larger schema is re-sent on every round.

### Interpretation

- **Rounds are the main latency lever in this harness.** Batching three independent reads into one reply takes four rounds down to two, a 41.9% turn saving even with serial dispatch. Parallel dispatch of the same batch saves another 19.3 ms (100.0 → 80.7) with identical rounds, data and order. The saving comes from overlapping 8 ms fixture reads, so it scales with read latency, not with this harness.
- **Dependencies cap both levers.** On the shard loop the index must be read before the shard paths are known. Batching and parallelism help only the later reads (144.9 → 126.1 ms).
- **Fewer calls is not less context.** `read_many` and the filter add schema and request overhead. On the three small tasks their input tokens are equal or worse than batching direct reads, and `read_many` returns more bytes.
- **The filter wins only where output is noisy and the terms are literal and known.** On the noisy log, result bytes fell from 61,859 to 420 and input tokens from 15,278 to 878, and all three evidence lines were kept. The task was designed for that shape. A model choosing the terms is the untested part.
- Full tool-result history is kept and re-serialized on every later request. No compaction, truncation or context overflow is simulated.

## Assessing `bash`

VC-245 found that `bash` produces ~57% of fan-out result tokens, so a reduction surface without it misses most of the prize. This prototype **deliberately does not expose `bash`, or any `bash`-equivalent, to generated code**, because it could not build a genuine safety boundary:

- **A command string cannot be proven read-only.** Redirection, `tee`, `find -delete`, `sed -i`, `git` hooks and aliases, `xargs`, subshells, `$(…)`, env-sensitive tools and network clients can all write, spawn or exfiltrate. Denylisting shell syntax is not a boundary.
- **A real boundary is a new app-owned capability, not "bash".** That means argv-only execution of an allowlist (for example `rg` and `git show/log/diff` with fixed flags), no shell parser, a worktree-confined cwd, a scrubbed environment, no network, and time/output/process caps. It also needs OS-level enforcement (a sandbox profile), because argv allowlists alone do not stop a tool reading `~/.ssh`. That is a production security project, outside a bench-only prototype.
- **The reduction shape does not need generated code to run `bash`.** Most of `bash`'s reducible volume is `grep`/`head`/`tail`-style filtering of large output. The closed `select-lines` AST in this prototype does exactly that, over data it is handed, with no execution capability. A future design could apply such a filter to the output of an ordinary, already-approved `bash` call, keeping that call's original authority, approval and cancellation, and storing the full output in durable history. Only the model-facing result would shrink. That is the safer direction, but it still carries the model term-selection risk above and is not evidenced here.

## MCP-first parallel workload (owner direction)

VC-245's 1.2% figure describes legacy `bash`/`read` sessions and is **not** used here to veto MCP parallelism. The question for independent MCP/serverless calls is when selective, read-only parallel dispatch pays, and what keeps it correct.

**Measured check.** Four independent in-memory calls with declared delays, two scripted rounds, three repeats. No transport or MCP client.

| Declared call wait | Sequential p50 | Parallel p50 | Saved | Reduction | Peak concurrent | Same ordered results |
|---:|---:|---:|---:|---:|---:|---|
| 50 ms | 274.4 ms | 123.2 ms | 151.2 ms | 55.1% | 4 | yes |
| 250 ms | 1075.5 ms | 323.1 ms | 752.5 ms | 70.0% | 4 | yes |
| 900 ms | 3675.4 ms | 972.8 ms | 2702.6 ms | 73.5% | 4 | yes |

The closed-form model `(replies + 1) × round + (parallel ? replies : calls) × wait` predicts 270/120, 1070/320 and 3670/970 ms. The test asserts that every measured row falls within timer-overshoot tolerance of it, so the wider sweep below is computed from that validated model.

**How each input changes the decision** (four independent calls; full tables are printed by the bench):

| Input | Effect | Evidence |
|---|---|---|
| **Batching propensity** (calls per model reply) | The gate. The saving is `(calls − replies) × wait`. If the model emits one call per reply, parallel dispatch saves **0** at any latency. With pairs it saves half as much as with all four. | 900 ms wait, 35 ms rounds: batch 4 saves 2700 ms (73.6%), batch 2 saves 1800 ms (48.6%), batch 1 saves 0 ms. |
| **Network wait** | Scales the absolute saving linearly. Slow real-model rounds dilute the *share* but not the milliseconds. | At a declared 2 s round, all-in-one saves 150 ms (3.6%) at 50 ms wait, 750 ms (15.0%) at 250 ms, and 2700 ms (35.5%) at 900 ms. |
| **Output volume** | Parallel dispatch changes **no** context volume. Low propensity costs extra rounds, and each round re-sends every earlier result. Large outputs need reduction (the filter shape), not parallelism. | 16 KB/call (5,786 tok): 27,144 input tok at batch 4 vs 67,860 at batch 1. 512 B/call: 4,748 vs 11,870. |
| **Correctness** | Parallelism is only safe for calls that are independent **and** read-only. A write or approval-gated call must be a barrier: reads before it overlap, it runs alone, and reads after it wait. That keeps reply order and gives back part of the saving. | Per-reply network wait for 4 calls at 900 ms: sequential 3600, barrier 2nd 2700, barrier last 1800, fully parallel (unsafe) 900 ms. Ordered results matched in every measured row. |

**What this means for VC-444.** For independent MCP reads at ≥250 ms wait with a model that batches, selective parallel dispatch is a real whole-turn win (15–74% across the swept rounds). It is worthless without batching, so propensity must be measured on real models, not assumed. The implementation complexity sits in the scheduler, not the fan-out:

- a per-tool read-only/idempotent classification owned by the app, never inferred from the model;
- barrier semantics for writes and approvals, so they stay in reply order;
- results committed to history in call order;
- per-server concurrency caps and rate-limit/error handling;
- cancellation of siblings when one call fails (this prototype does this);
- no retries of side-effecting calls.

None of this needs Pi's global all-or-nothing mode.

## Safety boundaries and bounds (tested)

- **Capability:** the only data source is `FixtureReader`, which accepts exact fixture keys (`Object.hasOwn`). Traversal, absolute host paths and duplicate paths are rejected before any read is charged. A test statically checks that `prototype.ts`, `fixtures.ts` and `mcp-decision-sweep.ts` import only the tokenizer and fixtures, and contain no `process.`, `require(`, `import(`, `eval(`, `new Function`, `fetch(`, `WebSocket`, `child_process` or `node:` reference.
- **Filter program:** a closed, versioned AST (`select-lines`, exact fixture paths, 1–8 literal terms of ≤80 chars, 1–20 max matches). Extra keys (for example a `code` field) and unknown operations are rejected. Nothing is compiled or evaluated.
- **Bounds enforced at run time, each with a test that trips it:** task wall time (2 s, by budget check plus abort timer); tool calls (16); nested reads (16); paths per call (8); per-result bytes (64 KiB); aggregate result bytes (128 KiB); filter lines scanned (8,192). Memory is bounded through the byte ceilings, because all held data is immutable fixtures plus byte-charged results.
- **Ordering, cancellation, retries:** batch results are committed in call order. A parent abort propagates, and a failed or settled run aborts still-pending sibling reads. Retries are always zero.

These checks show that the prototype is contained. They are not a production security review, and they are not a sandbox for real filesystem, `bash` or MCP access.

## Verification

- `pnpm -C packages/agent-runtime typecheck`: passed.
- `pnpm -C packages/agent-runtime run bench:reduction`: passed, 7 tests. It covers the 20 task/lane invariants, filter AST rejection, order and cancellation, runtime budgets, the static capability scan, measured-vs-model agreement, and the propensity/latency/volume/barrier sweep.
- `vp check`: passed.
