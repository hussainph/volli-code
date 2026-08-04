# OpenCode surface audit

What OpenCode can do that our Session UI cannot show or answer, and the order to close it in.

Measured against a live `opencode serve` (1.17.18) `/doc`: 188 endpoints, 89 `Event` variants, 12 `Part` variants, read alongside `/agent`, `/skill` and `/experimental/capabilities`. Every claim below is cited to a file and line rather than to the spec alone — the gap is usually not that OpenCode reports something we cannot see, but that we already model it and render nothing.

Status: audit complete, plan agreed. P0 step 3 (error classification) has landed; everything else is unimplemented. Companion to `chat-transcript-design.md`, which owns how the transcript *looks*; this owns what reaches it at all.

Line citations are as of `bc4603d`. They drift; the surrounding quote is the durable part, so search for that when a number no longer lands.

## Where the UI is

The chat surface lives only in `apps/desktop/src/renderer/lab/` — `renderer/src/components/sessions/` is still terminal-only. "Our UI" throughout means the `chat-session` scratch and the `lab/chat/` modules behind it.

## Scorecard

| Layer | Handled | Surface |
| --- | --- | --- |
| Events | 14 | ~30 relevant of 89 |
| Message parts | 3 | 12 |
| Interaction kinds rendered | 1 (permission, tool-correlated only) | 2 |
| Attention kinds actionable | 0 | 11 declared, 3 raised |
| Capability catalog kinds rendered | 2 (model, agent) | 6 fetched |

The adapter is consistently ahead of the renderer. Three of the four Tier 0 deadlocks below are fixed entirely in the UI against data that already arrives.

## Not gaps

Recorded so they are not re-filed:

- **`session.next.*` (28 events).** OpenCode's v2 granular stream — an alternative channel carrying the same facts as the `message.part.*` path the adapter uses. Adopting it is a transport decision, not a feature gap.
- **`tui.*` (4).** Remote control of OpenCode's own TUI.
- **`sync.*`, `workspace.*`, `worktree.*`, `global.*`, `server.*`, project-copy, console, integrations.** Cloud and multi-client features. Volli is local-first and single-player, and owns its own worktrees (CONCEPT #38–#43).

## Tier 0 — the agent stops and there is no way to answer

### 1. Questions are invisible

The adapter handles `question.asked` / `question.replied` / `question.rejected`, builds a `SessionInteraction` with flattened options, and can `POST /question/{id}/reply` (`index.ts:1062`, `1454`, `1592`). The only place that can *answer* an interaction is a tool row's approval gate, `chat-session.tsx:327` — and the adapter registers a row target for permissions only:

```ts
// index.ts:1479
const target = kind === "permission" ? this.#approvalTarget(raw) : null;
```

So a question reaches `projection.interactions.active` (`session-controller.ts:468`) and no answerable UI renders it. The `session-tracer` scratch does list `projection.interactions.active` (`session-tracer.tsx:689`), but as a read-only debug dump with no reply affordance — it proves the data arrives, which is the point. The turn cannot proceed until it is answered and the UI offers no way to answer; the only exit is Stop, which discards the turn. This is the single worst gap in the product and the cheapest to close.

The model is also lossy where it does arrive. `SessionInteraction.multiple` is hardcoded `true` for questions (`index.ts:1473`) while OpenCode declares `multiple` and `custom` *per question* (`QuestionInfo`), and `questionOptions` flattens every question's options into one list with index-encoded ids (`index.ts:1753`). A three-question request would render as one undifferentiated option pile with no free-text answer.

### 2. A permission with no tool call is equally invisible

`PermissionRequest.tool` is optional, and `approvalTarget` returns null without it:

```ts
// index.ts:2012
const tool = nested(raw, "tool");
const messageId = objectString(tool, "messageID");
const callId = objectString(tool, "callID");
return messageId && callId ? { messageId, callId } : null;
```

`doom_loop` and `external_directory` asks are configured by default, and MCP and startup permissions arrive the same way. No tool means no row, no row means no card, and `AttentionCard` takes a `DynamicToolUIPart` (`activity-ui.tsx:744`) — there is no shape available for an interaction that is not a tool.

Same deadlock, same fix: an interaction needs a home that does not depend on being correlated to a call.

### 3. No attention state is actionable

`projection.attention` carries `active` and `primary` (`session-ledger.ts:538`) and is plumbed to the renderer. `sessionBlocker` (`chat-session.tsx:477`) reads `session.error` — RPC and transport failures only — and `catalogState`; it never reads `attention`. The one reader anywhere is `session-tracer.tsx:682`, a debug list with no recovery action attached.

So an expired token, a rate limit or a context overflow produces a Session that stops with no explanation and no recovery action. That is exactly the case CLAUDE.md reserves for explicit user recovery.

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
- **Plan mode.** The composer's Build/Plan segment is built and correctly filters on declared `mode` / `hidden` (`isPrimaryAgent`, `session-model.ts:168`). Missing: which agent ran a past turn, and a plan→build handoff. The todo list does arrive — the adapter consumes `todo.updated` (`index.ts:1088`) but *synthesizes* a `todowrite` tool part from it (`index.ts:1327–1373`) rather than carrying it as its own observation, so a todo list can only ever look like a tool call.
- **Commands, skills, MCP, tools.** All are fetched into the capability catalog (`index.ts:400–406`). Agents and models render; commands, skills, MCP servers and tool ids do not. No slash-command palette and no skill invocation — 94 skills unreachable on this machine. `mcp.browser.open.failed` is unhandled, so a failed MCP OAuth is a silent dead end. (The app's own `runtime-catalog-settings.tsx` is models-only, but it sits outside the chat surface this audit scopes.)
- **Revert and checkpoints.** `/session/{id}/revert`, `/unrevert`, `Session.revert`, `patch` and `snapshot` parts — nothing. The artifact card's Undo in `chat-transcript-design.md` rests on this.
- **Compaction and context.** No `/summarize`, no manual compact, no context meter. `/session/{id}/context` is never called and `session.compacted` is ignored.
- **Diffs.** `session.diff` and `file.edited` ignored; `/session/{id}/diff` never called.
- **Session lifecycle.** No fork, share, rename, `session.deleteMessage` or `part.update` — the last being the substrate for the Conversation Branches CLAUDE.md commits to.
- **Turn header.** No model, cost or token display, though the adapter captures usage (`index.ts:1680`).
- **Background processes.** `session.shell` and OpenCode's `/pty` unused. Named as a rail section in `chat-transcript-design.md`, unbuilt.

## What is already built

A fair scorecard, so this reads as a backlog and not a verdict: per-kind tool presenters with diffs, numbered slices and match groups; the reasoning row; the flat bundle model; queue / steer / stop delivery; the model pill with variants; the agent segment; permission approve / deny / steer with a scrollback receipt; and the subagent-permission rerouting, which is subtle and correct. `ActivityKind` has landed in `@volli/shared`. The adapter's grasp of OpenCode substantially exceeds the UI's ability to display it.

## The shape change

One decision governs Tier 0. `SessionInteraction` is flat — one `title`, one `options` list, one `multiple` (`session-ledger.ts:90`) — and a permission and a multi-question request do not fit the same flat record.

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

`prompts?: readonly SessionInteractionPrompt[]` sits beside the existing fields; a reader falls back to `{options, multiple}` as a single prompt when it is absent. A permission is one prompt with three options, so one card component serves both kinds and the existing tool-row gate keeps working unchanged. Additive persistence, not a rewrite.

Option polarity stays where `session-model.ts:295` already put it — matched against declared ids, never assumed — and `custom` is the seam where free-text answers land when we render them.

## Sequence

**P0 — nothing can strand you.** The whole tier is Tier 0 and nothing else.

1. `SessionInteractionPrompt` in `@volli/shared` with a total, back-compatible read. Adapter fills `prompts` from `QuestionInfo[]`, carrying per-question `multiple` and `custom`; permission fills one prompt.
2. An interaction card in the transcript that does not require a tool row. Tool-correlated interactions keep rendering on their row; everything else renders at the foot of the transcript, above the composer, never behind a disclosure.
3. ~~Classify `session.error` into the right attention kind from the name the adapter already reads.~~ **Landed.**
4. `sessionBlocker` reads `projection.attention.primary` and offers one recovery action per kind: Settings for `auth_required`, Retry for `transport_retrying` and `rate_limited` (showing `retryAt` when the provider sent one), an honest message for `context_limit_reached` until compaction exists. Step 3 is what makes this possible — the kinds are now distinct, so the action can be.

**P1 — the transcript stops lying by omission.** `file` parts both directions, with composer attachment. Turn header: agent, model, cost, tokens. Keep `agent` / `mode` / `variant` in `OpenCodeMessageMetadata`. Subagent transcripts behind the `delegate` row, plus `agentName` and `childCount` on the descriptor. `todo.updated` as a first-class observation instead of a fake `todowrite` part.

**P2 — the rest of the surface.** Command and skill palette in the composer. Context meter and manual compact. Revert via `patch` / `snapshot`, which unlocks the artifact card's Undo. `session.diff` and `file.edited` into the artifact card. MCP auth recovery from `mcp.browser.open.failed`. Fork, rename, share. `part.update` for Conversation Branches.

## Left standing, on purpose

Found while reviewing this branch, judged out of scope for it and recorded so they are not rediscovered as news:

- **A failed stream snapshot is unrecorded.** `#emitStreamSnapshot` is fired from a debounced timer under `.catch(() => undefined)`. The catch is deliberate and tested — a failing sink must not escape the timer as an unhandled rejection — but nothing anywhere records that the transcript stopped catching up. It needs a diagnostic, not a rethrow.
- ~~**`reportError` in `session-controller.ts` is `console.error` alone.** The diagnostics query and subscription fail invisibly.~~ **Fixed.** `reportError` (`session-controller.ts:790`) is still `console.error`, but it is a logging helper and both call sites now pair it with an on-screen state setter — `:220` with `setDiagnosticsError`, `:366` with `setCatalogState("error")` and `setCatalogError`. The comment at `:212-217` records why the diagnostics path surfaces without outranking the harness's own attention. Not a silent swallow. The one that remains is `activity-ui.tsx:507`, a bare `void navigator.clipboard.writeText(...)`.
- **`ai-elements/code-block.tsx` has no consumer.** 522 vendored lines and a Shiki pipeline, staged for the app port along with the rest of `ai-elements/` and not yet wired to anything. Intentional staging, not drift — but nothing exercises it, so it will rot quietly until something imports it.

## Coverage

`packages/shared`, `session-engine`, `session-rpc` and `opencode-adapter` hold 100% thresholds on `src/**`, and the adapter's part-mapping tests are exact-object assertions — P0 touches `SessionInteraction`, so expect the interaction tests and the ledger projection tests to move together. `apps/desktop/src/renderer/lab/**` is not in the protected list, so the card itself is ungated. Thresholds only evaluate under `--coverage`: run `vp run -r test:coverage` before pushing, since a green `vp run -r test` says nothing about it.
