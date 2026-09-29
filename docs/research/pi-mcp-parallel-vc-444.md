# Local MCP parallel-dispatch pilot (VC-444)

**Decision: proceed only to a reviewed, opt-in implementation follow-up ([VC-454](#follow-up-vc-454)); do not enable parallel execution for ordinary Sessions.** A local, fixture-only run with Pi's actual dispatch loop shows material wall-time reductions when a model emits independent MCP calls in one batch. That establishes the workload's potential, not how often real models will batch, nor whether any configured remote MCP tool is safe to overlap.

The 1.2% figure from VC-245 is a result for its sampled historical coding workload, not a fleet-wide bound on browser/serverless MCP work. This benchmark measures a different, latency-heavy workload directly and does not use that old aggregate as a veto. The full five-repeat run took about 4m35s in this workspace; timing cells show noticeable host noise, so p95 based on five samples is especially tentative.

## Reproduce

```sh
pnpm -C apps/desktop run bench:mcp-parallel
```

The command is off the default test lane. It runs five repetitions for each of 40 cases (two artificial network latencies × one/two local MCP servers × cold/warm attachment × batch sizes 1/2/4/8/16), with sequential, parallel and unbatched arms. For a quick smoke only:

```sh
MCP_PARALLEL_BENCH_REPEATS=1 pnpm -C apps/desktop run bench:mcp-parallel
```

The harness uses Pi's real `Agent`, Volli's `createMcpTool` wrapper and desktop `McpSessionHost`, and a local unauthenticated Streamable HTTP MCP fixture. The dependency points app → package: the Pi-facing driver (real `Agent` loop, the VC-245 scripted provider, the MCP tool wrapper and the fixture allowlist policy) lives in `packages/agent-runtime/bench/mcp-parallel/driver.ts` and is exposed only through the `@volli/agent-runtime/bench/mcp-parallel` subpath; it takes the MCP side as a plain `RuntimeMcpPort`. The composition with the desktop MCP host and the fixture server lives in `apps/desktop/e2e/bench/mcp-parallel/` with its own `vite.mcp-parallel-bench.config.ts`, outside the desktop app's default `renderer`/`main` test projects. It uses a fixed in-process synthetic provider (no credentials or paid/remote provider requests), and sends no live MCP calls or remote mutations. The synthetic provider emits the **same tool-call batch** to the sequential and parallel arms (20 ms synthetic provider latency; 1,000 input + 60 output tokens per request); the unbatched control emits those same calls one per assistant reply. Tool-call latencies are 20/80 ms, result payloads are deterministic, and result tokens are counted with `o200k_base` over wrapper text.

“Cold” adds a synthetic 40 ms delay to first client attachment before the real local MCP handshake; the local fixture process itself is already listening. “Warm” opens and reuses the host's cached per-server client before the measured turn. So cold here is an attachment-start regime, not a benchmark of OS process launch or a production server's initialization. The report's tool-time value is the **sum** of Pi-to-host call intervals (and can exceed wall time under overlap). Result bytes are UTF-8 bytes of the wrapper's serialized content; provider tokens and tool-result tokens are separate quantities.

## Quantitative results

Five repeated tasks per cell; p50/p95 in milliseconds, nearest-rank. The following are the **warm, one-server** slices from the full generated 40-cell report. Each wall and tool-time value is p50/p95 ms over five tasks; tool time is the sum of call intervals. Other server-count/startup combinations are included in the reproduction command's full output.

**20 ms local MCP latency**

| batch | sequential wall | parallel wall | unbatched wall | sequential tool time | parallel tool time |
|---:|---:|---:|---:|---:|---:|
| 1 | 69.4 / 80.5 | 67.7 / 70.7 | 68.4 / 69.7 | 26.2 / 32.4 | 24.5 / 26.7 |
| 2 | 91.4 / 95.3 | 66.5 / 69.3 | 115.9 / 119.9 | 48.5 / 51.0 | 49.0 / 51.3 |
| 4 | 153.3 / 188.9 | 74.0 / 76.9 | 212.1 / 236.0 | 108.1 / 128.7 | 111.9 / 122.4 |
| 8 | 248.4 / 255.2 | 74.7 / 81.8 | 401.4 / 413.7 | 204.2 / 211.3 | 244.3 / 277.8 |
| 16 | 439.7 / 459.2 | 70.2 / 88.7 | 751.7 / 774.7 | 393.4 / 413.9 | 431.5 / 653.8 |

**80 ms local MCP latency**

| batch | sequential wall | parallel wall | unbatched wall | sequential tool time | parallel tool time |
|---:|---:|---:|---:|---:|---:|
| 1 | 127.4 / 176.5 | 125.7 / 132.3 | 126.7 / 135.5 | 84.9 / 94.5 | 83.9 / 89.4 |
| 2 | 210.5 / 211.0 | 127.0 / 129.1 | 234.1 / 235.6 | 167.8 / 168.4 | 168.2 / 172.0 |
| 4 | 377.6 / 380.4 | 126.7 / 127.8 | 444.9 / 462.9 | 334.9 / 337.3 | 334.3 / 339.1 |
| 8 | 718.0 / 1093.9 | 130.8 / 145.4 | 864.2 / 878.5 | 674.3 / 975.0 | 697.7 / 761.3 |
| 16 | 1381.8 / 1387.1 | 130.2 / 130.9 | 1709.3 / 1715.8 | 1337.5 / 1343.1 | 1383.9 / 1403.5 |

For the same 16-call emitted batch, warm parallel wall p50 was 84% lower at 20 ms latency and 91% lower at 80 ms than sequential; N=1 had no meaningful gain. The unbatched arm was slower and made more provider requests because each tool call required another synthetic assistant reply. Cold-start p95s were noisier (including large outliers in some cells), so the evidence supports warm scheduling potential, not a stable startup-time forecast. These are five samples per cell, not a production service-level estimate.

Across every normal matrix pair, sequential and parallel received the same model batch and reported identical provider request/token counts and result bytes/tokens. A batch of N calls used two provider requests in either mode (tool batch + final answer); the unbatched control used N+1 requests. Batch size one did not overlap; batches 2/4/8/16 overlapped in the parallel arm, while the unbatched arm remained at peak concurrency one. Pi persisted tool results in assistant source order even when MCP completions differed; the report records completion/result-order divergence separately. Every attached MCP client and local HTTP server was closed in each measured trial.

The separate per-server capacity stress batch (16 calls split across two servers, each limited to two in flight and six starts per 100 ms) produced 12 fixture errors: eight connection-limit and four rate-limit responses, zero automatic retries, and observed server peaks of 2/2. The capacity limits are applied independently per local fixture server. This is a deliberate failure case, not part of the baseline speed table: parallel dispatch can overwhelm a server if a host-level policy does not bound it.

Cancellation was sent during a 500 ms MCP read through the Volli wrapper and attachment host. The local MCP handler observed the abort, its active count drained to zero, the caller settled 1.4 ms after abort in the five-repeat run, and the single opened client was closed. Cancellation remains a negative-capacity/safety result, not a throughput claim.

## Safety and current runtime

- `createPiAgentRuntime` still builds ordinary production Sessions with `toolExecution: "sequential"`; a real runtime test emits a two-tool MCP batch and asserts peak in-flight calls remains one. The only opt-in is `createPiAgentRuntimeForFixture`, an internal test helper not re-exported from `packages/agent-runtime/src/index.ts` nor from the `./bench/mcp-parallel` subpath (a runtime test asserts both), and not imported by any `apps/desktop` production code. The performance harness's parallel mode is likewise fixture-local. No product setting or shipping default changed.
- Pi's mode is Agent-wide, not a per-call switch. Its per-tool `executionMode: "sequential"` override forces the **whole assistant batch** sequential if any call in it is marked sequential. Therefore the smallest defensible production pilot is: keep the public default sequential; add a host-authored allowlist for exact, audited, idempotent read tools; for an explicitly opted-in fixture/session use Pi parallel mode but mark every non-allowlisted tool sequential. A mixed batch then safely falls back to serial execution, at the cost of losing overlap for its safe reads. MCP descriptions, annotations and “read-only” claims are untrusted and never create allowlist entries.
- The negative-control tests each emit one batch containing two writes to a disposable local file and one MCP call. In the first, the MCP call is a mutation whose definition claims “read-only”; it is not allowlisted and is marked sequential. In the second, the MCP call is an allowlisted read (eligible to overlap on its own) mixed with the sequential local edits. With test-only parallel Agent mode, Pi runs both batches one at a time: edit → MCP call → edit, peak concurrency one, exactly the expected fixture side effects, and final file content from the second edit. No user's files or remote service are touched.
- Pi's `beforeToolCall` preflight runs serially; parallel mode does not create simultaneous approval prompts, but it does hold all calls in the batch until the slowest approval settles. Keep authority/approval before dispatch; never batch around a pending approval.
- Persisted tool-result order is source order; completion/activity order can differ. Use tool-call IDs to preserve lineage from Pi result to runtime observation. The MCP host routes on the frozen exact `(serverId, toolName)` definition; the downstream protocol request does not carry Volli's `toolCallId` as an idempotency key.
- The desktop MCP host lazily caches one protocol client per server **per Session attachment** and closes it with that attachment. It has no shared per-server semaphore/rate budget across Sessions. Transport failures become safe tool errors and the host retires a failed client; there is no automatic MCP mutation retry in this path. A model may still decide to issue another tool call, so side-effect idempotency remains the server/host policy's responsibility. Before any shipping opt-in, add shared server-scoped concurrency/rate limits and decide retry semantics for each exact tool; do not infer capacity or idempotency from MCP metadata.

## Recommendation and evaluation plan

**Go** on an opt-in implementation follow-up for vetted MCP reads; **no-go** on a global flip. The synthetic evidence establishes potential scheduling savings for model-issued fan-out; it does not measure real model propensity to batch, server-specific costs, multiple-Session aggregate load, or the value of adding prompt instructions. There were no paid model calls. The old VC-245 transcript audit remains evidence about its historical Sessions only, not about this prospective browser/serverless workload.

For a follow-up, record per-task paired sequential/parallel runs for actual opted-in read workloads: emitted batch size and dependency graph; p50/p95 turn and tool time; provider request count; output bytes/tokens; retries/errors/cancellations; completion vs transcript order; approval wait; server ID and in-flight/rate budget; and cleanup. First run only against local fixtures, then evaluate model batch propensity using an approved provider/cost budget before a developer-only remote read pilot. Require zero mixed-write concurrency, cancellation cleanup, result lineage, and a safe per-server cap before expanding. Coordinate turn-level accounting with VC-441, result-volume evaluation with VC-442, and shared fleet/resource caps with VC-366.

Programmatic tool calling is a separate lever: it may reduce provider rounds and model-visible result output. Pi parallel dispatch only overlaps a batch the model has already issued; it does not reduce provider requests or tool-result volume for the same batch.

## Follow-up (VC-454)

**VC-454 — Opt-in parallel MCP reads: host allowlist, per-server bound, sequential fallback** carries the go decision into an implementation: a host-authored exact `(serverId, toolName)` allowlist of audited idempotent reads (never derived from MCP metadata); Pi parallel mode only for opted-in Sessions, with every non-allowlisted tool marked sequential so mixed batches fall back to serial; a host-level per-server concurrency/rate bound shared across Sessions (the capacity stress case above produced 12 errors without one); approvals kept before dispatch; no automatic MCP retries; and the task-level evaluation plan above, first against these fixtures and then, with an approved budget, real model batch propensity.

## Checks run

- `pnpm -C apps/desktop run bench:mcp-parallel` — the numbers above are from the original five-repeat run (4 tests). After relocating the bench to the app and adding the allowlisted-read negative control, `MCP_PARALLEL_BENCH_REPEATS=1 pnpm -C apps/desktop run bench:mcp-parallel` passed 5/5 tests (limit stress again 12 errors: 8 connection-limited, 4 rate-limited, 0 retries).
- `pnpm -C packages/agent-runtime run typecheck` — passed.
- `pnpm -C apps/desktop run typecheck` — passed.
- `pnpm -C packages/agent-runtime exec vp test run src/pi/runtime.test.ts -t 'keeps ordinary production Sessions sequential|opts a fixture Session into parallel MCP dispatch' --maxWorkers=1` — passed, 2 targeted tests (218 skipped by filter).
- `git diff --check` — passed.

The full workspace test suite was not run.
