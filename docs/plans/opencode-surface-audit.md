# OpenCode surface audit

> **Historical evidence as of 2026-08-08.** Do not implement the remaining
> parity plan. Structured OpenCode execution is frozen pending replacement and
> removal by [`pi-native-ticket-session.md`](pi-native-ticket-session.md).

What OpenCode can do that our Session UI cannot show or answer, and the order to close it in.

Measured against a live `opencode serve` (1.17.18) `/doc`: 188 endpoints, 89 `Event` variants, 12 `Part` variants, read alongside `/agent`, `/skill` and `/experimental/capabilities`. Every claim below is cited to a file and line rather than to the spec alone — the gap is usually not that OpenCode reports something we cannot see, but that we already model it and render nothing.

Status: audit complete, plan agreed, **P0 landed in full** — all four steps, on `main`. P1 and P2 are unimplemented. Companion to `chat-transcript-design.md`, which owns how the transcript *looks*; this owns what reaches it at all.

Line citations were taken at `bc4603d` and re-derived in the sections revised for the landed P0. They drift; the surrounding quote is the durable part, so search for that when a number no longer lands.

## Where the UI is

The chat surface lives only in `apps/desktop/src/renderer/lab/` — `renderer/src/components/sessions/` is still terminal-only. "Our UI" throughout means the `chat-session` scratch and the `lab/chat/` modules behind it.

## Scorecard

| Layer | Handled | Surface |
| --- | --- | --- |
| Events | 14 | ~30 relevant of 89 |
| Message parts | 3 | 12 |
| Interaction kinds rendered | 2 | 2 |
| Attention kinds answered | 11 (5 with a recovery action) | 11 declared, 3 raised |
| Capability catalog kinds rendered | 2 (model, agent) | 6 fetched |

The adapter is consistently ahead of the renderer, and the two interaction rows are where it stopped being: three of the four Tier 0 deadlocks were fixed entirely in the UI against data that already arrived. The rows still short are Tier 1 and Tier 2.

## Not gaps

Recorded so they are not re-filed:

- **`session.next.*` (28 events).** OpenCode's v2 granular stream — an alternative channel carrying the same facts as the `message.part.*` path the adapter uses. Adopting it is a transport decision, not a feature gap.
- **`tui.*` (4).** Remote control of OpenCode's own TUI.
- **`sync.*`, `workspace.*`, `worktree.*`, `global.*`, `server.*`, project-copy, console, integrations.** Cloud and multi-client features. Volli is local-first and single-player, and owns its own worktrees (CONCEPT #38–#43).

## Tier 0 — the agent stops and there is no way to answer

### 1. ~~Questions are invisible~~ — landed

The adapter handled `question.asked` / `question.replied` / `question.rejected`, built a `SessionInteraction` with flattened options, and could `POST /question/{id}/reply`. The only place that could *answer* an interaction was a tool row's approval gate — and the adapter registers a row target for permissions only, which it still does and should:

```ts
// index.ts:1599
const target = kind === "permission" ? this.#approvalTarget(raw) : null;
```

So a question reached `projection.interactions.active` and no answerable UI rendered it. The `session-tracer` scratch listed it (`session-tracer.tsx:689`) as a read-only debug dump with no reply affordance — which proved the data arrived, and that was the point. The turn could not proceed until it was answered, the UI offered no way to answer, and the only exit was Stop, which discards the turn. This was the single worst gap in the product and the cheapest to close.

**Both halves of it landed.** `footInteraction` (`interaction.ts:580-590`) returns the first open interaction no tool row is gating, and `ChatPlane` mounts an `InteractionCard` for it in the composer's own slot (`chat-session.tsx:383-385`, `:559`) — so a question has a home whether or not it correlates to a call.

The model is no longer lossy either. `questionPrompts` (`index.ts:1965`) writes one `SessionInteractionPrompt` per `QuestionInfo`, carrying that question's own `multiple` and `custom` (`index.ts:1922-1923`), and the card draws a radio or a checkbox per prompt (`interaction-ui.tsx:428`) plus a free-text field where `custom` is declared (`:398`, `:475`). The flat `options` and `multiple` stay beside `prompts` as the union a reader written before them falls back to (`index.ts:1586-1593`), which is the back-compatible read the shape change below asked for.

### 2. ~~A permission with no tool call is equally invisible~~ — landed

`PermissionRequest.tool` is optional, and `approvalTarget` still returns null without it, correctly:

```ts
// index.ts:2309
const tool = nested(raw, "tool");
const messageId = objectString(tool, "messageID");
const callId = objectString(tool, "callID");
return messageId && callId ? { messageId, callId } : null;
```

`doom_loop` and `external_directory` asks are configured by default, and MCP and startup permissions arrive the same way. No tool meant no row, no row meant no card, and every card shape available took a `DynamicToolUIPart` — there was no shape for an interaction that is not a tool.

Same deadlock, same fix, and the fix is the one above: `footInteraction` selects on whether a row is gating the interaction, not on whether it has a tool, so a tool-less permission falls to the foot card by the same rule a question does. What still keys off a call is only the *placement* — `interactionForApproval` (`chat-session.tsx:1189`) puts a correlated permission back on its own row, which is where it reads best.

### 3. ~~No attention state is actionable~~ — landed

`projection.attention` carries `active` and `primary` (`session-ledger.ts:697-700`) and is plumbed to the renderer. `sessionBlocker` read `session.error` — RPC and transport failures only — and `catalogState`; it never read `attention`. The one reader anywhere was `session-tracer.tsx:682`, a debug list with no recovery action attached.

So an expired token, a rate limit or a context overflow produced a Session that stopped with no explanation and no recovery action. That is exactly the case CLAUDE.md reserves for explicit user recovery.

**It reads attention now.** `sessionBlocker` (`chat-session.tsx:747`) takes `attention` among its inputs and hands `attention.primary` to `attentionBlocker` (`:838`), a switch total over all eleven kinds with no `default`, so a kind added later is a build error rather than a silent absorption. Five earn an action — Settings for `auth_required` and `configuration_invalid`, Retry for `transport_retrying`, `adapter_disconnected` and `rate_limited`, the last showing the provider's own time only when it sent one. The other six state the fact and offer nothing, deliberately: `input_required` and `permission_required` suppress the row outright while a card is standing (`answeredByCard`, `:802`), rather than saying twice what the card already asks, and the rest have no local recovery to offer.

**And the classification was wrong upstream — fixed.** `session.error` mapped every OpenCode error to `adapter_unrecoverable`, while `safeOpenCodeError` already read the discriminating name and put it in `diagnostic.name` one line away. The information needed to say `auth_required` or `context_limit_reached` was extracted and then discarded, so rendering attention first would have shown a correct card carrying the wrong verdict and the wrong recovery action.

`openCodeAttentionKind` now classifies by the name OpenCode states:

| OpenCode error | Attention kind |
| --- | --- |
| `ProviderAuthError` | `auth_required` |
| `ContextOverflowError` | `context_limit_reached` |
| `MessageAbortedError` | `partial_turn_interrupted` |
| `APIError` | `rate_limited` at 429; else `adapter_unrecoverable` |
| `MessageOutputLengthError`, `StructuredOutputError`, `ContentFilterError`, `UnknownError` | `adapter_unrecoverable` |

A name the redaction list does not recognize reads as absent, so a member OpenCode adds later classifies by the same rule an empty error does rather than by an unreviewed string.

**Only the name is read, and 429 is the single exception.** It is one because the union has no rate-limit member at all, so the status is the sole signal and its HTTP meaning is not open to interpretation. Auth is deliberately *not* an exception: OpenCode already names auth failures `ProviderAuthError`, so reading `auth_required` out of a 401 on a generic `APIError` would second-guess a classification it declined to make — and a 403 is worse, since entitlement, region and policy blocks all arrive as one and re-authenticating fixes none of them.

`retryAt` is read from the `Retry-After` header on a 429, in both RFC 9110 forms. `responseHeaders` carries `authorization` among other things, so exactly one header is extracted and it leaves as a number; the bag itself never reaches a diagnostic. An unreadable or absent header means no time rather than a guessed one.

What stays unraised is load-bearing. `quota_exhausted` has no member stating it, and a 429 cannot say whether a limit is per-minute or spent for the month. `configuration_invalid` is a launch fact the probe establishes, not a turn's outcome. `input_required` and `permission_required` are not adapter-raisable at all. Capability is negative-friendly; an unraised kind is honest.

## Tier 1 — nine of twelve part types are dropped

`index.ts:2053` is `if (type !== "tool") return [];`. `text`, `reasoning` and `tool` are handled; the other nine are discarded before the renderer exists:

| Part | What is lost |
| --- | --- |
| `file` | Attachments and images, **both directions** — `#dispatchMessage` sends `parts: textParts(...)` (`index.ts:610`), and `textParts` keeps only `type === "text"` (`index.ts:1629`), so nothing can be attached either |
| `agent` | `@agent` mentions in a prompt |
| `subtask` | Explicit subagent launch from the composer |
| `patch`, `snapshot` | Checkpoints — the whole revert substrate |
| `step-start`, `step-finish` | Per-step cost and tokens |
| `retry` | Attempt number and the error being retried |
| `compaction` | Auto vs. manual, and overflow |

`#bufferMessage` additionally drops `AssistantMessage.agent`, `mode`, `variant` and `finish` (`OpenCodeMessageMetadata`, `index.ts:481`), so a transcript cannot say which agent ran a past turn — which is what makes Plan mode invisible in scrollback.

## Tier 2 — areas with no surface

- **Subagents.** `#ownsStreamEvent` admits only `INTERACTION_EVENT_TYPES` from a child session (`index.ts:849`), so a child transcript is never imported. A `delegate` row is a spinner and a duration; what the subagent did is unreadable. `subject.agentName` and `outcome.childCount` do not exist in `ActivityDescriptor`.
- **Plan mode.** The composer's Build/Plan segment is built and correctly filters on declared `mode` / `hidden` (`isPrimaryAgent`, `session-model.ts:168`). Missing: which agent ran a past turn, and a plan→build handoff. The todo list does arrive — the adapter consumes `todo.updated` (`index.ts:1204`) but *synthesizes* a `todowrite` tool part from it (`index.ts:1456–1478`) rather than carrying it as its own observation. The UI reads those parts back out and draws a real dock from them (`SessionTodoDock`, `activity-ui.tsx:890`), so a todo list no longer *looks* like a tool call — but it still travels as one, which is what P1's first-class observation retires.
- **Commands, skills, MCP, tools.** All are fetched into the capability catalog (`index.ts:400–406`). Agents and models render; commands, skills, MCP servers and tool ids do not. No slash-command palette and no skill invocation — 94 skills unreachable on this machine. `mcp.browser.open.failed` is unhandled, so a failed MCP OAuth is a silent dead end. (The app's own `runtime-catalog-settings.tsx` is models-only, but it sits outside the chat surface this audit scopes.)
- **Revert and checkpoints.** `/session/{id}/revert`, `/unrevert`, `Session.revert`, `patch` and `snapshot` parts — nothing. The artifact card's Undo in `chat-transcript-design.md` rests on this.
- **Compaction and context.** No `/summarize`, no manual compact, no context meter. `/session/{id}/context` is never called and `session.compacted` is ignored.
- **Diffs.** `session.diff` and `file.edited` ignored; `/session/{id}/diff` never called.
- **Session lifecycle.** No fork, share, rename, `session.deleteMessage` or `part.update` — the last being the substrate for the Conversation Branches CLAUDE.md commits to.
- **Turn header.** No model, cost or token display, though the adapter captures usage (`index.ts:1680`).
- **Background processes.** `session.shell` and OpenCode's `/pty` unused. Named as a rail section in `chat-transcript-design.md`, unbuilt.

## What is already built

A fair scorecard, so this reads as a backlog and not a verdict: per-kind tool presenters with diffs, numbered slices and match groups; the reasoning row; the flat bundle model; queue / steer / stop delivery; the model pill with variants; the agent segment; permission approve / deny / steer with a scrollback receipt; and the subagent-permission rerouting, which is subtle and correct. `ActivityKind` has landed in `@volli/shared`. So has the whole of P0: per-question prompts, the foot interaction card with free text and per-prompt answer rules, classified attention, and one blocker row with at most one action. The adapter's grasp of OpenCode still exceeds the UI's ability to display it, but no longer in a way that can strand a turn.

## The shape change — shipped as written

One decision governed Tier 0. `SessionInteraction` was flat — one `title`, one `options` list, one `multiple` (`session-ledger.ts:141-148`) — and a permission and a multi-question request do not fit the same flat record.

**Add `prompts`, do not reshape `options`.** `SessionInteraction` is persisted inside `interaction.opened` in the durable event log, so a stored interaction must keep projecting:

```ts
export interface SessionInteractionPrompt {
  id: string;
  label: string;
  detail: string | null;
  options: readonly SessionInteractionOption[];
  multiple: boolean;
  /** The harness accepts a free-text answer beside the declared options. */
  custom: boolean;
}
```

`prompts?: readonly SessionInteractionPrompt[]` sits beside the existing fields (`session-ledger.ts:154`); a reader falls back to `{options, multiple}` as a single prompt when it is absent. A permission is one prompt with three options, so one card component serves both kinds and the existing tool-row gate keeps working unchanged. Additive persistence, not a rewrite.

It landed field for field, with the fallback made total rather than left to each caller: `readInteractionPrompts` (`:198`) and `readInteractionAnswers` (`:226`) are the only sanctioned readers, and both distinguish an absent list from a declared empty one — absent means "written before an interaction could carry questions", empty means "this one asks none", and collapsing the second into the first would read downstream as a refusal nobody gave. Option polarity stays where `session-model.ts` already put it — matched against declared ids, never assumed — and `custom` turned out to be exactly the seam the free-text field needed.

## Sequence

**P0 — nothing can strand you.** The whole tier is Tier 0 and nothing else. **All four landed**; the wording is kept because it is the record of what was asked for, and each step went in substantially as written.

1. ~~`SessionInteractionPrompt` in `@volli/shared` with a total, back-compatible read. Adapter fills `prompts` from `QuestionInfo[]`, carrying per-question `multiple` and `custom`; permission fills one prompt.~~ **Landed.**
2. ~~An interaction card in the transcript that does not require a tool row. Tool-correlated interactions keep rendering on their row; everything else renders at the foot of the transcript, above the composer, never behind a disclosure.~~ **Landed.**
3. ~~Classify `session.error` into the right attention kind from the name the adapter already reads.~~ **Landed.**
4. ~~`sessionBlocker` reads `projection.attention.primary` and offers one recovery action per kind: Settings for `auth_required`, Retry for `transport_retrying` and `rate_limited` (showing `retryAt` when the provider sent one), an honest message for `context_limit_reached` until compaction exists. Step 3 is what makes this possible — the kinds are now distinct, so the action can be.~~ **Landed**, and wider than specified: the switch is total over all eleven kinds, `configuration_invalid` and `adapter_disconnected` earned actions too, and the two an interaction card already answers suppress the row rather than duplicating it.

**P1 — the transcript stops lying by omission.** `file` parts both directions, with composer attachment. Turn header: agent, model, cost, tokens. Keep `agent` / `mode` / `variant` in `OpenCodeMessageMetadata`. Subagent transcripts behind the `delegate` row, plus `agentName` and `childCount` on the descriptor. `todo.updated` as a first-class observation instead of a fake `todowrite` part.

**P2 — the rest of the surface.** Command and skill palette in the composer. Context meter and manual compact. Revert via `patch` / `snapshot`, which unlocks the artifact card's Undo. `session.diff` and `file.edited` into the artifact card. MCP auth recovery from `mcp.browser.open.failed`. Fork, rename, share. `part.update` for Conversation Branches.

## Left standing, on purpose

Found while reviewing this branch, judged out of scope for it and recorded so they are not rediscovered as news:

- **A failed stream snapshot is unrecorded.** `#emitStreamSnapshot` is fired from a debounced timer under `.catch(() => undefined)`. The catch is deliberate and tested — a failing sink must not escape the timer as an unhandled rejection — but nothing anywhere records that the transcript stopped catching up. It needs a diagnostic, not a rethrow.
- ~~**`reportError` in `session-controller.ts` is `console.error` alone.** The diagnostics query and subscription fail invisibly.~~ **Fixed.** `reportError` (`session-controller.ts:836`) is still `console.error`, but it is a logging helper and both call sites now pair it with an on-screen state setter — `:274` with `setDiagnosticsError`, `:420` with `setCatalogState("error")` and `setCatalogError`. The comment at `:265-271` records why the diagnostics path surfaces without outranking the harness's own attention. Not a silent swallow. ~~The one that remains is `activity-ui.tsx:507`, a bare `void navigator.clipboard.writeText(...)`.~~ **That one is fixed too.** The write goes through `copyActivityObject` (`activity-ui.tsx:507-518`), which returns `"copied"` or `"failed"` rather than leaving its caller to read a rejected promise as success, and the button wears that verdict for `COPY_FEEDBACK_MS` before going back to offering (`:496`, `:529-534`).
- **`ai-elements/code-block.tsx` has no consumer.** 522 vendored lines and a Shiki pipeline, staged for the app port along with the rest of `ai-elements/` and not yet wired to anything. Intentional staging, not drift — but nothing exercises it, so it will rot quietly until something imports it.

## Coverage

`packages/shared`, `session-engine`, `session-rpc` and `opencode-adapter` hold 100% thresholds on `src/**`, and the adapter's part-mapping tests are exact-object assertions — P0 touched `SessionInteraction`, and the interaction tests and the ledger projection tests moved together as expected. `apps/desktop/src/renderer/lab/**` is not in the protected list, so the card itself is ungated. Thresholds only evaluate under `--coverage`: run `vp run -r test:coverage` before pushing, since a green `vp run -r test` says nothing about it.
