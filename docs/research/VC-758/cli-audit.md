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

Rows 6, 7, 8 and 11 gain the unanswered line because their newest row is the
user's. Row 9 (`working`) does not. Rows 4 and 5 render identically before and
after: the CLI has nothing it can add to them.

## 4. Audit: paths where a turn ends, stalls, or a message waits silently

"Today" is what the reader of `volli session peek` (or `list`) sees now, at the
worktree base. Line numbers are at `c0cfd4577` (the worktree base); `origin/main`
shifts `session-ledger.ts` by +2 and `session-verbs.ts` by +5.

| ID | Path | Code location | What the reader sees today | Status | Fix / owner |
|---|---|---|---|---|---|
| P1 | Executor fails mid-turn; turn ends | `session-ledger.ts:2040` (attachment.failed sets `lastTurnOutcome=failed`), `:2063` (attachment.closed `failed`); `:503-515` `sessionInterruptionReason` reads only `interrupted`; `chat-attachment.ts:99-113` `chatActivity` → `idle`; `session-verbs.ts:567-572` reason only for `interrupted`; wire has no outcome (`chat-attachment.ts:59` computes `outcome`, not sent) | `idle  last …  turn N depth M`, nothing says it failed (rows 4–5) | **open** | Host: send `outcome` (F1); backend: fold `failed` into a reason. CLI renders once sent. |
| P2 | Attach refused (`configuration_invalid`, or `adapter_unrecoverable` at attach) | `session-runtime.ts:1616` (`configuration_invalid`), `#failAttach` at `:1818` (HEAD); `configuration_invalid` not user-blocking (`session-ledger.ts:426`), so folds to `idle` | `idle  turn 0 depth 1` and the message; the cause is absent | **partly** — CLI states the unanswered message (row 8) | Host: send active Attention (F2). |
| P3 | Transport retrying, rate limit, quota, context limit while a turn is open | `chat-attachment.ts:99-113`: `working` whenever `turnActive && executorBound`; non-user-blocking Attention ignored; `session-ledger.ts:426` names only three user-blocking kinds | `working  last …` — identical to a healthy turn (row 2) | **open** | Host: send active Attention kinds + untrusted detail (F2). Backend: none. |
| P4 | Runtime stopped the turn (retry budget spent, provider error) | `session-ledger.ts:503-520` (`stopped-by-runtime`), `render.ts` `sessionStopLines` | Explained; reset was a raw epoch | **fixed in CLI** (reset as UTC) | none further |
| P5 | App restarted mid-turn | `boot-recovery.ts:195-221` writes `partial_turn_interrupted` and `attachment.closed` `interrupted` | `interrupted (crash-recovered)` — the token, not plain words | **partly** (row 7); plain wording is a copy decision | Decision D5. |
| P6 | Steer sent mid-turn: not yet consumed | `transcript-tail.ts:142-150` counts `message.submit` as a transcript row when recorded; `agent-tool-door.ts:634` tells only the sender "the model reads it mid-stream"; tail entries carry no origin (`transcript-tail.ts` entry: at, role, text, tools) | `working`; the steer is a plain `user` row (row 9) | **open** | Backend: pending-steer state with its target turn (F5); Host: send it and steer origin (F5). |
| P7 | Follow-up queued behind a running turn, or delivery refused (VC-753 blocked delivery) | `session-follow-ups.ts:14-44` (`queued \| releasing`, `refused`, `refusedDetail`); `db/session-follow-up-repo.ts`; no agent verb reads it | Absent from `peek` and `list` entirely | **open** (not probed: host-owned queue, outside engine observe) | Host: queued/refused items with untrusted `refusedDetail` (F5). Desktop: parent. |
| P8 | Stopped by user, session, or watchdog | `session-ledger.ts:625` (`SessionStopActor`); `:1564` `projection.stopped {at, reason, by}`; `session-verbs.ts:277` (list) and `:675` (peek) set `interruption` null for stopped; the actor and reason are never sent | `stopped  last …` — no actor, reason or time (row 12) | **open** | Host: send `projection.stopped` (F3). |
| P9 | Watchdog wedge: open turn silent 10+ minutes | Watchdog writes a durable `blocked` signal (`shared/src/session-watchdog.ts:65`); `publicSessionSignal` (`session-verbs.ts:380`) is on `show` (434, 503) and `answer` (726), **not** on `peek` (589-690) | `working  last 40m` with no blocked signal | **open** | Host: add `signal` to peek (F4). CLI renders it with the existing `sessionSignalLine`. Rejected: a CLI-side stall threshold (§6). |
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

## 10. Open questions

- P13 (`executorBound` on agent reads) needs a probe where an attachment stays
  open with no live executor. I did not write one.
- The queue (P7) and steer (P6) rows are from code reading, not probed. They
  need the host's follow-up path, which is outside the engine `observe` seam the
  probe drives.
- Row 14 (exited terminal) is from code, not from a live terminal.
