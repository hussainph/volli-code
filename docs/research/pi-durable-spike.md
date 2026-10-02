# VC-497 — Pi Durable behind AgentRuntime

Date: 2026-10-02. **Ruling: wait**, with a concrete readiness path toward incorporation. Do not adopt 1.0.0 as the default runtime, or silently switch cloud execution to it yet.

The execution-only checkpoint split is **viable in principle and demonstrated for a narrow fixture**. Pi Durable's crash continuation and request deduplication hold up. The missing piece is an Engine-owned resume/projection protocol, not a reason to create another product ledger. Compaction and authority parity are release blockers, even for the cloud venue. This is a time-boxed spike, not an adoption patch.

## Artifact, isolation and reproducibility

- Base checked with `git fetch origin && git merge-base --is-ancestor origin/main HEAD`: passed. Base `1fdaafda223ae7e0c65f1a437f947632e951667f` (Pi 0.99.2 plus the existing patches).
- Exact dev pin `@earendil-works/pi-durable@1.0.0`, `@earendil-works/chord@1.0.0`, and alias `pi-durable-ai = npm:@earendil-works/pi-ai@1.0.0`. Lockfile records the nested 1.0.0 beside production Pi 0.99.2. No VC-496-owned source file changed.
- Prototype: `packages/agent-runtime/bench/pi-durable/runtime.ts`, structurally implements the existing `AgentRuntime`/`RuntimeAttachmentHandle` port. `createDurableSpikeRuntime({ enabled: false, fallback, ... })` returns the existing runtime itself. Only ticket Sessions take the enabled path; other roles use the fallback.
- Opens `Harness.open(await openNodeSqliteStorage(path), ...)`, one supplied checkpoint file per Session. New benchmark files only; **no desktop factory wiring, public runtime export, existing sidecar changes, or on-disk product format changes**. Dependencies are dev-only and not added to the production notice graph.
- Intentionally restricted: text-only, reasoning off, frozen read/write tools, one active input, deterministic authority gate. Unsupported surfaces/resources/legacy recovery are refused. Automatic compaction is disabled in the adapter and tested separately. `recovery` stays undefined rather than pretending this SQLite file is a legacy `RuntimeRecoveryRef.runtime = "pi"` JSONL sidecar.
- Model access and utility completions delegate to the existing runtime. The adapter is **not parity** for billing, authority audit, approvals, resource carry, busy steering, retry supervision, tool output bounds, cancellation or historical attachments. Its observer uses real product vocabulary, but this does not make it a drop-in desktop runtime.

Run from the worktree after `pnpm install`:

```sh
pnpm -C packages/agent-runtime typecheck
pnpm -C packages/agent-runtime exec vp test run --config vite.bench.config.ts \
  bench/pi-durable/durability.bench.test.ts \
  bench/pi-durable/compaction.bench.test.ts \
  bench/pi-durable/overhead.bench.test.ts \
  bench/pi-durable/watch.bench.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"
```

Optional `VC497_REPORT` and `VC497_WATCH_REPORT` paths save timing JSON inside the workspace. Published samples: [runtime](pi-durable-overhead.json), [watch](pi-durable-watch-overhead.json). Tests use synthetic faux providers, real files and Node SQLite, no credentials or paid model requests. Temporary data and the child bundle are created under this worktree and removed. The parent kills only its own child with **SIGKILL**, not graceful harness close.

## Crash and exactly-once results

`durability.bench.test.ts` bundles an owned child, waits for committed output (`api.details()` flush) or the first committed stream update, kills it, and opens the same SQLite file in a new process. The original submit caller never received its turn-end reply. Reopen resumes without new user input; the repeated Command reacquires the original submission.

| Death point | External execution after reopen | Committed result / model sees | Product projection in test |
| --- | --- | --- | --- |
| Safe read, after output commit but before result | Read invocation count **2** | Normal read result; progress is restarted rather than appended twice | One started/completed product Turn, one tool row and final answer |
| Unsafe write, after file write and output commit | Write invocation count **1**; file still has the one effect | `Tool write was interrupted and may have partially run`, with `write effect committed externally` output | Failed/interrupted tool row; model can answer, so enclosing Turn completes |
| Mid-model stream | Request sent again, not continued at a token offset | Committed partial becomes an **aborted** assistant entry; a new assistant answer follows | Partial and resumed answer remain visible; product Turn completes |
| Safe read, then input path replaced with symlink outside its workspace | Invocation count remains **1** | Execute-side scope recheck refuses `Outside spike workspace`; outside contents never reach model | Failed tool row and model answer, not an unauthorized reread |

Each scenario: repeated `command-497` produces **0 additional model requests**; reconciliation returns exactly one accepted Command mapping; another reconciliation with its acknowledged cursor returns zero observations.

The test then feeds pre-crash and reopened translated facts into the **real Session Engine with its in-memory transactional ledger and artifact store** (`engine-proof.ts`). It records canonical Command intent before applying admission evidence, applies the accepted Receipt, redelivers both Command and projection, and checks: **one user Command, one accepted Receipt, completed last Turn, event head 10 before and 10 after replay**. The Engine initially rejected incorrectly routed receipt evidence while developing this fixture; the proof now supplies the actual `pi` adapter identity and routed attachment. Durable submission IDs are not product Receipt IDs.

**Boundary of this evidence:** this is an Engine-port proof, not Electron/SessionRuntime boot recovery with the production SQLite ledger, an OS-power-loss test, or a full provider test. Desktop behavior remains unchanged: `boot-recovery.ts` reconciles then force-closes interrupted local attachments; `docs/crash-recovery.md` explains why mass automatic reattach is deliberately avoided. Wiring `resume()` into today's observation-only reconcile path would both launch work during recovery and compete with the Engine's interruption/attachment facts. It is unsafe to infer automatic desktop resume from these results.

### Command → submission → Receipt protocol

1. Engine records and validates the immutable Command and its payload/reference **before** delivery.
2. Executor submits with `requestId = command.id` to the stable Session conversation. A retry must use the same store/conversation, not a new attachment-specific store.
3. Admission (`queued`) and placement (`placed`, user entry written) are distinct. The narrow prototype refuses busy input and repairs accepted evidence from placed/done records and the user entry timestamp. Production must specify which point an accepted Receipt promises.
4. Engine stamps and deduplicates the Receipt with canonical route, provenance and IDs. The executor reports evidence; it never writes Engine tables.
5. Retry reconciles admission first. `requestId` deduplicates a **submission**, not arbitrary external effects, two different stores, or a command under two owners. Reusing a key with different content is an Engine command-validation concern; the spike only retries identical input.

Unsafe interruption gives **unknown-effect honesty**, not exactly-once shell/browser/deploy execution. Marking a mutation safe would require an external idempotency key/fenced effect protocol. A memo written before an effect can lose the effect; a memo written after it can duplicate it. No SQLite transaction covers an external filesystem/RPC effect and Engine Receipt together.

## Two stores without two authorities

| Owner | Canonical responsibilities |
| --- | --- |
| Session Engine | Session identity, command intent and receipts, attachments/binding generations, product Turns/attempts/branches, user stop/archive, interactions/approvals, attention, immutable session events, artifact references and multi-client presentation |
| Pi Durable executor | Provider request attempts/partials, tool intent/output/results, task dependencies/memos, compaction work and agent context; execution checkpoint store only |
| Bridge | Stable joins and product observations, committed projection cursor/outbox, admission evidence and resume handshake; not another command/approval ledger |

One Durable root maps to the Session's root agent thread for this spike. Pi's **turn** means one model response/tool round; Volli's Turn is the whole response run. The projector therefore keys a product Turn from the input submission, not each Durable `turn_start`. Queued steering, forks and task-owned conversations need explicit Thread/Branch/Attempt joins, not a second product Session tree. Pi child-conversation ownership cannot replace Volli's independently durable delegated Sessions, child slot policy or answer-delivery ledger.

There is no cross-store transaction. Proposed production rule: Durable commits execution facts first; an incremental bridge delivers stable entry/task/submission-keyed observations; Engine commits events plus content-addressed artifacts, then persists the projection acknowledgment. Crash before acknowledgment repeats evidence and Engine IDs dedupe it. Checkpoint commits must never assert product stop/approval/attention state without the Engine. Resume is authorized only after the Engine attaches an eligible, fenced owner; reconciliation must be safe to read without scheduling.

The current adapter uses `watchEvents()` as a wake-up and rescans immutable history plus submissions on the harness mutation line. It acknowledges in memory only **after the observer resolves**. Reconciliation uses an O(history) JSON key-set cursor, returned but never stored in product formats. This proves stable IDs/repair, **not** a scalable outbox or full sink-failure protocol. Shipping that cursor or rescanning whole history per commit would be a mistake. VC-500 owns the durable handshake and failure windows.

### watch / presentation

- `watchEvents()` supplies committed batches and an atomic acquisition snapshot. Assistant deltas map to existing ephemeral text/reasoning observations; settled assistant entries and tool results map to settled messages/activities; submission transitions map to product Turn boundaries and receipt evidence.
- Recovery uses immutable entry identity, not live deltas. Aborted-partial labeling, usage, failures/attention and live activity-start/progress require more complete presentation mapping than the spike provides. In particular, the current settled-message port loses the aborted stop reason: the partial is preserved as an ordinary settled row, not yet a product interrupted-attempt annotation.
- `watch()` exposes the structural view plus Chord ops. The test attaches **two clients** and verifies a later subscriber hydrates the committed assistant entry. It does not project raw Chord ops into the Engine ledger: those are a read-model transport, not product facts.
- Both watchers replace a backlog beyond 100 pending frames/batches with a snapshot. Neither is a durable replay cursor or an exactly-once event feed. A bridge must recover entry/receipt facts independently of snapshot resets; authorization remains at the product edge.

## Tool surface and authority mapping

`tools.ts` demonstrates `defineTool` plus `hook(ToolTask, { beforeTool })`, ordered frozen names and `authorityVerdict` against a copied birth snapshot. A grant mismatch on reopen refuses attachment. The installed registry is local code, not authority to add tools.

| Volli boundary | Durable mechanism | Fit / missing work |
| --- | --- | --- |
| Frozen `sessionToolBindings` and grants | Explicit `agent.tools`, selected extension names | Resolve only birth-granted bindings in exactly the persisted order. Stock CodingTools includes `bash`, not Volli's `execute`, and is not equivalent. No registry hot reload may widen birth grants. |
| Deterministic authority | `beforeTool` block/rewrite | Good pre-intent seam. **Safe recovery skips this hook**, entering ToolTask's `execute` checkpoint; fresh execute/env checks are mandatory. Shadow review, denial/audit observations and classifier/approval semantics are not implemented here. |
| Filesystem/path scope | Wrapped tool + scoped `ExecutionEnv` | `cwd` alone is not confinement. Prototype performs realpath/symlink checks twice and intentionally forbids outside reads; it is stricter than Volli's task-anchored external-read policy. Not an OS sandbox and not hardened against filesystem TOCTOU races. Port credential exclusions and every FS/shell operation, not just arguments. |
| Protection approvals / ask_user | Hook/task `memo` plus Engine interaction port | Memo should retain a stable Engine interaction/approval reference, not a second approval truth. Answer committed to Engine before resolving/memoing. Crash between open/answer/memo must join the existing interaction, not ask again. Not tested as production approvals. |
| Browser | Host-provided tools, not filesystem env | Snapshot generation refs and holds are live host state. Mutations default unsafe; snapshot/screenshot/console cannot blindly replay against old generations. Reacquire current eligibility or return interrupted. Durable has no Browser host. |
| Web / MCP / classifier | `defineTool` adapters to existing ports | Preserve SSRF/address policy, untrusted framing, budgets, frozen catalog and error semantics. Read-only is not enough to declare safe if the call spends money or changes host state. |
| Code Mode / nested tools | Wrapper/custom task | Preserve per-call grants, nested authority, bounded output and existing journal; don't mark an arbitrary script replay-safe. |
| Shell / session verbs / secret | Engine/host port adapters | Long-lived process lifetime, unknown external effects, durable child Session identity and credential-redaction boundary remain Volli-owned. No replay-safe write/execute/browser mutation by default. |

The safe-revoked crash test demonstrates why authority belongs in execution as well as before intent. It does not prove browser, remote leases, approval or all existing tool parity.

## Measured overhead

Darwin arm64, Apple M1, Node **v24.18.0**, `VOLLI_CONCURRENCY_HINT=1`, 2 paired warmups and 20 paired short-turn samples, alternating current/Durable order. Existing `bench/turn-to-completion/measurement.ts` supplies distributions; fixtures use zero-delay faux model → one real short read → final answer. Sink is awaited/no-op: **no production ledger cost, provider latency or cloud network**.

| Measure | Current Agent-loop + JSONL p50 / p95 | Durable SQLite adapter p50 / p95 |
| --- | --- | --- |
| New attachment open | 0.962 / 1.646 ms | 2.270 / 2.901 ms |
| Full short read turn | 2.139 / 4.453 ms | 5.668 / 7.010 ms |
| Closed execution-store bytes | 7,157 / 7,158 | 126,976 / 126,976 |
| Observer calls per turn/attachment | 12 / 12 | 4 / 4 |

Durable adds about **1.31 ms open and 3.53 ms short-turn p50** in this fixture; SQLite's fixed schema/page overhead dominates small-session disk size (~17.7× here). This is a comparison of two runtime implementations, **not an isolated durability tax**: the current runtime does more prompt/tool normalization, activity/delta and usage work; the prototype drops substantial parity work. Four observer calls do not mean better batching. Shared-machine timing and tiny histories cannot establish a production latency/memory budget.

Raw SQLite no-tool turn, separate watch probe (2 warmups + 20 samples per arm):

| Attached readers | p50 / p95 ms | Delivered callbacks across 20 turns |
| --- | --- | --- |
| None | 1.567 / 2.093 | 0 |
| `watchEvents` | 1.518 / 2.840 | 40 |
| Two structural `watch` clients | 1.393 / 1.922 | 120 |

The structural clients received 37,666 JSON characters of ops in aggregate. The watchEvents arm had an 18.520 ms max outlier (mean 2.550 ms). These differences are below the useful ranking/noise level and arms are sequential: **no claim that watching speeds execution up**. This bounds a tiny fixture, not large outputs, slow-client backpressure, remote transport or 10 concurrent Sessions. SQLite uses synchronous `node:sqlite`; main-thread stall/reopen costs need worker-host and large-store measurements in VC-502.

## Compaction parity

Verified with public APIs: manual summary finishes while the reply is held, remains a **queued write submission**, then places at the turn boundary; **7 entries stored, 4 active**. Background threshold starts **one nonblocking compaction** in seven tiny-window fixture turns and leaves a summary in stored history. The summary is supplied by a `beforeCompact` hook, so these tests prove scheduling/placement, not real summarizer quality, cost or provider failure behavior.

| Policy | 1.0.0 fit |
| --- | --- |
| Automatic switch, reserve 16,384 and keep-recent 20,000 | Settings can express them; add `backgroundTokens: 0` to retain current non-background scheduling. Background 32,768 is an upstream default, not current Volli policy. |
| Context overflow compact/retry once | Present in generation source; not exercised with a live provider here. |
| Model-aware `estimateMessage` threshold/cut | **Not present.** `selectCut` and `estimateContext` use imported pi-ai `estimateMessageTokens` (chars/4). Public `beforeCompact` runs **after range selection**; supplying a summary cannot correct the cut. |
| Provider-native compaction, fallback, encrypted checkpoints | Not equivalent to Volli's current OpenAI/Anthropic native-compaction machinery. Must retain/port policy and model applicability. |
| Thinking/resource restoration | Durable serializes assistant thinking for summaries; it doesn't reproduce Volli's retained-tail reasoning elision or exact controlled resource restoration. |
| Measurements after model switch | Stock estimateContext uses the latest positive assistant usage without Volli's provider/model applicability checks. |

Measured CJK fixture (`你好世界，代码路径不可重复执行。` ×200): **800** Durable tokens versus **9,608** Volli tokens for the existing long-context fixture's model (**12.01×**). This estimator gap affects both overflow prevention and keep-recent cuts. It is not solved by configuring larger reserve tokens or reusing VC-496's old harness patch: Durable has its own compaction implementation. VC-502 owns the seam/patch or MIT fork decision and parity fixtures.

## Cloud fit for VC-198 / VC-320

### A. Harness in hosted container, tools local to container

Engine/Convex control plane persists Command intent, policy/birth grants, approvals/attention and owner lease. An assigned container checks out the ticket branch and attaches an executor. Harness runs with a **persistent per-Session checkpoint volume**, `NodeExecutionEnv` pointed at the checkout, fenced writes and explicit source/secrets provisioning. Container-local SQLite is not durable after container deletion unless its volume/backups are durable. The executor projects admitted work/results into canonical Engine receipts/events; authenticated clients use product RPC/presentation, with Chord only as optional committed projection transport. Restart reacquires lease and reconciles before resuming; completion pushes the branch before releasing venue resources.

### B. Harness hosted elsewhere, tools on the person's machine

Hosted Harness owns checkpoint storage. `HarnessOptions.env(target)` returns an authenticated remote `ExecutionEnv` proxy to a local execution host, bound to Session, workspace/checkout identity, frozen policy and attachment generation. Every method validates its fence; remote effect requests need stable task/call keys and durable response/unknown-effect evidence. A disconnected machine means unavailable tools, not a successful cloud run. Do not mark arbitrary remote RPC calls safe simply because Harness can resend them. Browser/web/approval ports remain separate product services; no claim that a filesystem/shell interface transports their lifecycle.

**Pi Durable does not cover:** leases, lease renewal, fencing stale owners, host/workspace/user identity, authentication/authorization, a Convex control plane or conflict/offline semantics, cross-store transactions, external-effect exactly-once, secret provisioning, backup/retention/portable artifacts, the PTY supervisor/relay, browser ownership, notification delivery or multi-device approval arbitration. Node SQLite file locking and the “one process owns a storage” convention are not distributed ownership. The in-process owner Set in this prototype is only a double-open guard.

`docs/ROADMAP.md` named by the brief does not exist at this base. Cloud requirements above are grounded in the full current VC-198 and VC-320 briefs (C02 identity/fences, C03 receipts, C04 artifacts, C05 provisioning, C07 terminal/browser, C08 scheduling/attention), not invented from a missing roadmap. No container or remote ExecutionEnv was deployed in this spike.

## Ruling, rollout gates and created follow-ups

**Wait, rather than adopt now or cloud-only.** The same unresolved authority, projection and estimator contracts exist in both venues. **Do not reject the dependency solely because it is experimental**: the narrow recovery result is positive, the overhead is small in absolute terms, and an execution-only store is a reasonable substrate. But it is not safe to claim incorporation until the product, not the harness, authorizes and owns the recovery facts.

Created backlog tickets (no worktrees or implementation Sessions started):

1. **VC-500 — execution checkpoint bridge and Engine-owned resume protocol.** Stable Command/request joins across attachments; bounded replay/outbox acknowledgment; real SessionRuntime + SQLite ledger crash matrix. Gate: no duplicate rows/bills/receipts or competing interrupted/completed truth; resume only after eligible attachment ownership.
2. **VC-501 — frozen tool surface, replay authority and durable approval joins.** Exact port membership/order, execute/env replay enforcement, browser/secret/MCP/Code Mode parity and Engine-backed approvals. Gate: no ungranted or stale-authority effect after restart.
3. **VC-502 — model-aware compaction and runtime parity/performance gate.** Estimator seam, native/fallback/reasoning/resource behavior, billing/retry/busy-input parity, incremental projection, long-history/main-thread/concurrency measurements and upgrade contract suite. Gate: equivalent cuts and no duplicate usage; explicit acceptable resource budgets.
4. **VC-503 — fenced cloud owner and remote ExecutionEnv contract.** Feeds VC-198 / VC-320 C02/C05/C08; volume lifetime, fences, remote unknown-effect receipts, two-client approvals and PTY/browser separation. Gate: stale host cannot act after partition or handoff.

Conditional incorporation sequence: land VC-496 independently → complete VC-500/501/502 behind an internal ticket-only flag → owner-reviewed local canary with explicit resume eligibility/concurrency cap and legacy recovery preserved → apply VC-503 to VC-198's one-container workflow → reassess broader local/cloud rollout from measured evidence. Preserve the current runtime as rollback until checkpoints/legacy Sessions have a reviewed migration story. No “adopt” approval is implied by these readiness tickets.

**API/license risk:** 1.0.0 README explicitly says “Experimental. The API changes without notice between releases.” Pinning avoids surprise resolution, not compatibility debt. Public watchEvents is itself experimental; stored task/document versions, registry replacement and schema migrations need versioned compatibility tests. MIT permits a fork or vendored copy with license/provenance retained; that reduces churn risk but transfers maintenance/bugfix ownership to Volli. Decide that in VC-502 before production dependence, not by opportunistically copying runtime files during VC-496.

## Sources and verification

Primary evidence is the installed, exact-pinned 1.0.0 README and dist declarations/implementation (ToolTask recovery, generation partial throttle, compaction estimation, SQLite adapter), plus the runnable branch fixtures. Web `main` is moving reference material:

- [Announcement](https://earendil.com/posts/pi-durable/)
- [README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Design docs](https://github.com/earendil-works/pi/tree/main/packages/durable/docs), including the implementation handoff (read as design context, not a stable API contract)
- [Examples](https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples): 05 watches, 06 harness, 13 recovery, 25 compaction
- Local: `CONTEXT.md`; `docs/crash-recovery.md`; `packages/shared/src/agent-runtime.ts`; `packages/session-engine/src/{session-engine,session-runtime,observation-translation}.ts`; `apps/desktop/src/main/session-runtime/boot-recovery.ts`; current compaction/token-counting/authority source; VC-198 and VC-320.

Focused verification: package typecheck and all four new benchmark test files (10 tests); format/lint check. No full workspace suite, Electron smoke, real-provider crash, hosted deployment, power-loss, distributed fencing or production approval recovery was run. Those are explicitly follow-up gates, not unexplained successes.
