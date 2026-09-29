# Session peek / VC-406 integration boundary

Initial compatibility inspection: VC-406 at `c927e21b`. The PR now integrates main at `218c48e7`, including its roster and model/effort changes. The **sidebar hover behavior remains lab-only**, not a replacement for the production rail or a live sidebar integration. The conversation overlay shares production chat components as described below.

## Shared today

- `ListRow` owns the row density and activation target. VC-406 preserves its existing API and adds `ListRowSkeleton`; this prototype does not fork that primitive.
- `ModelMark` supplies the existing provider logos. Its API is unchanged on VC-406.
- `SESSION_ACTIVITY_LABEL` supplies accessible activity names, including **Interrupted** for the failed-turn fixture. Visible state text is omitted from rows and the card header; the provider/state glyph retains an accessible name.
- Full rows keep the title on its own line. Compact rows are an experimental density with a semibold title and display ID, not a new production default.
- The summary has a five-line budget and matching five-line loading skeleton. Questions remain untruncated, with recovery/actions outside the scroll region.

## Question fixture (lab only)

The **Question** control on the wireframe varies the waiting Session between a declared custom answer, choices only, multiple choices, two prompts, and freeform. These are fixtures using `SessionInteractionPrompt` (`options`, `description`, `multiple`, `custom`, `detail`) and `@volli/session-presentation` draft/selection rules, not a claim that every live harness offers Other. Choices use native radio/checkbox inputs in a question-named fieldset; descriptions sit below option labels and are associated separately with each control. The sample keeps the question short instead of repeating its answer subtitles. A custom field appears only when `custom` is declared. The two-prompt case keeps separate drafts across Back/Next, shows a counter, and enables the one final Send only when both have answers. Back/Next focuses the arriving fieldset so keyboard users can Tab into its answers. Switching cases clears the simulated question draft, unless a delivery is already in flight. Ordinary messages remain separate from answers.

The simulated transcript is a display string assembled from prompt labels, selected option labels and typed text. It is **not** a runtime `SessionInteractionResolution` and does not exercise delivery/cancellation or real redirection; the overlay and Undo remain fixture-local. Selection and navigation never submit. Failure retains the answers for explicit retry.

## Shared conversation overlay

- `components/chat/session-peek-dialog.tsx` owns the modal shell, title, promotion action, Escape isolation and return-focus behavior. Both this prototype and the existing production `SubagentPeekDialog` use it.
- The production subagent overlay retains the shared `AgentModelLine` model/effort display in its header, adopts the child and mounts the real `ChatPlane`, with its existing Session-keyed draft, message/queue/steer, pending interactions, attachments and model controls. It inherits the parent's project/ticket scope and file/tab callbacks, and closing it leaves the resident child client alive. Its composer dock is capped and scrollable so a question or long draft cannot cover the modal header in a short window; the ordinary tab layout is unchanged.
- `conversation.tsx` is the **lab-only adapter**: source-message fixtures rendered through `ChatTurn`, plus the real controlled `SessionComposer`. It never adopts a Session or sends IPC. Successful simulated messages append only to that fixture's local conversation; failure keeps the text for retry. Drafts and in-flight sends survive closing/reopening and remain keyed to the recipient. Ordinary messages do not resolve a pending question, and the card's answer draft remains separate.
- The lab's Send outcome control applies to both answer sends and conversation messages. Its fixed model/disabled attachment supply intentionally does not pretend to simulate production model selection, queueing or attachments.

## Both sidebars, with ticket folders (`#session-peek-sidebars`)

The v2 wireframe drew the peek over a flat list of four fixture rows. `scratches/session-peek-sidebars.tsx` puts it in the sidebar it has to live in: the Active band, the Previous band grouped into ticket folders (VC-69), and the in-ticket rail's Sessions block with its record folded under the eyebrow (VC-406), all in the VC-402 row language (the vendor's mark carries the state; PR #568, closed unmerged).

- Band membership, order and grouping come from the shipped `buildActiveSessionListing` and `groupPreviousByTicket` over `sidebar-corpus.ts`. The rows (`sidebar-rows.tsx`) are lab rows on the shipped primitives and geometry; their module comment lists the three places they differ.
- `use-peek-controller.ts` is the v2 controller, lifted out of the wireframe so both scratches run on one. Its extensions (`canPeek`, `canPin`, `warmDwell`, `onRowKey`, `layoutKey`) are opt-in; the wireframe passes none and its tests are unchanged.
- A folder's peek is the question this scratch adds, as a control: the ticket with a line per Session (`ticket-card.tsx`, proposed), the newest Session with a pager, or nothing. Folder peeks are read-only, and expanding a folder closes its card. The rules are pure and tested in `sidebar-model.ts`.
- Active and the rail draw ONE two-line row (the shipped `ListRow`, 52px — v2's row): the mark centred in a 24px slot, the second line `VLT-14 · 2m ago` in the row's own `text-ui`, and no state words anywhere under a title — the mark carries the state. In the rail, the ticket is the page, so the line is only the age.
- `row-mark.tsx` draws the mark three ways. `badge` is v2's `SessionGlyph` exactly (tile, 16px logo, spinner/question/warning/idle-circle badge); `ink` is VC-402's. The two still in contention are also drawn side by side on the live rows, in the scratch's "Status ink or logo + badge" panel. The status→ink map is a LAB COPY of #568's `ink` column; production reads it from `ui/status-dot.tsx`.
- `card.tsx` has ONE GRID for every strip and block, exported for `ticket-card.tsx`: a 12px inset, a 24px lead column then 8px (text always starts 44px in), 12px between blocks, 8px inside a block and on the thin strips. Block icons centre on the lead column; ghost buttons' icons are pulled onto it. It also gained opt-in props (`glyph`, `accessory`, `canReply`, `canViewConversation`, `showTicket`); every default is the v2 card.

## Attach the production peek to VC-406, do not replace its roster

- `components/ticket/ticket-sessions-panel.tsx` owns the ticket scope, attention ordering, filter and Earlier/history fold. `components/sidebar/active-sessions.tsx` and `active-session-listing.ts` own the project bands. The lab's right-hand **state gallery** intentionally exercises different states; it is not the production ticket query.
- Preserve the chat/terminal kind and `SessionProvenanceMark`, rename, drag, context menu, Resume, and normal click/Enter activation. An inert closed-terminal history row must not acquire a live Open/Send action merely because it has a preview.
- Use VC-406's `sessionActivityIsLive`, `sessionAttentionRank`, and `sessionActivityDotState` at the real-data boundary. Do not infer liveness from an open tab or attachment. The four fixture states are not a production state union.
- The provider-plus-state composite glyph remains a visual experiment. The existing production `StatusDot` owns activity tone/motion; integrating this composite must reconcile it with that shared primitive rather than introducing a second production status map.
- Attach hover/focus behavior to the existing row without stealing focus, consuming its context-menu/drag gestures, or replacing its activation. Resolve positioning against the actual scroll containers, not the fixture page's global selectors.
- Summary freshness, pending-interaction identity, delivery/cancellation and whether Undo is supported remain runtime contracts. The lab conversation adapter reads source-message fixtures; unlike the production subagent overlay, it is not a live Session renderer.

No VC-406 files, production roster components, or UI primitives were modified. Production edits are limited to the shared chat overlay, its subagent host, and the ChatPlane mount/preview containment; there are no new IPC or runtime contracts.
