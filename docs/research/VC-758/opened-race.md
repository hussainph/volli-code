# Opened-settlement rejection investigation

## Decision

**No production runtime change in this follow-up. Recommend pushing the CI-contract-only fix, not a speculative runtime fix.** The false-delivered result is reproducible through real Pi when calling the attachment concurrently, but the corresponding host command path serializes the competing retry. The passing focused host test is evidence, not a new production seam.

No client, RPC, desktop, host test, ledger vocabulary, exports or frozen tools were changed by this investigation. Untargeted supervisor steering remains unchanged.

## Direct attachment: confirmed false delivery

A temporary test inserted into `packages/agent-runtime/src/pi/runtime.test.ts` used its existing `fixture`, `modelsWithStream`, `scriptedStream` and provider gates. Pi and sidecar persistence were real; only provider replies were scripted.

1. Disable automatic compaction; submit an ordinary successful turn measured at 200,000 tokens.
2. Submit the existing `PASTED` fixture; fail that reply with `malformed provider payload`, also measured at 200,000 tokens. This failure is not automatically retried.
3. Enable automatic compaction. Call `handle.submitUserMessage("NEVER-DELIVERED", "queue", "new-message", [], [], "opened")` and gate its threshold-summary provider request.
4. Directly call `handle.retry("retry-command")` while that summary is in flight. Wait until the retry's provider request has started and gate that reply too.
5. Disable automatic compaction, release the summary as `summary unavailable`, and await the new message's submission.

The assertion that submission rejects failed with this actual value:

```text
AssertionError: promise resolved "{ kind: 'delivered', …(2) }" instead of rejecting
Received:
  { delivery: "prompt", kind: "delivered", turnOpened: false }
```

There was no `acceptedAt`. Pi refused the second prompt because its retry was already active. `runtime.ts:3653` sends both `run()` promise outcomes to the same cleanup callback, losing the raw rejection, and `runtime.ts:3664–3668` then returns delivery. `retry` at `runtime.ts:3764–3782` checks streaming, but not the context rewrite. The reproduction released both gates and successfully awaited retry and attachment close even when its assertion failed. The temporary failing test was removed; it did not alter production Pi or replace `agent.prompt`.

Command (from `packages/agent-runtime`; concurrency hint was 1):

```sh
vp test run src/pi/runtime.test.ts -t 'does not falsely deliver an opened message' --maxWorkers="$VOLLI_CONCURRENCY_HINT" --reporter=dot
```

Result: **1 failed, 325 skipped**, with the false-delivered object above (33 ms test time). Earlier observer-gated attempts timed out: the durable observation-delivery chain also serialized the summary's completion behind the gated retry start. They did not establish pending-slot corruption. A `--reporter=basic` attempt failed at startup because this Vitest version has no built-in reporter by that name.

## Host path: the alleged overlap was not reproduced

`packages/agent-runtime/src/pi/opened-race.test.ts` drives the real host Session runtime, native Pi adapter, follow-up ledger, SQLite receipts, sidecar persistence and Pi using the existing `host-core/src/testing/silent-ends.ts` fixture. Its provider is scripted in the test; no production export or production fake was added.

A successful high-occupancy first turn and an aborted second reply leave a retryable tail **without Attention blocking queue release**. The test queues a new message, gates its threshold summary, and issues the real `executor.retry` command while the summary is pending. Unlike the direct-attachment reproduction, retry does not reach Pi inside the summary:

- The summary is released as a failed maintenance attempt.
- The queued message opens and receives its own accepted receipt with a numerical `acceptedAt` while its provider reply remains gated.
- The competing retry then receives **`rejected`, code `PI_BUSY`**.
- The fourth actual provider request contains `QUEUED-MESSAGE`; it is the queued message's reply, not a retry of the previous tail.

Why the host differs:

- `packages/session-engine/src/session-runtime.ts:1183–1186` makes **retry read the existing admission tail**. Not appearing in `serializesAdmission` means retry does not *install* a tail, not that it ignores a predecessor.
- `session-runtime.ts:1242–1253` installs a message's admission promise as that tail.
- Although externally queued messages bypass immediate admission, queue draining at `session-runtime.ts:2470–2482` calls `#admitCommand` with a `message.submit` whose `delivery` is omitted. Thus it creates a serialized admission, too; the queue-drain payload is not an externally queued command anymore.
- The admission releases on the turn-start boundary, by which point Pi is already streaming. Retry is then refused without replacing `pendingRunDelivery`.

The original host experiment waited for a retry provider call *before* releasing the summary and timed out (5 seconds); changing it to assert serialization passed. An initial expected-code typo (`PI_BUSY_UNSUPPORTED` instead of the actual `PI_BUSY`) was corrected without any production edit.

## Verification

From `packages/agent-runtime`:

```sh
vp test run src/pi/opened-race.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"
```

Result: **1 passed** (182 ms test time). The retained test explicitly checks the retry rejection, command-correlated queued acceptance, and the real provider payload.

From the worktree root:

```sh
vp fmt packages/agent-runtime/src/pi/opened-race.test.ts --write --threads "$VOLLI_CONCURRENCY_HINT"
vp lint packages/agent-runtime/src/pi/opened-race.test.ts
vp run --filter @volli/agent-runtime typecheck
```

Final focused regression check (from `packages/agent-runtime`):

```sh
vp test run src/pi/runtime.test.ts src/pi/opened-race.test.ts -t 'settling a submit|acknowledges supervisor steering immediately|opened delivery through host queue admission' --maxWorkers="$VOLLI_CONCURRENCY_HINT" --reporter=default
```

Result: **9 passed, 317 skipped, 2 files passed** (247 ms test time). This includes the unchanged untargeted-supervisor immediate-ack test and existing opening-boundary/observer-failure/detached-cleanup checks.

Results: TypeScript formatting completed and the final `vp fmt ... --check --threads "$VOLLI_CONCURRENCY_HINT"` passed; lint **0 warnings, 0 errors**; package typecheck passed. The formatter ignored the Markdown path. No coverage threshold was changed. There is no production runtime delta requiring production-file coverage, and no broad suite, Electron, Docker, SSH, keychain or provider sign-in was run.

## Limits and bounded follow-up

This does not establish safety for every concurrent attachment caller, retry-first ordering, admission-timeout path, or attach/reconcile interleaving. The direct-attachment defect is real. Its alleged daily client/host manifestation, and acceptance-slot theft before `agent_start` persistence, are not established by these experiments.

A separate bounded runtime-contract follow-up should explicitly decide concurrent-call semantics, preserve raw pre-opening prompt rejections while always releasing `boundaryChecked`, and guard context rewriting against retry. It should test command-correlated acceptance and detached-close cleanup through real Pi. It should not infer acceptance from arbitrary turn starts or redesign untargeted supervisor steering. Do not broaden this CI fix round without a host-path reproduction or that explicit contract decision.
