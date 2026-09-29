# Local MCP parallel-dispatch pilot (VC-444)

**Decision: proceed only to a reviewed, opt-in implementation follow-up ([VC-454](#follow-up-vc-454)); do not enable parallel execution for ordinary Sessions.** A local, fixture-only run with Pi's actual dispatch loop shows material wall-time reductions when a model emits independent MCP calls in one batch. That establishes the workload's potential, not how often real models will batch, nor whether any configured remote MCP tool is safe to overlap.

The 1.2% figure from VC-245 is a result for its sampled historical coding workload, not a fleet-wide bound on browser/serverless MCP work. This benchmark measures a different, latency-heavy workload directly and does not use that old aggregate as a veto. The full five-repeat run takes a few minutes; timing cells show noticeable host noise. With five samples per cell, nearest-rank p95 would equal the maximum, so the tables report **p50/max**. `MCP_PARALLEL_BENCH_REPEATS=20` (or more) switches the generated label to p95.

## Reproduce

```sh
pnpm -C apps/desktop run bench:mcp-parallel
```

The command is off the default test lane. It runs five repetitions for each of 40 cases (two artificial network latencies × one/two local MCP servers × cold/warm attachment × batch sizes 1/2/4/8/16), with sequential, parallel and unbatched arms. For a quick smoke only:

```sh
MCP_PARALLEL_BENCH_REPEATS=1 pnpm -C apps/desktop run bench:mcp-parallel
```

The harness uses Pi's real `Agent`, Volli's `createMcpTool` wrapper and desktop `McpSessionHost`, and a local unauthenticated Streamable HTTP MCP fixture. The dependency points app → package: the Pi-facing driver (real `Agent` loop, the VC-245 scripted provider, the MCP tool wrapper, and the same `applyToolDispatch` allowlist policy the runtime's fixture factory uses) lives in `packages/agent-runtime/bench/mcp-parallel/driver.ts` and is exposed only through the `@volli/agent-runtime/bench/mcp-parallel` subpath; it takes the MCP side as a plain `RuntimeMcpPort`. The composition with the desktop MCP host and the fixture server lives in `apps/desktop/e2e/bench/mcp-parallel/` with its own `vite.mcp-parallel-bench.config.ts`, outside the desktop app's default `renderer`/`main` test projects. It uses a fixed in-process synthetic provider (no credentials or paid/remote provider requests), and sends no live MCP calls or remote mutations. The synthetic provider emits the **same tool-call batch** to the sequential and parallel arms (20 ms synthetic provider latency; 1,000 input + 60 output tokens per request); the unbatched control emits those same calls one per assistant reply. Tool-call latencies are 20/80 ms on the first server; a second server adds max(5 ms, latency/4), which gives 25/100 ms, so completions interleave. Result payloads are deterministic, and result tokens are counted with `o200k_base` over wrapper text.

“Cold” adds a synthetic 40 ms delay to first client attachment before the real local MCP handshake; the local fixture process itself is already listening. “Warm” opens and reuses the host's cached per-server client before the measured turn. So cold here is an attachment-start regime, not a benchmark of OS process launch or a production server's initialization. The report's tool-time value is the **sum** of Pi-to-host call intervals (and can exceed wall time under overlap). The driver runs a bare Pi `Agent`, not `attachSession`, so approval (`beforeToolCall`), the Agent Tool Surface and durable tool-event persistence are **not** in these timings. The speed-ups are best cases for dispatch alone, not a forecast for a full Session turn. The same dispatch policy is covered through the real attach path by the runtime tests below. Result bytes are UTF-8 bytes of the wrapper's serialized content; provider tokens and tool-result tokens are separate quantities.

## Quantitative results

Five tasks per cell; values are nearest-rank **p50 / max** in milliseconds, from the latest run after the review fixes. Tool time is the sum of call intervals. The full 40-cell table (1/2 servers × cold/warm × both latencies) is printed by the reproduction command. Below are the **warm, one-server** slices and a **cold, two-server** wall-time slice.

**Warm, one server, 20 ms MCP latency**

| batch | sequential wall | parallel wall | unbatched wall | sequential tool time | parallel tool time |
|---:|---:|---:|---:|---:|---:|
| 1 | 66.4 / 67.6 | 66.6 / 66.9 | 66.4 / 68.3 | 24.5 / 25.0 | 23.8 / 24.2 |
| 2 | 89.8 / 92.8 | 66.7 / 67.2 | 112.0 / 114.0 | 47.6 / 49.2 | 48.2 / 50.0 |
| 4 | 138.0 / 140.7 | 66.9 / 75.0 | 201.6 / 204.9 | 95.9 / 98.2 | 98.5 / 115.6 |
| 8 | 239.9 / 253.0 | 69.0 / 76.7 | 383.3 / 397.3 | 195.1 / 198.9 | 222.0 / 253.6 |
| 16 | 447.1 / 470.4 | 75.7 / 83.7 | 777.8 / 862.2 | 399.8 / 423.4 | 503.7 / 569.2 |

**Warm, one server, 80 ms MCP latency**

| batch | sequential wall | parallel wall | unbatched wall | sequential tool time | parallel tool time |
|---:|---:|---:|---:|---:|---:|
| 1 | 126.3 / 128.4 | 127.4 / 129.7 | 127.2 / 139.5 | 84.0 / 85.1 | 84.5 / 87.0 |
| 2 | 210.5 / 211.4 | 128.9 / 129.2 | 233.5 / 235.0 | 167.9 / 168.7 | 170.9 / 172.4 |
| 4 | 381.0 / 385.9 | 128.2 / 130.8 | 443.8 / 448.2 | 337.3 / 341.9 | 344.2 / 350.8 |
| 8 | 716.9 / 731.1 | 131.4 / 151.7 | 865.8 / 867.6 | 673.8 / 687.8 | 704.9 / 801.6 |
| 16 | 1390.2 / 1411.4 | 130.1 / 141.0 | 1711.7 / 1769.4 | 1345.8 / 1361.1 | 1387.5 / 1491.7 |

**Cold, two servers: task wall time (sequential → parallel → unbatched)**

| batch | 20 ms (+25 ms second server) | 80 ms (+100 ms second server) |
|---:|---:|---:|
| 1 | 107.5 → 108.4 → 108.2 | 170.6 → 171.0 → 168.1 |
| 2 | 178.6 → 116.4 → 206.5 | 316.7 → 194.8 → 337.9 |
| 4 | 247.6 → 118.0 → 308.0 | 503.1 → 189.6 → 567.4 |
| 8 | 342.3 → 124.3 → 496.7 | 880.6 → 195.7 → 1025.9 |
| 16 | 556.3 → 120.6 → 893.6 | 1632.0 → 193.7 → 1963.2 |

For the same 16-call emitted batch, warm one-server parallel wall p50 was 83% lower than sequential at 20 ms latency and 91% lower at 80 ms. Cold two-server wall p50 was 78% and 88% lower. N=1 had no meaningful gain. Summed tool time rises under parallel dispatch (for cold starts, calls queue behind the first attach), and it can exceed wall time. The unbatched arm was slower and made more provider requests because each tool call needed another synthetic assistant reply. These are five samples per cell on a shared developer machine, not a production service-level estimate.

Across every normal matrix pair, sequential and parallel received the same model batch and reported identical provider request/token counts and result bytes/tokens. A batch of N calls used two provider requests in either mode (tool batch + final answer); the unbatched control used N+1 requests. Batch size one did not overlap; batches 2/4/8/16 overlapped in the parallel arm, while the unbatched arm remained at peak concurrency one. Pi persisted tool results in assistant source order even when MCP completions differed; the report records completion/result-order divergence separately. Every attached MCP client and local HTTP server was closed in each measured trial.

The separate per-server capacity stress batch (16 calls split across two servers, each limited to two in flight and six starts per 100 ms) produced 12 fixture errors in parallel mode: eight connection-limit and four rate-limit responses, and observed server peaks of 2/2. The servers received exactly 16 calls, so nothing in the stack retried below the host. The same batch run sequentially produced zero errors, with server peaks of 1/1. The capacity limits are applied independently per local fixture server. This is a deliberate failure case, not part of the baseline speed table: parallel dispatch can overwhelm a server if a host-level policy does not bound it.

Cancellation was sent during a 500 ms MCP read through the Volli wrapper and attachment host. The local MCP handler observed the abort, its active count drained to zero, the caller settled 1.6 ms after abort in the latest five-repeat run, the single opened client was closed, and the fixture server stopped listening. Closing that fixture server took about 4 s after the abort, so a socket may linger. Cancelling a whole in-flight batch across servers is not yet covered; it is listed in VC-454. Cancellation remains a negative-capacity/safety result, not a throughput claim.

## Safety and current runtime

- `createPiAgentRuntime` still builds every ordinary Session with `toolExecution: "sequential"`, and its tool array is unchanged. The only opt-in is `createPiAgentRuntimeForFixture(options, dispatch)`. It is an internal test seam, not re-exported from `src/index.ts` or the `./bench/mcp-parallel` subpath (a runtime test checks every `package.json#exports` entry for the value under any name), and no `apps/desktop` production code imports it. It is also **not** a bare flag. `ToolDispatch` (`src/pi/tool-dispatch.ts`) is either `sequential` or `parallel` with a host-authored set of exact `serverId:toolName` keys. In parallel mode, every built-in tool (edit, write, bash, verbs, browser…) and every unlisted MCP tool is marked `executionMode: "sequential"`. Volli's built-in tools declare no mode of their own, so without that marking a parallel mode would also run file edits concurrently. No product setting or shipping default changed.
- Pi's mode is Agent-wide, not a per-call switch. Its per-tool `executionMode: "sequential"` override (honoured in `agent-loop.js`) forces the **whole assistant batch** sequential if any call in it is marked sequential. A mixed batch therefore falls back to serial execution safely, at the cost of losing overlap for its safe reads. MCP descriptions, annotations and "read-only" claims are untrusted and never create allowlist entries.
- Runtime tests that go through the real `attachSession` path, and so run in CI (`describe("VC-444 tool dispatch")` in `src/pi/runtime.test.ts`):
  - a production Session keeps a two-call MCP batch at peak concurrency one (flipping the default to parallel fails it);
  - two allowlisted reads overlap, with results persisted in source order;
  - an allowlisted read plus an unlisted MCP tool stays serial;
  - near-miss keys (a listed server with an unlisted tool, a listed tool on another server) stay serial;
  - an allowlisted read plus a built-in `write` stays serial (the write lands only after the read ends).

  Removing the dispatch marking, or matching on tool name only, fails these tests.
- The HTTP-level negative controls in the bench each emit one batch of local file edit → MCP call → local file edit. The local edit declares no mode, like the built-ins, and the policy marks it sequential. In the first, the MCP call is a mutation whose definition claims "read-only"; it is not allowlisted. In the second, the MCP call is an allowlisted read. With parallel Agent mode, Pi runs both batches one call at a time in source order, with the expected fixture side effects and the final file content from the second edit. No user's files or remote service are touched.
- Pi's `beforeToolCall` preflight runs serially; parallel mode does not create simultaneous approval prompts, but it does hold all calls in the batch until the slowest approval settles. Keep authority/approval before dispatch; never batch around a pending approval.
- Persisted tool-result order is source order; completion/activity order can differ. Use tool-call IDs to preserve lineage from Pi result to runtime observation. The MCP host routes on the frozen exact `(serverId, toolName)` definition; the downstream protocol request does not carry Volli's `toolCallId` as an idempotency key.
- The desktop MCP host lazily caches one protocol client per server **per Session attachment** and closes it with that attachment. It has no shared per-server semaphore/rate budget across Sessions. Transport failures become safe tool errors and the host retires a failed client. **Under parallel dispatch this is a hazard:** `McpSessionHost#call` closes the shared client on *any* thrown error, the call's own abort included, and it drops the cache entry without an identity check. So one failed or cancelled call can fail every sibling call to that server. VC-454 must fix this before any parallel use. One of five post-review smoke runs saw parallel and sequential result volume diverge while the machine was heavily loaded, which is consistent with this hazard; the harness now prints both volumes and error counts when that check fails. there is no automatic MCP mutation retry in this path. A model may still decide to issue another tool call, so side-effect idempotency remains the server/host policy's responsibility. Before any shipping opt-in, add shared server-scoped concurrency/rate limits and decide retry semantics for each exact tool; do not infer capacity or idempotency from MCP metadata.

## Recommendation and evaluation plan

**Go** on an opt-in implementation follow-up for vetted MCP reads; **no-go** on a global flip. The synthetic evidence establishes potential scheduling savings for model-issued fan-out; it does not measure real model propensity to batch, server-specific costs, multiple-Session aggregate load, or the value of adding prompt instructions. There were no paid model calls. The old VC-245 transcript audit remains evidence about its historical Sessions only, not about this prospective browser/serverless workload.

For a follow-up, record per-task paired sequential/parallel runs for actual opted-in read workloads: emitted batch size and dependency graph; p50/p95 turn and tool time; provider request count; output bytes/tokens; retries/errors/cancellations; completion vs transcript order; approval wait; server ID and in-flight/rate budget; and cleanup. First run only against local fixtures, then evaluate model batch propensity using an approved provider/cost budget before a developer-only remote read pilot. Require zero mixed-write concurrency, cancellation cleanup, result lineage, and a safe per-server cap before expanding. Coordinate turn-level accounting with VC-441, result-volume evaluation with VC-442, and shared fleet/resource caps with VC-366.

Programmatic tool calling is a separate lever: it may reduce provider rounds and model-visible result output. Pi parallel dispatch only overlaps a batch the model has already issued; it does not reduce provider requests or tool-result volume for the same batch.

## Follow-up (VC-454)

**VC-454 — Opt-in parallel MCP reads: host allowlist, per-server bound, sequential fallback** carries the go decision into an implementation: a host-authored exact `(serverId, toolName)` allowlist of audited idempotent reads (never derived from MCP metadata); Pi parallel mode only for opted-in Sessions, with every non-allowlisted tool marked sequential so mixed batches fall back to serial; a host-level per-server concurrency/rate bound shared across Sessions (the capacity stress case above produced 12 errors without one); approvals kept before dispatch; no automatic MCP retries; and the task-level evaluation plan above, first against these fixtures and then, with an approved budget, real model batch propensity. The code review added these to its scope:
- fix the host's shared-client teardown first;
- store eligibility as a host-authored field in the Session's frozen MCP tool data, with a per-Session opt-in, instead of this pilot's per-runtime key set;
- put the per-server bound in a `RuntimeMcpPort` wrapper that does not depend on desktop code;
- carry an operation id (Session id + tool-call id) before any retry;
- add batch-cancellation coverage;
- re-measure through `createPiAgentRuntime` with ≥20 repeats.

Coordination notes went to VC-441 (turn timing), VC-442 (result volume) and VC-366 (fleet budget) as ticket comments.

## Checks run

- `pnpm -C apps/desktop run bench:mcp-parallel`: 5/5 passed after syncing with main and applying the review fixes. This is the five-repeat run in the tables. `MCP_PARALLEL_BENCH_REPEATS=1` smokes also passed 5/5 in five of six runs; the sixth hit the result-volume divergence described above.
- `pnpm -C packages/agent-runtime run typecheck` and `pnpm -C apps/desktop run typecheck` (which now includes `tsconfig.bench.json` for the bench files): passed.
- `vp check`: passed.
- `pnpm -C packages/agent-runtime exec vp test run src/pi/runtime.test.ts`: 252 passed. `pnpm -C packages/agent-runtime run test:coverage`: 100% thresholds hold, including `tool-dispatch.ts` and `runtime.ts`.
- `vp run -r test` (before the review fixes): all workspace suites passed (desktop 597 files / 10,968 tests). The bench files were in no default lane.
