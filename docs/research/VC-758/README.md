# VC-758 — nothing ends or waits silently

## Changes for the person and the model

The desktop now draws a submitted message immediately, keeps Working visible above undelivered steering, labels queue ownership, and places existing runtime failures in the conversation. A reader scrolled into history gets a navigation hint naming the current failure, without a second recovery. Successful sends have no Delivered/Recorded footer, including accepted held copies awaiting durable ownership. Explanatory waits and refusals remain visible. Unlabelled historical messages keep their old appearance.

`volli session peek` now carries existing failure/Attention, stop actor/reason, watchdog signal, queue ownership, and per-message delivery proof. The CLI prints those facts rather than guessing a cause from elapsed time or assistant prose. Reasons and queued message bodies are bounded/redacted by the host and quoted as untrusted prose in text output. No Session tool array, description, Code Mode record, model prompt, cloud flag, migration, or new ledger event kind changes.

## Review fix round

[PR #865 fix-round evidence](fixround.md) adds fatal-close live-turn retirement, prompt delivery at opening acceptance (before the reply finishes), and targeted real-runtime N−1 continuation fixtures. Both fixed downgrade promises, 0.2.1 and 0.2.2-canary.1, now have explicit CI lanes alongside rolling release/canary/base.

## Measured audit

Baseline was worktree birth `c0cfd4577`. Main including VC-753 was merged before integrated checks. Detailed locations, reproductions, initial failures and commands are in `runtime-audit.md`, `renderer-audit.md`, and `cli-audit.md` beside this file. `H` below means the real Pi → adapter → SessionRuntime → engine → SQLite/artifact integration suite, `silent-ends.integration.test.ts`; provider replies and host ports are scripted, not real sign-ins or network providers.

| Path / code location | Before: desktop / peek | After / disposition | Measured evidence |
|---|---|---|---|
| Before-stream provider error — Pi `runtime.ts`, observation translation | Runtime failure durable but only composer explanation; peek can read idle | Existing failure in timeline with Retry; peek names failure and latest outcome | H before-stream rejection |
| Provider error between steps — same lifecycle | Conversation ends without its own error row; peek lacks Attention | Timeline recovery; peek explanation | H between-step rejection |
| Context assembly before attach — `pi-adapter.ts` resolver | Failure outside conversation; peek idle turn 0 | Existing attach failure in timeline; peek configuration/runtime detail | H context resolver failure |
| MCP startup before attach — `pi-adapter.ts` MCP port resolver | Same missing conversation/peek explanation | Same existing recovery, no duplicate error fact | H actual frozen port resolver throws |
| Tool/MCP failure that the model handles — Pi tools/activity | Failed tool artifact already visible and model can recover | Preserve tool row and successful completion; no second Session recovery | H failed MCP call then successful reply |
| Expired sign-in — Pi Attention classifier | Competing Settings/Retry in composer; peek lacks cause | One Open settings recovery in timeline; peek names sign-in wait | H expired authentication |
| User attachment preparation rejected — PiBinding submit | Intent looks like an ordinary user message; peek does not state delivery | Not delivered receipt label; live client reports host refusal; no automatic resend | H attachment preparation; real-codec delivery/client tests |
| Fatal runtime observation — engine native observation recorder | Close was durable but diagnostic lost; no cold recovery; peek idle | Existing redacted Session-scoped failure Attention before close; timeline Retry and failed outcome in peek | H fatal observer injection, independent cold SQLite fold; invariant fallback/dedupe/close races |
| Stop races a normal provider finish — Pi agent-end | Could write completed despite deliberate Stop | Existing turn.interrupted, no failure Attention | H cancellation and Pi sidecar replay regression |
| Provider request has not answered — stream supervisor | Working can vanish on empty transcript or later become only dots | Visible Working until the real boundary; retain existing silence deadline and recovery | H gated provider stall; focused supervisor/runtime tests |
| Transport retry/offline/rate-limit wait — Pi transport notices | Non-user-blocking Attention absent from peek; desktop can hide Working on error | Existing wait/stop explanation in timeline and peek; Working follows actual open turn | Focused Pi retries/offline/abort/budget tests; real SQLite peek fixture |
| Submit waits on promotion, persistence or IPC — ChatPlane dispatch/drafts | Words disappear after composer clears | Immediate Pending bubble with files/resources | Mounted deferred promotion; before assertion reproduced absence |
| Raw steering mid-turn — dispatch, delivery proof | Words disappear while the current step runs; peek plain user row | Pending · After the current step while local intent exists; durable peek distinguishes pending/accepted/rejected/unknown | Mounted and real-codec delivery tests; raw steering provenance limitation below |
| Queued follow-up — engine follow-ups/composer | No visible queue label; absent from peek | Queued, Sending, or existing blocked-delivery explanation; host queue exposed to peek | H real Pi queue consumption; SQLite peek queue fixture |
| Steering a host-owned queued message — engine steer claim | Unexplained releasing row | After the current step hint; keep payload until Pi consumption, Working above it | H real Pi steering consumption; queue claim codec tests |
| Receipt precedes host projection — draft/store ownership handoff | Accepted words disappear until refresh arrives | Same non-editable accepted copy until queue/transcript owns its identity | Deferred projection store tests and mounted recovery-strip steering |
| Unreconciled receipt — presentation client and delivery fold | Falsely returns Delivered, then row stays Pending | Visible unconfirmed delivery; keep recorded words; positive runtime proof is never downgraded by a later unknown receipt | Failing-before/passing-after real-client codec tests; engine tail proof tests |
| New pending intent while reply streams — ChatPlane live-turn identity | Pending user turn can steal the last-turn live identity | Select live turn from delivered rows; pending intents remain below Working | Mounted ordering and renderer regression assertions |
| Restart queue / crash question — VC-753 recovery | Previously could wait forever | Reuse VC-753's visible, retryable fail-closed hold and pending-question presentation | Post-merge crash, crash-question, queue admission and clean-close integrations |
| Deliberate stop/watchdog signal — durable projection and host peek | Peek omits stop actor/reason and blocked signal | Names user/session/watchdog and quotes reason/signal | Real engine/SQLite host fixture and real CLI command path |
| Reader above live tail — ChatPlane conversation navigation | A new timeline blocker could be offscreen | Detached latest-navigation slot names failure and returns to its one recovery | Final light/dark browser screenshots and navigation click |
| Terminal parked / unreadable tail / reset instant — CLI render | Unexplained parked token, unreadable count, raw reset epoch | Plain paused explanation, unreadable message count, UTC reset time | Focused real runCli command-path tests; parked is not a live PTY reproduction |

## Compatibility

- No database migration or new durable row/Attention/queue vocabulary. Runtime fixes write existing `attention.raised`, `attachment.closed`, and `turn.interrupted` shapes. 0.2.1 and canary.1–3 already understand these facts and their existing recovery/replay.
- Optional local draft hints are ignored by older readers. Both old and current conservative hydration recover the same words, skills and files as unsent; no blind resend.
- Optional output-only `afterCurrentStep: true` retains the existing queued/releasing state and complete payload. Older clients ignore the hint and retain their existing queue presentation rather than dropping a frame/message. New peek keys are additive; old CLIs ignore them.
- Public protocol schema was regenerated, not hand-edited. No output enum was expanded. Opening settlement reuses an existing command field. Additive gate and real JSON codec tests pass locally. Older-checkout and CI results for the targeted runtime-written fixtures are recorded in `n1-fixround.md` and `validation.md`; fixtures assert continuation behavior rather than version-specific decoded event shapes.

## Decisions to confirm

1. Keep visible Working throughout an actual open turn, including between steps; no new elapsed-time stall heuristic. Watchdog/provider-supervisor facts remain authoritative.
2. Sign-in/configuration gets one Open settings recovery. Runtime failures retain existing Retry. Dismiss and Scroll to latest are view/navigation actions, not alternative recovery operations.
3. Unknown delivery is not non-delivery. Keep the recorded words and explanation; never automatically resend uncertain work. Positive consumption/turn proof outranks a later unreconciled receipt.
4. Delivery footers explain only non-delivered states with existing intent/receipt proof, not successful sends, interaction answers or unlabelled history. Text CLI reset instants are UTC; JSON keeps the epoch.
5. Raw steering mode is not in the durable `message.submit` intent. After the local hint is lost, peek honestly says Pending rather than inventing a target step. Host-owned queued steering has durable target state and the additive wait hint.

## Follow-ups / explicit limits

- Durable raw-steering provenance, a live executor-loss seam for agent reads, and a terminal-exit peek response need separate bounded tickets; do not infer them from tail order or missing observation. The audited terminal-without-observation response remains an explicit error, not silent output.
- Actual OS-process killing, external MCP subprocess faults and real account expiration were not reproduced locally. Scripted provider/port failures and persisted restart fixtures prove the semantics; deployment and N−1 binaries remain CI's responsibility.
- A historical rejected prompt is not an accepted failed model run. Its Not delivered receipt remains visible; a broader durable edit/resend workflow for every rejected attachment is outside this change. Existing queue edit/removal recovery remains unchanged.

## Validation

Focused package checks, protected-file 100% coverage, typechecks, protocol compatibility, host Electron-import boundary, and final visual evidence are recorded in `validation.md` and the adjacent audits. Final checks include 404 renderer/store tests, 198 CLI tests, 74 real-Pi/SQLite/socket host checks, 34 engine delivery-tail tests and 155 client tests; the directly covered protected files are all 100% on all four axes. No full local workspace suite, Electron, Docker, SSH, keychain/security command, real provider sign-in, or smoke matrix was run. The PR remains unmerged; exact-head CI gate, CodeQL and N−1 results are the final handoff gate.
