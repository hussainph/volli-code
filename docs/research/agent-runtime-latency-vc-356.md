# Agent-runtime per-turn cost (VC-356)

## Scope and method

This profiles the CPU a turn spends inside `@volli/agent-runtime`, plus the
durable cost the Session Engine pays to record what that turn produced. It does
not measure provider latency or real tool execution: those dominate a turn's
wall clock, cannot be measured without spending money, and `bench:live` is the
lane for them. The default lane makes no network, browser, model or paid call.

Two instruments, in the package that owns each subject:

| instrument | subject |
|---|---|
| `packages/agent-runtime/bench/parallel-tools/runtime-cost*` | prompt assembly, context projection, activity normalization |
| `packages/session-engine/src/turn-write-cost.bench.test.ts` | what recording one streamed turn costs the ledger |

The split is deliberate. The Agent Runtime emits observations and holds no
durable Session state (`CONTEXT.md`), so a probe inside it cannot honestly
price the Engine's work — an earlier draft of this profile reached across the
package boundary into `@volli/session-engine`'s private translator to do so,
which is both a layering inversion and a dependency the package does not
declare.

```sh
pnpm -C packages/agent-runtime bench:runtime             # fast probe arm
pnpm -C packages/agent-runtime bench:runtime:published   # the arm figures are quoted from
pnpm -C packages/agent-runtime bench:runtime:profile     # --cpu-prof + bottom-up table
pnpm -C packages/session-engine test src/turn-write-cost.bench.test.ts
```

### Reading the timing numbers honestly

Two things about this harness matter more than any figure in it.

**Batch scale changes the answer, not just the runtime.** These operations cost
single-digit microseconds, which is the same order as `performance.now()`. The
probe arm runs batches of one to a few operations and therefore prices the
timer alongside the work; the published arm runs 20× batches. The arm and its
scale are printed above every table so the two can never be confused.

**A loaded machine cannot be measured by comparing separate runs.** During this
work the host sat at load average 11 (other Sessions). Identical code measured
in separate processes varied by 2×, which is far larger than any effect here.
The first attempt to evaluate the redaction guard produced flatly contradictory
answers that way. Anything comparing two implementations must therefore be
**paired**: both timed in one process, interleaved, many rounds, compared by
median and by how often each round wins.

Because of that, the table now marks any figure above 20% RSD as *too noisy to
quote* and says so beneath itself. **The regression guards that matter do not
depend on a quiet machine at all** — they count content reads and ledger rows
rather than microseconds, and are asserted in the bench tests.

## Ranked findings: the user is waiting

Ranked by cost on the path a person waits on. Everything below is
user-waiting; see the next section for why almost nothing here is background.

### 1. Recording a turn cost more the longer the Session had run — **fixed**

The largest finding, and the only one whose cost grows without bound.

`SessionEngine.observe` listed a Session's **entire** event log before
recording each durable fact, then folded it. `submit` did the same when
accepting a Command. So a turn's durable cost was a function of the Session's
age rather than of what the turn reported — quadratic across a Session. The
real profile's busiest Session holds 1,668 events.

Measured with the ledger probe, at a fixed 44-observation turn:

| prior events | durable writes | event rows read | widest single read |
|---:|---:|---:|---:|
| 0 | 5 | 29 | 7 |
| 600 | 5 | **3,040** → **145** | **610** → **31** |
| 1,200 | 5 | — → **265** | — → **55** |

Five durable facts cost 3,040 row reads to land once 600 events preceded them,
and one of those reads was the whole Session.

The fix uses the projection checkpoints VC-355 landed, and needed one thing
VC-355 did not have: **a refresh cadence**. VC-355 persists a checkpoint when
an attachment closes, which bounds nothing for the Session that is currently
running — a long chat appends facts for the whole attachment. `observe` now
refreshes the checkpoint once the durable cache has drifted a full window
(`CHECKPOINT_REFRESH_EVENTS = 64`) behind the log. That bounds both sides: at
most one window is ever re-folded, and at most one cache row is written per
window.

The remaining reads are bounded by the window, not by history. The two large
arms differ only by where the Session sits inside the window when the turn
starts — phase, not growth — which is why the probe asserts a ceiling per arm
rather than equality between arms.

Sequence assignment moved from `(events.at(-1)?.sequence ?? 0) + 1` over the
whole log to `latestEventSequence()`, an index read. **No durable event shape,
payload or id derivation changed**; sequences are still 1-based and assigned
identically.

One read on this path still walks the log, deliberately: resolving which event
carries a re-delivered receipt. No index answers that question, and narrowing
it to the observation's own id would change behaviour for a receipt
re-delivered under a new envelope id. It is the rare replay path.

### 2. Re-tokenizing a settled context on every preflight — **fixed**

Compaction preflight and the provider output-ceiling check both project context
occupancy, in succession, over the same settled prefix. Both re-tokenized every
message, the system prompt and all tool schemas each time. Pi messages are
append-only once settled and request metadata is frozen for an attachment, so
rescanning them cannot improve the estimate.

A per-attachment projector now reuses those estimates. It is keyed by
**tokenizer family**, not by model, because `estimateMessageTokens` depends on
the model only through its counter — two models of one family necessarily
agree.

The guard against this silently breaking is not a timing: the bench asserts
that a second projection of the same prefix touches **no** message content, and
that the cached answer always equals the uncached one.

### 3. Redaction scanned clean tool output four times — **fixed, and re-measured**

Every activity payload string ran four regex replacements to strip secrets.
Most tool output holds none. One marker scan now gates the four.

This one is worth reading carefully, because the first measurement of it was
wrong. The fixture's "clean" blocks were punctuation-free prose, and
redaction's cost is driven by how often `-`, `_`, `:` and `=` appear — which is
constantly, in the source code a coding agent's `read` and `execute` actually
return. The fixture now uses source-shaped output.

Re-measured with paired interleaved rounds:

| corpus | no guard | guard | guard wins |
|---|---:|---:|---:|
| prose | 7.451 us | 6.256 us | 35/41 rounds |
| source | 7.444 us | 6.569 us | 39/41 rounds |

The guard holds, on both shapes. Two smaller changes came with it: the JSON
length in `normalizedString` is serialized once instead of twice, and a patch's
additions and removals share one scan instead of two.

**The guard is a hand-mirrored copy of the four patterns, and a marker that
stops matching leaks a credential into durable history with nothing to notice
it.** It is now pinned by a case per pattern arm — each written as a secret in
an unremarkable key, so the recursive key-based redaction cannot mask a marker
failure — plus a marker-free case. Removing any arm from the marker fails those
tests. Separately, 400,000 fuzzed strings found no input the four patterns
redact that the marker misses.

### 4. Role-static prompt layers rebuilt per attachment — **fixed**

The operating and workspace layers depend only on the Session Role and whether
resources exist, so they are assembled once at module load. `CONTEXT.md` already
requires the system prompt to be a pure function of Role, bundle, version and
resource set; the bench asserts that property directly.

This is the smallest of the four and is honestly labelled: it runs once per
attachment, not per turn. A hand-rolled join was tried here and reverted — it
bought microseconds once per Session in exchange for two non-null assertions.

## Ranked findings: background

Almost nothing in this pipeline is background, which is itself the finding.
The expensive-looking paths are all awaited before the next model request, tool
result or subscriber delivery:

1. **Compaction is blocking maintenance.** Threshold compaction is awaited
   before `agent.prompt`; overflow compaction is awaited before retry. A
   summarization call is user-waiting work. Its provider latency cannot be
   represented honestly without a live call, so the default fixture does not
   invent one.
2. **Durable translation and ledger appends are serialized and awaited.**
3. **Transcript subscriber fan-out is awaited for backpressure.** A slow
   listener paces streamed deltas. That ordering is a semantics guarantee, not
   a CPU cost to remove.

The genuinely non-awaited path is the passive observability sink, whose cost is
host-defined and whose default no-op is below this fixture's resolution. It was
not promoted above user-waiting work or given an invented latency.

## Paths ruled out

- **Model catalog and access** are resolved once by `createPiAgentRuntime` and
  reused; `startSession` awaits the existing `catalogReady` promise. Not rebuilt
  per turn, and no network call sits on a path a user waits on.
- **`scoped-execution-env.ts`** builds `NodeExecutionEnv`, the tool bundle and
  the system prompt once while attaching a Session — not per tool call.
- **Tool dispatch.** The existing parallel-tools bench already measures real Pi
  dispatch. VC-245 found ~1.2% aggregate tool-time saving from parallel mode on
  real transcripts, so dispatch reordering was not promoted above the measured
  CPU work.

## CPU flame chart

`bench:runtime:profile` bundles the fixture, runs it under `--cpu-prof`, and
prints the bottom-up self-sample table. Rows are keyed by **call frame** —
function name plus script and line — because a bundle holds many `run`, `count`
and `main` frames and merging them by name attributes cost to the wrong
function.

After the changes, the fixture's remaining cost is dominated by the redaction
marker (17.8% of self samples) and prompt composition (15.8%). The marker's
share grew because everything around it shrank; it is kept deliberately, since
weakening secret redaction would change durable activity payloads.

## Concurrency and `VOLLI_CONCURRENCY_HINT`

**No new runtime fan-out was introduced, and the hint is not used to reorder
model-issued tool calls.** Runtime tool execution stays Pi's documented
sequential mode: VC-245 measured ~1.2% aggregate saving from speculative
parallel mode, while mixed side effects still require ordering. The hint is a
budget for work Volli chooses to start, not permission to reorder work a model
asked for in sequence.

The benchmark config uses one worker even when the hint is higher, because
concurrent benchmark files would measure contention rather than one runtime
operation. That is consistent with `CLAUDE.md`'s rule that a budget only ever
lowers a project's own cap.

One existing fan-out is worth naming rather than leaving silent: Model Access
probes every provider concurrently with an unbounded `Promise.all`. It is left
as it is on purpose — those probes are network-bound and individually
timeout-bounded, while the hint is a CPU-job budget. Gating them on core count
would make sign-in slower without freeing a core.

## Contract notes

- No durable event, activity or observation shape changed.
- No event or observation id derivation changed. Sequence assignment reads the
  same 1-based values from an index instead of from a full log scan.
- The projection checkpoint remains a rebuildable cache: a refresh that fails
  is reported through `onProjectionCheckpointFailure` and leaves the immutable
  log canonical. A Session that can never refresh is slower, never wrong, and
  that path is pinned by a test.
- The token cache is attachment-local and assumes Pi's existing contract that
  settled messages and frozen tool definitions are not mutated in place. That
  assumption is a documented comment, not a type.
