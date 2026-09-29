# Opt-in parallel MCP reads through the real Session path (VC-454)

**What shipped:** parallel dispatch of MCP reads is possible, developer-only, for exact tools a host has audited, behind a per-server bound shared by every Session. Ordinary Sessions are unchanged: one tool call at a time. There is no product setting and no UI. The owner has to sign off before this becomes anything more.

VC-444 measured Pi's parallel dispatch on a bare `Agent`: no approval, no Agent Tool Surface, no durable tool events, and no bound on how many calls reach a server. This report measures the same 40-cell workload through `createPiAgentRuntime`, with the allowlist and host bound in place.

## What changed

1. **Shared-client teardown (fixed first).** `McpSessionHost` shares one protocol client per server across every call an attachment makes. It used to close that client on any thrown error, a call's own abort included, and dropped the cache entry without checking it was the same client. Now the protocol client reports a lost or refused connection as `McpTransportFailure`. The host retires a client only on that error, identity-checked, and closes it only after the last call still running on it settles. A shared open runs under the attachment's lifetime, not the first caller's signal.
2. **Per-server bound** (`packages/agent-runtime/src/mcp/server-budget.ts`). A `RuntimeMcpPort` wrapper with no desktop dependency, keyed by server id (the `mcp_servers` primary key, so unique across projects). There is one per process, and every attachment's port is bound through it. Calls over budget queue first-in first-out rather than fail, a queued call is withdrawn by its own signal, and closing one binding withdraws that Session's calls only. Nothing retries. The shipped default is 8 in flight and 32 starts per second per server. A start counts until one window after its call **settles**. A server has certainly received a call once it has answered it, so however the network delays requests, no window the server measures sees more than `maxStarts` of them. A unit test with randomly delayed arrivals fails a start-counted window and passes this one. The cost is throughput: one call's latency is added to every window.
3. **Host-authored eligibility, selected per Session.** `McpToolDefinition.parallelRead?: true` is frozen with the Session's MCP definitions. Its only writer is `withParallelReadEligibility`, which marks exact `serverId:toolName` keys from a host allowlist and strips every other mark. It never reads a description, annotation or `readOnlyHint`. The Session event codec round-trips the mark and refuses any value other than `true`. `applyToolDispatch` selects Pi's `parallel` mode only when the Session carries marks **and** the runtime was built with `parallelMcpReads`. Every built-in tool and every unmarked tool is then marked `executionMode: "sequential"`, so a mixed batch runs one call at a time in source order. `createPiAgentRuntime`'s default is unchanged, and VC-444's `createPiAgentRuntimeForFixture` seam is gone.
4. **Developer-only opt-in.** An unpackaged build reads `VOLLI_DEV_MCP_PARALLEL` once at launch: a `reads` allowlist and optional per-server `limits`. It stamps new root Sessions from it and turns on `parallelMcpReads`. Unsetting it and relaunching turns parallel dispatch off for every Session, marked or not. A packaged build ignores it. The syntax is in `docs/mcp.md`.

## Safety constraints and where each is tested

| Constraint | Test |
| --- | --- |
| Production default is sequential | `runtime.test.ts` › *keeps ordinary production Sessions sequential*; *keeps a Session born unmarked sequential even on a runtime that honours marks*; *ignores a Session's frozen marks unless the runtime was built to honour them* |
| Metadata cannot opt in | `runtime.test.ts` › *never lets server metadata opt a tool in*; `mcp.test.ts` › *marks exactly the allowlisted tools and never reads what a server says about itself*; *strips a mark the host did not author* |
| Mixed batches are serial, in source order | `runtime.test.ts` › marked read + unmarked MCP mutation; marked read + built-in `write`; exact-key near misses. Bench: built-in `write` → MCP → `write` with an unlisted mutation and with an allowlisted read |
| Per-server cap: VC-444 stress with zero limit errors | bench › *completes the VC-444 capacity stress batch with no limit errors under the host bound*; `server-budget.test.ts` (cap, window, jitter) |
| Cancellation drains and closes | `runtime.test.ts` › *withdraws in-flight and queued calls across two servers when the turn is interrupted*; bench › the same across two real HTTP fixture servers, then client close |
| Approvals before dispatch | `runtime.test.ts` › *settles the whole batch's authority before any marked read is dispatched*; `tool-dispatch.test.ts` › *no call in a parallel batch starts until every approval settles* (parked `beforeToolCall`) |
| No retries; lineage; source order | `server-budget.test.ts` › *hands each call to the port exactly once*; `runtime.test.ts` › *overlaps host-marked MCP reads, results in source order and lineage intact*; bench asserts zero retries and source order in every trial |
| Shared-client teardown | `session-host.test.ts` › two in-flight calls where one aborts and the other completes, shared open survives the first caller's abort, identity-checked retirement with draining; `client.test.ts` › error classification |

Mutation checks during development: ignoring the runtime switch fails the kill-switch test; dropping the `sequential` marking fails both mixed-batch tests; the pre-fix host fails six of the new host tests; a start-counted window fails the budget's jitter and slow-call tests.

## Results (evaluation step 1)

`MCP_PARALLEL_BENCH_REPEATS=20 pnpm -C apps/desktop bench:mcp-parallel` ran 20 repeats per cell after one discarded warm-up trial, so the tails are nearest-rank **p95**. All five tests passed. The full 40-cell output is in [`mcp-parallel-vc454/tables.md`](mcp-parallel-vc454/tables.md).

Setup: a scripted provider (no credentials, no paid calls), local unauthenticated Streamable HTTP fixture servers (20/80 ms per call; a second server adds max(5 ms, latency/4)), and the shipped default bound of 8 in flight and 32 starts per second per server. Every turn is a real Session: `startSession`, the Authority gate, the Agent Tool Surface, the MCP wrapper and durable observations, then the budget, then the desktop `McpSessionHost`. The sequential arm is an ordinary Session. The parallel arm is a runtime built with `parallelMcpReads` and a Session stamped from the exact-key allowlist. Both arms receive the same one-reply batch. The unbatched control emits the same calls one per reply.

**Task wall time, p50/p95 ms (sequential → parallel)**

| cell | sequential | parallel | p50 change |
| --- | ---: | ---: | ---: |
| warm, 1 server, 20 ms, n=2 | 106.0/119.7 | 80.2/102.0 | −24% |
| warm, 1 server, 20 ms, n=8 | 285.8/316.8 | 92.5/143.4 | −68% |
| warm, 1 server, 20 ms, n=16 | 516.2/712.1 | 126.8/171.8 | −75% |
| warm, 1 server, 80 ms, n=2 | 217.4/223.6 | 130.6/144.9 | −40% |
| warm, 1 server, 80 ms, n=8 | 729.4/817.8 | 133.9/143.4 | −82% |
| warm, 1 server, 80 ms, n=16 | 1419.8/1439.5 | 226.7/243.4 | −84% |
| warm, 2 servers, 20 ms, n=16 | 507.8/563.8 | 83.2/107.9 | −84% |
| warm, 2 servers, 80 ms, n=16 | 1578.3/1625.3 | 165.6/182.6 | −90% |
| cold, 2 servers, 20 ms, n=16 | 628.3/680.1 | 129.7/170.8 | −79% |
| cold, 2 servers, 80 ms, n=16 | 1701.7/1767.4 | 207.5/250.1 | −88% |
| warm, 1 server, 20 ms, n=1 | 77.3/105.5 | 77.2/84.0 | none |

- **The bound sets the ceiling, not the batch.** A 16-call batch to one server peaks at 8 in flight and runs in two waves, so one-server n=16 saves 75–84% here against 83–91% uncapped in VC-444. Queue wait (p50) for those cells was 247 ms warm at 20 ms and 707 ms warm at 80 ms. Split across two servers, each gets its own 8 and the saving returns to 84–90%.
- **The Session path costs about 11 ms per turn** over VC-444's bare `Agent` (warm n=1 at 20 ms: 77.3 ms against 66.4 ms). Every call passes the Authority gate before any call is dispatched: gated calls equal batch size in every trial of every arm.
- **Accounting is identical across arms.** For the same batch, sequential and parallel sent the same provider requests (2) and tokens (2,120), and returned the same result bytes and tokens (305 bytes / 48 tokens per call). The unbatched control needed N+1 requests.
- **Clean in every trial** (40 cells × 3 arms × 20 repeats): zero fixture errors, zero retries (host calls equal distinct tool-call ids), zero cancellations, persisted results in source order, every client closed and every fixture server stopped listening. Completion order differed from source order in up to 20/20 parallel trials of the cells where completions interleave. That is expected, and the persisted order did not change.
- **Approval wait was 0 ms throughout.** The built-in rule pack allows MCP reads, so no call parked on a person. The ordering guarantee is tested separately with a parked `beforeToolCall`.
- **Cold parallel tool time exceeds wall time.** Calls wait on the one shared connection open, and the host counts that wait as tool time. The same thing happened in VC-444.

**Capacity stress** (VC-444's case: 16 calls over two servers that each allow 2 in flight and 6 starts per 100 ms):

| arm | fixture errors | host/fixture peak per server | wall |
| --- | ---: | --- | ---: |
| parallel, host bound set to the servers' limits | **0** | 2,2 / 2,2 | 163.1 ms |
| parallel, shipped default bound only | 12 (8 connection, 4 rate) | — | 33.2 ms |
| sequential | 0 | — / 1,1 | 430.2 ms |

The servers received exactly 16 calls in each arm, so nothing retried. The bound is only as good as the limits it is given: a server tighter than the default needs its own host-authored entry (the `limits` field of the developer opt-in).

**Cancellation.** A four-call batch across two servers, with one slot per server, leaves two calls in flight and two queued. Stopping the turn settled it in 6.7 ms. The servers observed 2 cancellations and their active counts drained to 0. The two queued calls never reached a server. The budget drained to 0 active and 0 queued, and both clients closed when the attachment was disposed.

## Next steps that need owner approval

Neither of these was run. There were no paid provider calls and no remote MCP servers.

**Evaluation 2 — real model batch propensity (needs a provider/cost budget).** Everything above assumes the model already emitted a batch. Whether real models do so on MCP read tasks is the number that decides the value.
- Add `packages/agent-runtime/bench/mcp-parallel/live-batch-propensity.live.test.ts` on the pattern of VC-245's `bench/parallel-tools/live-batch-rate.live.test.ts`. Put it in the existing `bench:live` lane, skipped unless `PI_LIVE_BENCH=1`. Each trial is a real `createPiAgentRuntime` Session against the local HTTP fixtures (no remote server), with tools shaped like real reads (`get_issue(id)`, `list_directory(path)`, `search(query)`) and tasks whose answer needs 2–8 independent reads.
- Pair every task sequential vs parallel, since the model cannot see the mode. Record emitted batch sizes, the share of turns with ≥2 MCP calls in one reply, provider requests and tokens, turn wall time and task correctness.
- Suggested size: 8 tasks × 2 arms × 5 repeats × 2 models (one Anthropic, one OpenAI) = 160 turns at about 3 requests and 5k input tokens each, roughly 2.4M input and 0.1M output tokens. That is about $3–4 on a Haiku-class model or $9–11 on a Sonnet-class model. The owner picks the models and the ceiling.

**Evaluation 3 — developer-only remote read pilot (needs approved servers).** The mechanism is ready now. A developer on an unpackaged build runs `VOLLI_DEV_MCP_PARALLEL='{"reads":[…],"limits":{…}}' pnpm dev` (see `docs/mcp.md`) naming only owner-approved, read-only remote tools, with `limits` set to each server's published capacity. Expand only if every run shows zero mixed-write concurrency, clean cancellation, preserved lineage and no limit errors under the cap, compared paired against the same tasks with the variable unset. No remote mutation tool may appear in `reads`.

**Before any retry is added:** `RuntimeMcpCall.toolCallId` still never reaches a server. A retry of an exact tool audited as idempotent should carry an operation id derived from the Session id and the tool-call id, as `mcp_operations` rows already are (`${sessionId}:${toolCallId}`).

## Coordination

- **VC-366 (fleet budgets):** this adds a per-server ceiling (8 in flight, 32 starts per second) shared by every Session in the process. It is not a fleet-wide ceiling across servers.
- **VC-441 (turn accounting):** the bench reports turn wall, gate count, approval wait and budget queue wait per turn.
- **VC-442 (result volume):** result bytes and tokens are measured on the tool-result text the model actually receives, and are identical across dispatch modes.

Note: programmatic tool calling is a separate lever. It can reduce provider rounds and model-visible output. Pi's parallel dispatch only overlaps a batch the model has already issued.

## Checks run

- `MCP_PARALLEL_BENCH_REPEATS=20 pnpm -C apps/desktop bench:mcp-parallel` — 5/5 passed (the tables above).
- Targeted suites: `packages/agent-runtime` (`runtime.test.ts`, `tool-dispatch.test.ts`, `server-budget.test.ts`, `mcp-tools.test.ts`), `packages/shared` (`mcp`, `mcp-surface`, `session-event-codec`, `agent-tool-surface`), `apps/desktop` (`src/main/mcp/`, `pi-adapter.test.ts`). `server-budget.ts`, `tool-dispatch.ts`, `runtime.ts`, `mcp.ts` and `session-event-codec.ts` hold 100% coverage.
- Typecheck of `@volli/agent-runtime` and `apps/desktop` (including `tsconfig.bench.json`).
