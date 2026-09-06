# Split View for tabs (VC-202) — design of record

Status: implementation in progress on `volli/VC-202-integrate-split-view-for-tabs-inside-volli`.
This document is the contract the implementation phases build against. Where code and this
document disagree mid-flight, the phase brief and the reviewer's comments on VC-202 win.

## What we are building

Both tabbed surfaces — **Home** (out-ticket) and a **ticket workspace** (in-ticket) — learn to
split their main area into multiple **panes**, each pane holding a subset of that surface's tabs
with its own active tab:

1. **Drag a tab into the main area** → clearly demarcated drop zones appear (per pane: center /
   right edge / bottom edge). Dropping on an edge splits that pane; dropping center moves the tab
   into that pane. Same drag started from any pane's strip.
2. **The right rail is reactive**: it reads its context (`activeTabId`) from the **focused pane's
   active tab**. Clicking into a pane focuses it; the rail follows.
3. **Keyboard shortcuts + a surface menu**: `⌘\` splits the focused pane right, `⇧⌘\` splits
   down; the new pane is empty and shows a Codex-style menu of surfaces to open (New chat `⌘T`,
   New terminal `⌥⌘T`, Open file… `⌘P`), each row also reachable by its existing global chord
   because an empty pane is the focused pane. `⌃⌘←/→/↑/↓` moves pane focus.
4. **Drop from the sidebars**: session rows (sidebar Active/Previous bands, the rails' session
   lists) and file rows (rail Files navigators) drag natively into the same drop zones, so a
   split opens without opening a tab first.

### Grounding (researched precedent)

- **VS Code** `editorDropTarget`: a translucent overlay per editor group; pointer near an edge
  previews the half that a split would create, center previews the whole group (merge). Editors
  open into the *active* group; dropping activates the dropped editor. `⌘\` = Split Editor.
- **Zed**: `cmd-k <arrow>` splits, `cmd-k cmd-<arrow>` moves focus between panes; tab drags onto
  pane hot zones split with a drawn overlay.
- **In-app precedent**: terminal tabs already split internally (Ghostty-derived, `⌘D`/`⇧⌘D`,
  "Split Right"/"Split Down" — right/down only), with an active-pane ring and a rAF-coalesced
  divider. The surface-level split view deliberately reuses that vocabulary (right/down splits,
  same ring treatment, same divider mechanics) so the app has one splitting grammar.

### Deliberate constraints (v1)

- Splits create panes **right or down only** (matches the in-app terminal grammar and VS Code's
  default `openSideBySideDirection`). Consequence: the **primary pane** — the one holding the
  permanent tab (Home's Board, a ticket's Body) — is always the top-left leaf, so the existing
  full-width top strip remains the primary pane's strip and the chrome metaphor survives.
- The permanent tab (Board / Body) never leaves the primary pane and still never drags.
- A surface with **no split** (`splitView: null`) must behave byte-for-byte as today: same
  strip, same single plane, same store writes. Splitting is strictly additive.
- Ticket detail still takes Home over full-bleed; each surface owns its own split state.
- Terminal-focus zen mode still hands the whole canvas to one terminal; panes hide behind it.
- Tabs never move between surfaces (a ticket tab cannot land on Home, and vice versa).

---

## 1. The pure model — `packages/shared/src/split-view.ts`

Pure, exhaustively tested (the shared package sits under the 100% coverage gate), exported via
`packages/shared/src/index.ts`. No DOM, no React, no Date/random except the injected minter.

```ts
export type SplitViewDirection = "row" | "column"; // row = side-by-side (vertical divider)
export type SplitViewEdge = "right" | "down";

export interface SplitViewPane {
  kind: "pane";
  id: string;
  /** Tab ids assigned to this pane, in strip order. Ids may name nothing (tolerant read). */
  tabIds: readonly string[];
  /** The pane's front tab, or null (empty pane / never chosen). */
  activeTabId: string | null;
}

export interface SplitViewBranch {
  kind: "split";
  id: string;
  direction: SplitViewDirection;
  /** first's share, clamped to [0.15, 0.85]. */
  ratio: number;
  first: SplitViewNode;
  second: SplitViewNode;
}

export type SplitViewNode = SplitViewPane | SplitViewBranch;

export interface SplitViewState {
  root: SplitViewNode;
  /** A pane id; sanitize falls back to the primary pane. */
  focusedPaneId: string;
}
```

Operations (each identity-stable — returns its input when nothing changed):

- `splitPane(state, paneId, edge, opts, mintId)` — replace the pane node with a branch
  (`right` → row, `down` → column, ratio 0.5); `opts.tabId` moves that tab into the new pane
  (removing it from its old pane, collapsing that pane if emptied and non-primary); otherwise the
  new pane is empty. The new pane becomes focused; its active is `opts.tabId ?? null`.
- `activateTab(state, tabId)` — focus the pane holding `tabId` and make it that pane's active.
  If no pane holds it, assign it to the focused pane (append). **This is the write-through
  primitive** behind every existing "make this tab active" store action.
- `moveTabToPane(state, tabId, paneId)` — append `tabId` to `paneId` (no-op if already there and
  last), remove from source (collapse source if emptied and non-primary), focus target pane and
  activate the moved tab (a dropped tab is the one you meant to look at).
- `removeTab(state, tabId)` — drop the id wherever it appears. If it was its pane's active, the
  successor is the next id in that pane, else the previous. A non-primary pane emptied by this
  collapses (its branch is replaced by the sibling). Used by every tab-close write-through.
- `closePane(state, paneId)` — collapse the pane outright (empty-pane × / its menu row). The
  primary pane never closes.
- `renamedTabInSplitView(state, fromId, toId)` — the split-view twin of `renamedTabOrder`:
  preview-slot substitution and file rename swap a tab's id in place; the pane assignment must
  follow or the tab teleports to the primary pane. Absorb an existing mention of `toId`.
- `setSplitRatio(state, splitId, ratio)` — clamp to [0.15, 0.85].
- `focusPane(state, paneId)` / `focusAdjacentPane(state, direction: "left"|"right"|"up"|"down")`
  — the latter walks the tree geometrically (same approach as
  `apps/desktop/src/renderer/src/terminal/pane-navigation.ts`; copy the algorithm shape, do not
  import renderer code into shared).
- Readers: `splitViewPanes(state): readonly SplitViewPane[]` (in-order), `primaryPaneId(state)`,
  `paneForTab(state, tabId): string | null`, `isSinglePane(state)`.
- `sanitizeSplitView(raw): SplitViewState | null` — tolerant shape-only read of persisted JSON:
  valid tree, ratios clamped, duplicate tab ids across panes deduped (first mention wins),
  `focusedPaneId` must name a pane else primary, depth > 6 or panes > 8 ⇒ `null` (degrade to
  unsplit rather than draw a pathological tree). Never prunes tab ids against live tabs — a
  Session that has not hydrated yet looks exactly like one that is gone (`tab-order.ts` rule).
- `resolveSplitView(state, orderedTabIds, permanentTabId): ResolvedSplitView` — the render-time
  projection. `orderedTabIds` is the surface's composed+arranged live tab list (permanent tab
  first). Per pane: keep only ids that exist, in the pane's own order; ids no pane claims append
  to the **primary** pane in `orderedTabIds` order; the permanent tab is always the primary
  pane's first tab. Pane active resolves to its `activeTabId` when present, else its first
  present id, else (primary) the permanent tab, else null (renders the empty-pane menu).
  Resolution never mutates persisted state and never collapses panes — an empty resolved pane
  draws the menu (this is also what a pane full of dead terminal ids renders after relaunch).

`mintId` is an injected `() => string`; renderer callers pass `() => crypto.randomUUID()`.

### Collapse-to-null convention (the compatibility keystone)

The workspace store holds `splitView: SplitViewState | null` per surface; `null` means "never
split / no longer split" and **every existing code path runs untouched**. After any model op the
store checks `isSinglePane(next)`: if true it writes the surviving pane's `tabIds` into the
surface's existing `tabOrder` overlay (so the merged strip keeps the order the panes had) and
resets `splitView` to `null`. While `splitView` is null, no write-through happens at all.

## 2. Workspace store integration — `stores/workspace.ts`

New state:

- `WorkspaceUiState.homeSplitView: SplitViewState | null` (default null).
- `TicketTabsState.splitView: SplitViewState | null` (default null; lives inside the existing
  per-ticket record so `forget`/prune semantics hold).

Both persisted (an arrangement is deliberate — same argument as `tabOrder`), sanitized via
`sanitizeSplitView` in `sanitizePersistedUi` / `sanitizeTicketTabs`, included in `partialize`,
and counted in `isDefaultPersistedUi` / `isEmptyTicketTabs` (`null` = default).

New actions (thin over the model; Home and ticket twins):

- `splitHomePane(projectId, paneId, edge, opts?: { tabId?: string })` /
  `splitTicketPane(projectId, ticketId, paneId, edge, opts?)` — materialize
  `splitView` from null as a single pane first (root pane id `"root"`, focused).
- `moveHomeTabToPane(projectId, tabId, paneId)` / `moveTicketTabToPane(…)`.
- `focusHomePane(projectId, paneId)` / `focusTicketPane(…)` — also syncs the surface-level
  active tab to the newly focused pane's active (see invariant below).
- `focusAdjacentHomePane(projectId, direction)` / `focusAdjacentTicketPane(…)`.
- `setHomeSplitRatio(projectId, splitId, ratio)` / `setTicketSplitRatio(…)`.
- `closeHomePane(projectId, paneId)` / `closeTicketPane(…)`.
- `moveHomeTabInPane(projectId, paneId, movedId, ids)` / `moveTicketTabInPane(…)` — a strip
  reorder inside one pane rewrites that pane's `tabIds` (sanitized to strings; the drop handler
  hands the pane's movable ids in drawn order, exactly as `moveHomeTab` does today for the
  surface). The surface-level `tabOrder` is untouched while split.

**The invariant**: while `splitView !== null`, the surface-level active tab
(`homeActiveTab` / `ticketTabs[id].active`) **equals the focused pane's active tab**. Every
existing action that writes the surface active (`setHomeActiveTab`, `openHome`, `openHomeBoard`,
`previewHomeFile`, `pinHomeFile`, `activateHomeFile`, `openTicket*`, `setTicketActiveTab`,
`openTicketFile/Diff`, `previewTicketFile`, …) additionally runs `activateTab(splitView, tabId)`
(assign-to-focused when unassigned; focus the holding pane otherwise). Every close action
(`closeHomeFile`, `closeTicketFile/Diff`, and the session/chat tab closes routed through the
surfaces) runs `removeTab`. `renameHomeFile` / `renameTicketFile` / preview substitution run
`renamedTabInSplitView` beside their existing `renamedTabOrder` call (workspace.ts's
`orderAfterFileTabs` is the seam — give it a split-view twin next to it).

While split, the close-return path changes shape: if the closed tab's pane still has tabs, the
pane's successor (from `removeTab`) is the new surface active; if the pane collapsed, the newly
focused pane's active is. The MRU `homeTabHistory` return applies only while unsplit
(`splitView === null`), where behavior is unchanged.

`openHomeBoard` while split: Board lives in the primary pane — focus the primary pane, activate
Board there, clear `openTicketId` (unchanged semantics otherwise).

Sessions-store sync stays surface-level and untouched: a terminal tab activated in any pane
still calls `setActiveSession(ownerId, tabId)` (the container's notion of "front terminal" now
means "most recently activated terminal tab", which is exactly what zen focus and
`resolveHomeTabs`' fallback want).

## 3. Rendering — both surfaces

New components under `apps/desktop/src/renderer/src/components/split/`:

- **`split-view-grid.tsx`** — recursive renderer of `ResolvedSplitView`: a branch is a
  flex row/column with a `SplitViewDivider` between the two children (sized
  `flex: 0 0 calc(ratio*100% - 3px)` / `flex-1`, exactly the terminal split's math); a leaf is a
  cell rendered by the caller through two slots: `renderStrip(pane)` (null for the primary pane —
  its strip is the surface's existing top strip) and `renderContent(pane)`. The cell wraps
  content in a focus boundary: `onPointerDownCapture` → `focusPane` (capture so clicking a
  terminal, Monaco, or a chat composer all focus the pane without stealing the event), plus the
  focused ring when >1 pane: focused `ring-1 ring-primary/50 ring-inset`, unfocused
  `ring-1 ring-border/50 ring-inset` (the terminal split's exact vocabulary).
- **`split-view-divider.tsx`** — lift of `SplitDivider` from
  `components/sessions/session-split-layout.tsx` (rAF-coalesced pointer drag, keyboard arrows,
  `role="separator"`, min-pane clamp — use 240px min pane size for surface panes). The terminal
  file keeps its own copy for now (do not destabilize it); a follow-up may unify.
- **`pane-empty-state.tsx`** — the Codex-style surface menu, centered in an empty pane: rows
  (icon + label + right-aligned shortcut hint) for **New chat ⌘T**, **New terminal ⌥⌘T**,
  **Open file… ⌘P**, and **Close pane** (no hint). Rows are buttons wired to the surface's
  create/open callbacks with an explicit `paneId` target; Open file… opens the existing quick
  open (⌘P palette) — the resulting preview lands in this pane because the pane is focused.
  Follow `docs/DESIGN.md` (text-ui rows, h-9, rounded-md, `bg-accent/50` hover, list width
  ~ w-72, muted shortcut hints) and the house empty-state tone: no tutorial prose.
- **`terminal-viewport-registry.ts`** — generalization of the external store in
  `components/sessions/ticket-terminal-host.tsx`: a map keyed by terminal **tab id** →
  `{ ownerId, anchor: HTMLElement }`, `publishTerminalViewport(tabId, target|null)`, one
  subscribe/snapshot pair. Multiple terminals are visible at once now (one per pane), on both
  surfaces.
- **`terminal-pane-anchor.tsx`** — replaces `TicketSessionPlane` at per-pane scope: a
  `absolute inset-0` measured placeholder that publishes its box for `tabId` while mounted
  (works for Home and ticket terminals alike).

Surface integration:

- **`sessions-layer.tsx`** — project-scope terminal tabs stop rendering `hidden`/`inset-0`;
  every `SessionSplitLayout` box is positioned over its published anchor (the
  `TicketTerminalBox` rect-sync mechanic, generalized — one `TerminalViewportBox` used by both
  scopes), staying mounted and hidden when unpublished. The Home **chat plane moves out** of
  this layer: chats mount inside their pane cells (their state is registry-resident; remounts
  are cheap by design). The layer keeps: all subscriptions/fan-outs, the overlay host for ticket
  terminals (now driven by the registry map), the pane-close guard, `handleTerminalShortcut`,
  and the `plane`/`rail` slots.
- **`home-surface.tsx`** — always hands `SessionsLayer` a `plane`: the Home split grid.
  The grid's primary cell renders whichever primary-pane tab is active — the Board included
  (BoardBoundary+Board move into the cell; `ticketTakesOver` still replaces everything
  full-bleed). Non-primary cells render their pane strips + content (chat plane / FileView /
  terminal anchor). The top `HomeTabStrip` shows the **primary pane's** tabs (partition helper
  below); its actions cluster is unchanged. While unsplit, everything renders exactly as today
  (the grid degenerates to one cell with no ring and no inner strips).
- **`ticket-detail.tsx`** — same restructure: the top `TicketTabStrip` shows the primary pane's
  tabs; the content area renders the grid; per-pane content routes by kind (body → title +
  `TicketBodyPanel` in `ContentColumn` — primary only; file → `FileView`; diff → `DiffView`;
  chat → `ChatPlane`; session → `TerminalPaneAnchor`). Per-pane editors bind their own relPath
  for dirty reports (`onDirtyChange` closures per cell — the single `activeEditorRelPath` is
  replaced by per-cell bindings). Zen (`terminalFocused`) renders the focused session's anchor
  full-bleed instead of the grid, strip and rail hidden, exactly as today.
- **Per-pane strips**: a partition helper (pure, tested —
  `components/split/split-tab-partition.ts`) takes the surface's arranged descriptors + the
  resolved view and yields per-pane descriptor lists. Secondary panes render the existing
  `TabStrip`/`Tab` primitives (folder variant, `label="Pane N tabs"`, no actions cluster); tab
  select/close/rename callbacks are the surface's existing handlers plus pane context for
  reorder (`move*TabInPane`).
- **Rail reactivity** falls out of the invariant: `activeTabId` threaded to `TicketRail` /
  `HomeRail` is the surface active, which now tracks the focused pane. No rail code changes.

## 4. Drag & drop

- **`split-dnd.tsx`** — a per-surface `SplitDndContext` (React context + one dnd-kit
  `DndContext`) wrapping the surface's strips and grid. `TabStrip` learns to detect it: when an
  ancestor provides the surface context, the strip mounts **no** DndContext of its own (its
  `SortableContext` registers into the surface's) and the horizontal/parent modifiers move to
  the surface context, applied **only while the drag is over a strip** (dnd-kit `modifiers` are
  static — so instead: no modifiers, and a `DragOverlay` tab ghost renders the travel; sortable
  siblings still shift within the source strip). Reorder drops (over a strip) route through
  `tabDropOrder` exactly as today — same-pane reorder → `move*TabInPane` (or `move*Tab` while
  unsplit); cross-pane strip drop → `moveTabToPane` (append; v1 accepts end-of-strip landing).
  Drops over a **zone** route to `splitPane`/`moveTabToPane`.
- **`split-drop-zones.tsx`** — the demarcated zones, rendered as an overlay over the grid only
  while a compatible drag is live: per pane, three `useDroppable` targets — center, right edge
  band, bottom edge band (edge bands are the outer 25%, min 48px; center is the rest). The zone
  under the pointer draws the **result preview**: center = the whole pane, right = the pane's
  right half, bottom = the bottom half — `bg-primary/10` fill + `ring-1 ring-primary/40 ring-inset`,
  `rounded-md`, fading in 120ms ease-out (opacity only), the preview rect morphing between zones
  with a 150ms ease-out transform/size transition; `motion-reduce`: no transitions. A drop that
  would change nothing (a pane's only tab onto its own center/edges) renders the center preview
  and lands as the model's identity no-op.
- **Native drag sources** (HTML5, `draggable` + `dataTransfer`; they cannot join dnd-kit and do
  not need to):
  - Sidebar session rows (`sidebar/session-band-row.tsx`) and the rails' session rows
    (`ticket-sessions-panel.tsx`, Home rail sessions page): type `application/x-volli-session`,
    payload `{ scope: "project"|"ticket", projectId, ticketId?, kind: "chat"|"terminal",
    sessionId }`. Draggable when the row is a door: chats always; terminals only while open.
  - Rail Files navigator rows (both surfaces): type `application/x-volli-file`, payload
    `{ relPath }`.
  - The zones listen natively too (`onDragOver`/`onDrop` + a window-level
    `dragenter`/`dragleave` counter to show the overlay), validate the payload **scope against
    the surface** (a ticket-A session cannot land on ticket B or Home; a project session lands
    only on Home; files resolve against the surface's own checkout), and route: chat → adopt +
    open tab in target pane; terminal → move its existing tab's pane assignment; file → preview
    + assign. Foreign payloads render no zones at all.
- Keyboard reorder within a strip (Space + arrows) is untouched; zones are pointer-only in v1
  (the `⌘\`/`⇧⌘\` chords are the keyboard path to a split).

## 5. Shortcuts — `lib/split-shortcut.ts` (pure, tested) + `hooks/use-split-shortcuts.ts`

- `⌘\` → split focused pane **right**; `⇧⌘\` → split **down** (match on `event.code ===
  "Backslash"`, reject repeats, reject while `terminalFocusTarget` is set, reject when a dialog
  is open or per the escape-guard's exempt surfaces where appropriate).
- `⌃⌘←/→/↑/↓` → `focusAdjacent*Pane` (no-repeat allowed; skipped in zen; distinct from ⌥⌘arrows,
  which remain terminal-internal pane nav).
- New splits are **empty panes** showing the surface menu; the menu's rows carry the existing
  chords (`⌘T`, `⌥⌘T`, `⌘P`) as hints — those chords already act on the surface and now land in
  the focused (= new) pane via the write-through.
- Mounted once per surface (ticket detail; Home via the always-mounted layer's neighbor — mirror
  `useNewSessionShortcut`'s placement discipline), routing to whichever surface is in front.

## 6. Copy, a11y, motion

- Zones/panes: `aria-label`s ("Split right", "Move here", "Pane 2 of 3"); dividers keep the
  separator role + arrow keys; the focused pane is also where DOM focus lives (the capture
  handler never calls `.focus()` itself — pointer-down inside already lands focus there).
- No onboarding prose anywhere: the empty pane's menu is rows of verbs, not explanation
  (CLAUDE.md "let controls talk").
- Motion per the animation decision framework: zone overlay is opacity-only 120ms ease-out;
  preview rect morph 150ms ease-out (`transform`/`width`/`height`); **no animation on
  keyboard-initiated splits** (a `⌘\` pane appears instantly — it will be used tens of times a
  day); tab drag ghost = the tab's own drawing at 1.02 scale with `shadow-overlay`;
  `motion-reduce` cancels all of it. Dividers/pane rings: the existing 150ms color transitions.

## 7. Files & tests summary (per phase)

**Phase 1 — model + store (no UI)**
- `packages/shared/src/split-view.ts` + `split-view.test.ts` (100% — every branch).
- `packages/shared/src/index.ts` export.
- `stores/workspace.ts`: fields, sanitizers, partialize, new actions, write-through on every
  existing action listed in §2; `stores/workspace.test.ts` additions covering: materialize/split/
  move/focus/ratio/close/collapse-to-null (order carry into `tabOrder`), write-through of each
  existing action while split, rename/preview substitution following, persistence round-trip +
  hostile JSON, `isDefault*` behavior.
- Gates: `pnpm typecheck`, `vp run -r test:coverage`, `vp check`.

**Phase 2 — rendering (both surfaces)**
- `components/split/{split-view-grid,split-view-divider,pane-empty-state,terminal-pane-anchor}.tsx`,
  `components/split/{terminal-viewport-registry,split-tab-partition}.ts` (+ tests for the two
  `.ts` modules and grid/empty-state component tests in the house style).
- `sessions-layer.tsx`, `ticket-terminal-host.tsx` (registry-driven, multi-anchor),
  `home-surface.tsx`, `ticket-detail.tsx`, minor `home-tab-strip.tsx`/`ticket-tabs.tsx` reuse
  for per-pane strips.
- Gates: phase-1 gates + existing smokes stay green (`node apps/desktop/scripts/run-smokes.mjs
  --tier boot` at minimum).

**Phase 3 — dnd + shortcuts + menu wiring + polish**
- `components/split/{split-dnd,split-drop-zones}.tsx` (+ pure zone-geometry/routing module with
  tests, e.g. `split-drop.ts`: pointer→zone hit-testing, payload validation, drop→op routing),
  `ui/tab-strip.tsx` surface-context awareness, native drag sources (`session-band-row.tsx`,
  rails), `lib/split-shortcut.ts` + test + `hooks/use-split-shortcuts.ts`, empty-state menu
  wiring, animations, `apps/desktop/e2e/split-view-smoke.mjs` (boot → open ticket → `⌘\` →
  two panes + menu visible → menu "New terminal" → terminal lands in new pane → close pane).
- `docs/DESIGN.md` split-view section; CONTEXT.md decision-log entry.
- Gates: all of the above + full smoke lane locally if feasible.

## 8. Invariants that must not break

- No live terminal is ever unmounted incidentally; visibility/position changes only.
- `splitView === null` ⇒ zero behavioral difference anywhere (assert by leaving every existing
  test untouched and green).
- The permanent tab: primary pane only, never draggable, never closable, always first.
- Surface active ≡ focused pane's active while split (single source for the rail and effects).
- Persisted split state is tolerant-read, never pruned against live tabs at sanitize time.
- Renderer↔main boundary untouched: this feature is renderer + shared only.
