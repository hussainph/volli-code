# File editor improvements (VC-186)

An exploration of what the file-editing surface is missing, what comparable
products ship, and a reconciled improvement plan. Every claim about Volli is
verified against the code at the cited location; external claims cite the
public page they came from (read 2026-08; product docs move).

This is the successor to the VC-120 audit (`docs/plans/files-feature-audit.md`).
That audit demoted Files from a first-class nav surface and deliberately
declared a "won't-do" list (§5.7: problems panel, status bar, project-wide TS,
in-app search, file create/rename/delete) so the demotion would not silently
grow an IDE. VC-186 revisits that line with a different question: now that
files live as tabs inside Home and the ticket workspace, **what must exist so a
person who decides to work on files directly hits no wall and is told no
lies?** Some of §5.7 stays won't-do; some of it moves.

## 1. Where the editor stands today

### 1.1 What landed since the audit

The VC-120 slices shipped their restructure: the Files nav page is retired
(VC-122), file tabs live in Home's strip beside Session tabs and in the ticket
strip (`home/home-tab-strip.tsx`, `ticket/ticket-tabs.tsx`, both drawing
`ui/tab-strip.tsx`), the rail has a Files navigator at both scopes
(`home/home-files-panel.tsx`, `ticket/ticket-files-panel.tsx`), editor theming
follows resolved app appearance (vitesse-light/-dark in
`editor/monaco-runtime.ts`), and the "Open in <editor>/Finder" escape hatch
exists on tabs and rows (`files/external-app-menu.tsx`). VC-125 (grammar
coverage) is still backlog.

### 1.2 The substrate is ahead of the chrome

Worth stating plainly, because it shapes every recommendation below: the
invisible half of this feature is genuinely strong, and several things
competitors advertise as features are already true here.

- **One shared model per document, however many views** — the document
  registry with leases and view-state memory (`editor/document-registry.ts`).
  Warp documents this as "shared buffers"; Volli has it.
- **Live external reconciliation** — an agent's write lands as minimal edit
  operations, the caret maps through, disjoint edits merge in place, conflicts
  raise a consequence-labelled banner instead of clobbering
  (`editor/live-document-reconciliation.ts`, `monaco-file-editor.tsx`).
  This is *the* hard problem of an editor that shares a worktree with an
  agent, and it is solved and tested.
- **Conflict-guarded writes** on mtime, per-tab fs-watch with bounded re-arm,
  save/discard/cancel close guards, preview/pin tab semantics, per-tab view
  state restored across relaunch.
- **Document Mode** — Obsidian-style live-preview markdown editing (the reveal
  contract in `editor/reveal.ts` says "exactly like Obsidian"), registry-backed,
  with `@file` chips — currently mounted only for `.volli/artifacts` markdown.
- **An editable diff** — the Change Set diff's modified side is the same
  registry model as the file tab, so edits in the diff are edits in the file
  (`editor/monaco-diff-editor.tsx`, `ticket/diff-view.tsx`).

The gaps are almost all in the visible half: affordances, navigation, and one
place where the UI actively lies.

### 1.3 The walls, the lies, and the rough edges (verified)

**Walls — things a person cannot do at all:**

| # | Wall | Where it is enforced |
|---|---|---|
| W1 | Create a file or folder; rename, move, delete, duplicate | NEW-FILE POLICY refuses writes to nonexistent paths outside `.volli/**` (`main/volli-fs.ts:593`); no affordance anywhere in the renderer |
| W2 | Reorder tabs | No drag or move operation in any strip; order is insertion order (`packages/shared/src/file-workspace.ts` has preview/pin/activate/close only; both strips compose kind-grouped) |
| W3 | Edit repository markdown in rendered form | `fileSavePolicy` routes all non-artifact markdown to the raw source editor (`packages/shared/src/file-save-policy.ts:37-41`); Document Mode never mounts for it |
| W4 | Jump to a file by name | ~~No quick-open; the command palette has no file entries (`command-palette-model.ts`); the rail navigator is a one-level-at-a-time walk~~ — **removed by §4.4 (VC-190)**: ⌘P over the scoped file index (`components/files/quick-open.tsx`) |
| W5 | Search across files | No search IPC exists at all (`main/volli-fs.ts`, `ipc/contract.ts`) |

**Lies — things shown that are wrong:**

| # | Lie | Mechanism |
|---|---|---|
| L1 | TS/JS files render as a wall of red squiggles in ordinary healthy repos | Monaco's TS worker runs semantic validation against isolated single-file models with **zero configuration** — no `typescriptDefaults` call exists in the codebase — so every cross-file import fails resolution and JSX errors under default compiler options |

L1 is the ticket's "each file is just a red squiggle entirely," and it is worse
than an absent feature: it teaches the user to distrust every diagnostic
surface in the app.

**Rough edges — present but unpolished:**

- The diff presentation toggle is two text buttons, `Inline | Side by side`,
  in a full-width border-bottom band (`ticket/diff-presentation-toggle.tsx`) —
  the only always-visible editor control, drawn as page chrome. `ui/segmented.tsx`
  already supports `icon` + `iconOnly`; this is nearly free to fix.
- No word-wrap toggle (`wordWrap: "on"` is hardcoded in `SOURCE_MODE_OPTIONS`,
  `monaco-file-editor.tsx`), no visible go-to-line (Monaco's action exists but
  nothing surfaces it), no copy-path/copy-relative-path anywhere.
- Clicking the Changes diff never focuses it, so ⌘S and keyboard scroll are
  unreachable from a click (VC-148, filed).
- ~30 shiki grammars; everything else is plaintext (VC-125, filed).
- Find/replace *within* a file already works (Monaco's built-in ⌘F/⌥⌘F widget
  ships enabled) — a gap the ticket does not have, worth knowing.

## 2. What comparable products do

The useful comparison set is not IDEs; it is the products that, like Volli,
put an agent first and then had to decide how much editor to build. They span
a clean spectrum:

| Product | Editing answer | What they built instead of / around an editor |
|---|---|---|
| **Sculptor** (Imbue) | **None in-app.** "Pairing Mode" checks the agent's branch out locally and syncs it so your own IDE is the editor ([docs.imbue.com, Pairing Mode](https://docs.imbue.com/core-concepts/core-concepts/pairing-mode)) | Diff view + terminal in-app; merge/pull UI |
| **Conductor** (Mac, parallel Claude/Codex) | **Review-first, no editor push.** Diff viewer (⌘⇧D) with unified toggle, commit filtering, file list ([conductor.build/docs, Diff viewer](https://www.conductor.build/docs/reference/diff-viewer)) | Line-anchored comments that feed the agent as precise context; recommended PR actions |
| **Warp** (the "ADE" that named the category) | **A real lightweight editor, built up deliberately over 2025** ([docs.warp.dev, Built-in Code Editor](https://docs.warp.dev/code/code-editor/); [blog, "Building a first-class code editor in Warp"](https://www.warp.dev/blog/building-a-first-class-code-editor-in-warp)) | Everything below |
| **Cursor / Windsurf** | Full IDE (VS Code forks) | The pole VC-186 explicitly does not chase |

### 2.1 Warp's ladder, in order

Warp is the closest analog — agent-first product, own UI framework, editor
grown from "technically, you could edit a file" to credible. The order they
built in is effectively a peer's answer to this ticket's question:

1. Basic open/edit/save (their starting point, ≈ Volli today)
2. **Find and replace** in-file (their first investment — Volli has this via
   Monaco already)
3. **Clickable file paths with line numbers** in agent conversations, and code
   snippets that carry `path` + line metadata with "Open in Warp" actions
   (Volli: chat file mentions open tabs since VC-121, without line anchors)
4. **Tabbed file viewer** — files group into one pane; **reorder, close, and
   drag file viewers between tabs; merge panes by dragging one into another**
5. **File tree** with browse/open/**create**
6. **Quick-open** (⌘O) — fuzzy file search scoped to the git repo
7. **LSP** for Rust/Go/Python/TS/JS/C++ — hover, go-to-definition, references,
   inline diagnostics, format-on-save
8. **Shared buffers** — same file in two views stays in sync (Volli has this)
9. **⌘L selection-as-context** — send an editor selection to the agent

Their scoping words are worth adopting: the editor exists for "quick, in-flow
edits alongside your Agent conversations… renaming a variable, tweaking copy,
or rewriting a short function," because "just enough editing power in-context
makes it easier to land an agent's changes and keep momentum."

### 2.2 The markdown question

The industry taxonomy is: raw source with a *split preview pane* (VS Code),
*live preview* that renders in place and reveals syntax at the caret
(Obsidian, Typora), or full WYSIWYG. Volli's Document Mode **is** the
Obsidian model, already built and registry-backed. The only decision left is
policy — which files may mount it and under which save contract — not
machinery. Obsidian's own answer to "prose surface vs source of truth" is a
per-view Source/Live-Preview toggle, which is the shape proposed in §4.

### 2.3 Language intelligence: the honest options

Three tiers exist between "red squiggle wall" and "ship an IDE":

1. **Configure what's there.** Monaco's TS worker accepts
   `typescriptDefaults.setCompilerOptions/setDiagnosticsOptions`. Feed it the
   project's real `jsx`/`target`/`strict` (a cheap tsconfig read) and suppress
   the module-resolution diagnostic family that *cannot* be satisfied on
   single-file models, and the remaining squiggles are true statements about
   the file itself. Near-zero cost, no new processes.
2. **Real LSP.** Run language servers in the main process over stdio and
   bridge to Monaco. `monaco-languageclient` exists but its own maintainers
   describe it as layered on VS Code API shims ("the whole lib is kind of a
   hack", [TypeFox/monaco-languageclient#400](https://github.com/TypeFox/monaco-languageclient/discussions/400));
   the honest Electron path is a thin product-owned bridge for the four or
   five capabilities that matter (diagnostics, hover, definition, references),
   which is what Warp built natively. Real cost: per-language server
   lifecycle, per-worktree roots, install/discovery story.
3. **Project-wide checking as a *task*, not a live service** — run
   `tsc --noEmit` (or the repo's own check command) in the worktree and
   present results. In an ADE this is arguably the native shape: it is what
   the agent itself does, and Volli already has the execution and worktree
   plumbing. No editor coupling at all.

The recommendation in §4 is tier 1 now, tier 3 as the "project-wide" answer
when wanted, tier 2 only behind an explicit later decision gate.

### 2.4 What the spectrum says for Volli

Volli's product shape — local-first, worktree-per-ticket, review-centric —
already contains Sculptor's answer (external-app menu ≈ pairing mode's intent)
and Conductor's answer (the Change Set diff, minus line comments). The ticket's
"robust fundamentals, no big obvious misses" ask lands Volli at **Warp's rungs
1–6 plus honest diagnostics**, and deliberately *not* at rung 7 (LSP) yet. The
agentic rungs (Conductor's diff comments, Warp's ⌘L) are real differentiators
but belong to the VC-145 portable-chat exploration, not here; the plan below
only keeps seams open for them.

## 3. The MVP fundamentals bar

What must be true so that direct file work never hits a wall or a lie in the
first session. Each item names its current state and verdict.

| # | Fundamental | Today | Verdict |
|---|---|---|---|
| F1 | Open/edit/save with conflict safety | Solid (§1.2) | Done |
| F2 | Find/replace in file | Monaco built-in | Done |
| F3 | Reorder tabs by drag | Absent (W2) | **Must** |
| F4 | Create/rename/delete/duplicate files and folders | Absent (W1) | **Must** |
| F5 | Quick-open by name | ⌘P over `volli:file-index`, now scope-taking (`components/files/quick-open.tsx`) | Done (§4.4, VC-190) |
| F6 | Diagnostics that tell the truth | Actively wrong for TS/JS (L1) | **Must** |
| F7 | Rendered markdown editing for repo files | Machinery built, policy withholds it (W3) | **Must** |
| F8 | Editor controls drawn as controls (diff toggle icons, word wrap, go-to-line, copy path) | Rough (§1.3) | **Must** (cheap) |
| F9 | Search across files | Absent (W5) | **Should** — the last "reach for another tool" moment |
| F10 | Broad syntax highlighting | ~30 grammars | **Should** (VC-125, already filed) |
| F11 | Keyboard/focus correctness in diffs | VC-148 filed | **Should** (fold in) |
| F12 | Live language intelligence (hover/def/refs) | Absent | **Later** — decision gate, §4.8 |
| F13 | Format-on-save | Absent | **Later** — rides the LSP decision |
| F14 | Split panes, minimap, breadcrumbs, outline | Absent | **Won't** (this pass) |

## 4. The plan

Seven slices, ordered by leverage over cost. Each is independently shippable;
sizes are relative (S ≈ a day, M ≈ a few days, L ≈ a week+).

### 4.1 Editor chrome pass (S)

The visible-polish slice, all small and additive:

- **Diff toggle → icons.** `Segmented` with `iconOnly` and two Phosphor icons
  (e.g. `Rows` for inline, `SquareSplitHorizontal` for side-by-side); labels
  stay as accessible names. One file (`diff-presentation-toggle.tsx`).
- **Word-wrap toggle** — per-surface preference in the UI store (tolerant-read
  persisted, like `diffPresentation`); applied via `updateOptions`.
- **Go-to-line** — surface Monaco's existing action (⌃G binding + a command
  palette entry).
- **Copy Path / Copy Relative Path** on file tab and navigator-row context
  menus, beside the existing "Open in…" items.
- **VC-148 fix** — focus the diff editor on click so ⌘S/keyboard work; this
  slice is already in the diff pane's chrome, take it together.

One rule while here: controls join the *one* existing slim band above the
editor (where the diff toggle lives) or the tab context menu — no new chrome
bands. House design culture is explicit about this.

### 4.2 Honest diagnostics for TS/JS (S)

Kill L1 without building anything speculative:

- In `editor/monaco-runtime.ts` (beside `startModelLanguageWorker`), configure
  `typescriptDefaults`/`javascriptDefaults` once per runtime load:
  - `setCompilerOptions` from a cheap read of the project's nearest
    `tsconfig.json` `compilerOptions` (jsx, target, lib, strict,
    experimentalDecorators; fall back to permissive defaults). This kills the
    JSX-flag and target-mismatch false reds.
  - `setDiagnosticsOptions({ diagnosticCodesToIgnore: [...] })` for the
    module-resolution family that single-file models can never satisfy
    (cannot-find-module and friends — enumerate by testing on this repo).
    Unresolved imports then type as `any` quietly instead of erroring loudly;
    what remains red is genuinely wrong *in this file*.
- Leave syntax validation on everywhere; it is always true.
- Decide `overviewRulerLanes` (currently 0) once diagnostics are trustworthy —
  a ruler mark is only good chrome when it marks something real.

Explicitly not in this slice: any new language service. This is subtraction of
falsehood, not addition of intelligence.

### 4.3 Tab drag-reorder (M)

The "big L". dnd-kit is already in-house, patched, and proven on the board
(`apps/desktop/package.json:22-25`, `patches/@dnd-kit__core@6.3.1.patch`).

- **Pure state:** add `moveFile(state, relPath, toIndex)` to
  `packages/shared/src/file-workspace.ts` — the reducer is pure and tested;
  this is one function + tests.
- **The real work is composition:** both strips currently derive order by
  concatenating kind groups (Home: Board → terminals → chats → files; ticket:
  Body → files → diffs → sessions → chats). Introduce a per-surface
  `tabOrder: string[]` overlay in the workspace store — compose descriptors as
  today, then sort by the overlay, append unknowns in kind order, tolerant-read
  on restore. This is also the natural foundation for VC-105 (Home remembers
  its whole strip), so build it as one model, not two.
- **Interaction:** horizontal sortable on the `role="tab"` elements inside
  `ui/tab-strip.tsx`; the permanent first tab (Board / Body) is not draggable
  and index 0 is not a droppable target; keep dnd-kit's keyboard sensor so
  reorder is not pointer-only; respect reduced motion.
- **Decision to record:** dragging a *preview* tab pins it. Arranging a tab is
  a deliberate act; a tab the user placed must not be silently replaced by the
  next preview (same reasoning as decision #56's "a dirty tab is never
  replaced").
- Out of scope: dragging tabs *between* windows/surfaces, split-pane docking.

### 4.4 Quick-open (S–M) — **landed: VC-190**

Shipped as written below, minus the command-palette file section, which the
ticket cut: ⌘P is the whole surface, and a second door onto the same list is a
separate decision. The index IPC now takes `{ projectId, ticketId }` and lists
the repo half from the worktree while `.volli/**` stays on Main — decision #6
spelled for a listing instead of a path.

- ⌘P (and a command-palette file section) over the existing
  `volli:file-index` — the ranking/match code already exists in the `@` picker
  (`chat/composer-picker.ts`); the overlay is a new thin surface.
- Scope follows the surface: Home → main checkout (the index as-is); ticket
  workspace → that ticket's worktree, which needs the index IPC to accept the
  established `{ projectId, ticketId }` scope pair and list from the worktree
  root through the same resolution seam file reads use.
- Enter previews, ⌘Enter (or double-invoke) pins — same grammar as the
  navigator. Opening lands in the surface you invoked it from.

### 4.5 File create / rename / delete / duplicate (M)

The audit's biggest deliberate omission, now a wall worth removing — with the
same safety posture the write path has:

- **Main:** new IPC verbs (`files.create`, `files.createDirectory`,
  `files.rename`, `files.delete`, `files.duplicate`) in `main/volli-fs.ts`,
  inside the existing two-layer path-safety and worktree-resolution seams.
  Delete goes to the **trash** (`shell.trashItem`), never `rm`. Create refuses
  to overwrite; rename refuses to clobber. The NEW-FILE POLICY comment block
  gets rewritten to name this as the sanctioned creation track.
- **Renderer:** context menu on navigator rows (New File…, New Folder…,
  Rename…, Duplicate, Delete — beside the existing Open in…), a New File
  action in the rail header at both scopes, and inline-rename in the navigator
  reusing `ui/inline-rename.tsx`. A created file opens pinned and focused.
- **Rename vs open documents:** document identity keys on relPath
  (`editor/document-identity.ts`), so v1 rule: renaming a file whose document
  is dirty is refused with "save first" (cheap, honest); clean open tabs remap
  by close/reopen with view state carried by the host. Ticket-body `@file`
  references may dangle after a rename — the Dangling Reference concept
  already exists and renders honestly (CONTEXT.md), so v1 records this rather
  than building reference rewriting.
- The watch/recency pipeline already handles externally-appearing and
  disappearing files (tested paths in `file-view.tsx`), so tabs stay correct.

### 4.6 Rendered markdown for repo files (M)

The ticket's "we already have the machinery" — true, and the missing piece is
policy plus one save-contract nuance:

- **A per-tab Source ⇄ Document toggle** on markdown file tabs (iconOnly
  `Segmented`, e.g. `Code` / `Article`), drawn in the same slim band as
  §4.1's controls. Default **source** — this is a code checkout and diffs are
  the lingua franca — remembered per file in the workspace store.
- **Save contract does not change:** repo markdown stays explicit-⌘S. The
  autosave-vs-explicit split in `fileSavePolicy` is about *which files*, not
  *which editor*; `FileView` already owns the write path for both of its
  editors, so mounting `MonacoDocumentEditor` in Document view without wiring
  the autosave debouncer — routing ⌘S through the same conflict-guarded write
  the source editor uses — keeps CONCEPT #49 intact. Registry-backed dirty
  state and the close guard work unchanged because both editors share the
  document identity.
- Frontmatter, raw HTML blocks, and anything the projection cannot represent
  losslessly must round-trip byte-identical or the toggle refuses Document
  view for that file (Document Mode's projection already runs on artifacts;
  verify against repo-typical markdown before enabling broadly).

### 4.7 Search across files (M–L)

The last "leave the app to do a basic thing" moment, and the one **Should**
that needs a real build:

- **Main:** a `volli:search` IPC backed by `@vscode/ripgrep` (the rg binary
  VS Code ships; MIT), scoped by the same `{ projectId, ticketId }` resolution
  as file reads, with hard caps (result count, time budget) and honest
  truncation flags — same posture as the 1 MiB read cap.
- **Renderer:** a Search page in the rail navigator (both scopes), results
  grouped by file, click opens the file at the match line (preview semantics,
  Monaco `revealLineInCenter`). Find-only in v1 — replace-across-files is a
  different risk class beside a live agent and stays out until wanted.
- Respect `.gitignore` by default (rg's default), with node_modules never
  searched.

### 4.8 The LSP decision gate (explicitly deferred)

Recorded as a *gate*, not a slice: after §4.2 ships, live with honest
diagnostics for a while. If hover/go-to-definition absence still hurts in
practice, the shape is Warp's — real language servers in main over stdio, a
thin product-owned Monaco bridge, TS first via tsserver/vtsls, per-worktree
roots — and it is L-sized with a real lifecycle/discovery story. If
"project-wide type checking" is the actual want, prefer tier 3 (§2.3): run the
repo's own check command in the worktree and present results, which is ADE-
native and shares machinery with sessions rather than with the editor. Do not
adopt `monaco-languageclient` wholesale (§2.3).

### Order and dependencies

```
4.1 chrome pass ──────────────┐
4.2 honest diagnostics ───────┤  independent, ship in any order
4.4 quick-open ───────────────┘
4.3 tab reorder ──── shares the strip-order model with VC-105; build together
4.5 create/rename ── after 4.3 only to avoid rebasing tab code twice
4.6 markdown toggle ─ independent
4.7 search ────────── last of the batch; largest new surface
4.8 LSP gate ──────── a decision after 4.2 has soaked, not a scheduled slice
```

Ticket mapping: the brief's five complaints land as 4.1 (diff buttons), 4.5
(no way to add files), 4.6 (markdown), 4.3 (tab reorder), 4.2 + 4.8 (language
intelligence).

**A nearer-term cut: the solo review-and-hand-edit session.** The slices also
serve a concrete workflow worth naming — one person, one session at a time,
reading everything the agent writes and sometimes implementing changes by
hand; the review-first shape §2's spectrum converges on. For that cut the
order tightens to **4.1 → 4.4 → 4.5 → 4.7** (polish, then navigate, then
create, then find usages), because those four are what a desktop editor would
otherwise be opened for. 4.2 stays cheap and first when the repo is TS/JS;
Python and Ruby (grammars and extension maps already shipped) have no Monaco
worker and therefore no false diagnostics to fix — the honest check loop
there is the repo's own commands in the terminal, which the product already
has. 4.3 and 4.6 trail without harm. No slice changes; only order.

## 5. Non-goals, recorded

Unchanged from the audit's spirit — the ADE bet is that deep authoring
happens with the agent or in the user's IDE (the external-app menu is the
sanctioned door):

- No debugger, no extension system, no git staging/commit UI inside the
  editor, no minimap, no breadcrumbs/outline/symbol tree, no split panes in
  this pass, no settings sprawl (word wrap and the markdown view mode are the
  whole preference surface this plan adds).
- No replace-across-files in v1 search (§4.7).
- No `monaco-languageclient`/VS Code-shim adoption (§2.3, §4.8).
- No WYSIWYG-for-everything: Document view is a per-tab choice on markdown,
  never the forced default for repo files (§4.6).

## 6. Adjacent work and the agentic seam

- **VC-105** (Home strip persistence) — §4.3's order model is its foundation;
  coordinate rather than collide.
- **VC-125** (grammar gaps) — unchanged, still the cheapest polish per line.
- **VC-148** (diff focus) — absorbed by §4.1.
- **VC-145** (universal chat / portable chats in file views) — out of scope
  here by the brief, but two research findings belong to it when it runs:
  Conductor's line-anchored diff comments that feed the agent, and Warp's ⌘L
  selection-as-context. §4.1's slim control band and the tab model leave room
  for both without new chrome.
- **Change review at project scope** — observed while cutting priorities: the
  diff stack is ticket-scoped (`diff-view.tsx:150` and
  `ticket-changes-panel.tsx:419` both key off `ticket.id`; Home's rail pages
  are now/sessions/files, `home-rail-model.ts:21`), so a Project Session
  working the Main checkout has no diff surface at all. **Not a slice of this
  plan** — the ticket workspace is the product's review home, and a
  lightweight ticket already buys the whole review stack (worktree, Changes
  panel, diff tabs, PR row) with no new build. Worth a ticket of its own only
  if Main-checkout sessions become a primary workflow.
