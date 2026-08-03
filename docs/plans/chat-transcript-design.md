# Chat transcript design

Decisions for the Session chat surface, made against the `labs/chat-ui` draft. Research inputs: OpenCode (TUI + web), T3 Code, Codex (CLI source + desktop), Cursor, Claude desktop. Design lenses: interface-craft, emil-design-eng, apple-design.

Status: agreed, not yet implemented. The code in `apps/desktop/src/renderer/lab/` is the draft this replaces.

## The rule

> A caret means process you can audit. A border means an object you can act on. Bare text means the answer.

Today a border means nothing — the todo dock, the tool detail drawer and the dead `ai-elements/tool.tsx` card all have one and none of them signal the same thing. Three shapes follow from the rule:

| Shape | Border | Collapses | Used for |
| --- | --- | --- | --- |
| **Row** | no | yes, by default | reasoning, read-only exploration, folded turn headers |
| **Line** | no | no | a first-class tool that succeeded |
| **Card** | yes | no | the turn's artifact, and anything needing attention |

## Turn anatomy

A turn reads top to bottom: activity → prose answer → artifact card → attention card (if any) → actions row.

Only the final answer renders as prose. Mid-turn narration folds into the activity block, following Codex's `phase: Commentary | FinalAnswer` split. This is a data-model decision, not a styling one — the adapter must classify assistant text before the renderer sees it.

## Density: one flat list, one bundle

Superseded 2026-08-03. The transcript was four nested levels — turn fold over block over group header over rows — with a fold mechanism at each. Every level needed its own spacing rule and its own left edge, and they composed into a rhythm no single rule could fix. The build is now flat.

**The list.** Two kinds of thing: what the agent said, and one **bundle** per contiguous run of everything else. Nothing else. Reasoning is a row inside a bundle, not a shape of its own.

**One left edge.** A bundle's rows sit at exactly the summary's left edge, and an expanded payload is a flush framed card rather than a rule hanging off a margin. Depth is never spelled as indentation — the caret and adjacency say it. Opening something makes the list longer instead of making it a tree.

**Rest and live are the same one row.** A bundle rests as `Read 4 files, ran 3 commands, edited activity.ts` — phrases per kind in first-appearance order, so the sentence tracks the work. Durable kinds are *named* up to `NAMED_SUBJECT_LIMIT` and counted past it: the deliverable is the point of the row, and `edited 2 files` makes you open it to find out what the turn was for. While a turn streams the same row carries the whole report, taking the present participle for the kind still in flight — `Read 2 files, running 1 command…` — and ticking in place. It never auto-expands; watching the work is a click, not a default.

**Height is capped, not folded.** An open bundle scrolls inside itself past `BUNDLE_CAP`, and a tool payload past its own. Expanding must not cost the reader their place, and a cap does that without hiding anything behind a count.

**Turns are not folded at all.** Every agent message stays in view; navigation is the minimap, not truncation. `foldTurn`, `foldRun` and `rollingTail` are gone.

Open state is derived — `userOpen ?? bundleNeedsAttention(rows)` — never animated into and never raced against a timer, so a restored 200-turn session fires no transitions at boot and a bundle holding a failure is open before anyone asks. An approval request is the one thing that leaves the bundle: it blocks the reader, so it must not sit behind a disclosure at all. Failures stay inside, confessed in red by the summary.

**Two spacing constants.** 12px between segments *and* between messages — OpenCode splits one reply into a message per step, and a wider gap at that seam would put 24px between two bundles and 12px between two others purely on where the harness cut the stream. 2px between rows inside a bundle. There is no third value.

## Tool lines

Formula: `‹status› ‹icon› ‹Verb› ‹object›` left, `‹meta›` right.

The meta slot is the whole gap between us and the reference apps. Codex and Cursor put a number in every resting line — `+497 −167`, `14 in 6 files`, `exit 1`, `2.4s`. Our rows currently have no meta slot at all.

**Two click targets.** The row expands a tool-specific body inline. The mono object — the path, the command — opens the real artifact in a tab or the terminal pane. Both revealed on hover.

| Kind | Collapsed | Meta | Expanded |
| --- | --- | --- | --- |
| run-command | `Ran  pnpm test` | `2.4s`, or `exit 1` in destructive | output only — the command is already the headline |
| edit-file | `Edited  src/index.ts` | `+49 −12` | unified diff, changed hunks with 3 lines of context |
| write-file | `Created  src/new.ts` | `+41` | file content |
| read-file | `Read  src/index.ts` | `1–48` only when partial | the slice, with line numbers |
| search | `Grepped  useSession` | `14 in 6 files`; `no matches` in muted, never an error color | grouped by file, ≤3 lines each |
| list-directory | `Listed  src/` | `12 entries` | the listing |
| fetch-url | `Fetched  example.com` | size when the harness reports bytes, else duration | the fetched content |
| delegate | `explore  Find the streaming seam` | duration; child count when a harness reports one | nested transcript at one indent, then the subagent's answer |
| plan | — | — | hidden from the transcript; projects to the rail |
| other | `linear_create_issue  VC-12 chat seam` | duration | dim inline signature, Codex-style: `({"query":"…","limit":3})` |

Rules that hold across all of them:

- **Raw JSON is never the default view.** Only `other` may show it, compact and dim, and only in the detail.
- **Never show a lie while streaming.** `+0 −0` on an in-flight edit is worse than no meta.
- Paths render dim-directory / bright-basename so long paths stay scannable under truncation.
- Verbs are sans; objects and meta are mono. One string, one treatment.
- Meta numerals get `tabular-nums` so live counters don't jitter.
- `delegate` is the only tool whose object swaps while running — it shows the subagent's last tool line.

## Reasoning

No collapsible. The model's own first `**bold**` line becomes the status verb — OpenCode's TUI (`reasoningSummary()`, regex `^\*\*([^*\n]+)\*\*`), Codex (`extract_first_bold`) and Cursor all converge on this independently.

- Live: `· Checking the reducer`, pulsing dot, **no number**.
- Settled, header found: one dim line, `· Checking the reducer   4s`.
- Settled, no header: `· Thought for 8s`.

Full reasoning text stays in the durable transcript for the inspector. It does not render in the feed. Reasoning markdown must be neutered where it does render — a footnote must never out-bold the answer, which is the bug behind the current `Thought / **Marking task complete**` screenshot.

### Four rules the row must not break

Surveyed against Codex (`codex-rs/tui`), Zed (`crates/agent_ui`), OpenCode's TUI and desktop client, and t3code. They disagree about almost everything else and agree on these.

1. **A live thought carries no number.** None of the five runs a ticking counter beside reasoning text that is still growing. OpenCode shows a spinner and prints the duration only once the server sets `time.end`; t3code puts its ticking timer in a separate row; Codex pins the elapsed/interrupt segment and appends variable text *after* it, with the comment that core affordances must stay in a fixed visual location. Ours ticked at 200ms — five React commits a second to animate a number — and, because the row was a shrink-wrapped flex item, a growing verb pushed that number across the screen.
2. **The row fills its container.** `flex-1`, always. `ml-auto` only pins the meta to the right edge if there is a right edge to pin to.
3. **An empty reasoning part renders nothing.** Zed returns early on `trim().is_empty()`; OpenCode's TUI guards `<Show when={content()}>`. The placeholder belongs one level up, at the turn — that is where OpenCode's desktop client, Codex and t3code all put it, and it is why a reasoning part is never asked to hold the floor while empty.
4. **A header only ever replaces a complete header.** Codex's `extract_first_bold` returns `None` while the closing `**` is missing and the delta handler early-returns rather than writing a partial one. The promoted line is anchored to the start of the part, not to any line: a provider emits one summary per part, so a bold phrase opening a later line is body text, not a title.

Related, and load-bearing: any component that paints text through `bg-clip-text` must keep the words on a layer with a real `color`. A single-element shimmer has to set `color: transparent` for the clip to show, which makes the gradient the sole source of colour — and then one unresolvable token (a `@theme inline`-pruned `--color-*`, or `currentColor`, which by then *is* the transparency) drops the declaration and the text renders as nothing at full width. Split into base + `aria-hidden` overlay, the worst case is a line that does not shimmer. This failure is invisible to jsdom and to the fixture gallery — the text is in the DOM the whole time — so only a real browser reading computed style catches it.

### Three columns, three jobs

Left glyph says what happened. The caret sits **against the label it opens**, inline. The far right belongs to the number alone.

Parking the caret at the right edge — which container rows and leaf rows each did in their own way — makes it share that edge with the meta, and durations then land on as many different margins as there are row shapes. Perplexity's transcript settles it the same way: `Searching Cursor Anysphere valuation 2026 ›` with `1m 32s` alone on the right.

**Duration is the fallback meta and is thresholded at 1s.** Sub-second work is instant, and instant needs no number; `3ms` on a read spends the column on noise and leaves the eye hunting for `exit 127` among numbers that never mattered. Zed gates its stopwatch at 30s for the same reason, and Perplexity shows a duration on one row in a turn. Semantic metas (`+49 −12`, `exit 1`, `14 in 6 files`, `12 entries`) are never thresholded — they say what happened, not how long it took.

## Attention

Errors, denials and approval requests **always** break out as a full-width card. They can never sit inside a rolling window or a folded group.

The card carries a right-aligned action plus the escape hatch: **"No, and tell it what to do differently"** — which converts a refusal into steering rather than a dead end. After the decision resolves, the card leaves a one-line receipt in scrollback (`✓ You allowed rm -rf node_modules this time`) so the transcript stays an honest record of what was authorized.

Folded headers confess outcomes: `Explored 4 reads · 1 failed`. A collapsed group may hide detail; it must never hide outcome. This requires `activitySummary` to return `{text, tone}[]` rather than a string.

Approval-pending must never share a glyph with running.

## Composer

```
┌──────────────────────────────────┐
│ 1 Queued  ⏎ to send    ✎  ×     │   ← only while a turn is live
│ also add a test for the…         │
├──────────────────────────────────┤
│  Ask, plan, or implement…        │
├──────────────────────────────────┤
│ ⊕  [ Build │ Plan ]  sonnet-4.5 ⌄│
│                       ■    [ ⌷ ] │
└──────────────────────────────────┘
```

- **Model** — one pill. Provider folds in as a `CommandGroup` heading; effort folds into the pill label and appears as a segmented control on the selected row inside the popover. Codex's shape: two values, one caret.
- **Mode** — segmented Build / Plan. Renders nothing when the harness declares fewer than two primary agents.
- **Delivery is not a control.** It is session state. Idle: `⏎` sends. Working: the submit glyph becomes Queue, `⏎` queues, `⌘⏎` steers (injects without interrupting), `⌫` on an empty box unqueues. Stop sits beside submit only while working.
- Five native `<select>` elements are deleted.

**Which agents are user-facing is a harness-declared fact, not a denylist.** OpenCode marks `compaction` / `title` / `summary` with `hidden: true` and `general` / `explore` with `mode: "subagent"`; its own picker rule is `a.mode !== "subagent" && a.hidden !== true`. Our adapter already captures both flags (`opencode-adapter/src/index.ts:1944-1946`) — the renderer simply never filters on them. Filtering on declared facts means harness #2 gets correct behavior with no code change.

## Artifact card

Ends a turn that touched files:

```
┌──────────────────────────────────┐
│ ⊞  Edited 3 files      +49 −12   │
│                 Undo ↺  [Review] │
├──────────────────────────────────┤
│ packages/opencode-adapter/       │
│   src/index.ts           +31 −8  │
│ renderer/lab/chat/               │
│   activity.ts            +12 −4  │
└──────────────────────────────────┘
```

`Undo` reverts that turn's edit set. `Review` switches the rail to the existing `changes` mode scoped to this turn.

Direction, not this cycle: Codex treats Review as an *agent turn* — per-hunk comments that the agent addresses on its next turn, with `ReviewTarget` including `Last turn`. That matches the product thesis better than a diff viewer and is the intended upgrade. Establishing the card now makes it a swap rather than a rebuild.

## Rail

The session rail is a fifth `TICKET_RAIL_MODES` entry — `session` — gated in `ticket-rail-model.ts` so it is offered only when the active tab is a session tab, with `selectRailMode` falling back otherwise. That module already owns the mode-vs-active-tab relationship, so the gate costs one rule and stays unit-testable.

It holds only what has no other home: **Plan**, **Subagents**, **Background processes**. Changes and files stay in the rail modes that already own them.

Deleted: the bespoke `<aside>` in the scratch (a duplicate of `ticket-detail.tsx:859` minus resize, minus persisted width, minus the mode strip), the `ChatPlane` header (a third chrome band whose content is a word the tab already says), and `ContextRail` / `DebugRail`. Session id, attachment id, receipts, capability inventories and wire events move to Settings → Diagnostics.

The principle, from Codex: **the transcript holds this turn's narrative; standing state is consulted, not monitored.**

## Materials, type, motion

**Layer ladder.** popover (`--popover`, `--shadow-overlay`) › composer + plan dock as *one* surface (`--card`, `--shadow-raised`) › transcript (`--background`, flat) › rail (`--sidebar`, opaque, no blur). Tailwind's stock `shadow-lg` / `shadow-md` are off-system and get replaced.

The plan dock is not a second card floating on the composer's scrim — that is stacked translucency, which the design language forbids. It is the composer's header row: one surface, one border, one shadow.

The bottom scrim (`bg-gradient-to-t from-background via-background`) repaints the card rung over itself and reads as a grey wash. Replace with a scroll mask keyed to a measured `--composer-height`, which also removes the magic `bottom-36` that breaks the moment the dock expands.

**Two registers.** Prose is sans / `--foreground` / `text-sm`, centered on `<ContentColumn>` (`--container-content`, 45rem). The chat currently uses `max-w-3xl` (48rem) in four places — 3rem wider than every other Tier-A surface in the app. Machine rows are mono / `text-xs` / muted, with the **object** promoted to `--foreground`, not the verb. This is currently inverted: `activity-ui.tsx:130` paints the predictable half loud.

`text-label` (11px, +0.05em) is a caps-label token and is banned from the transcript.

**Motion.** One caret glyph (Phosphor, `rotate-90` on open) — never swap glyphs, which cannot animate and reads as a flicker. One collapse constant at 400ms on `--ease-swift`, with opacity leading height. Currently there are two different delays for the same gesture (800ms in `activity-ui.tsx`, 1000ms in `reasoning.tsx`) and `animate-collapsible-down` resolves to tw-animate-css stock `.2s ease-out` with no opacity channel, so text is clipped mid-glyph.

Replace the auto-collapse timer with derived state — `const open = userOpen ?? streaming` — so it is interruptible by construction rather than racing a `setTimeout`.

Rail open/close keeps the panel mounted at `width: 0` and springs the width (`bounce: 0, duration: 0.35`); it currently unmounts, so the transcript measure jumps 300px in one frame.

## The activity seam

The engine is harness-neutral only by being empty — it carries `UIMessage` opaquely, and every scrap of harness knowledge lives in the renderer across three separate copies of the same tool-name list (`EXPLORE_TOOLS`, `countToolFamilies`, `verbForTool`).

The proof the seam is missing: OpenCode's `todo.updated` is a first-class native event, but the adapter manufactures a fake assistant message with a fake `toolName: "todowrite"` part (`index.ts:1179`) purely so the renderer's string matching finds it.

**Fix:** a closed `ActivityKind` set in `@volli/shared`, with each adapter owning its own mapping table and stamping a descriptor into a reserved `volli.activity` metadata key. The slot already exists and round-trips — no engine change, no RPC change, no migration.

```ts
export const ACTIVITY_KINDS = [
  "run-command", "read-file", "edit-file", "write-file",
  "search", "list-directory", "fetch-url", "plan", "delegate", "other",
] as const;
```

OpenCode's table is ~15 lines. The renderer ends with zero tool-name literals, and harness #2 never touches React.

**`other` is first-class, not degraded.** Same component, same layout, generic icon. The adapter guarantees a subject label from any string scalar in the input, so an unknown MCP tool reads `linear_create_issue  VC-12 chat seam` rather than a blob.

T3 Code independently validates adapter-owned normalization: its `itemTitle()` / `titleForTool()` mint `"Ran command"` / `"File change"` / `"Subagent task"` server-side per adapter, so the client never sees a provider's tool vocabulary.

## What OpenCode actually reports

Verified against OpenCode's tool sources while implementing the adapter. `outcome` is null unless the tool status is `completed` or `error`.

| Field | Source |
| --- | --- |
| `exitCode` | `metadata.exit` (bash) |
| `matchCount` | `metadata.matches` (grep) |
| `fileCount` | `metadata.count` (glob) · `metadata.display.totalEntries` (read of a directory) |
| `lineCount` | `metadata.display.totalLines` (read of a file) |
| `addedLines` | `metadata.filediff.additions` (edit) · derived from input line count when `write` reports `exists: false` |
| `removedLines` | `metadata.filediff.deletions` (edit) |
| `diff` | `metadata.diff` — edit only; `write` reports none |
| `bytes`, `summary` | **never reported** |

Two consequences the UI must respect: `fetch-url` falls back to duration rather than showing a size, and `delegate` shows duration alone. `subject.lineRange` appears only when `display.truncated === true`.

Known gaps in the contract, worth closing before a second harness lands:

- `delegate` has no `subject.agentName` or `outcome.childCount`, so the subagent name rides `nativeToolName` and any child count would ride free-text `summary`. That is stringly-typed where it should be structured.
- `readActivityDescriptor` normalizes `diff` through the same trim used for labels, so a stamped diff loses its trailing newline. Content and labels should not share a normalizer.

## Bugs this fixes

Found during the audit, all verified in source:

1. `activity.ts:161` — `toolRowLabel` returns OpenCode's `title` as the verb *and* computes `primaryToolObject`, printing the same string twice (`git status --short git status --short`). Worse, `title` is the **result sentence**, not a label — which is why an edit row's header reads `Success. Updated the following files: A CONTRIBUTING.md`. Derive verb and object from kind + input; the result belongs in meta.
2. `opencode-adapter/src/index.ts:1738` — `pending` and `running` both map to `input-streaming`, and `input-available` is never emitted. A running tool shows the dim idle circle for its entire life.
3. `activity.ts:77` — explore tools fold into the group regardless of state, so a failed read inside `Explored 4 reads` is invisible and the summary still claims success.
4. `activity-ui.tsx:195` — `approval-requested` renders the same spinner as `input-available`: the state needing a human looks identical to the state needing nothing.
5. `ai-elements/tool.tsx` — zero importers. Delete.
6. `activity.ts:25` — `FIRST_CLASS_TOOLS` is never read; `groupMessageParts` falls through by default. `"mcp"` could never have matched, since MCP tools are named `<server>_<tool>`.
7. `chat-session.tsx:265` — `aria-pressed={!inspectorOpen}` is inverted.
8. `index.ts:972` — `#bufferMessage` drops token/cost/model metadata, so there is nothing to build a turn header from.
9. `chat-markdown.tsx:186` — file mentions differ from inert code spans by one token. They must read as clickable: no border, dotted underline, accent on hover.
10. `reasoning.tsx` imports lucide icons in an otherwise-Phosphor codebase.
11. Clicking a row after selecting output text collapses it — needs a `getSelection()` guard.

## Sequence

**P0 — correctness and structure**
Delete `ai-elements/tool.tsx`. Fix the label bug, the `input-available` mapping, the attention escape, the inverted `aria-pressed`. Land `ActivityKind` in shared plus the OpenCode mapping table. Per-kind presenters replacing `ToolDetail`. One rail via the gated `session` mode; delete `ChatPlane`'s header and `DebugRail`.

**P1 — register and control**
Reasoning as status verb. Two type registers on `<ContentColumn>`. Composer: model pill, Build/Plan segment, queue/steer. Artifact card. File-mention treatment. On-system shadows, easing, caret.

**P2 — craft**
Composer and dock as one surface; scroll mask on `--composer-height`. Derived-state collapse with the off-screen guard. Rail width spring. Transcript as one focus stop with ↑/↓ traversal; Esc interrupts from anywhere. `prefers-reduced-transparency` and `prefers-contrast` blocks.

## Coverage

`packages/shared`, `session-engine`, `session-rpc` and `opencode-adapter` all hold 100% thresholds on `src/**`, and the adapter's part-mapping tests are exact-object assertions — adding a metadata key breaks roughly six of them, and changing the `running` mapping breaks the lifecycle test. `apps/desktop/src/renderer/lab/**` is not in the protected list, so the UI work itself is ungated. Run `vp run -r test:coverage` before pushing; a green `vp run -r test` says nothing about it.
