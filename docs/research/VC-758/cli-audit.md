# VC-758 — CLI audit: `volli session peek` and `session list`

Scope: the agent-facing CLI (`packages/cli`) and the host reply it renders
(`session.peek`, `session.list`). The desktop timeline belongs to the renderer
audit (`docs/research/VC-758/renderer-audit.md`, parent-owned); the runtime and
engine fixes belong to the backend agent. Where a fix needs a host field, the
field is listed in §5 for the parent to route. Nothing in `packages/host-core`,
`packages/shared` or `packages/session-engine` was changed by this audit.

## 1. Result in one paragraph

Four peek explanations were missing in the CLI and are now rendered from fields
the host already sends: a quiet chat whose newest message has no reply, the
meaning of a `parked` terminal, the provider reset time (was a raw epoch), and
the unreadable-message count. Most silent ends are **not** fixable in the CLI,
because the host's reply carries no field that states them: a failed turn, a
retrying or rate-limited turn (`working`), a stop with no actor or reason, a
steer or queued follow-up, and the watchdog's own blocked signal. §5 lists the
fields needed. Reproduced against the real session engine, a failed turn still
reads `idle` with no reason when the ledger carries the sequence the backend's
in-flight change writes (§3, row 5). I reproduced that sequence; I did not apply
their change.

**Update (host fields landed in this worktree).** The parent's uncommitted edits to
`packages/host-core/src/agent-dispatch/session-verbs.ts` and `packages/cli/src/render.ts`
now send and render the host fields that §5 asked for: `attention`, `stopped`,
`signal`, `lastTurnOutcome`, `pendingMessages` and `pendingMessageCount`. In the
after-measurements (§11), the states that had no reason before now carry one: a
failed turn, a reconnect, a stop by a named actor, a blocked signal, a queued or
refused message. Still open: the backend fold of a failed turn into a reason
(P1), the steer's target and origin (P6), and the executor-bound and
exited-terminal items (P11, P13; F6 not landed). The before-states in §3 are kept
as measured.

## 2. Base, coordination and what was touched

- **Stale base.** The worktree branch `volli/VC-758-…` is at `c0cfd4577`
  (2026-10-07). `origin/main` is `795aec3f9` (2026-10-13, `0.2.2-canary.3`), 55
  commits ahead, and includes VC-753 (`8fff4bb71`). Main's peek adds
  `pendingQuestionLines` in `renderChatPeek` (the VC-753 pending-ask block), in
  the same slot as the line added here (between the stop lines and the
  transcript). **Expect a conflict in `renderChatPeek` on merge; keep both
  sides** (pending questions, then this change's unanswered line). I did not rebase or merge: that changes the
  parent's branch. The parent should merge `origin/main` before pushing.
- **Concurrent uncommitted work.** The worktree had changes from others when
  I looked (renderer, `agent-runtime`, `session-engine/session-runtime.ts`,
  `session-presentation`, a host-core `silent-ends` integration test, and
  `docs/research/VC-758/` screenshots). I did not modify, stage or revert any of
  them. My edits are confined to `packages/cli/src/render.ts`,
  `packages/cli/src/render.test.ts` and the new
  `packages/cli/src/session-peek-status.test.ts`.
- **Temporary probes (removed from the tree).** To drive the real service and
  session engine, I wrote two throwaway test files: a host-core probe and a CLI
  capture. Both were deleted from `packages/`. Their sources are kept, as
  evidence, in the gitignored `.tmp/VC-758/` (`probe-host-core.test.ts.txt`,
  `probe-cli-capture.test.ts.txt`). Captured payloads are in
  `.tmp/VC-758/peek-probe.json`; before/after CLI output is in
  `.tmp/VC-758/cli-before.txt` and `cli-after.txt`.
- **Host code state during the probe.** The peek fold path was unmodified in git
  at probe time: `packages/shared/src/session-ledger.ts`,
  `packages/host-core/src/session-control/chat-attachment.ts`,
  `packages/host-core/src/agent-dispatch/session-verbs.ts` and
  `packages/session-engine/src/transcript-tail.ts`. `session-runtime.ts` was
  already modified by the backend agent; the probe calls `engine.observe`
  directly, so it does not run that runtime path. §3 re-drives the ledger
  sequence the in-flight change writes at audit time: an `adapter_unrecoverable`
  Attention with no attachment, then the close as `failed`.

## 3. Method and the status matrix

The probe drives the real `createAgentCommandService` (`session.peek`,
`session.list`) on a real session engine and SQLite ledger, with scripted
events. Each row is one scripted Session; the **host wire** column is what
`session.peek` returned. The **CLI before** and **CLI after** columns are the
same payload rendered through `runCli` (parse → socket → render), before and
after this change. The status word is the host's; "explained" means the reader
can tell why the state is what it is from the reply alone.

| # | Scripted state | Host wire (status · reason · other) | CLI before | CLI after | Explained? |
|---|---|---|---|---|---|
| 1 | Working, tool running | `working` · — · transcript | `working  last 1m …` + tail | same | yes (state is the cause) |
| 2 | Transport retrying | `working` · — · no marker | `working` | same | **no** (P3) |
| 3 | Permission asked | `waiting` · `permission` | `waiting on permission` | same | yes |
| 4 | Turn failed (`attachment.closed` outcome `failed` mid-turn) | `idle` · null · last row assistant | `idle  …` | same | **no** (P1) |
| 5 | Same, plus `adapter_unrecoverable` Attention with no attachment (the sequence the backend's in-flight change writes) | `idle` · null · last row assistant | `idle  …` | same | **no** (P1) |
| 6 | Runtime stopped the turn (rate limit) | `interrupted` · `stopped-by-runtime` · interruption `rate-limited`, `resetsAt` epoch | `reset: 1800000000000.` | `reset: 2027-01-15T08:00:00.000Z.` + unanswered line | yes (reset now readable) |
| 7 | App restarted mid-turn | `interrupted` · `crash-recovered` | `interrupted (crash-recovered)` | + unanswered line | yes (token only, P5) |
| 8 | Attach refused (`configuration_invalid`) | `idle` · turns 0 · last row user | `idle  … turn 0 depth 1` | + unanswered line | partly (cause not sent, P2) |
| 9 | Steer sent mid-turn, unconsumed | `working` · — · last row user | steer as plain `user` row | same | **no** (P6) |
| 10 | Turn completed, nothing pending | `idle` · — · last row assistant | `idle` | same | yes |
| 11 | Message after a completed turn, no turn started | `idle` · — · last row user | `idle` + row | + unanswered line | yes (fact stated, cause not sent) |
| 12 | Stopped by user | `stopped` · — (actor, reason not sent) | `stopped` | same | **no** (P8) |
| 13 | Terminal parked (warm park) | `parked` · output | `parked` | `parked (paused while idle; output stops until it wakes)` | yes |
| 14 | Terminal ended | `SESSION_NOT_FOUND` · "has no observable live terminal" | error text | same | **no** (P11, wording) |

Rows 1–12 are probed (`.tmp/VC-758/peek-probe.json`, 12 scenarios; the list
column of each is in `cli-after.txt`). Row 13 is a CLI test fixture, from the
terminal branch of `session.peek` in `packages/host-core/src/pty/manager.ts`
(statuses `parked | working | idle`), not a live PTY run. Row 14 is from
`session-verbs.ts` (line 605), not probed. Row 5 is probed with the same events
the backend change writes (`attention.raised` `adapter_unrecoverable` with no
attachment, then `attachment.closed` `failed`); the fold reads it as `idle`.
HEAD writes that close for any `attachment.failed` observation
(HEAD `session-runtime.ts:3818`), so a native failure reaches this ledger shape.

Excerpt of row 6 after the change (`cli-after.txt`):

```
5a00b64e  interrupted (stopped-by-runtime; rate-limited)  last 1m  turn 1 depth 1  started by the user
Stopped: the provider's usage or rate limit was reached; retry: not-retried; reset: 2027-01-15T08:00:00.000Z.
…untrusted provider stop detail block…
no assistant message since the last user message
1m  user  Ship the CLI
```

**Note (this pass).** The "CLI after" column above is the CLI-only state
(`cli-after.txt`), measured before the host fields landed. Rows 2, 4, 5, 8, 9 and 12
have since gained the host's fact, so for the current state of every row see §11.
The before-states above are unchanged.

Rows 6, 7, 8 and 11 gain the unanswered line because their newest row is the
user's. Row 9 (`working`) does not. Rows 4 and 5 render identically before and
after: the CLI has nothing it can add to them.

## 4. Audit: paths where a turn ends, stalls, or a message waits silently

"Today" is what the reader of `volli session peek` (or `list`) sees now, at the
worktree base. Line numbers are at `c0cfd4577` (the worktree base); `origin/main`
shifts `session-ledger.ts` by +2 and `session-verbs.ts` by +5.

| ID | Path | Code location | What the reader saw at the audit base (measured) | Status | Fix / owner |
|---|---|---|---|---|---|
| P1 | Executor fails mid-turn; turn ends | `session-ledger.ts:2040` (attachment.failed sets `lastTurnOutcome=failed`), `:2063` (attachment.closed `failed`); `:503-515` `sessionInterruptionReason` reads only `interrupted`; `chat-attachment.ts:99-113` `chatActivity` → `idle`; `session-verbs.ts:567-572` reason only for `interrupted`; wire has no outcome (`chat-attachment.ts:59` computes `outcome`, not sent) | `idle  last …  turn N depth M`, nothing says it failed (rows 4–5) | **fixed** for the outcome: `Last turn failed` (F1 `lastTurnOutcome`). The reason fold is still open. | Host F1 landed. Backend: fold `failed` into a reason (open). |
| P2 | Attach refused (`configuration_invalid`, or `adapter_unrecoverable` at attach) | `session-runtime.ts:1616` (`configuration_invalid`), `#failAttach` at `:1818` (HEAD); `configuration_invalid` not user-blocking (`session-ledger.ts:426`), so folds to `idle` | `idle  turn 0 depth 1` and the message; the cause is absent | **fixed** (F2): `Configuration invalid · Open settings`. | Host F2 landed (primary Attention). |
| P3 | Transport retrying, rate limit, quota, context limit while a turn is open | `chat-attachment.ts:99-113`: `working` whenever `turnActive && executorBound`; non-user-blocking Attention ignored; `session-ledger.ts:426` names only three user-blocking kinds | `working  last …` — identical to a healthy turn (row 2) | **fixed** for the active Attention kinds (F2): `Reconnecting`, `Rate limited`, and the rest of the table. | Host F2 landed. Backend: none. |
| P4 | Runtime stopped the turn (retry budget spent, provider error) | `session-ledger.ts:503-520` (`stopped-by-runtime`), `render.ts` `sessionStopLines` | Explained; reset was a raw epoch | **fixed in CLI** (reset as UTC) | none further |
| P5 | App restarted mid-turn | `boot-recovery.ts:195-221` writes `partial_turn_interrupted` and `attachment.closed` `interrupted` | `interrupted (crash-recovered)` — the token, not plain words | **partly**: `Turn interrupted` is named (F2); the header token `crash-recovered` is unchanged (D5). | Decision D5 (copy). |
| P6 | Steer sent mid-turn: not yet consumed | `transcript-tail.ts:142-150` counts `message.submit` as a transcript row when recorded; `agent-tool-door.ts:634` tells only the sender "the model reads it mid-stream"; tail entries carry no origin (`transcript-tail.ts` entry: at, role, text, tools) | `working`; the steer is a plain `user` row (row 9) | **partly** (F5): a queued steer is listed as `After the current step`. A steer already in the transcript is still a plain user row, and the target turn and origin are not sent. | Host F5 landed without origin or target. Backend: pending-steer state (open). |
| P7 | Follow-up queued behind a running turn, or delivery refused (VC-753 blocked delivery) | `session-follow-ups.ts:14-44` (`queued \| releasing`, `refused`, `refusedDetail`); `db/session-follow-up-repo.ts`; no agent verb reads it | Absent from `peek` and `list` entirely | **fixed** (F5): queued, sending, after-step and refused follow-ups, with the refusal detail and the boot-hold reason. | Host F5 landed (`pendingMessages`, `pendingMessageCount`). Desktop: parent. |
| P8 | Stopped by user, session, or watchdog | `session-ledger.ts:625` (`SessionStopActor`); `:1564` `projection.stopped {at, reason, by}`; `session-verbs.ts:277` (list) and `:675` (peek) set `interruption` null for stopped; the actor and reason are never sent | `stopped  last …` — no actor, reason or time (row 12) | **fixed** (F3): actor (session id shortened), reason (redacted, 400 max) and time. | Host F3 landed. |
| P9 | Watchdog wedge: open turn silent 10+ minutes | Watchdog writes a durable `blocked` signal (`shared/src/session-watchdog.ts:65`); `publicSessionSignal` (`session-verbs.ts:380`) is on `show` (434, 503) and `answer` (726), **not** on `peek` (589-690) | `working  last 40m` with no blocked signal | **fixed** (F4): `signal  blocked · 1m ago` with the reason quoted. | Host F4 landed in peek. `show` and `answer` still send the raw reason (§10). |
| P10 | Terminal parked (warm park: idle tree SIGSTOP'd) | `pty/manager.ts:1289-1307` (`parked`); wake in `host-core/src/pty/park-controller.ts` | `parked`, output frozen, no explanation | **fixed in CLI** | none further |
| P11 | Terminal ended | `session-verbs.ts:601-606`: `SESSION_NOT_FOUND`, "has no observable live terminal" | Does not say it exited (`session list` does: `exited`) | **open** (wording) | Host: say it exited (F6). Small. |
| P12 | Unreadable transcript messages in the tail | `render.ts` header | `2 unreadable` (no noun) | **fixed in CLI** (`N unreadable message(s)`) | none further |
| P13 | Open turn with no executor in this process | `session-verbs.ts:198, 249, 447, 463, 628, 641` call `chatSessionRecord(p)` with the default `executorBound = true`; desktop `listing-row.ts:80` passes it | Could read `working` where the app would not | **unverified** — boot recovery closes such attachments on relaunch (`boot-recovery.ts:209-221`); only a live executor loss without a close is exposed | Host: pass `executorBound` on agent reads (F6). Needs a probe before a claim. |
| P14 | Terminal waiting at an interactive prompt | `pty/manager.ts:1298` (`idle` is the default) | `idle` | **by design** — terminals have no waiting state | Note only. |
| P15 | VC-753 pending question | `origin/main` `render.ts` `pendingQuestionLines` (main only) | On main: the question text is shown; in this base: `waiting on question` | covered on main | After the merge, check the matrix still passes. |
| P16 | Desktop timeline rows (error, pending, queued, working) | parent's renderer audit | — | out of CLI scope | Parent. |

## 5. Host fields needed (for the parent to route; none added here)

All are additive keys on the `session.peek` (and where noted `session.list`)
reply. Each source already exists in the host's projection; none needs a new
fact. The CLI will render each once it arrives (no dead code is added before
then).

| ID | Field (proposed) | Source (existing) | Closes |
|---|---|---|---|
| F1 | `outcome`: latest turn's `completed \| interrupted \| failed` | `ChatSessionRecord.outcome` = `projection.lastTurnOutcome` (`chat-attachment.ts:59`) | P1 (with backend folding `failed` into a reason) |
| F2 | `attention`: `[{kind, detail}]` for active Attention | `projection.attention.active` (`session-ledger.ts`); `detail` is untrusted prose, so it goes through the same envelope as the stop detail | P2, P3 |
| F3 | `stopped`: `{at, reason, by}` (`by` is user, session or watchdog) | `projection.stopped` (`session-ledger.ts:1564`) | P8 |
| F4 | `signal`: latest done/blocked | `publicSessionSignal` (`session-verbs.ts:380`) | P9 |
| F5 | Queue and steer: queued/refused follow-ups (state, `refusedDetail`) and pending steer (target turn, origin) | `session-follow-ups.ts`; the steer origin needs the backend's delivery state | P6, P7 |
| F6 | `executorBound` passed on agent reads; exited-terminal wording | `session-verbs.ts` call sites; `:605` | P13, P11 |

Compatibility: an older CLI ignores keys it does not read. The reply of
`session.peek` is not in the generated output schema (`session-rpc` defines only
its input), so the protocol gate should not move; the host owner should confirm
with `pnpm check:protocol-schema --base origin/main`.

### 5b. What landed (this pass)

The proposed fields are now sent by `session.peek` under these names. The shapes
differ from the proposal where noted.

| ID | Landed as (`session.peek`) | Differs from the proposal |
|---|---|---|
| F1 | `lastTurnOutcome`: the projection's latest turn outcome (`completed \| interrupted \| failed \| null`) | Named after the projection field, not `outcome`. |
| F2 | `attention`: `{message, recovery, detail}` for the primary (latest) active Attention only. `message` and `recovery` are the host's human copy (`PEEK_ATTENTION`, all 11 kinds). `detail` is redacted and cut to 400. | One object, not a list. A second active Attention is not sent. |
| F3 | `stopped`: `{at, reason, by}`. `reason` is redacted and cut to 400; a session actor's id is cut to 8 characters. | None. |
| F4 | `signal`: `{kind, reason, at, ageMs}` from `publicSessionSignal`. `reason` is redacted and cut to 400 in peek only. | `show` and `answer` still send the raw reason (§10). |
| F5 | `pendingMessages` (rows up to `lines`) and `pendingMessageCount` (all rows): `{id, text, label, detail}`, read in the SQLite follow-up ledger transaction. Labels: `Blocked`, `After the current step`, `Sending`, `Queued`. Text and refusal detail are redacted and cut to 400. | No steer origin or target turn. A steer is labelled, not attributed. |
| F6 | Not landed. | `executorBound` and the exited-terminal wording stay open (P11, P13). |

Also from the concurrent transcript work, not in §5: each transcript row of
`session.peek` may carry `delivery` (`Pending`, `Delivered`, `Not delivered`,
`Delivery unconfirmed`), rendered as `[Delivered]` after the role. A render test
covers it (§12).

## 6. Rejected CLI-only fixes

- **A "stalled" marker from `lastActivityAgeMs`.** The durable age is not the
  watchdog's clock. The watchdog measures process-local progress, and streamed
  tokens are transient (`shared/src/session-watchdog.ts` header). A long healthy
  model call would print as stalled. Only the host's blocked signal (F4) is a
  real fact.
- **A failure reason guessed from transcript text.** No field in the tail says a
  turn failed, and an error string in an assistant message is not that fact.
- **A "pending steer" marker inferred from a trailing user row.** A consumed
  steer and an unconsumed one look the same in the tail (row 9).
- **Recovery commands on idle or interrupted rows.** `session send` is
  tool-only (`verb-registry`: `accessModes: ["tool"]`), so a CLI reader gets
  `WRONG_DOOR`. The person's recovery (reattach in the app) depends on host
  state we do not carry.

## 7. Changes made

`packages/cli/src/render.ts`:

- `resetInstantText`: the provider reset as an ISO UTC instant; invalid values
  print `not stated`. `--json` is unchanged (still the epoch).
- `unansweredMessageLines` (in `renderChatPeek`): for `idle` or `interrupted`
  chats whose newest tail row is the user's and whose tail is fully readable,
  print `no assistant message since the last user message`.
- Terminal `parked` status: `parked (paused while idle; output stops until it wakes)`.
- Unreadable count: `N unreadable message` / `messages`.

`packages/cli/src/render.test.ts`: two existing assertions updated (the unreadable
wording and the reset value), and new tests for each branch.

`packages/cli/src/session-peek-status.test.ts` (new): one scripted-socket test per
state from §3, through `runCli`, using the captured host payload shape. Each test
names the state it pins. Tests that pin a gap (rows 2, 4, 5, 9, 12) assert that
the CLI invents no reason. They do not assert the gap is correct.

## 8. Checks run

| Check | Command | Result |
|---|---|---|
| Format and lint, touched files | `vp check packages/cli/src/render.ts packages/cli/src/render.test.ts packages/cli/src/session-peek-status.test.ts` | exit 0 (formatting fixed first with `vp fmt`; lint: `consistent-function-scoping` fixed by moving helpers to module scope) |
| Typecheck, CLI | `pnpm run typecheck` in `packages/cli` (`tsc --noEmit`) | exit 0 |
| Focused tests with coverage | `vp test run src/render.test.ts src/session-peek-status.test.ts src/orchestration.test.ts src/run.test.ts src/cli-reference.test.ts --coverage --coverage.include=src/render.ts --maxWorkers=$VOLLI_CONCURRENCY_HINT` (hint `1`) | 5 files, 159 tests passed; `render.ts` 100% statements, branches, functions, lines; exit 0 |
| Focused tests, no coverage | `vp test run src/render.test.ts src/session-peek-status.test.ts` | 101 passed |
| Host probe (temporary, real service and engine) | `vp test run src/vc758-peek-probe.test.ts --maxWorkers=$VOLLI_CONCURRENCY_HINT` (hint `1`) in `packages/host-core` | 1 test passed; 12 scenarios written to `.tmp/VC-758/peek-probe.json` |
| CLI capture (temporary, real `runCli`) | `vp test run src/vc758-cli-capture.test.ts` in `packages/cli` | passed; before/after written to `.tmp/VC-758/` |

Not run, by instruction or because nothing relevant changed: full suites, the
full CLI coverage gate, desktop and renderer tests, the smoke matrix, Electron,
SSH, keychain, and `check-host-electron-imports.mjs` and
`check:protocol-schema` (no host, shared or protocol file changed in my diff).

### 8b. Checks in this pass

Run against the parent's uncommitted product diffs, identified by `git diff HEAD`
hash. `render.ts` was `978683bc…` for every run in this pass. `session-verbs.ts`
was `c1297324…` for the first set of runs and `7d80d92f…` for the final re-run,
which covers the focused CLI and host suites, the host dispatch suite, the host
typecheck and the after-probe (its CLI text was identical to the earlier capture,
ids normalised). No commit, no push.

| Check | Command | Result |
|---|---|---|
| Host verb tests: real engine, SQLite, follow-up ledger, socket and `runCli` | `vp test run src/agent-dispatch/session-verbs.test.ts --maxWorkers=$VOLLI_CONCURRENCY_HINT` in `packages/host-core` (hint `1`) | 38 passed (14 before this pass; 1 expected-fail marker flipped, see §12) |
| Host agent dispatch, all four files | `vp test run src/agent-dispatch --maxWorkers=1` in `packages/host-core` | 4 files, 86 passed |
| CLI focused, with the protected coverage | `vp test run src/render.test.ts src/session-peek-status.test.ts src/orchestration.test.ts src/run.test.ts src/cli-reference.test.ts --coverage --coverage.include=src/render.ts --maxWorkers=1` in `packages/cli` | 5 files, 192 passed. `render.ts`: 100% statements, branches, functions, lines. Exit 0. |
| CLI, whole package | `vp test run --maxWorkers=1` in `packages/cli` | 14 files, 448 passed |
| Format and lint, touched test files | `vp check` on `render.test.ts` and `session-peek-status.test.ts` (CLI), and `session-verbs.test.ts` (host-core) | pass |
| Typecheck | `pnpm run typecheck` in `packages/cli` and `packages/host-core` | both exit 0 |
| Before/after capture: temporary probe on the real service, socket and `runCli` | probe in host-core, removed afterwards | 15 scenarios: `.tmp/VC-758/cli-after-host-fields.txt`, `.tmp/VC-758/peek-probe-after.json`; source `.tmp/VC-758/probe-host-core-after.test.ts.txt` |

Before this pass, in the two-file run (`render.test.ts`, `session-peek-status.test.ts`),
`render.ts` was at 93.87% statements, 89.33% branches, 99.14% functions and 94.35%
lines. The uncovered lines were `runtimePeekLines`.

Not run: Electron, SSH, keychain, security, Docker, the desktop renderer, the full
host-core suite, `check-host-electron-imports.mjs`, and `check:protocol-schema`.
The protocol output schema is changing in this worktree for other work
(`docs/protocol/protocol.schema.json`, `packages/session-rpc/src/output-schema.ts`),
so that gate belongs to the parent.

## 9. Decisions to confirm

- **D1 — line wording.** `no assistant message since the last user message` is
  a fact about the tail, not a cause. The alternative is a cause, which the
  peek cannot know.
- **D2 — scope.** The unanswered line is for `idle` and `interrupted` only.
  It is not shown for `working` (a reply is coming), `waiting` (has its own
  reason) or `stopped` (ended on purpose). It is suppressed when the tail is
  partly unreadable.
- **D3 — reset in text.** ISO UTC in text; `--json` keeps the epoch. Agents
  that parsed the old text by eye will see a different string.
- **D4 — `parked` wording.** `paused while idle; output stops until it wakes`.
  Lower case, same register as the other CLI state words.
- **D5 — plain words for `crash-recovered`.** Not changed: the token is what
  `session list` has always printed. A copy change would touch the list too.
- **D6 — base.** I did not rebase. The parent merges `origin/main`; expect a
  conflict in `renderChatPeek` (see §2).

- **D7 — recovery words name app actions.** `Open settings` and `Retry` tell the
  person what to do in the app. A CLI reader cannot do either (`session send` is
  tool-only, §6). The copy is the host's (`PEEK_ATTENTION`, "human copy"). Decide
  whether a peek names the recovery or only the state.
- **D8 — `N message(s) waiting` counts a refused message.** The count is every queued
  row, and a `Blocked` row is held, not waiting. `1 message waiting` above
  `pending message 1: Blocked:` contradicts itself (§11, N1). Options: say `held` for
  blocked rows, or count only the waiting ones.
- **D9 — the header and the Attention line can say the same thing.**
  `waiting on permission` with `Waiting for approval`, and
  `interrupted (stopped-by-runtime; rate-limited)` with `Runtime stopped · Retry`.
  Both are true. Decide whether the Attention line yields when the header already
  names the state.

## 10. Open questions

- P13 (`executorBound` on agent reads) needs a probe where an attachment stays
  open with no live executor. I did not write one.
- The queue (P7) and steer (P6) rows are from code reading, not probed. They
  need the host's follow-up path, which is outside the engine `observe` seam the
  probe drives.
- Row 14 (exited terminal) is from code, not from a live terminal.

### Open after the host fields

- **The signal reason in `show` and `answer` is still raw.** `publicSessionSignal`
  (`session-verbs.ts:384`) is used by `sessionShowVerb` (lines 438, 508) and
  `sessionAnswerVerb` (line 816) and sends `signal.reason` as written. Peek now
  redacts and cuts it (line 735). `show` is capped at 1000 characters by the CLI,
  not redacted. Recommend one redaction at `publicSessionSignal`. Pre-existing for
  `show` and `answer`; no test in this pass covers them.
- **The CLI does not bound peek prose.** Peek's stop reason, Attention detail, signal
  reason and queued text print as the host sent them. The bound is the host's 400
  characters. `show` caps its signal reason at 1000 characters in the CLI. Decide
  whether peek should cap too.
- **Malformed host values print as words.** A stop without `by.kind` prints
  `Stopped by undefined`, and a queued row without a label prints
  `pending message 1: undefined`. The host always sends both, so this is robustness
  only. No test pins it.
- **An empty stop reason is quoted; a blank signal reason is dropped.** A stop reason
  of `""` prints an empty quoted line (`  | `). A signal reason of spaces does not
  print. Decide one rule.
- **The `attachment.failed` branch is not exercised by a test.** The fold in
  `packages/shared/src/session-ledger.ts:2042` (in HEAD, unchanged) sets `failed` on
  `attachment.failed` only while a turn is open. The engine refuses an
  `attachment.failed` for an id that already exists, so the tests use the reachable
  path, `attachment.closed` with outcome `failed`. This is in `shared`, outside this
  scope.
- **P11 and P13 are unchanged.** F6 has not landed.

## 11. After the host fields: measured matrix

Same scripted events as §3, run against the current working tree through the
real host service, the socket and `runCli` (`.tmp/VC-758/cli-after-host-fields.txt`;
host payloads in `.tmp/VC-758/peek-probe-after.json`). The before columns of §3
are not changed. Rows N1 to N3 are new: the states the host now carries that the
original probe did not reach.

| # | Scripted state | Host wire, after (new fields) | CLI after, current | Explained now? |
|---|---|---|---|---|
| 1 | Working, tool running | unchanged | `working  last 1m  turn 1 depth 2`, then the transcript | yes (unchanged) |
| 2 | Transport retrying | `attention` `{message: Reconnecting, recovery: null, detail: null}` | `working …`, then `Reconnecting` | yes (the reconnect is named) |
| 3 | Permission asked | `attention` `{message: Waiting for approval, recovery: null, detail: null}` | `waiting on permission …`, then `Waiting for approval` | yes (the same fact twice, D9) |
| 4 | Turn failed (`attachment.closed` outcome `failed` mid-turn) | `lastTurnOutcome: failed`; status `idle` | `idle …`, then `Last turn failed` | **yes** (was no, P1) |
| 5 | Same, plus `adapter_unrecoverable` with no attachment | `attention` `{message: Runtime stopped, recovery: Retry, detail: The runtime stopped unexpectedly.}`; `lastTurnOutcome: failed` | `idle …`, then `Runtime stopped · Retry`, `Last turn failed`, and the runtime-detail block | **yes** (was no, P1 and P3) |
| 6 | Runtime stopped the turn (rate limit) | `attention` `{message: Runtime stopped, recovery: Retry}` beside the existing `interruption` | the stop block as before, then `Runtime stopped · Retry`, then the unanswered line | yes (the reset as UTC was already measured, §3) |
| 7 | App restarted mid-turn | `attention` `{message: Turn interrupted, recovery: null}` | `interrupted (crash-recovered)`, then `Turn interrupted`, then the unanswered line | yes (plain words added; the header token stays, D5) |
| 8 | Attach refused (`configuration_invalid`) | `attention` `{message: Configuration invalid, recovery: Open settings}` | `idle  …  turn 0 depth 1`, then `Configuration invalid · Open settings`, then the unanswered line | **yes** (was partly, P2) |
| 9 | Steer sent mid-turn, not yet consumed | `pendingMessageCount: 1`; `pendingMessages[0]` label `After the current step` | `working`, `1 message waiting`, then the `pending message 1: After the current step` block; the transcript row is unchanged | **partly**: the queued steer is named; its origin is not sent (P6) |
| 10 | Turn completed, nothing pending | unchanged | unchanged | yes |
| 11 | Message after a completed turn, no turn started | unchanged | unchanged, with the earlier unanswered line | yes |
| 12 | Stopped by user | `stopped` `{at, reason: owner stop, by: {kind: user}}` | `stopped …`, then `Stopped by user`, then the `stop reason:` block | **yes** (was no, P8) |
| 13 | Terminal parked | unchanged (terminal branch) | unchanged | yes (earlier CLI change) |
| 14 | Terminal ended | unchanged | unchanged | no (P11; F6 open) |
| N1 | Delivery refused, VC-753 blocked delivery | `pendingMessages[0]` label `Blocked`, detail `Queued delivery refused: rejected: session_archived` | `idle …`, `1 message waiting`, `pending message 1: Blocked:` with the refusal line, then the unanswered line | **yes**, with the count wording open (D8) |
| N2 | Held at boot, because an older Volli ran | label `Blocked`, detail `Held: an older Volli version ran since this was queued — edit or remove it` | `idle …`, `1 message waiting`, `pending message 1: Blocked:` with the hold reason | **yes** |
| N3 | Blocked signal, open turn (the watchdog's signal) | `signal` `{kind: blocked, reason: No progress for ten minutes, ageMs: 99000}` | `working …`, `signal  blocked · 1m ago`, then the `signal reason:` block | **yes** (was no, P9) |

Notes:

- Row 9, N1 and N2 need queue state. The probe writes those queue entries through
  the same SQLite follow-up ledger the runtime drains, because it does not drive the
  runtime's steer and refusal paths. The transcript row of the steer is the one
  §3 measured.
- Row 5's before state is the §3 row 5 measurement; the CLI printed no failure line there.
- The `stopped` reason and the signal reason shown here are the host's values after
  redaction. A secret in them does not reach the peek text (§12).
- Duplicated facts (rows 3, 6): D9.

## 12. Tests and changes in this pass

**Tests added or changed** (no product file was edited in this pass):

- `packages/host-core/src/agent-dispatch/session-verbs.test.ts`: 24 new tests in
  `session peek runtime facts (VC-758)`; the 14 existing tests are unchanged. The
  fixtures run the real engine, SQLite and the follow-up ledger.
  - One test per Attention kind (11 cases): the message and the recovery, with no
    recovery where the host sends none.
  - The Attention's detail is redacted and cut to 400; `attention.cleared` removes
    it; the latest active Attention is the one shown, and the one before it returns
    when that clears.
  - The stop: a session actor is named by its short id and the reason is redacted;
    the user and the watchdog are named with their reasons; a resumed attachment
    clears the stop.
  - The signal: the latest done or blocked, with its age. The reason is redacted and
    cut to 400. This test first pinned the gap with `it.fails` (the reason came back
    raw); the parent's redaction made it pass, so it was flipped to a normal test with
    the exact expected text.
  - The last-turn outcome: completed, interrupted and failed. Failed is written as
    `attachment.closed` with outcome `failed`.
  - The queue read through `createSqliteSessionFollowUpLedger`: Queued, Sending, After
    the current step and Blocked; an attachment-only row is named; text is redacted and
    cut; `lines` bounds the rows but not the count.
  - The boot hold: `stampFollowUpCleanClose`, a later event, then
    `consumeFollowUpCleanClose`. The held row reads Blocked with the hold detail.
  - Socket and `runCli`: the text and `--json` carry every fact, and no secret appears
    in either.
- `packages/cli/src/render.test.ts`: 12 new tests (88 to 100), at module scope where
  they need it. They cover every branch of `runtimePeekLines` with exact text: an
  Attention with and without a recovery; a detail that quotes a forged end marker;
  stops by user, session and watchdog, with and without a reason, and a malformed stop;
  a blocked and a done signal, a blank reason and a malformed signal; `Last turn
  failed`; the singular, plural, zero and non-number counts; queued rows with empty,
  non-string text and a detail; a malformed or empty queue; the full fixed-order
  output; terminal controls and bidi marks escaped in every fact, with `--json`
  unchanged; and the transcript `delivery` tag.
- `packages/cli/src/session-peek-status.test.ts`: 6 new tests (14 to 20), each a real-shape
  reply through `runCli`: failed turn, steer waiting, stopped by user, blocked signal,
  reconnect, and `--json`. The four earlier tests that pinned a gap (transport retry,
  failed turn, steer, stop) are renamed "an older host ..." and keep their assertions:
  a reply without the field must not invent the fact.

**Coverage.** `render.ts` in the focused CLI run: 100% statements, branches, functions and
lines (§8b). The protected gate is scoped to `src/render.ts`, as asked.

**Not changed:** `packages/cli/src/render.ts`, `packages/host-core/src/agent-dispatch/session-verbs.ts`,
and every file outside the three test files and this audit. Nothing was committed or
pushed. The temporary probe was written to `packages/host-core/src/`, run, and
removed; its source is kept in `.tmp/VC-758/` (gitignored).
