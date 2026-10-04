# VC-30 — Session peek in both sidebars: production implementation plan

Status: plan only. No production code written by this document's author.
Source of truth for the design: `apps/desktop/src/renderer/lab/session-peek/README.md`,
`scratches/session-peek-sidebars.tsx`, `scratches/session-peek-wireframe*`, and the
owner decisions restated in §1.2 below. Where this plan and the lab disagree, this
plan is the production reading and says why.

> **Paths moved (VC-553).** `apps/desktop/src/main/db/` is now `packages/host-core/src/db/` (`@volli/host-core/db/*`), and its coverage entries moved to `packages/host-core/vite.config.ts`. The paths below are as of this document's writing.

---

## 0. Production map (what these features touch today)

### 0.1 Left sidebar — Active / Previous bands

| Concern | File · symbol |
| --- | --- |
| Band membership, order, grouping, boundary clock | `apps/desktop/src/renderer/src/components/sidebar/active-session-listing.ts` · `buildActiveSessionListing`, `BuildActiveSessionListingInput`, `ActiveSessionRow`, `PreviousSessionRow`, `PreviousListingEntry`, `groupPreviousByTicket`, `activeGroup` (private), `ACTIVE_QUIET_WINDOW_MS`, `isConcludedBusiness`, `sessionRowRoute`, `SessionRowRoute`, `isProjectSessionRowSelected`, `listingSessionIds`, `listingOutputStamps` |
| Fetching, clocks, navigation, selection | `components/sidebar/active-sessions.tsx` · `ActiveSessions`, `activate`, `isSelected`, `toggleGroup`, `selectedGroupId`, `listingNow`/`ageNow` boundary effects, `provisionalRows` (Chat Drafts) |
| Rows | `components/sidebar/session-band-row.tsx` · `ActiveBandRow`, `PreviousBandRow`, `TicketGroupRow`, `SessionBandRowSkeleton`, `sessionGroupPanelId`, `RowIdentity`, `KindGlyph`, `CompanionGlyph`, `stateLine`, `placeLine`, `attentionLine`, `rowTitleAttribute`, `sessionRowDragPayload` |
| Band header / filter | `components/sidebar/session-band-header.tsx` · `SessionBandHeader`, `SessionBandFilterMenu`; `components/sidebar/session-band-filter.ts` · `sessionListingFilter`, `DEFAULT_SESSION_BAND_FILTER` |
| Mount | `components/sidebar/primary-sidebar.tsx:84` · `<ActiveSessions project={selected} visible={sessionsVisible} />` |
| Row data | `stores/project-sessions.ts` · `useProjectSessionsStore`, `ProjectSessionRows` (`.terminal`, `.chat`, `.provenance`), `listingState`, `refresh`, `applyActivity`, `subscribeProjectSessionActivity`; `stores/sessions.ts` (terminal containers, `lastOutputAt`, `parkState`, `harness`); `stores/chat-sessions.ts` (resident titles, `openTabs`); `stores/chat-drafts.ts` (provisional Drafts); `stores/board.ts` (tickets); `stores/workspace.ts` (nav, `openTicketId`, `ticketTabs`, `homeActiveTab`, `expandedSessionGroups`) |
| Opening a row | `activate(row)` in `active-sessions.tsx` → `sessionRowRoute(row)` → `useUiStore.openSessionDetail` \| `openTicketSession` \| `adoptChatSession`+`openChatTab`+`openTicketWorkspace` \| `openHome` |

### 0.2 In-ticket right rail — Sessions fold

| Concern | File · symbol |
| --- | --- |
| The block | `components/ticket/ticket-sessions-panel.tsx` · `TicketSessionsPanel`, `SessionList`, `SessionRow`, `RowStatus`, `SessionListSkeleton`, `sessionStatusLabel` |
| Fold chrome | `components/ticket/rail-panel-parts.tsx` · `RailFold`, `RailFoldHeadingRow`, `RailFoldBody`, `RailFoldTrigger`, `RailHeadingReadStatus`, `RailReadFaultBody`, `RAIL_PANEL_INSET` |
| Row model / ordering | `components/ticket/session-history.ts` · `SessionRailRow`, `buildTicketSessionRows`, `buildTicketChatSessionRows`, `groupSessionRows`, `mergeSessionRailRows`, `orderSessionRailRowsByAttention`, `sessionRailRowDotState`, `sessionRailRowStampAt`, `sessionRailRowActivityAt`, `nextSessionRailAgeChangeAt`, `nextTicketSessionStatusChangeAt`, `filterSessionHistory`, `filterChatSessionHistory`, `SESSION_ROSTER_FILTER_THRESHOLD`, `ticketOutputStamps`, `ticketSessionProvenance` |
| Row data | `stores/ticket-session-records.ts` · `useTicketSessionRecordsStore` (`byTicket`, `ensure`, `refresh`, `renameLocally`), `ticketSessionListingStateOf`; `stores/sessions.ts`; `stores/ui.ts` (`railFolds.sessionsRecord`) |
| Opening a row | `onActivateChat(sessionId)` / `onActivateSession(tabId)` + `setActivePane`, and `useUiStore.getState().openSessionDetail(projectId, record.id)` for a closed terminal record |

### 0.3 Activity, state and marks

- Activity → dot state and words: `components/ui/session-activity-status.ts` · `sessionActivityDotState`, `sessionActivityIsLive`, `sessionAttentionRank`, `SESSION_ACTIVITY_LABEL`.
- Dot: `components/ui/status-dot.tsx` · `StatusDot`, `StatusDotState`, `STATUS_DOT_TONE` (the only status→colour map; #568's `ink` column was never merged, so production has **no** `ink` field today — the lab's `STATUS_INK` copy in `row-mark.tsx` has no upstream to read from and must not be ported).
- Vendor logos: `components/models/model-identity.tsx` · `providerMark(providerId): Mark | null`, `ModelMark({model, providerLabel, by})`, `markFor`, `modelFamily`, `PROVIDER_MARK`/`FAMILY_MARK`, `MarkBy`. `Mark = { viewBox, paths }`; a miss falls back to a lettermark.
- Harness (terminal companion) glyphs: `session-band-row.tsx` · `HARNESS_GLYPHS`, `harnessGlyphOf` (Phosphor mnemonics, deliberately *not* vendor logos).
- Which model a chat runs: `ChatSessionRecord.model: ModelSelection | null` (`packages/shared/src/session.ts`) — this is the provider id the peek mark needs. `ModelSelection` carries `providerId`/`modelId`/`label`.
- Provenance mark: `components/sessions/session-provenance-mark.tsx` · `SessionProvenanceMark`; hover line `sessionProvenanceHoverLine` (`@volli/shared`).
- Row primitive: `components/ui/list-row.tsx` · `ListRow` (`density: "row" | "two-line"`, 52px, `leading`/`primary`/`primaryTrailing`/`secondary`/`trailing`/`actions`/`onActivate`/`selected`), `ListRowSkeleton`, `LoadingBarWidth`.
- Context menu: `components/ui/context-menu.tsx` · `ContextMenu`, `ContextMenuTrigger asChild`, `ContextMenuContent`, `ContextMenuItem({icon})` (Phosphor icon per item — AGENTS.md).

### 0.4 "In front" in production

Already solved and already main-side:

- `renderer/src/lib/notification-target.ts` · `activeNotificationTarget(reading: ActiveTargetReading): NotificationTarget | null` — chat tab in front ⇒ `{kind:"session", sessionId, …}`, terminal in front ⇒ its **active pane**, anything else ⇒ the ticket or nothing.
- `renderer/src/hooks/use-notification-target.ts` pushes it on every change via `window.api.notifications.setActiveTarget` → `volli:notification-active-target`.
- `main/notifications/active-targets.ts` · `createActiveTargetRegistry`, `ActiveTargetRegistry.focusedTargets()` — targets of **focused, live** windows. Held by `main/notifications/runtime.ts` (`createNotificationRuntime`), currently private to the dispatcher.

This is the production answer to "not in front", including window focus, which the renderer cannot answer honestly (its own module comment says so). The unread rule therefore reads `focusedTargets()` in main.

### 0.5 Turn lifecycle reaching the renderer

- Ledger facts: `packages/shared/src/session-ledger.ts` · `SessionEventPayload` — `turn.started`, `turn.completed`, `turn.interrupted`, `interaction.opened/resolved/cancelled`, `attention.raised/cleared`, `usage.recorded`. Fold: `SessionProjection` with `turnActive`, `lastTurnOutcome`, `lastActivityAt`, `interactions`, `attention`; predicates `sessionAwaitsUser`, `sessionEndedInterrupted`, `sessionInterruptionReason`.
- Per-Session stream: `packages/session-rpc/src/index.ts` (`session.subscribe`, `interaction.resolve`, `message.submit`) over `volli:session-rpc` / `volli:session-rpc-event`; renderer link `lib/session-rpc-ipc-link.ts`; resident client `@volli/session-presentation` `client.ts` (`getChatClient`), bound by `renderer/src/chat/use-session-controller.ts` (`SessionController.submit`, `.resolveInteraction`, `.cancelInteraction`, `.interrupt`, `.enqueue`/`.dequeue`).
- Per-Project push (no subscription needed): `packages/host-core/src/session-control/activity-watch.ts` · `watchSessionActivity` decorates the `SessionEngine`, re-folds dirty Sessions on a 60 ms trailing timer, builds `sessionListingRow(...)` and publishes only when the row differs. Ports: `publish`, `provenanceOf`, `listOpenNativeBindings`, **`observe(projection)`** (pre-gate, per fold — the hook `automations/run-attention.ts` and `scheduled-resume` already use), `observeBirth`, `onError`. Wired in `main/index.ts:~923`. Renderer side: `volli:session-activity` → `stores/project-sessions.ts` `applyActivity` and `stores/ticket-session-records.ts`.
- Row builders: `packages/host-core/src/session-control/listing-row.ts` · `sessionListingRow`/`sessionListingRows`; `packages/host-core/src/session-control/listing-roster.ts` · `sessionListingRowsForRoster` (batch provenance + rows); `packages/host-core/src/session-control/chat-attachment.ts` · `chatSessionRecord`, `chatActivity`, `chatWaitingOn`; `terminal-attachment.ts` · `terminalSessionRecord`.
- IPC: `volli:session-list`, `volli:session-list-for-ticket` (`main/data-ipc.ts:1233,1244`), contract in `apps/desktop/src/ipc/contract.ts` (`SessionsResult`, `SessionActivityNotice`), preload `apps/desktop/src/preload/index.ts` `sessions.*`.

### 0.6 Ask User questions and answering them

- Model: `SessionInteraction { id, attachmentId, kind: "permission"|"question", title, detail, options, multiple, prompts?, native }`, `SessionInteractionPrompt`, `SessionInteractionOption`, `SessionInteractionResolution { optionIds, response, answers? }`, `SessionInteractionCancelReason` — `packages/shared/src/session-ledger.ts`. Renderer-safe form `RendererSessionInteraction` + `scrubSessionInteraction` in `packages/shared/src/session-event-codec.ts`. **Question identity is `SessionInteraction.id`**; the runtime correlation lives in `native`, which the renderer never sees.
- Pending set: `SessionProjection.interactions.active` (and `.resolved`), projected to the renderer on the session stream as `RendererSessionInteractionProjection`.
- Answer path: `SessionController.resolveInteraction(interactionId, resolution)` → resident client → `sessionRpc.request({command:{kind:"interaction.resolve", interactionId, resolution}})`. Cancel: `cancelInteraction(interactionId)` (reason fixed `abandoned`).
- Answer **UI** already exists and is reusable: `components/chat/interaction-ui.tsx` · `InteractionCard({interaction, onResolve, onWithdraw?, resolving?})` (chooses `QuestionCard` vs `DecisionCard`), plus `@volli/session-presentation` `interaction.ts` (`InteractionDraft`, `promptDraft`, `selectOption`, `setPromptResponse`, `isPromptAnswered`, `canSubmitInteraction`, `interactionSubmission`, `interactionResolution`, `createSubmissionLatch`, `SEND_ANSWER_LABEL`). The lab card re-implemented this; production must not.
- Sending a message: `SessionController.submit(message: QueuedMessage, delivery: ChatMessageDelivery)` (`"queue" | "steer" | "replace"`), or `enqueue` for the resident queue. `isDeliverable(slice)` says whether a message could leave now.
- **Undo: none exists.** The only retraction primitives are `dequeue(id)` on a *queued* (not yet released) message and `interrupt()` on a live turn. `chat/rename.ts` rolls back an optimistic rename; the editor's undo is Monaco's. Nothing retracts a delivered message or a resolved interaction.

### 0.7 Summary text available today

- `#610`'s chat overlay `components/chat/session-peek-dialog.tsx` is **chrome only** (title, state word, metadata, Open-as-tab, Escape isolation, return focus). Its one production host `components/chat/subagent-peek-dialog.tsx` adopts the child (`adoptChatSession`) and mounts the real `ChatPlane` — i.e. it shows the **live transcript**, not a summary. There is no production summary string anywhere.
- The honest, already-built source is the engine's tail fold used by the CLI: `packages/session-engine/src/transcript-tail.ts` · `readSessionTranscriptTail(ports, {sessionId, limit}) → SessionTranscriptTail { entries[{at, role, text, tools}], messages, unreadable, turns, turnDepth }`, `TRANSCRIPT_TAIL_TEXT_LIMIT = 120`; and `session-answer.ts` · `readSessionAnswer` (the full final message). Used by `packages/host-core/src/agent-dispatch/session-verbs.ts` · `sessionPeekVerb` (`volli session peek`), `sessionAnswerVerb`. **No IPC door exposes either to the renderer today** — that is the gap §3.1 closes.
- Auto-title (`@volli/shared` `auto-title.ts`, VC-81) already names the row; it is not a summary.

### 0.8 Durable state, and where a read receipt belongs

- SQLite owned by main: `apps/desktop/src/main/db/` — `migrations.ts` (`MIGRATIONS`, latest **version 51**, `migrate()`), repos beside it (`session-provenance-repo.ts`, `signals-repo.ts`, `scheduled-resume-repo.ts`, `app-state-repo.ts`, …). Session tables: `sessions`, `session_attachments`, `session_commands`, `session_events`, `session_command_receipts`, `session_projection_checkpoints`.
- The established shape for "a per-Session fact the ledger does not own" is **`session-provenance-repo.ts`**: a repo that answers a batch (`readSessionProvenances`) and a single (`readSessionProvenance`), joined into rows by `listing-roster.ts` (fetch) and `activity-watch.ts` (push), with the row type carrying the answer (`SessionListingRow.provenance`) and a sparse-miss resting value (`PERSON_STARTED`, `sessionProvenanceOf`). **Read state follows that shape exactly.**
- Rejected alternative: a `session.read` ledger command/fact. Reads are not work (the lab's own module comment says so), a receipt would churn `session_events`, force `session-event-codec.ts` + checkpoint-compatibility changes, and move `lastActivityAt`. A receipt table is the cheaper honest record and is fully rebuildable-by-hand (its loss costs one wrong dot).

### 0.9 Coverage gate

- `apps/desktop/vite.config.ts` → `test.coverage.include` (thresholds **100 % statements/branches/functions/lines, global**). Already listed and therefore already protected: `src/stores/**`, `src/components/sidebar/active-session-listing.ts`, `src/components/sidebar/session-band-filter.ts`, `src/components/sidebar/listing.ts`, `src/components/ticket/session-history.ts`, `src/lib/relative-time.ts`, `**/packages/host-core/src/session-control/activity-watch.ts`, `**/packages/host-core/src/session-control/sessions.ts`, and a named (not wildcard) set of `src/main/db/*` modules — `spawn-ledger-repo.ts`, `export.ts`, `theme-repo.ts`. Note what is **not** listed: `src/main/data-ipc.ts`, `src/main/db/migrations.ts` and `src/main/db/session-provenance-repo.ts` are outside the report, so S2's handler and migration edits are gated by tests rather than by coverage — they still need `data-ipc.test.ts` / `migrations.test.ts` cases, which is why S2 names them.
- `packages/shared/vite.config.ts` → `include: ["src/**"]` at 100 %. Every new pure rule placed in `@volli/shared` is covered by construction and must ship with its test.
- `.tsx`, hooks and `ui/**` are deliberately outside the report. Pure `.ts` extracted beside a view is the repo's idiom for getting a rule into the gate (`tab-focus.ts`, `tab-scroll.ts`, `drag-picker-model.ts`). **Every new module this plan adds to a covered glob must be at 100 %; every new pure module belongs in a covered glob.**

### 0.10 Existing tests near each surface

`components/sidebar/active-session-listing.test.ts`, `active-sessions.test.tsx`, `session-band-row.test.tsx`, `session-band-filter.test.ts`, `listing.test.ts`, `nav-list.test.tsx` ·
`components/ticket/ticket-sessions-panel-rows.test.tsx`, `-actions.test.tsx`, `-push.test.tsx`, `session-history.test.ts`, `rail-fold.test.tsx` ·
`components/ui/list-row.test.tsx`, `status-dot.test.tsx`, `session-activity-status.test.ts`, `context-menu.test.tsx` ·
`components/chat/interaction-ui.{test,behavior.test,layout.test}.tsx`, `subagent-peek-dialog.test.tsx` ·
`lib/relative-time.test.ts` · `stores/project-sessions.test.ts`, `ticket-session-records.test.ts`, `chat-sessions.test.ts` ·
`packages/host-core/src/session-control/{activity-watch,chat-attachment,listing…}.test.ts`, `main/db/migrations.test.ts`, `main/data-ipc.test.ts` ·
`packages/shared/src/session-ledger.test.ts`, `session.test.ts` ·
lab: `scratches/session-peek-sidebars.test.tsx`, `session-peek/{sidebar-live,sidebar-model,geometry,conversation}.test.*`, `scratches/session-peek-wireframe*.test.*`.

---

## 1. Architecture summary

### 1.1 Shape

```
main                                   renderer
────────────────────────────────────   ─────────────────────────────────────────────
session_read_receipts (SQLite, v52)    stores/project-sessions   ─┐
  ↑ readSessionUnread{,s}               stores/ticket-session-records ┤ rows carry row.read
activity-watch.observe(projection) ──►  (push: volli:session-activity)┘
  session-read-watch:                  stores/session-order  (held Active order + hold count)
    turn just ended && not in a          ↑ commit / hold()
    focused ActiveTarget  ⇒ markUnread  components/sidebar/*  +  components/ticket/*
                                          rows: SessionGlyph (logo+badge), unread dot, ReadMenu
volli:session-peek-content  ◄────────── components/session-peek/use-session-peek (dwell/warm/suppress)
  readSessionTranscriptTail +             └ SessionPeekCard  ── InteractionCard (existing)
  projection.interactions.active          └ TicketPeekCard  (read-only, drill)
volli:session-read-set  ◄────────────── markRead on open / reply / view-conversation / U / menu
```

Four rules, four homes:

1. **Unread is a durable per-Session receipt, decided in main.** Main is the only process that
   knows whether a window is focused *and* what it is showing (`ActiveTargetRegistry.focusedTargets()`),
   and it is the only process that sees every turn boundary (`activity-watch`'s `observe` port).
   So "a turn ended while it was not in front" is evaluated once, where it is true, and written as
   `session_read_receipts.unread_since`. Everything downstream is a projection of that one stamp:
   the row carries it, the renderer draws a dot, and no renderer decides anything about focus.
2. **The held Active order is a pure rule in `@volli/shared`**, applied by a tiny renderer store so
   both sidebars read one committed order (AGENTS.md: domain rules live in `@volli/shared`; the UI
   only observes). The store also holds the *hold count* — non-zero while the pointer is in either
   sidebar or a peek is open — which is what makes moves wait.
3. **The peek is one controller + two cards, mounted by each sidebar.** The controller owns dwell,
   warm switch, suppression, pin, the Escape ladder and geometry; the cards own content. The rows
   stay the shipped rows plus three additions (mark, unread dot, context-menu item) — no fork of
   `ListRow`, `SidebarMenuButton`, drag, rename or activation.
4. **The card reads through one new pull door and acts through the existing session client.**
   Reading a peek costs one `volli:session-peek-content` fold (no subscription, no adoption).
   *Acting* — answering a question, sending a message, viewing the conversation — is an explicit
   intent, and only then is the Session adopted (`adoptChatSession`) so the shipped
   `InteractionCard` / `submit` path is reused verbatim.

### 1.2 Owner decisions this implements (verbatim constraints)

D1 350 ms dwell; 150 ms warm switch once a card is open; 1 s suppression after dismissal; peekable rows lose their native `title`.
D2 A Previous-band ticket **folder** peeks the **ticket** (read-only: status, title, one line per Session; press a Session to drill; ← back). Expanding a folder closes its peek. Folder rows keep the shipped **count** on their face.
D3 The Session card allows transient action without navigating: answer a pending Ask User question **in full**, send a message, view the conversation, open the Session. Folder peeks are read-only.
D4 Row mark everywhere (Active, Previous, inside folders, rail) = vendor **logo** + state **badge** (v2 `SessionGlyph`: 24 px tile, 16 px logo, spinner/question/warning/idle-circle). Replaces the status dot on these rows.
D5 One two-line row in both sidebars (`ListRow density="two-line"`, mark centred). Nav subtitle = where + when, never state (`VLT-14 · 2m ago` / `No ticket · 22m ago`); rail subtitle = age only.
D6 Unread is its own axis; a peek never reads; `● Unread · {age}` on the card; right-click *Mark as read/unread* (Phosphor `EnvelopeSimple`/`EnvelopeSimpleOpen`) and `U`; blue `bg-info` dot in the trailing slot + semibold title; unread keeps a Session in Active past the 30-minute window and pulls a Previous one back; **durable across restart**.
D7 Held Active order: new question → very top; new turn (idle→working) or first appearance → top but under the lowest open question; everything else moves nothing (an answered question stays pinned where it floated). Nothing moves while the pointer is in either sidebar or a peek is open; pending moves land on leave; no animation. The rail follows the same order.
D8 Keys: `U` toggles read; `↑`/`↓` or `J`/`K` step every visible row (folders + their open Sessions in one order); `→` opens a folder, `←` closes it / returns from a Session to its folder; `Space` peeks the focused row, `Space` again pins a Session or moves into a folder's card; Escape ladder (drilled card → ticket → close; v2 ladder otherwise).
D9 Fix `relativeTime` "0m ago" for 45–59 s.

### 1.3 Deliberate departures from the lab

- **No `ink` mark style, no `STATUS_INK` copy.** PR #568 never merged, so `status-dot.tsx` has no `ink` column to read from; the badge style is the decision and the other two lab styles are comparison scaffolding. `SessionGlyph`'s badge tones use the existing semantic tokens directly (`text-positive`, `text-attention`, `text-destructive`, `text-muted-foreground`) — one component, no second status map (the lab README's own instruction).
- **The card does not re-implement the answer form.** `interaction-ui.tsx`'s `InteractionCard` is the production question surface (multi-prompt, custom text, redirection, refusal, submission latch). The lab's `AnswerForm` is a fixture-era copy.
- **No client-side `delivered` map, no fixture Undo.** See §3.2.
- **Geometry takes real bounds.** `positionPeek` in the lab hard-codes the lab shell's 48/56 px insets; production passes the sidebar's scroll container rect and the window rect.
- **Rows keep drag, rename, context menu, Resume and activation.** A peek must not consume `pointerdown` (rows are `splitDragSourceProps` drag sources) or steal focus.

---

## 2. Slices

Ownership is exclusive: no file appears in two slices. Signatures below are the contract between
slices — code against them, do not invent variants.

```
S1 (blocking, ~½ day) ──┬──► S2 (main + IPC + stores)
                        ├──► S3 (peek engine + cards)
                        └──► S4 (held order + unread membership)
                                     │
                       S5 (left sidebar) ◄─┴─► S6 (right rail + lab retirement)
```

S2, S3 and S4 run in parallel after S1 lands. S5 and S6 run in parallel after S3 + S4 land (they
can be written against the signatures immediately and integrated once those merge). S2 is
independent of S3–S6 except that S5/S6 read `row.read` and call `api.sessions.setRead`.

---

### S1 — Shared contracts and pure rules · complexity: **medium** · blocks everything

**Goal.** Put every cross-slice type and every pure domain rule in `@volli/shared` (covered at 100 %
by construction), and fix the shipped `relativeTime` bug. Deliberately touches **no** existing
required field: `SessionListingRow.read` is optional with a resting value, so every existing builder
(including the lab's fixtures and the renderer tests) keeps compiling.

**Owns (create).**
- `packages/shared/src/session-read.ts` + `session-read.test.ts`
- `packages/shared/src/session-order.ts` + `session-order.test.ts`
- `packages/shared/src/session-peek.ts` + `session-peek.test.ts`

**Owns (modify).**
- `packages/shared/src/session.ts` — add the optional field to `SessionListingRow` only.
- `packages/shared/src/index.ts` — export the three new modules.
- `apps/desktop/src/renderer/src/lib/relative-time.ts` + `lib/relative-time.test.ts` — D9.
- **`apps/desktop/vite.config.ts`** — add **every** new coverage `include` entry for the whole
  feature in one edit (the table in §5). This file is owned by S1 alone precisely because three
  later slices would otherwise all edit it; an entry whose file does not exist yet matches nothing
  and cannot affect the gate, so pre-declaring them is free and removes the only shared-file
  collision in the plan. Each later slice then only has to make its own listed module reach 100 %.

**Interfaces provided.**

```ts
// packages/shared/src/session-read.ts
/** Whether a Session has unread work, and since when. Durable; see session_read_receipts. */
export interface SessionReadState {
  /** Epoch ms the Session became unread, or `null` when it is read. */
  readonly unreadSince: number | null;
}
export const SESSION_READ: SessionReadState = { unreadSince: null };

/** A sparse/absent answer is the resting one — the `sessionProvenanceOf` idiom. */
export function sessionReadStateOf(read: SessionReadState | undefined): SessionReadState;
export function isSessionUnread(read: SessionReadState | undefined): boolean;

/** The two facts the unread edge is decided from. */
export interface SessionTurnPhase {
  readonly turnActive: boolean;
  readonly lastTurnOutcome: SessionTurnOutcome | null;
}
/**
 * Whether a turn ENDED between these two sightings. `previous === null` is a first
 * sighting and never an edge (the `run-attention.ts` discipline: a process that just
 * started must not mark yesterday's finished turns unread).
 */
export function turnJustEnded(previous: SessionTurnPhase | null, current: SessionTurnPhase): boolean;
export function sessionTurnPhaseOf(
  projection: Pick<SessionProjection, "turnActive" | "lastTurnOutcome">,
): SessionTurnPhase;
```

```ts
// packages/shared/src/session-order.ts  — D7, ported from lab/session-peek/sidebar-live.ts
export type SessionOrderPhase = "waiting" | "working" | "resting";
export interface SessionOrderMember { readonly id: string; readonly phase: SessionOrderPhase }
export interface HeldSessionOrder {
  readonly order: readonly string[];
  readonly phases: Readonly<Record<string, SessionOrderPhase>>;
}
/** Where each row goes, given the last commit and this build's membership. */
export function heldOrderTarget(
  held: HeldSessionOrder | null,
  members: readonly SessionOrderMember[],
): readonly string[];
/** What a band commits to once it is free to move. */
export function commitHeldOrder(
  order: readonly string[],
  members: readonly SessionOrderMember[],
): HeldSessionOrder;
/** What a HELD band draws: the committed order, with genuinely new ids appended last. */
export function frozenHeldOrder(
  held: HeldSessionOrder,
  memberIds: readonly string[],
): readonly string[];
export function sameHeldOrder(a: HeldSessionOrder | null, b: HeldSessionOrder): boolean;
/** Applies an id order to rows, keeping unknown rows in their own relative order at the end. */
export function applyHeldOrder<T extends { readonly id: string }>(
  order: readonly string[],
  rows: readonly T[],
): T[];
```

The `QuestionRule` parameter from the lab is **dropped**: `float` is decided (D7).
`SessionOrderPhase` is `"waiting"` when a row has an attention, else `"working"` for a working
row, else `"resting"` (the lab's `phaseOf`, renamed so it does not read as an activity state).

```ts
// packages/shared/src/session-peek.ts
export const SESSION_PEEK_ENTRIES = 6;
export interface SessionPeekEntry {
  readonly at: number;
  readonly role: "user" | "assistant" | "system";
  /** Whitespace-collapsed, cut at TRANSCRIPT_TAIL_TEXT_LIMIT. Empty for a tools-only message. */
  readonly text: string;
  readonly tools: readonly string[];
}
export interface SessionPeekContent {
  readonly sessionId: string;
  /** Oldest first. */
  readonly entries: readonly SessionPeekEntry[];
  /** The open question, scrubbed; `null` when nothing is being asked. */
  readonly question: RendererSessionInteraction | null;
  readonly turns: number;
  readonly turnDepth: number;
  /** Tail messages whose artifact could not be read — counted, never faked. */
  readonly unreadable: number;
  readonly lastActivityAt: number;
}
/**
 * The card's summary line: the newest assistant text in the tail, else the newest tool
 * names as "Ran read_file, edit_file", else null. Never invents prose (§3.1).
 */
export function peekSummaryOf(entries: readonly SessionPeekEntry[]): string | null;
```

```ts
// packages/shared/src/session.ts  (ADD to the existing type)
export type SessionListingRow = SessionListingIdentity & {
  usage: SessionUsageSummary;
  provenance: SessionProvenance;
  /**
   * Unread state. OPTIONAL and sparse for the reason `provenance` is defaulted: a builder
   * with no receipt reader must mark nothing rather than guess. Read via `sessionReadStateOf`.
   */
  read?: SessionReadState;
};
```

```ts
// apps/desktop/src/renderer/src/lib/relative-time.ts  (D9 — the whole fix)
// before: if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;   // 45–59 s → "0m ago"
   if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MINUTE))}m ago`;
// compactAge inherits it ("0m" → "1m"); nextAgeChangeAt is already correct
// (the 45 s bucket closes at epochMs + 60 s), so it must NOT change — pin that with a test.
```

**Tests it must add.** `session-read.test.ts`: resting default; `isSessionUnread`; `turnJustEnded`
first-sighting seeds silently, falling edge of `turnActive` fires, `working→working` does not,
`interrupted` outcome counts as an end, a new `turn.started` after an end does not re-fire.
`session-order.test.ts`: the lab's `sidebar-live.test.ts` cases, ported — null commit = shipped
order; a tool call moves nothing; a new question floats to the very top; a new turn lands under the
lowest open question; an answered question stays where it floated; a first appearance lands under
questions; `frozenHeldOrder` keeps a retired row and appends new ids last; `sameHeldOrder` compares
order *and* phases; `applyHeldOrder` over a subset (the rail). `session-peek.test.ts`:
`peekSummaryOf` prefers the newest assistant text, falls back to tool names, returns `null` for an
empty tail. `relative-time.test.ts`: 44 s → "just now", 45 s → "1m ago", 59 s → "1m ago", 60 s →
"1m ago", 119 s → "1m ago", `compactAge` 45 s → "1m", `nextAgeChangeAt(45s)` unchanged.

---

### S2 — Durable read state + the peek-content door (main, IPC, preload, row stores) · **high**

**Goal.** One durable receipt per Session, decided in main at the turn boundary; one pull door for
the card's content; both threaded through the fetch *and* the push so a row never changes shape when
it moves.

**Owns (create).**
- `apps/desktop/src/main/db/session-read-repo.ts` + `session-read-repo.test.ts`
- `packages/host-core/src/session-control/session-read-watch.ts` + `session-read-watch.test.ts`
- `packages/host-core/src/session-control/peek-content.ts` + `peek-content.test.ts`

**Owns (modify).**
- `apps/desktop/src/main/db/migrations.ts` (+ `migrations.test.ts`) — migration **52**.
- `packages/host-core/src/session-control/listing-row.ts` — new optional `read` parameter.
- `packages/host-core/src/session-control/listing-roster.ts` — batch read + thread.
- `packages/host-core/src/session-control/activity-watch.ts` (+ `activity-watch.test.ts`) — new `readOf` port, threaded into `sessionListingRow`.
- `apps/desktop/src/main/notifications/runtime.ts` — expose `focusedSessionIds(): ReadonlySet<string>` on `NotificationRuntime`.
- `apps/desktop/src/main/index.ts` — construct the repo + watch, wire `observe`, pass `readOf`.
- `apps/desktop/src/main/data-ipc.ts` (+ `data-ipc.test.ts`) — two new handlers.
- `apps/desktop/src/ipc/contract.ts` — the two channels and their DTOs.
- `apps/desktop/src/preload/index.ts`, `apps/desktop/src/preload/index.d.ts` — `sessions.setRead`, `sessions.peekContent`.
- `apps/desktop/src/renderer/src/stores/project-sessions.ts` (+ test) — optimistic `setSessionRead`.
- `apps/desktop/src/renderer/src/stores/ticket-session-records.ts` (+ test) — the same for the rail's rows.

**Interfaces provided.**

```sql
-- migrations.ts, version 52, name:
-- "session_read_receipts — unread is its own axis, durable across relaunch (VC-30 × VC-108)"
CREATE TABLE session_read_receipts (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  unread_since INTEGER
);
CREATE INDEX session_read_receipts_unread ON session_read_receipts(unread_since)
  WHERE unread_since IS NOT NULL;
```

```ts
// main/db/session-read-repo.ts
export function readSessionUnreads(
  db: Database.Database,
  sessionIds: readonly string[],
): (sessionId: string) => SessionReadState;              // batch — the fetch path
export function readSessionUnread(db: Database.Database, sessionId: string): SessionReadState;
/** Idempotent. `at === null` marks read. */
export function writeSessionUnread(
  db: Database.Database,
  sessionId: string,
  at: number | null,
): void;
/** Marks unread only if it is currently read — so a second turn does not restamp. */
export function markSessionUnread(db: Database.Database, sessionId: string, at: number): void;
```

```ts
// packages/host-core/src/session-control/session-read-watch.ts  — rides activity-watch's `observe` port
export interface SessionReadWatchPorts {
  /** Session ids on screen in a FOCUSED window right now (notifications' ActiveTargetRegistry). */
  focusedSessionIds(): ReadonlySet<string>;
  markUnread(sessionId: string, at: number): void;
  now(): number;
}
export interface SessionReadWatch {
  observe(projection: SessionProjection): void;
  /** A Session minted in this process: seed silently, exactly as run-attention does. */
  observeBirth(sessionId: string): void;
}
export function createSessionReadWatch(ports: SessionReadWatchPorts): SessionReadWatch;
```

Rule, stated once: on each fold, `phase = sessionTurnPhaseOf(projection)`; if
`turnJustEnded(previousPhaseOf(sessionId), phase)` and `!focusedSessionIds().has(sessionId)`, then
`markUnread(sessionId, projection.lastActivityAt)`. Store `phase` per Session. First sighting seeds.

```ts
// packages/host-core/src/session-control/listing-row.ts  (signature change; callers in this slice)
export function sessionListingRow(
  session: SessionProjection,
  provenance?: SessionProvenance,
  liveAttachmentIds?: ReadonlySet<string>,
  read?: SessionReadState,            // NEW, defaults to SESSION_READ
): SessionListingRow;
export function sessionListingRows(
  sessions: readonly SessionProjection[],
  provenanceOf: (session: SessionProjection) => SessionProvenance,
  liveAttachmentIds?: ReadonlySet<string>,
  readOf?: (session: SessionProjection) => SessionReadState,   // NEW
): SessionListingRow[];
```

```ts
// packages/host-core/src/session-control/peek-content.ts
export interface SessionPeekContentPorts {
  listEvents: (query: ListSessionEventsQuery) => Promise<readonly SessionEvent[]>;
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  getSession: (input: { sessionId: string }) => Promise<SessionProjection | null>;
}
/** One fold: the tail, plus the open question scrubbed for the renderer. `null` = no such Session. */
export function readSessionPeekContent(
  ports: SessionPeekContentPorts,
  input: { sessionId: string; limit?: number },
): Promise<SessionPeekContent | null>;
```

```ts
// ipc/contract.ts
export interface SessionReadSetInput { sessionId: string; unread: boolean }
export type SessionReadSetResult = Result<{ read: SessionReadState }>;
export interface SessionPeekContentInput { sessionId: string; limit?: number }
export type SessionPeekContentResult = Result<{ content: SessionPeekContent | null }>;
// VolliInvokeContract:
//   "volli:session-read-set":     { args: [input: SessionReadSetInput];     result: SessionReadSetResult }
//   "volli:session-peek-content": { args: [input: SessionPeekContentInput]; result: SessionPeekContentResult }

// preload/index.ts → api.sessions
setRead: (input: SessionReadSetInput) => Promise<SessionReadSetResult>;
peekContent: (input: SessionPeekContentInput) => Promise<SessionPeekContentResult>;
```

```ts
// stores/project-sessions.ts  (added to ProjectSessionsState)
/**
 * Optimistic: writes row.read locally, then persists. A failure reverts and toasts
 * (AGENTS.md: surface every failed mutation). The authoritative answer arrives as an
 * ordinary `volli:session-activity` upsert.
 */
setSessionRead(projectId: string, sessionId: string, unread: boolean): Promise<void>;
// stores/ticket-session-records.ts
setSessionRead(ticketId: string, sessionId: string, unread: boolean): Promise<void>;
```

`volli:session-read-set` must also **publish** the affected row (call the same broadcast
`activity-watch` uses) so a mark made in one window reaches the other sidebar and the other window.

**Tests it must add.** `migrations.test.ts`: v52 applies on a populated db, `foreign_key_check`
clean, cascade on session delete. `session-read-repo.test.ts`: every branch (absent → resting,
mark-unread is idempotent and does not restamp, mark-read clears, batch answers a miss with the
resting value). `session-read-watch.test.ts`: first sighting silent; turn end while focused ⇒ no
write; turn end while unfocused/not showing ⇒ one write; a second turn ending while already unread
does not restamp; `observeBirth` seeds; a terminal-only Session never ends a turn.
`peek-content.test.ts`: a tail with artifacts, a missing artifact counted as `unreadable`, an active
question scrubbed (`native` blanked), a Session that does not exist ⇒ `null`.
`activity-watch.test.ts`: the pushed row carries `read` and the push still gates on difference.
`data-ipc.test.ts`: both handlers, including the re-publish on set. Store tests: optimistic write,
revert + toast on failure. All three new main modules are already enrolled in the coverage gate by
S1 (`**/src/main/db/session-read-repo.ts`, `**/packages/host-core/src/session-control/session-read-watch.ts`,
`**/packages/host-core/src/session-control/peek-content.ts`) and `src/stores/**` is enrolled already — **this
slice must land them at 100 %**, and must not edit `apps/desktop/vite.config.ts`.

---

### S3 — Peek engine and cards · **high**

**Goal.** One controller, one geometry module, two cards, one glyph — all production components,
no fixtures, no lab imports. Written against S1's DTOs and a ports object, so it is testable without
IPC and integrable by S5/S6 without modification.

**Owns (create).**
- `apps/desktop/src/renderer/src/components/session-peek/peek-machine.ts` + `.test.ts` — the pure reducer (port of `lab/scratches/session-peek-wireframe-model.ts`, minus every fixture concern: no `delivered`, no `SendOutcome`, no `opened`).
- `apps/desktop/src/renderer/src/components/session-peek/peek-geometry.ts` + `.test.ts`
- `apps/desktop/src/renderer/src/components/session-peek/peek-subject.ts` + `.test.ts` — folder/session/drill rules (port of `lab/session-peek/sidebar-model.ts`'s `folderRowId`, `folderTicketId`, `peekSubject`, `canPeekRow`, `canPinRow`, `folderSessions`).
- `apps/desktop/src/renderer/src/components/session-peek/use-session-peek.tsx` — the hook + card mount.
- `apps/desktop/src/renderer/src/components/session-peek/session-peek-card.tsx` (+ `.test.tsx`)
- `apps/desktop/src/renderer/src/components/session-peek/ticket-peek-card.tsx` (+ `.test.tsx`)
- `apps/desktop/src/renderer/src/components/session-peek/use-peek-content.ts` — pull + refresh-on-activity.
- `apps/desktop/src/renderer/src/components/sessions/session-glyph.tsx` (+ `.test.tsx`) — D4.

**Interfaces provided.**

```ts
// components/sessions/session-glyph.tsx  — the ONE mark, used by rows and by the card header
export type SessionGlyphSize = "row" | "card";   // 20px slot in a one-line row, 24px tile elsewhere
export function SessionGlyph(props: {
  /** Provider id for the logo: ChatSessionRecord.model?.providerId, else the harness id. */
  providerId: string | null;
  providerLabel: string;
  /** `null` draws the logo alone, muted — a Previous row carries no state. */
  state: StatusDotState | null;
  /** Falls back to the shipped kind glyph when there is no logo to draw. */
  kind: "chat" | "terminal";
  /** Complete accessible name, composed by the caller from SESSION_ACTIVITY_LABEL. */
  name: string;
  size?: SessionGlyphSize;
  /** Which surface the badge's disc is cut out of. */
  surface?: "sidebar" | "popover";
}): React.ReactElement;
```
Badge map (the only new state→glyph map, and it reuses the shipped tone tokens):
`working|setup|starting → CircleNotchIcon text-positive (motion-safe:animate-spin)`,
`waiting → QuestionIcon text-attention`, `interrupted|error → WarningIcon text-destructive`,
everything else → `CircleIcon text-muted-foreground`. State comes from
`sessionActivityDotState(...)` — never re-derived here.

```ts
// components/session-peek/peek-machine.ts
export type PeekSurface = "nav" | "rail";
export interface PeekTarget { readonly rowId: string; readonly surface: PeekSurface }
export type PeekFocusOwner = "none" | "row" | "dialog" | "field";
export type PeekDismissReason = "click-away" | "list-scroll" | "escape" | "pointer-down";
export interface PeekState {
  readonly shown: PeekTarget | null;
  readonly pinned: PeekTarget | null;
  readonly hovered: PeekTarget | null;
  readonly overCard: boolean;
  readonly focus: PeekFocusOwner;
  readonly suppressedUntil: number;
}
export type PeekEvent =
  | { type: "hover-row"; target: PeekTarget } | { type: "hover-leave-row" }
  | { type: "dwell-elapsed"; target: PeekTarget; now: number }
  | { type: "open-now"; target: PeekTarget; now: number }
  | { type: "card-enter" } | { type: "card-leave" } | { type: "grace-elapsed" }
  | { type: "pin"; target: PeekTarget } | { type: "unpin" }
  | { type: "focus-field" } | { type: "blur-field" }
  | { type: "escape"; now: number }
  | { type: "dismiss"; reason: PeekDismissReason; now: number };
export const PEEK_DWELL_MS = 350;        // D1
export const PEEK_WARM_DWELL_MS = 150;   // D1
export const PEEK_GRACE_MS = 300;        // WCAG 1.4.13 hoverable
export const PEEK_SUPPRESSION_MS = 1000; // D1
export const PEEK_FOCUS_DWELL_MS = 250;
export const initialPeekState: PeekState;
export function peekReducer(state: PeekState, event: PeekEvent): PeekState;
export function isPeekShowing(state: PeekState, target: PeekTarget): boolean;
```

```ts
// components/session-peek/peek-geometry.ts
export interface PeekPosition { readonly left: number; readonly top: number; readonly maxHeight: number }
export function positionPeek(input: {
  row: Pick<DOMRect, "left" | "right" | "top">;
  /** The scroll container the row lives in — the card is clamped to its vertical span. */
  container: Pick<DOMRect, "top" | "bottom">;
  viewport: { width: number; height: number };
  surface: PeekSurface;          // nav opens right, rail opens left
  cardHeight: number;            // 0 before the first measure
  cardWidth: number;
}): PeekPosition;
export function clamp(value: number, min: number, max: number): number;
export const PEEK_CARD_WIDTH = 360;
```

```ts
// components/session-peek/peek-subject.ts
export function folderRowId(ticketId: string): string;                 // "folder:<id>"
export function folderTicketId(rowId: string): string | null;
export function peekSessionId(rowId: string): string | null;           // strips "chat:" / "session:"
export interface FolderPeekView { readonly drill: string | null }
export type PeekSubject =
  | { kind: "ticket"; ticketId: string; sessionRowIds: readonly string[] }
  | { kind: "session"; rowId: string; via: { kind: "row" } | { kind: "drill"; ticketId: string } };
export function peekSubjectOf(
  rowId: string,
  folders: ReadonlyMap<string, readonly string[]>,
  view: FolderPeekView,
): PeekSubject | null;
export function canPeekRow(rowId: string): boolean;                    // every Session + every folder
export function canPinRow(rowId: string, kindOf: (rowId: string) => "chat" | "terminal" | undefined): boolean;
```
D2/D3 encoded here: a folder is never pinnable; a `terminal` row is never pinnable (nothing to
answer); a drilled Session card shows a `← <TICKET-ID>` strip and no ticket block.

```ts
// components/session-peek/use-session-peek.tsx
export interface SessionPeekRow {
  readonly rowId: string;
  readonly sessionId: string | null;      // null for a folder row
  readonly title: string;
  readonly ticket: Ticket | null;
  readonly kind: "chat" | "terminal";
  readonly state: StatusDotState | null;
  readonly providerId: string | null;
  readonly providerLabel: string;
  readonly at: number | null;
  readonly unread: boolean;
  readonly model: ModelSelection | null;
  readonly provenance: SessionProvenance;
}
export interface SessionPeekPorts {
  /** One pull per shown Session; the hook debounces and refreshes on activity. */
  readContent(sessionId: string): Promise<SessionPeekContent | null>;
  /** Adopts the Session and resolves its question. `false` = not delivered (§3.3). */
  answer(sessionId: string, interactionId: string, submission: InteractionSubmission): Promise<boolean>;
  sendMessage(sessionId: string, text: string): Promise<boolean>;
  /** Opens the Session (navigates) and reads it. */
  openSession(rowId: string): void;
  openTicket(ticketId: string): void;
  /** Opens the shared conversation overlay (SessionPeekDialog + ChatPlane) and reads it. */
  viewConversation(sessionId: string): void;
  setRead(sessionId: string, unread: boolean): void;
}
export interface SessionPeekOptions {
  ticketPrefix: string;
  now: number;
  rowOf(rowId: string): SessionPeekRow | undefined;
  ticketOf(ticketId: string): Ticket | undefined;
  folders: ReadonlyMap<string, readonly string[]>;   // folderRowId → its Session row ids
  /** A folder just expanded: its peek closes (D2). */
  onFolderToggle?(ticketId: string): void;
  ports: SessionPeekPorts;
}
export interface SessionPeekBinding {
  /** Spread onto the list container of each surface. Never consumes pointerdown's default. */
  rowProps(surface: PeekSurface): Pick<React.HTMLAttributes<HTMLElement>,
    "onPointerMove" | "onPointerLeave" | "onPointerDownCapture" | "onKeyDown" | "onFocusCapture" | "onBlurCapture">;
  /** Spread onto the scroll container: a scroll dismisses. */
  scrollProps: Pick<React.HTMLAttributes<HTMLElement>, "onScroll">;
  /** The fixed-position card, or null. Render it once per surface host. */
  card: React.ReactNode;
  /** True while the pointer is inside this surface or a card is open — S4's hold (D7). */
  holding: boolean;
  shownRowId: string | null;
  /** The surface's own keys (folder ←/→, U); returns true when it handled the event (D8). */
  registerRowKeys(handler: (event: React.KeyboardEvent<HTMLElement>, target: PeekTarget) => boolean): void;
}
export function useSessionPeek(options: SessionPeekOptions): SessionPeekBinding;
```
Rows are addressed by `data-peek-row` / `data-peek-surface` exactly as in the lab (a Session's `<li>`,
a folder's disclosure `<button>`); `peekRowElement` / `peekRowButton` move into this module.
`onPointerDownCapture` dismisses without suppression-on-drag: a `pointerdown` on a row is a drag or a
click, and either way the card must go (the earlier prototype's finding, recorded on VC-30).

```ts
// components/session-peek/session-peek-card.tsx
export function SessionPeekCard(props: {
  row: SessionPeekRow;
  content: SessionPeekContent | null;     // null while loading
  loading: boolean;
  failed: boolean;
  position: PeekPosition;
  pinned: boolean;
  /** `← VLT-14` strip for a card reached by drilling a folder. */
  back?: { ticketLabel: string; onBack(): void };
  canReply: boolean;                      // false for a terminal row / a folder drill
  onPin(): void; onClose(): void;
  onOpen(): void; onViewConversation(): void;
  onAnswer(interactionId: string, submission: InteractionSubmission): Promise<boolean>;
  onSend(text: string): Promise<boolean>;
  ref?: React.Ref<HTMLDivElement>;
}): React.ReactElement;
```
Header: `SessionGlyph size="card" surface="popover"`, title, then `● Unread · {age}` when
`row.unread` (D6) else `{age}`; `Open session` icon button; `Close` while pinned. Body: ticket block
(id + `TICKET_STATUS_LABELS[status]` + title) unless drilled; summary (`peekSummaryOf`, 5-line clamp,
skeleton while loading, "Summary unavailable" on failure); the provenance/harness line the row's
native `title` used to carry (D1); the question. **When pinned with an open question, mount
`InteractionCard` from `components/chat/interaction-ui.tsx`** — not a local form. When pinned with no
question, a `Textarea` + Send that calls `onSend`. Footer: `View conversation`, then `Answer`/`Send`.

```ts
// components/session-peek/ticket-peek-card.tsx  (D2, read-only)
export function TicketPeekCard(props: {
  ticket: Ticket; ticketPrefix: string;
  sessions: readonly { rowId: string; title: string; age: string; summary: string | null;
                       glyph: React.ReactNode }[];
  position: PeekPosition;
  onDrill(rowId: string): void; onOpenTicket(): void;
  ref?: React.Ref<HTMLDivElement>;
}): React.ReactElement;
```

```ts
// components/session-peek/use-peek-content.ts
export interface PeekContentState {
  content: SessionPeekContent | null; loading: boolean; failed: boolean;
}
/** One pull per sessionId, cached per Session for the life of the mount, refreshed when
 *  that Session's listing row is pushed (its `lastActivityAt` moved). Never subscribes. */
export function usePeekContent(
  sessionId: string | null,
  read: (sessionId: string) => Promise<SessionPeekContent | null>,
  activityToken: number,
): PeekContentState;
```

**Tests it must add.** `peek-machine.test.ts` — the lab's `session-peek-wireframe-model.test.ts`
cases, ported: hover never opens; the dwell that completes must be the row still hovered; a pin owns
the surface; the bridge (grace) keeps the card while hovered/overCard; drift away does not suppress;
dismissal suppresses for 1 s; the Escape ladder field→dialog→unpin→close. `peek-geometry.test.ts` —
nav opens right / rail opens left, clamped to viewport and container, bottom-anchored row does not
bootstrap a tiny box. `peek-subject.test.ts` — folder ids, drill/back, `canPinRow` refuses folders
and terminals. `session-peek-card.test.tsx` — unread header says `Unread`, a peek alone never calls
`setRead`, `InteractionCard` is mounted only when pinned with a question, a terminal row offers no
reply, `Open session` and `View conversation` fire their ports, failure keeps the card with a reason.
`ticket-peek-card.test.tsx` — one line per Session, drill fires, no reply affordance anywhere.
`session-glyph.test.tsx` — the four badge states, the `null` state, the accessible name, the missing-
logo fallback. `peek-machine.ts`, `peek-geometry.ts` and `peek-subject.ts` are enrolled in the
coverage gate by S1 (pure `.ts` beside views — the `tab-focus.ts` precedent) and **must land at
100 %**; the `.tsx` files stay outside it as view glue. Do not edit `apps/desktop/vite.config.ts`.

---

### S4 — Held order, unread membership, and the peek's hold · **medium/high**

**Goal.** The two order/membership rules as renderer state both sidebars share, plus the one change
to the shipped listing builder.

**Owns (create).**
- `apps/desktop/src/renderer/src/stores/session-order.ts` + `session-order.test.ts`

**Owns (modify).**
- `apps/desktop/src/renderer/src/components/sidebar/active-session-listing.ts` (+ `.test.ts`) — unread membership only.

**Interfaces provided.**

```ts
// stores/session-order.ts   (covered by src/stores/** — 100 %)
export interface SessionOrderState {
  /** projectId → the order that band last committed to. */
  held: Readonly<Record<string, HeldSessionOrder>>;
  /** >0 while a pointer is inside either sidebar or a peek is open: nothing may move (D7). */
  holds: number;
  /** Takes a hold; call the returned function to release it. Idempotent per caller. */
  hold(): () => void;
  /** Commits an order for a project. A no-op while `holds > 0` or when nothing changed. */
  commit(projectId: string, members: readonly SessionOrderMember[]): void;
  /** What a surface should draw now: the target when free, the frozen order while held. */
  orderFor(projectId: string, members: readonly SessionOrderMember[]): readonly string[];
}
export const useSessionOrderStore: UseBoundStore<StoreApi<SessionOrderState>>;
/** The band's own hook: commits on every free build, freezes while held, never animates. */
export function useHeldSessionOrder(
  projectId: string,
  members: readonly SessionOrderMember[],
): readonly string[];
```
`orderFor` = `holds > 0 && held[projectId] ? frozenHeldOrder(held, ids) : heldOrderTarget(held, members)`.
Both sidebars call `useHeldSessionOrder(project.id, members)`; the rail passes its ticket's subset and
applies the result with `applyHeldOrder`, so one commit orders both surfaces (D7).

```ts
// components/sidebar/active-session-listing.ts  (ADD to BuildActiveSessionListingInput)
  /**
   * Sessions with unread work (VC-108). An unread Session is not done with you, so the
   * quiet window cannot retire it and a Previous one comes back: `activeGroup` short-circuits
   * on it exactly as it does on `attention`, which also exempts it from Previous cleanup and
   * from the `ACTIVE_QUIET_WINDOW_MS` boundary. OPTIONAL — absent is the resting case, so the
   * lab fixtures and every existing caller keep compiling.
   */
  unreadSessionIds?: ReadonlySet<string>;
```
Implementation: `activeGroup(row, quietAt, attached, now, unread)` returns `ACTIVE_GROUP.recent`
when `unread` before the window test, and the boundary loop skips an unread entry (its membership
does not change on the clock). `unreadSessionIds` holds bare Session ids; the builder already knows
each row's id prefix.

**Tests it must add.** `session-order.test.ts`: a commit while free; no commit while held; two holds
released independently; `orderFor` freezes and then lands the pending moves in one step on release;
the rail's subset keeps the band's relative order. `active-session-listing.test.ts` (extend): an
unread chat past 30 minutes stays in Active; marking a Previous Session unread returns it to Active;
an unread Session is never cleaned; `nextBoundaryAt` does not name a boundary for an unread row;
the default (absent set) reproduces today's output byte for byte.

---

### S5 — Left sidebar integration · **high**

**Goal.** Make the Active/Previous bands the peek's surface, in the one row language (D1–D8).

**Owns (modify).**
- `apps/desktop/src/renderer/src/components/sidebar/active-sessions.tsx` (+ `active-sessions.test.tsx`)
- `apps/desktop/src/renderer/src/components/sidebar/session-band-row.tsx` (+ `session-band-row.test.tsx`)

**Owns (create).**
- `apps/desktop/src/renderer/src/components/sidebar/session-band-keys.ts` + `.test.ts` — D8's stepping over folders + their open Sessions in one order, as a pure rule.

**What changes.**
1. `ActiveBandRow` becomes the two-line `ListRow` (D5): `leading={<SessionGlyph …/>}`,
   `primary` = title (`font-semibold` when unread, keeping the working sweep),
   `secondary` = `activeSubtitle(row, prefix, now)` = `"<TICKET-ID|No ticket> · <relativeTime>"`,
   `trailing` = the unread dot (`size-2 rounded-full bg-info` + `sr-only "Unread"`).
   `stateLine`/`placeLine`/`attentionLine`/`WAITING_COPY` are **deleted** (the mark carries state, D5).
   `CompanionGlyph` is deleted (the mark carries the vendor/harness).
2. `PreviousBandRow` keeps its one-line density, swaps `KindGlyph` + the interrupted `StatusDot` for
   `SessionGlyph size="row" state={row.activity === "interrupted" ? "interrupted" : null}`.
3. Both rows: `title={undefined}` on peekable rows (D1). What the attribute carried — the harness
   label and `sessionProvenanceHoverLine` — moves onto the card (S3), so nothing is lost.
   `SessionProvenanceMark` stays on the row.
4. Both rows gain a `ContextMenu` wrapper with `Mark as read`/`Mark as unread`
   (`EnvelopeSimpleOpenIcon`/`EnvelopeSimpleIcon`), calling `onToggleRead(row)`. The menu must wrap
   the row without stealing the drag props.
5. `TicketGroupRow` keeps its count and age (D2) and gains `data-peek-row={folderRowId(ticket.id)}`
   / `data-peek-surface="nav"`; its `title` is dropped.
6. `ActiveSessions`: build `SessionPeekRow`s, call `useSessionPeek({surface:"nav", …})`, spread
   `rowProps("nav")` + `scrollProps` on the band container, render `binding.card`, and take S4's
   hold via `binding.holding`. Apply `useHeldSessionOrder(project.id, members)` to `activeRows`
   (Chat Drafts stay ahead of the listing, as today, and are never peekable — a Draft has no Session).
   Pass `unreadSessionIds` into `buildActiveSessionListing`. Wire the ports: `openSession` → the
   existing `activate(row)` **plus** `setSessionRead(sessionId, false)`; `setRead` → the store action;
   `viewConversation` → the shared overlay (see S6's note — the overlay component is shared and owned
   by S6; S5 consumes it).
7. Expanding a folder closes its peek (D2) via `onFolderToggle`.

**Tests it must add.** `session-band-row.test.tsx`: the two-line Active row's subtitle says where and
when and never a state word; unread draws the dot and the semibold title; no `title` attribute on a
peekable row; the context menu offers the right item in each direction; the glyph's accessible name.
`active-sessions.test.tsx`: dwell opens a card for the hovered row (fake timers at 350/150 ms); a
`pointerdown` dismisses and does not cancel a drag; opening a row reads it; the held order does not
move while the pointer is in the sidebar and lands on leave; an unread Previous Session appears in
Active; `U` toggles; `↑/↓`/`J`/`K` step folders and their open Sessions in one order; `→`/`←` open
and close a folder; `Space` peeks then pins. `session-band-keys.test.ts`: the pure stepping order —
`src/components/sidebar/session-band-keys.ts` is enrolled by S1 and **must land at 100 %**.
Do not edit `apps/desktop/vite.config.ts`.

---

### S6 — Ticket rail integration, the conversation overlay, and lab retirement · **high**

**Goal.** The rail's Sessions fold gets the same row language, the same peek, and the same held
order; the view-conversation overlay becomes a shared production component; the lab is retired.

**Owns (modify).**
- `apps/desktop/src/renderer/src/components/ticket/ticket-sessions-panel.tsx` (+ `ticket-sessions-panel-rows.test.tsx`, `-actions.test.tsx`, `-push.test.tsx`)
- `apps/desktop/src/renderer/src/components/ticket/session-history.ts` (+ `session-history.test.ts`) — held-order application and the unread axis on `SessionRailRow`.

**Owns (create).**
- `apps/desktop/src/renderer/src/components/session-peek/peek-conversation.tsx` (+ `.test.tsx`) — the shared overlay: `SessionPeekDialog` chrome + `adoptChatSession` + `ChatPlane`, i.e. exactly what `subagent-peek-dialog.tsx` already does, generalised for a sidebar row. Consumed by S5 and S6.

**Owns (delete/retire).**
- `apps/desktop/src/renderer/lab/scratches/session-peek-sidebars.tsx` + `.test.tsx`
- `apps/desktop/src/renderer/lab/session-peek/**` (card, row-mark, sidebar-rows, ticket-card, use-peek-controller, geometry, conversation, sidebar-model, sidebar-live, sidebar-corpus, README and their tests)
- `apps/desktop/src/renderer/lab/scratches/session-peek-content.ts` + `.test.ts`, `session-peek-corpus.ts`, `session-peek.tsx` (the v1 scratch)
- **Kept:** `scratches/session-peek-wireframe*.tsx` and `session-peek-wireframe-model.ts` + their tests — see §4.

**What changes.**
1. `SessionRow` in the panel: `leading={<SessionGlyph size="row" …/>}` instead of the kind glyph;
   `secondary` = the age alone (D5 — the ticket is the page); `RowStatus`'s state word is removed
   from live rows (the mark carries it) but **kept in the record/history fold**, where a row's whole
   content is "when it stopped" and the state word (`Stopped`, `Interrupted`) is the fact.
   Rename, Resume, drag and activation are untouched.
2. Unread: the trailing slot gets the dot; the context menu gains the read item beside `Rename`
   and `Resume`; `U` toggles.
3. `title={sessionProvenanceHoverLine(...)}` is dropped on peekable rows (D1).
4. The current live rows are ordered by `applyHeldOrder(useHeldSessionOrder(projectId, members), current)`
   instead of `orderSessionRailRowsByAttention` (D7). `orderSessionRailRowsByAttention` stays
   exported and tested — it is still the right rule for Home's roster — with a doc note saying which
   surfaces use which. The record fold stays a chronology.
5. `useSessionPeek({surface:"rail", …})` on the fold's list; the card opens **left** (geometry).
   Folder peeks do not exist here (the rail has no folders); `peekSubjectOf` returns a session
   subject for every rail row.
6. The eyebrow itself does not peek (an open question, recorded in §3.6).

**Tests it must add.** `ticket-sessions-panel-rows.test.tsx`: the rail row's second line is the age
alone; the mark replaces the kind glyph; the unread dot and semibold title; the record fold keeps its
state word. `-actions.test.tsx`: the read menu item, `U`, and that Rename/Resume still work.
`session-history.test.ts`: held-order application over the ticket's subset; unread rows stay in the
live half. `peek-conversation.test.tsx`: opening adopts the Session, closing leaves the client
resident, viewing marks read, Escape does not also dismiss the peek behind it.

---

## 3. Runtime gaps and resolutions

### 3.1 The card's summary — **no production source exists**

Nothing in production carries a Session summary. `#610`'s `session-peek-dialog.tsx` is chrome; its
only host mounts the live `ChatPlane`. Auto-titles are titles.

**Resolution (smallest honest source).** Reuse the engine fold the CLI already ships:
`readSessionTranscriptTail` (`packages/session-engine/src/transcript-tail.ts`), exposed to the
renderer as `volli:session-peek-content` (S2), rendered through `peekSummaryOf` (S1): the newest
**assistant** message's own words (already whitespace-collapsed and cut at 120 chars), else the tool
names of the newest message ("Ran `read_file`, `edit_file`"), else nothing. The card says
`Summary unavailable` when the fold returns no readable entry — it never generates prose, never calls
a model, and never claims a summary it does not have. `unreadable > 0` is reported as
`Some messages could not be read` rather than silently shortening the tail.

### 3.2 Undo for answer/send — **none exists in production**

The only retractions that exist are `dequeue(id)` on a message still in the resident queue and
`interrupt()` on a live turn. A delivered `interaction.resolve` cannot be recalled; the ledger has no
retraction command and adding one is a runtime contract, not a UI decision.

**Resolution.** Ship **no Undo**. The card's Send is the composer's Send: one explicit press,
`Sending…`, then `Sent` for ~2 s and the card closes (the lab's `CONFIRMATION_MS`), and a failure
keeps the card open with the text intact and a `Try again` (the shipped `InteractionCard` already
does exactly this through its submission latch). The lab's 5-second Undo strip is a fixture and is
**not** ported. Rejected alternative — a client-side hold before delivery: it would make every answer
5 s late for the one case the whole ticket exists to make fast ("answer it and go back to work"), and
a hold the ledger does not know about is a message that is not sent while the UI says it is.

> **OPEN QUESTION Q1 — Undo.** Recommended default: **no Undo**, as above. If the owner wants one,
> the honest form is a queued-send hold (`enqueue` + `dequeue`) for *messages only*, never for answers,
> and it needs its own ticket.

### 3.3 Question identity when answering from a card

`SessionInteraction.id` is the identity and is stable and durable; the runtime correlation
(`native`) is scrubbed before it reaches the renderer, so the card can never see or forge it.
Two races are real: the question may be answered in its own chat, or cancelled/superseded, between
the pull and the press.

**Resolution.** The card reads the question from `volli:session-peek-content` (one fold), but a pin is
an explicit intent and therefore **adopts** the Session (`adoptChatSession`) before showing the form.
The form is then driven by the resident projection's `interactions.active`, exactly as the chat plane
is, so a question that has gone away disappears from the card the same instant it disappears from the
chat. `onAnswer` refuses (returns `false`) when the id is no longer active and the card says
`That question was already answered.` The pull's `question` field is used only for the *unpinned*
preview line.

### 3.4 What reads a Session

Read (clears unread): opening it (`activate`), sending a reply/answer to it from the card, viewing
its conversation, `U`, the context menu, and — decided in main — a turn ending while it is in front
of a focused window. **A peek never reads** (D6): the controller has no read side effect at all, and
`session-peek-card.test.tsx` pins that.

### 3.5 Terminal companions

They have no turns, no interactions and no transcript fold, so: never automatically unread, never
pinnable, no summary. Their peek card shows identity, ticket, state and `Open session` only, and the
context menu's read item is offered for chat rows only. (Stated so a reviewer does not read the
absence as an omission.)

> **OPEN QUESTION Q2 — manual unread on a terminal row.** Recommended default: **not offered**.
> The receipt table has no opinion, so enabling it later is a UI change only.

### 3.6 Smaller open questions

> **Q3 — does the rail's `SESSIONS ›` eyebrow peek its folded record?** Default: **no** (the lab left
> this open). A caret is a disclosure, not a subject.
>
> **Q4 — the board's ticket cards.** `TicketPeekCard` is deliberately built to be mountable from the
> board (the ticket's brief asks for it). Default: **out of scope for this plan**; it is a second
> host for an already-built card and should be its own ticket.
>
> **Q5 — Home's Sessions page / ⌘K.** Same shape, same answer: out of scope, no new component needed.
>
> **Q6 — unread on the board ring / tab strips / project rail aggregate** (the rest of VC-108's
> surfaces). Default: **out of scope**; the durable receipt this plan lands is what they would read.
>
> **Q7 — the VC-108 audit document.** Searched: the ticket is closed and no audit file exists in this
> worktree (`docs/`, `docs/plans/`, `lessons/` have nothing under that name). The only surviving
> statement of its findings is the module comment in `lab/session-peek/sidebar-live.ts`, which is
> what §1.2 D6 is derived from. If the owner has the audit elsewhere, it should be read before S2 is
> reviewed; nothing in this plan depends on a finding beyond what that comment records.

---

## 4. The lab

**Recommendation: retire the integrated scratch, keep the v2 wireframe.**

- Delete (S6): `scratches/session-peek-sidebars.tsx` + `.test.tsx`, the whole `lab/session-peek/`
  directory, `scratches/session-peek-content.{ts,test.ts}`, `scratches/session-peek-corpus.ts`,
  `scratches/session-peek.tsx` (the superseded v1). Every rule in them now exists in production with
  its own tests: `sidebar-live.ts` → `@volli/shared/session-order.ts` + the read receipt,
  `sidebar-model.ts` → `peek-subject.ts`, `use-peek-controller.ts` → `use-session-peek.tsx`,
  `card.tsx`/`ticket-card.tsx` → the two production cards, `row-mark.tsx` → `SessionGlyph`,
  `geometry.ts` → `peek-geometry.ts`. Keeping them means two implementations of eight rules, and the
  lab copy is the one nobody runs.
- Keep: `scratches/session-peek-wireframe.tsx`, `session-peek-wireframe-model.ts` and their three
  test files. They are the argument the design was settled from, they have no production dependency
  beyond primitives, and the wireframe's question fixtures are still the fastest way to look at a
  five-prompt question.
- **The kept wireframe imports three of the files marked for deletion** (verified):
  `../session-peek/use-peek-controller`, `../session-peek/card` (`SessionPeekCard`, `SessionGlyph`,
  `SessionFixture`, `STATE_WORD`) and `../session-peek/conversation` (`PeekConversation`). So S6 has
  exactly two honest options, and must pick one before deleting anything:
  **(a) fold those three files back into `scratches/session-peek-wireframe.tsx`** (they were lifted
  out of it in the first place, for the integrated scratch that is now going away) — recommended,
  because it leaves one self-contained fixture scratch and no shared lab module; or
  **(b) retire the wireframe too** and keep only `session-peek-wireframe-model.ts` + its tests as the
  recorded argument. Do **not** point the wireframe at the production hook: it drives fixture rows
  with a fixture send, and wiring it to `use-session-peek` would make the lab a second caller of the
  production ports for no design question.
- Nothing else in the lab imports `lab/session-peek/**` (verified: only the sidebars scratch, its
  test, and the wireframe do), so the deletion is local to those three files.
- Constraint for every slice: `lab/**` is type-checked and its tests run. Adding a **required** field
  to `ChatSessionRecord`, `SessionProjection` or `SessionListingRow` breaks `lab/fixtures.ts`,
  `lab/session-peek/sidebar-corpus.ts` and several renderer tests. This plan adds only one field, to
  `SessionListingRow`, and it is optional — deliberately.

---

## 5. Verification bar

Every slice, before it is called done:

```bash
pnpm typecheck                     # == vp exec tsc --noEmit -p tsconfig.json && vp run -r typecheck
vp check                           # vp fmt + vp lint
vp test run --maxWorkers=$VOLLI_CONCURRENCY_HINT      # or the package-scoped filter
```

Before pushing anything in S1, S2, S4, S5 or S6 (each adds branches or store actions):

```bash
vp run -r test:coverage --maxWorkers=$VOLLI_CONCURRENCY_HINT
```

`packages/shared` and the desktop's protected surface are at **100 %** statements/branches/functions/
lines, globally — a partial carve-out cannot rescue it. **S1 adds every row of this table to
`apps/desktop/vite.config.ts` in one edit**; the slice that writes each module is the one that has
to make it reach 100 %.

| Enrolled by S1 | Written by | Module |
| --- | --- | --- |
| new | S2 | `**/src/main/db/session-read-repo.ts` |
| new | S2 | `**/packages/host-core/src/session-control/session-read-watch.ts` |
| new | S2 | `**/packages/host-core/src/session-control/peek-content.ts` |
| new | S3 | `src/components/session-peek/peek-machine.ts` |
| new | S3 | `src/components/session-peek/peek-geometry.ts` |
| new | S3 | `src/components/session-peek/peek-subject.ts` |
| new | S5 | `src/components/sidebar/session-band-keys.ts` |
| already listed | S1 | `src/lib/relative-time.ts` |
| already listed | S2 | `src/stores/**`, `**/packages/host-core/src/session-control/activity-watch.ts` |
| already listed | S4 | `src/stores/**`, `src/components/sidebar/active-session-listing.ts` |
| already listed | S6 | `src/components/ticket/session-history.ts` |
| whole package | S1 | `packages/shared/src/**` (session-read, session-order, session-peek) |

CI's other gates that this work can trip (`.github/workflows/ci.yml`, job `core`):

- `vp run check:workspace-licenses`, `vp run check:excluded-dependencies` — only if a dependency is
  added. **Add none**: every icon is Phosphor, already a dependency.
- `vp run --filter @volli/desktop check:design-tokens` — every new utility must be on the ladder or
  recorded in `scripts/design-token-allowlist.json`. The unread dot is `bg-info` (a generated token,
  `--color-info` exists); the card is `shadow-overlay` + `bg-popover`; alphas stay on
  `/10 /30 /50 /70 /90`.
- `vp run --filter @volli/desktop check:theme-css` — untouched unless `globals.css` changes; it must not.
- `vp run --filter @volli/desktop check:vendored-themes`, `check:node-version` — unaffected.
- `vp run check:notices` — unaffected (no dependency-set change). Run it anyway if a manifest moves.
- `vp run --filter @volli/desktop check:licenses`, `check:notice-inputs`, `check:lgpl-source`,
  `check:library-validation` — unaffected.
- `vp run --filter @volli/desktop build` + the artifact check — S2 touches preload and main, so the
  packed build must be verified (`dist-electron/main.cjs`, `preload.cjs`, `dist/index.html`).
- Smoke lanes (macOS): S2 changes the database schema, so the boot tier is the real gate —
  `migrate()` must apply v52 to an existing database and pass `foreign_key_check`.
  Locally: `act pull_request --container-architecture linux/amd64`.

Not part of the gate and not to be run in this lane: `pnpm test:performance-harness`
(`vite.bench.config.ts`) — unless S2's roster read shows up in `e2e/bench/session-listing-vc388.mjs`,
in which case run it once to confirm the extra per-roster repo read has not moved the number.

---

## 6. Coordinator amendments (override anything above that disagrees)

Reviewed against the lab and the owner's decisions before any slice started.

**A1 — Viewing clears unread (S2).** §3.4 only stops a turn that ends *in front* from marking
unread. The converse is also required: whenever a Session **becomes** in front of a focused window —
the renderer's active target changes to it, or its window regains focus while showing it — and it is
unread, main marks it read and publishes the row. Otherwise a person who returns to a window already
showing a finished chat keeps seeing its dot until they navigate away and back. S2 decides where the
hook lives (`main/notifications/active-targets.ts` / `runtime.ts`, both S2-owned for this purpose) and
tests: target change → read; window focus while showing → read; an unfocused window showing it → not
read.

**A2 — The rail keeps its own held order (S4, S6).** One project-keyed commit cannot be shared by two
callers with different member sets: the rail's ticket subset would overwrite the band's commit on
every build, and the rail would never commit at all while the left sidebar is hidden. So the store is
keyed by a **surface key**, not a project id: the left band commits under `project:<projectId>`, the
rail under `ticket:<ticketId>`, both through the same pure `heldOrderTarget` rules, so the same
events produce the same lifts on both. **The hold is global** — a pointer in either sidebar, or any
open peek, freezes every key. Rename accordingly:
`useHeldSessionOrder(key: string, members: readonly SessionOrderMember[])`,
`commit(key, members)`, `orderFor(key, members)`, `held: Record<string, HeldSessionOrder>`.
Commits happen in an effect, never during render.

**A3 — The mark, exactly as the lab draws it (S3, S5, S6).** `SessionGlyph` is `lab/session-peek/row-mark.tsx`'s
`BadgeMark` (24 px tile, 16 px logo, badge disc cut from `bg-sidebar` or `bg-popover`, `badgeFor`'s four
badges). A Previous row passes its real state — `idle` (idle circle) or `interrupted` (warning) — not
`null`: one mark everywhere. A terminal companion is drawn with its **harness's vendor** logo (the
lab's `HARNESS_VENDOR` map in `sidebar-corpus.ts`: move it into production beside `SessionGlyph`);
only a harness with no known vendor falls back to its shipped `HARNESS_GLYPHS` glyph.

**A4 — Open questions settled with their recommended defaults.** Q1 no Undo (the card's Send/Answer
behave like the composer's: `Sending…`, then `Sent`, failure keeps the text and offers retry). Q2 no
manual unread on terminal rows. Q3 the rail eyebrow does not peek. Q4–Q6 out of scope. Q7 no audit
beyond the lab comment. §4's lab option **(a)**: fold `use-peek-controller`, `card` and
`conversation` back into the wireframe scratch, then delete the rest as listed.

**A5 — Working rules for parallel slices.** All slices share ONE working directory.
- Touch only the files your slice owns. If you need a change in a file another slice owns, stop and
  say so in your final message instead of editing it.
- Do **not** commit, stash, reset, checkout or rebase — the coordinator commits each slice.
- Format only your own files: `vp fmt <your paths>`; lint with `vp lint <your paths>` (or `vp check`
  and ignore findings in other slices' files). Never run a repo-wide formatter write.
- Other slices may be mid-edit: a typecheck or test failure in a file you do not own is not yours —
  report it, do not fix it. Scope test runs to your files
  (`cd apps/desktop && vp test run <paths>`; `cd packages/shared && vp test run <paths>`).
- Coverage: run the package's `test:coverage` scoped as tightly as the tooling allows and read the
  rows for your modules; they must be 100 %.
- If `node_modules` is missing (an external cleanup job keeps deleting it), run
  `pnpm install --frozen-lockfile` from the workspace root and continue.
- Pass `$VOLLI_CONCURRENCY_HINT` to every `--maxWorkers` / `-j`.
