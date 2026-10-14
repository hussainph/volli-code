# VC-758 runtime audit

## Scope and baseline

Backend owner: `packages/session-engine`, `packages/agent-runtime`, and `packages/host-core`. Renderer, presentation, and CLI changes belong to the parent Session. No commits, pushes, Electron, Docker, real sign-ins, keychain, or SSH commands were performed.

**Integrated validation:** the shared worktree HEAD is now `cf7cf0f9156447fdc47014bc79753b7cf79f9b14`. `git merge-base --is-ancestor 8fff4bb71 HEAD` returned **0**: current main, including VC-753's queue admission deadlines and crash-question recovery, is merged. The focused post-merge checks below pass. Validation used the shared working tree, not a clean checkout; concurrent parent edits were preserved.

**Historical baseline:** initial implementation checks below used `c0cfd4577363c86022df3bb6e9cb2720b8c17897`, before VC-753 was merged (`--is-ancestor` returned 1 then). The earlier merge/recheck blocker is resolved.

## Measurement method

`packages/host-core/src/session-runtime/silent-ends.integration.test.ts` scripts only provider responses, failure injection, and host ports. The path under test is real Pi -> sidecar -> Pi native adapter -> SessionRuntime -> SessionEngine -> SQLite -> transcript files. Reads use the real ledger and artifact codecs. Queue/steer assertions subscribe to committed queue frames; deterministic gates, not sleeps, release requests. A second engine independently folds the fatal failure from SQLite. No providers are contacted.

The fatal test injects a semantic runtime failure into the real Pi adapter observer; it does **not** kill the OS process. Existing Pi `runtime.test.ts` recovery tests exercise sidecar recovery semantics, and `boot-recovery.test.ts` exercises host startup decisions. The VC-753 integration tests restore pre-loss SQLite/sidecar snapshots after fixture teardown, then launch a fresh host; they simulate process loss without killing an OS process. Those distinctions matter: the new fatal test proves the recorder preserves an injected diagnostic, not that a specific process crash produces that observation.

## Audit table

Paths below are current worktree source locations. `H` means `packages/host-core/src/session-runtime/silent-ends.integration.test.ts`.

| Path | Before / observed facts | Code locations | Fix or disposition | Scripted evidence |
| --- | --- | --- | --- | --- |
| Provider throws before returning its stream | Existing adapter/runtime already commits one failure Attention and interrupted turn. No assistant prose is required. Missing timeline row is consumer projection, not missing runtime fact. | `agent-runtime/src/pi/runtime.ts` message-end classification and agent-end (~3212–3415); `session-engine/src/observation-translation.ts` Attention mapping | Preserve `adapter_unrecoverable`; existing Retry. Parent renders durable facts. | H `records a provider rejection before stream durably` |
| Provider fails between tool steps | Same durable interruption/Attention; failed tool activity also persists before the next provider request. | Same lifecycle plus `runtime.ts` `observeToolActivity` | Preserve existing facts/Retry. | H `records a provider rejection between tool steps durably` |
| Expired sign-in | Existing `auth_required`, exactly one raised Attention, turn inactive. | `runtime.ts` `attentionReasonFor` / final failure classification | Preserve existing sign-in recovery; parent offers Open settings. | H `records expired sign-in with one existing authentication recovery` |
| Context assembly throws before attachment | Attach rejected with detail and one Session-scoped failure Attention; no false working turn. | `host-core/src/session-runtime/pi-adapter.ts` `resolveRuntimeContext`; `session-engine/src/session-runtime.ts` `#attach` (~1615) | Already durable. Parent projects the failure row. | H `records context assembly failing before attach` |
| MCP capability startup throws | Actual frozen MCP port resolver throws before Pi start; attach rejects and persists its explanation. | `pi-adapter.ts` `resolveMcpPort` in `piNativeAdapter.attach`; `session-runtime.ts` `#attach` | Already durable; preserve existing attach recovery. This scripts resolver startup, not a live external MCP transport. | H `records MCP startup failing through the actual port resolver` |
| MCP/tool call fails between steps, model recovers | `dynamic-tool` output-error artifact records the refusal and the model reads it. The subsequent successful answer legitimately completes; not a broken Session. | `agent-runtime/src/pi/tools.ts`; `runtime.ts` `observeToolActivity`; `observation-translation.ts` `activityPart` | No extra failure Attention: do not offer a second recovery for a tool failure the model handled. | H `keeps a failed MCP call visible while the model recovers between steps` |
| User attachment cannot be prepared | Definitive rejected delivery receipt retains error text; no model turn starts. A model Retry would have no accepted prompt to retry. | `pi-adapter.ts` `PiBinding.#submit` attachment-preparation catch (~1433); `session-runtime.ts` `#recordDelivery` | Parent must show rejected delivery rather than silently drop it; queue-owned delivery already uses blocked-delivery state. Do not invent runtime failure here. | H `records attachment preparation failing before the first model step` |
| Runtime fatal observation after a live attachment | **Confirmed gap:** translator carries `detail`, recorder formerly ignored it and wrote only `attachment.closed: failed`; empty Attention, no durable explanation after close. | Before/fix: `session-engine/src/session-runtime.ts` `#recordNativeObservation`, `attachment.failed` case (~4057). Producer mapping: `observation-translation.ts` `#translateAttachment` (~412) | Commit existing `attention.raised` / `adapter_unrecoverable` BEFORE closing. Session-scoped, bounded/redacted detail, named fallback for missing/blank detail. Keep an already-explained failure's one recovery. A successful fresh attach clears it through existing VC-220 machinery. Guards prevent writes after teardown wins either async boundary. | H `preserves a runtime fatal observation as a durable recovery, not just a close`; `session-runtime.invariants.test.ts` fallback/redaction, dedupe, recovery, and both shutdown races |
| Stop races a provider's normal finish | **Confirmed gap:** provider ignores/races abort and returns `stop`; `failure === undefined` formerly records `turn.completed` despite the live Stop. | Before/fix: `agent-runtime/src/pi/runtime.ts` agent-end success branch (~3388); test `runtime.test.ts` `honors Stop when the provider races the abort with a normal finish` (~6159) | Record existing `turn.interrupted` for a live runtime interruption even without an aborted/error provider reply. No failure Attention for a choice the user made. Preserve normal teardown's existing drain behavior. | H `records deliberate cancellation without failure Attention`; Pi test checks sidecar replay too |
| Provider silent while first request is pending | Engine continues to project working; no fabricated failure. Existing stream supervisor later cuts an actual provider-silence deadline and recovery stays in the same turn. | `agent-runtime/src/pi/stream-supervisor.ts`; `runtime.ts` recovery; `runtime.test.ts` ~7541 | Preserve working until actual end. No new inactivity heuristic or Attention reason. | H `keeps a provider stall working without inventing a failure`; existing `cuts a request that stops answering and resumes the same turn` |
| Reconnecting / offline wait | Existing transport notice appears during bounded retry or offline wait; success clears it, Stop ends it. | `runtime.ts` `recoverFromTransport` / `clearTransportNotice`; `runtime.test.ts` ~6901, ~7198 | Existing waiting vocabulary; no new row kind. First brief retry attempts deliberately remain Working. | Covered by focused Pi runtime tests: reconnecting, network wait, abort during notice/backoff, budget exhaustion |
| Follow-up queued behind working turn | Host acceptance is not provider consumption: queue row remains `queued`, working stays true, message not yet in delivered transcript. At consumption the queue drains and user text appears once. | `session-runtime.ts` `#followUpCommand` / `#settleFollowUp`; `session-follow-ups.ts` | Existing facts correct; parent fixes immediate pending presentation/order. | H `keeps queue pending until real Pi consumption` |
| Steering an existing queued message mid-turn | Queue claim becomes `releasing`; acceptance waits for the Pi consumption marker, not volatile enqueue. Canonical queued payload survives until proof; exactly one transcript message after delivery. | `session-runtime.ts` `#steerFollowUp` / `#deliverQueuedSteer`; Pi `pendingQueuedDeliveries` / `persistAcceptedDelivery` | Existing proof semantics preserved. Parent labels arrival after current step and keeps Working above it. Supervisor/raw steer's earlier enqueue acknowledgement remains distinct from host queued steering. | H `keeps steer pending until real Pi consumption`; existing Pi host-steer tests |
| Restarted queue / ambiguous delivery | Existing queue fail-closed guard names the hold and allows explicit edit/removal; does not blindly resend accepted/unknown work. Merged VC-753 adds bounded attach/admission waits and crash-question recovery. | `session-runtime.ts` `reportMessageDeliveryFailure` / queue recovery; `host-core/src/db/session-follow-up-repo.ts` | Reuse existing blocked-delivery state, not a new queue enum. | `follow-up-clean-close.integration.test.ts`: 11 passing round trips; `session-follow-ups.test.ts`: 94 passing tests; VC-753 `crash-recovery.integration.test.ts`: 14 and `crash-question-recovery.integration.test.ts`: 2 passing tests |

## Before/fix evidence

1. At 03:11:02, the corrected real-path suite had **7 passing / 1 failing** test before the cancellation fix: `records deliberate cancellation without failure Attention` found no `turn.interrupted`. The deterministic provider gate released specifically on the real Pi abort signal, then returned a normal finish. The final implementation and sidecar replay test pass.
2. At 03:12:20, the suite had **8 passing / 1 failing** before the fatal-observation fix: the attachment closed, but Attention was `[]` instead of a persisted explanation. The final test observes the crash while a real Pi turn is active, verifies cold-engine failure projection, and verifies fresh-attach recovery clears it.
3. Early fixture runs were not product findings: explicit `delivery: queue` returns host queue acceptance before asynchronous drain, and an unbound artifact `read` method cannot read the store. The fixture was corrected to distinguish queue acceptance from Pi acceptance and bind artifact reads. No product changes were made to accommodate those mistakes.
4. One initial scoped coverage run hit an existing 5-second bounded-history test timeout on this shared machine. Final scoped checks used `--testTimeout=20000` (thresholds unchanged). Expanding only direct covering test files brought both touched production files to 100%, rather than lowering coverage thresholds.

## Durable / N−1 shape

The two runtime production fixes add no migration, output enum, row kind, queue state, tool description, tool order, Code Mode shape, or new export. The fixes write the existing `attention.raised` (`adapter_unrecoverable` with null attachment), `attachment.closed` (`failed`), and `turn.interrupted` shapes. Fatal diagnostic IDs are attachment-scoped; an existing failure stays the only active recovery. Blank diagnostic fallback is plain prose, not a new reason.

The real SQLite codec and independent cold fold are tested. Old **binaries** (0.2.1 / canary.1) were not launched locally; the repository's N−1 CI lanes still need to run on the integrated branch. Expected older behavior is its already-shipped attach-failure recovery and interrupted-turn presentation, not silent degradation from an unknown kind.

## Historical pre-merge focused checks

All test commands used `--maxWorkers="$VOLLI_CONCURRENCY_HINT"` (resolved to **1**). No full package/workspace suite was run.

```sh
# packages/agent-runtime
vp test run src/pi/runtime.test.ts src/pi/secrets-runtime.test.ts \
  src/pi/tool-results.test.ts src/codemode/runtime-codemode.test.ts \
  --coverage --coverage.include=src/pi/runtime.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 337 tests, 4 files; runtime.ts 100% statements/branches/functions/lines.

# packages/session-engine
vp test run src/session-runtime.test.ts src/session-runtime.invariants.test.ts \
  src/session-follow-ups.test.ts src/session-history-window.test.ts \
  src/transcript-baseline.test.ts src/queue-revision.test.ts \
  --coverage --coverage.include=src/session-runtime.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 277 tests, 6 files; session-runtime.ts 100% on all four axes.

# packages/host-core (no production file changed here; scope protected boot recovery)
vp test run src/session-runtime/silent-ends.integration.test.ts \
  src/session-runtime/follow-up-clean-close.integration.test.ts \
  src/session-runtime/boot-recovery.test.ts \
  --coverage --coverage.include=src/session-runtime/boot-recovery.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 47 tests / 3 files (12 new real-path tests),
# boot-recovery.ts 100% statements/branches/functions/lines.

vp run --filter @volli/session-engine typecheck
vp run --filter @volli/agent-runtime typecheck
vp run --filter @volli/host-core typecheck
# PASS all three. Earlier host checks were blocked by the parent's temporary
# src/vc758-peek-probe.test.ts implicit-any; after that probe disappeared, PASS.

vp lint packages/agent-runtime/src/pi/runtime.ts \
  packages/agent-runtime/src/pi/runtime.test.ts \
  packages/agent-runtime/test-fixtures/scripted-provider.ts \
  packages/session-engine/src/session-runtime.ts \
  packages/session-engine/src/session-runtime.invariants.test.ts \
  packages/host-core/src/session-runtime/silent-ends.integration.test.ts
# PASS: zero warnings/errors (two test-local shadows corrected first).

node scripts/check-host-electron-imports.mjs
# PASS: 1,615 package/host source modules; six pre-existing computed-import notes.
git diff --check
# PASS.
```

## Post-merge measured checks (`cf7cf0f91`)

All commands below returned **0**, with `VOLLI_CONCURRENCY_HINT=1`. No full suites or full coverage gates ran; coverage thresholds stayed at 100% and were scoped to one directly exercised production file per package.

```sh
# packages/session-engine
vp test run src/session-runtime.test.ts src/session-runtime.invariants.test.ts \
  src/session-follow-ups.test.ts src/session-history-window.test.ts \
  src/transcript-baseline.test.ts src/queue-revision.test.ts \
  --coverage --coverage.include=src/session-runtime.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS twice: 297 tests / 6 files; session-runtime.ts 100% on all four axes.
# Includes 30 invariants and 94 queue/follow-up tests, including VC-753 deadlines.

# packages/host-core
vp test run src/session-runtime/silent-ends.integration.test.ts \
  src/session-runtime/follow-up-clean-close.integration.test.ts \
  src/session-runtime/boot-recovery.test.ts \
  src/session-runtime/crash-recovery.integration.test.ts \
  src/session-runtime/crash-question-recovery.integration.test.ts \
  --coverage --coverage.include=src/session-runtime/boot-recovery.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS twice: 63 tests / 5 files; boot-recovery.ts 100% on all four axes.
# Counts: silent ends 12, clean close 11, boot 24, VC-753 crash 14 + questions 2.

# packages/agent-runtime
vp test run src/pi/runtime.test.ts src/pi/secrets-runtime.test.ts \
  src/pi/tool-results.test.ts src/codemode/runtime-codemode.test.ts \
  --coverage --coverage.include=src/pi/runtime.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# PASS: 341 tests / 4 files; runtime.ts 100% on all four axes.
# Counts: runtime 325, Code Mode 11, tool results 3, secrets-runtime 2.

# repository root
vp run --filter @volli/session-engine typecheck
vp run --filter @volli/agent-runtime typecheck
vp run --filter @volli/host-core typecheck
# PASS all three (exit 0).
node scripts/check-host-electron-imports.mjs
# PASS: 1,632 packages/host source modules; nine computed-import notes.
git diff --check
# PASS (exit 0).
```

The first engine/host runs started at 03:36:57 / 03:37:38; agent-runtime at 03:37:57. After the parent's concurrent `session-follow-ups.ts` display-hint change appeared, engine/host checks were repeated at 03:39:43 / 03:40:46. `git hash-object` before and after that repeat returned identical blobs for:

- `packages/session-engine/src/session-runtime.ts`: `e65e6c3dff3791d0b7d8969d688903070ce62f0d`.
- `packages/session-engine/src/session-follow-ups.ts`: `97f7b45cf23e2fb2193cb968d61e61ed571f431f` (parent-owned working-tree version).
- `packages/host-core/src/session-runtime/silent-ends.integration.test.ts`: `0b573a5fc49a5f556201ef55e2d10cd9e98fac4a`.

No real failures occurred in these post-merge checks. The host import checker reports statically uncheckable computed imports as notes, not failures. These checks do not validate the parent's renderer/CLI timeline changes or guarantee a later concurrent edit is covered. Only this audit document was edited by the validation Session.

## Decisions and follow-ups

- VC-753 merge and focused runtime revalidation are complete; the earlier integration blocker is resolved.
- Parent owns timeline/peek/CLI consumer presentation. A durable failure was already present for most paths; avoid duplicate transcript error facts or recoveries. A rejected user-message delivery is not an accepted failed model turn.
- Large work intentionally excluded: killing the entire live desktop process, live MCP subprocess startup failures, provider sign-in expiration against a real account, and old-binary compatibility execution. Existing scripted Pi/codec tests prove semantics; CI must prove deployment/upgrade behavior.
- No new turn-stall heuristic. Existing supervisor deadlines and notices cover provider silence; host queue admission deadlines come from VC-753 rather than a competing implementation here.
- Fatal native diagnostics must remain product-sanitized at their producer. The recorder also applies shared credential-pattern redaction before its 400-character bound; neither stacks nor opaque SDK envelopes are stored by this fix.
